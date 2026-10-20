// The prepareSession/openHeld protocol shared by bark.ts (main thread) and
// walletWorkerImpl.ts (worker).
//
// Its own module rather than living next to the implementation for a
// bundling reason, not a stylistic one: walletWorkerImpl.ts statically
// imports @secondts/bark/web, so importing *any runtime value* from it on
// the main thread would pull the ~7.7MB WASM SDK into the main bundle — and
// would also mean the SDK gets evaluated in the one realm the network guard
// in public/fetch-guard.js is built around keeping it out of. Types alone
// would be safe (they erase), but the error sentinels below are real
// values, so both live here instead.

import type { EncryptedVault } from "../vault/vaultCrypto";
import type { BackupKeys } from "../backup/backupCrypto";

// How a session's mnemonic gets into the wallet worker. Every variant
// resolves to a plaintext mnemonic *there* and nowhere else:
//
//   - "vault": the normal password unlock. The password crosses the worker
//     boundary; the mnemonic never does. This is the whole point of the
//     split — the main thread (React, jsqr, the whole dependency tree
//     sharing that realm) used to call decryptMnemonic itself and hold the
//     result for the length of an unlock, which put the seed in by far the
//     widest-attack-surface realm the app has.
//   - "bioVault": biometric unlock. navigator.credentials only exists on
//     the main thread, so the WebAuthn PRF secret is obtained there and
//     imported as a non-extractable CryptoKey, which is then structured-
//     cloned into the worker. Honest code on the main thread never sees the
//     mnemonic, but the key can still DECRYPT, and the raw PRF bytes arrive
//     on the main thread before import, so hostile code there can recover
//     the seed. See the threat-model note below.
//
// Threat model, stated plainly: this split keeps the plaintext seed out of
// the main thread's heap, logs and crash reports (passive leaks). It is NOT a
// boundary against malicious code running on the main thread: every unlock
// hands that realm enough to decrypt the seed itself (password + the vault in
// localStorage, or a decrypt-capable PRF key + the bio vault).
//   - "mnemonic": onboarding and seed import only. There the mnemonic is
//     unavoidably in the main thread already (it's displayed word by word,
//     or typed in by the user), so routing it through the worker adds no
//     exposure — it just means there is exactly one open path instead of
//     two.
export type PrepareSource =
  | { kind: "mnemonic"; mnemonic: string }
  | { kind: "vault"; vault: EncryptedVault; password: string }
  | { kind: "bioVault"; unwrapKey: CryptoKey; ivB64: string; cipherB64: string };

export interface PrepareResult {
  // Non-extractable CryptoKey + public lookup key for the cloud backup (see
  // ARCHITECTURE.md's backup section). Derived in the worker so the derivation's
  // input — the mnemonic's BIP39 seed — stays in that realm; only the
  // derived, non-extractable result crosses back. null if this browser
  // can't structured-clone a CryptoKey (see canCloneCryptoKey in
  // walletWorkerImpl.ts).
  backupKeys: BackupKeys | null;
  // Set only when the vault was still on the legacy PBKDF2 iteration count
  // and has been transparently re-encrypted at the current one. The caller
  // persists it; re-encrypting needs the plaintext seed, so it has to
  // happen in the worker rather than on the main thread.
  rehashedVault: EncryptedVault | null;
}

// Sentinel error messages, matched by App.tsx to tell "you typed the wrong
// password" apart from "something else went wrong" — the distinction used to
// be free (a decryptMnemonic() call the main thread made itself, in its own
// try/catch) and has to be carried explicitly now that the decrypt happens
// across a postMessage boundary that flattens every failure to a string.
export const VAULT_DECRYPT_FAILED = "VAULT_DECRYPT_FAILED";
export const BIO_DECRYPT_FAILED = "BIO_DECRYPT_FAILED";
// openHeld with no prepareSession before it — in practice this means the
// worker was terminated and recreated between the two (bark.ts's watchdog,
// or a worker error), so the seed that was held for this session is gone.
export const NO_HELD_MNEMONIC = "NO_HELD_MNEMONIC";

// --- Spend authorization -------------------------------------------------
//
// The wallet worker used to execute any `call` message it received, with no
// check of its own: every gate that stood between a request and real money
// (the password prompt for large sends, the SendPlan confirm screen, the
// arm delay, auto-lock) lived on the main thread. That is the one realm this
// app's whole architecture treats as compromisable — React, jsqr and the
// entire dependency tree share it — and `Worker.prototype.postMessage` is
// reachable from anything running there, so a compromised dependency could
// simply post its own `{type:"call", method:"sendOnchain", ...}` and drain
// the wallet without ever touching the seed, the password, or any UI.
//
// The gate therefore has to be enforced *inside* the worker. Anything the
// main thread merely holds (a session token, a flag) is readable by an
// attacker sharing that realm, so the proof is a secret the main thread does
// not keep: the password, re-entered by the human.
//
// Limit: it only holds against an attacker who has not yet seen a password
// being typed or a biometric unlock happen. Either one gives the main thread
// the seed (see the threat-model note above), and with the seed a valid
// SpendAuth is trivial to forge (encrypt it under any password). What this
// gate reliably stops is a crafted message from code that has not watched an
// unlock, and any method outside the allowlist.
export interface SpendAuth {
  // The password vault as it currently sits in localStorage, plus the
  // password typed for this specific spend. The worker does NOT trust this
  // vault on its own, see the seed-hash binding in walletWorkerImpl.ts: the
  // pair must decrypt to the exact seed the currently-open wallet was opened
  // with. Constructing one needs the password or the seed; the seed is
  // exactly what a main-thread attacker gets from watching an unlock, so this
  // binding stops a substituted vault only from one that has not.
  vault: EncryptedVault;
  password: string;
}

// Sends at or above this need the password re-entered. Lives here rather
// than inside SendPanel because the worker enforces the same number: a
// threshold the UI and the enforcement point could disagree about is worse
// than no threshold, since the UI would decide not to ask for something the
// worker then insists on (or, far worse, the other way round).
export const PASSWORD_REQUIRED_THRESHOLD_SATS = 100_000;

// Sub-threshold sends stay frictionless, so an attacker who can post
// messages to the worker can still move money below the threshold. That is
// bounded rather than prevented: the worker refuses to let unauthorized
// spending exceed this much within a rolling window, so the exposure is one
// capped amount instead of the whole balance. Deliberately equal to the
// threshold above — a wallet spending more than this in a day is expected to
// type its password at least once along the way.
export const UNAUTHORIZED_SPEND_CAP_SATS = 100_000;
export const UNAUTHORIZED_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

// This call moves funds and needs a SpendAuth that wasn't supplied.
export const SPEND_AUTH_REQUIRED = "SPEND_AUTH_REQUIRED";
// A SpendAuth was supplied but the password is wrong, or the vault it came
// with is not the one this session's wallet was opened from.
export const SPEND_AUTH_FAILED = "SPEND_AUTH_FAILED";
// Under the threshold, but the rolling unauthorized-spend cap is exhausted.
export const SPEND_LIMIT_EXCEEDED = "SPEND_LIMIT_EXCEEDED";
// refreshVtxosDelegated() called more often than REFRESH_SUBMIT_MAX per
// REFRESH_SUBMIT_WINDOW_MS. Every submission burns a vtxo key index toward the
// recovery scan's key gap limit (bark's default 250), so the worker caps it no matter what the main
// thread (the refresh engine, or anything posting to the worker) asks for.
// Same numbers as the engine's own breaker (refreshEngine/breaker.ts).
export const REFRESH_LIMIT_EXCEEDED = "REFRESH_LIMIT_EXCEEDED";
export const REFRESH_SUBMIT_MAX = 6;

// What refreshVtxosDelegatedAndLock() answers (see its comment in bark.ts).
export interface RefreshAndLockResult {
  round: { id: number; state?: string } | undefined;
}
// refreshVtxosDelegatedAndLock() could not lock its inputs (a payment took
// one, or it is no longer Spendable locally), so nothing was submitted, no
// key index was derived and no submission slot was charged. Not a rejection:
// the engine just plans again.
export const REFRESH_INPUTS_UNAVAILABLE = "REFRESH_INPUTS_UNAVAILABLE";
// A wallet call reached the worker after the session closed (a lock, an
// auto-lock, a relock landing mid refresh engine tick): nothing ran. The
// engine drops such a tick without a log entry and never counts a submit
// that died this way as sent.
export const WALLET_NOT_OPEN = "Wallet not open";
// What a deliberate lock rejects the calls it cut with (bark.ts, dropWorkerForLock):
// read-only work that never finished. Treated like WALLET_NOT_OPEN.
export const WALLET_LOCKED_MESSAGE = "Wallet locked.";
export const REFRESH_SUBMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
// The `call` named a method that is not on the worker's per-target allowlist
// (see walletSpendPolicy.ts). No legitimate caller hits this — the bark.ts
// client proxy can only forward methods the WalletClient/OnchainWalletClient
// interface declares — so in practice it means a crafted message tried to
// reach a wallet method the app never uses (offboardAll, OnchainWallet.send,
// free, …).
export const METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED";
// prepareSession was called while a wallet is already open. No legitimate
// flow does this (App.tsx only opens from a locked screen); an attacker
// doing it would be trying to re-point the seed-hash binding that spend
// authorization is checked against, while leaving the victim's wallet open.
export const WALLET_ALREADY_OPEN = "WALLET_ALREADY_OPEN";
