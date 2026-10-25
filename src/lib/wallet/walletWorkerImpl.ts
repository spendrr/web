// The actual wallet worker implementation — split out from wallet.worker.ts
// so that file can install network patches *before* this module (and thus
// the @secondts/bark SDK it imports) is ever evaluated. See wallet.worker.ts
// for why that ordering matters.
//
// Owns the real WASM Wallet instance off the main thread — see the design
// notes in bark.ts, which is the only other file that talks to this worker.
//
// Every request is processed through a single serialized queue: no two
// wallet.* calls (or a call racing a close()) are ever allowed to run
// concurrently. That's not just an efficiency nicety — concurrent calls into
// the WASM bridge crash it with "memory access out of bounds", and this
// queue is now the one app-wide place that guarantees it, instead of the
// narrower per-component guards the UI layer used before this migration.
import init, {
  OnchainWallet,
  Wallet,
  extractTxFromPsbt as rawExtractTxFromPsbt,
  generateMnemonic as rawGenerateMnemonic,
  validateMnemonic as rawValidateMnemonic,
  type Network,
} from "@secondts/bark/web";
import { CONFIG, FALLBACK_ESPLORA_ADDRESS, arbitraryDomain, exitChainRedirect } from "./walletWorkerGuard";
import { IS_REGTEST, IS_SIGNET } from "../network";
import {
  EXIT_COIN_NOT_ELIGIBLE,
  EXIT_LOCK_HOLDER_ID,
  EXIT_ROUND_INPUTS_UNKNOWN,
  exitExpiryHeights,
  parseExitStartArgs,
  planExitLocks,
  planExitStart,
  type ExitLockSync,
  type ExitStartResult,
} from "../exit/exitLocks";
import { decodeLnurlHost } from "../send/lnurl";
import {
  decryptMnemonic,
  decryptVaultBytes,
  encryptMnemonic,
  fromB64,
  vaultNeedsRehash,
  zeroBytes,
  type EncryptedVault,
} from "../vault/vaultCrypto";
import { bip39Seed, deriveBackupKeysFromSeed, type BackupKeys } from "../backup/backupCrypto";
import { deriveChatKeyFromSeed } from "../chat/chatKey";
import {
  BIO_DECRYPT_FAILED,
  METHOD_NOT_ALLOWED,
  NO_HELD_MNEMONIC,
  SPEND_AUTH_FAILED,
  SPEND_AUTH_REQUIRED,
  SPEND_LIMIT_EXCEEDED,
  REFRESH_LIMIT_EXCEEDED,
  REFRESH_SUBMIT_MAX,
  REFRESH_SUBMIT_WINDOW_MS,
  UNAUTHORIZED_SPEND_CAP_SATS,
  UNAUTHORIZED_SPEND_WINDOW_MS,
  VAULT_DECRYPT_FAILED,
  WALLET_ALREADY_OPEN,
  type PrepareResult,
  type PrepareSource,
  type SpendAuth,
  WALLET_NOT_OPEN,
} from "./walletSession";
import {
  classifyOnchainCall,
  classifyWalletCall,
  createRefreshSubmitBudget,
  createUnauthorizedSpendBudget,
  isCallTarget,
  isGiftMethodAllowed,
  sanitizeWalletCallArgs,
} from "./walletSpendPolicy";
import { refreshAndRelease } from "./refreshSubmit";
import { pendingRoundInputIds } from "./roundInputs";

const NETWORK: Network = IS_REGTEST ? "Regtest" : IS_SIGNET ? "Signet" : "Bitcoin";

const DB_NAME = "btc-wallet-mainnet";
const ONCHAIN_DB_NAME = "btc-wallet-mainnet-onchain";

// wallet.* methods that legitimately need to resolve a recipient-chosen
// domain — see walletWorkerGuard.ts.
const ARBITRARY_DOMAIN_METHODS = new Set(["payLightningAddress", "payLnurl"]);

// The host(s) to exempt from the network allowlist for the duration of one
// ARBITRARY_DOMAIN_METHODS call — derived from the call's own destination,
// not "any host" (see walletWorkerGuard.ts's arbitraryDomain.allow()). An
// empty result (a destination that doesn't parse) grants no exception at
// all: the call then fails closed against the allowlist instead of falling
// back to a blanket bypass.
function arbitraryDomainHostsFor(method: string, args: unknown[]): string[] {
  const first = args[0] as Record<string, unknown> | undefined;
  if (method === "payLightningAddress" && typeof first?.lightningAddress === "string") {
    const at = first.lightningAddress.lastIndexOf("@");
    if (at < 0) return [];
    const domain = first.lightningAddress.slice(at + 1).trim();
    if (!domain) return [];
    try {
      return [new URL(`https://${domain}`).host];
    } catch {
      return [];
    }
  }
  if (method === "payLnurl" && typeof first?.lnurl === "string") {
    const host = decodeLnurlHost(first.lnurl);
    return host ? [host] : [];
  }
  return [];
}

// The per-target method allowlist and the send-amount classification both
// live in walletSpendPolicy.ts — a pure module with no SDK import, so it can
// be unit-tested directly (this file cannot). See its header for why the
// gate is an allowlist rather than the deny-list it used to be.

export type Request =
  | { id: number; type: "ensureWasm" }
  | { id: number; type: "generateMnemonic" }
  | { id: number; type: "validateMnemonic"; mnemonic: string }
  // A free SDK function, not a wallet method — but it lives in the same
  // WASM module, so it has to run here rather than on the main thread.
  | { id: number; type: "extractTxFromPsbt"; psbtBase64: string }
  | { id: number; type: "prepareSession"; source: PrepareSource }
  | { id: number; type: "openHeld"; useFallbackChainSource?: boolean; exitChain?: boolean; runDaemon?: boolean }
  | { id: number; type: "call"; target: "wallet" | "onchain"; method: string; args: unknown[]; auth?: SpendAuth }
  | { id: number; type: "close" }
  // Money chat (beta): posts the session's chat key into `port`. See
  // sessionChatKey below for what that does and does not protect.
  | { id: number; type: "chatKey"; port: MessagePort }
  // --- Gift-link ephemeral wallet ------------------------------------------
  // A throwaway wallet opened from the one-time mnemonic carried in a gift
  // link, used only to pull the gift VTXO out of its mailbox and forward it
  // on. It lives in its own handle slot (giftWallet / giftOnchain) and never
  // touches currentWallet, heldMnemonic or the spend-authorization state, so
  // the real wallet's single-open invariant and password gate are unaffected.
  // Runs on the same FIFO queue, so it can never interleave a call with the
  // real wallet. Opened with runDaemon:false and its own IndexedDB names
  // (btc-wallet-gift-<id>*) so it shares nothing with btc-wallet-mainnet.
  | { id: number; type: "giftOpen"; mnemonic: string; dbName: string; onchainDbName: string }
  | { id: number; type: "giftCall"; method: string; args: unknown[] }
  | { id: number; type: "giftClose" };

type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
// Posted the moment a request leaves the queue below and actually begins,
// so the client's watchdog can tell "still waiting its turn" apart from
// "running and wedged" and time only the latter. See armWatchdog in bark.ts.
type StartedNotice = { id: number; started: true };

let wasmReady: Promise<unknown> | null = null;
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) wasmReady = init();
  return wasmReady;
}

let currentWallet: Wallet | null = null;
let currentOnchainWallet: OnchainWallet | null = null;

// Gift-link ephemeral wallet handles — see the "giftOpen" branch of Request.
// Separate from currentWallet on purpose: a gift claim must not disturb (or
// be gated by) the real session.
let giftWallet: Wallet | null = null;
let giftOnchainWallet: OnchainWallet | null = null;

// The plaintext mnemonic for the session being opened, held between
// prepareSession and the openHeld that consumes it. Kept across a *failed*
// openHeld on purpose: App.tsx retries the open more than once for reasons
// that have nothing to do with the seed (the stale-DB wipe retry, the
// fallback chain source), and each retry needs it again. Cleared as soon as
// an open succeeds — from then on the seed lives only inside the WASM
// wallet, which is where it has to live anyway for every wallet.* call, and
// a second JS-side copy would just be one more thing to lose.
let heldMnemonic: string | null = null;

// Backstop for the seed above. It used to be cleared on exactly two events —
// a successful open, or close — which left one reachable gap: an open that
// *fails* for any reason other than a mnemonic mismatch (esplora
// unreachable, a timeout, IndexedDB blocked) drops the user back to the
// unlock screen without App.tsx ever closing the session, so the plaintext
// seed sat in this realm indefinitely while the app looked locked, and a
// replayed `openHeld` could consume it with no password.
//
// App.tsx now closes the session on a failed open, which is the real fix;
// this timer covers the cases that can't reach that code (a promise chain
// interrupted, the tab suspended mid-flow). Deliberately as wide as
// OPEN_TIMEOUT_MS in bark.ts, and re-armed at the start of every openHeld
// attempt, so it can never fire during an open that is legitimately still
// running — a slow first-import recovery scan takes minutes, and killing the
// seed underneath it would break the retry path (the fallback chain source)
// that exists for emergencies.
const HELD_MNEMONIC_TTL_MS = 20 * 60_000;
let heldMnemonicTimer: ReturnType<typeof setTimeout> | null = null;

function setHeldMnemonic(mnemonic: string | null): void {
  heldMnemonic = mnemonic;
  if (heldMnemonicTimer !== null) {
    clearTimeout(heldMnemonicTimer);
    heldMnemonicTimer = null;
  }
  if (mnemonic !== null) {
    heldMnemonicTimer = setTimeout(() => {
      heldMnemonic = null;
      heldMnemonicTimer = null;
      console.error("[wallet.worker] held mnemonic expired unconsumed; unlock has to start over");
    }, HELD_MNEMONIC_TTL_MS);
  }
}

// SHA-256 of the seed the currently-open wallet was opened with, and the
// same for a session prepared but not yet opened. The worker cannot trust a
// vault handed to it by the main thread (it could send one made up under a
// password it knows), so a SpendAuth is accepted only when the vault+password
// it carries decrypt to *this* seed. Producing such a pair requires the
// password or the seed. A main-thread attacker has neither until it watches
// an unlock, and then has both (see the threat-model note in
// walletSession.ts), so this stops the one that hasn't.
//
// A hash, not the seed: it answers "same seed?" without keeping a second
// copy of the secret alive for the whole session, and inverting SHA-256 over
// a BIP39 mnemonic is not a route back to it.
let sessionSeedHash: Uint8Array | null = null;
let pendingSeedHash: Uint8Array | null = null;

// The money chat's Nostr key (chat/chatKey.ts), derived from the seed during
// prepareSession and bound to the session the same way as the seed hash. It
// cannot move money, but whoever holds it can write as this user. It leaves
// only through the "chatKey" request, into a port the caller chooses: honest
// code (chatClient.ts) hands it the chat worker's end, so the key never sits
// in the main thread's heap. Hostile main-thread code could pass its own port
// and get the key, the same limit as the biometric unlock's key (see the
// threat-model note in walletSession.ts): this guards against passive leaks,
// not against a compromised main thread. Zeroed on close.
let sessionChatKey: Uint8Array | null = null;
let pendingChatKey: Uint8Array | null = null;

function dropChatKeys(): void {
  sessionChatKey?.fill(0);
  pendingChatKey?.fill(0);
  sessionChatKey = null;
  pendingChatKey = null;
}

// Rolling window of sats spent without a SpendAuth, see
// UNAUTHORIZED_SPEND_CAP_SATS and createUnauthorizedSpendBudget. In memory
// only: anywhere persistent (IndexedDB, localStorage) is writable by the main
// thread this exists to distrust. So a reload or a watchdog reset does clear
// it; reopening needs an unlock, but an unlock is routine (auto-lock), so this
// bounds the exposure per worker lifetime, not per day.
const unauthorizedBudget = createUnauthorizedSpendBudget(UNAUTHORIZED_SPEND_CAP_SATS, UNAUTHORIZED_SPEND_WINDOW_MS);
const refreshSubmitBudget = createRefreshSubmitBudget(REFRESH_SUBMIT_MAX, REFRESH_SUBMIT_WINDOW_MS);

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Throws unless `auth` proves the human re-entered the password for the
// wallet that is actually open. Never builds a mnemonic string: only the
// raw bytes, hashed and immediately zeroed.
async function requireSpendAuth(auth: SpendAuth | undefined): Promise<void> {
  if (!auth) throw new Error(SPEND_AUTH_REQUIRED);
  if (sessionSeedHash === null) throw new Error(SPEND_AUTH_FAILED);
  let bytes: Uint8Array;
  try {
    bytes = await decryptVaultBytes(auth.vault, auth.password);
  } catch {
    // Wrong password, or a vault that isn't a vault. Indistinguishable, and
    // the caller has nothing useful to do with the difference.
    throw new Error(SPEND_AUTH_FAILED);
  }
  try {
    if (!sameBytes(await sha256(bytes), sessionSeedHash)) {
      // Right password for *a* vault, but not this session's wallet — i.e.
      // exactly the substituted-vault forgery this binding exists to catch.
      throw new Error(SPEND_AUTH_FAILED);
    }
  } finally {
    zeroBytes(bytes);
  }
}

// Applies exitLocks.ts's plan. The lock goes in one atomic call; if that
// fails (a coin changed state between the read and the lock), coin by coin,
// so one coin can't keep the rest unlocked. unlockVtxos goes one id at a
// time too: bark-ffi rejects the whole batch when any id isn't ours.
async function syncExitLocks(w: Wallet): Promise<ExitLockSync> {
  const exits = await w.getExitVtxos();
  const vtxos = await w.allVtxos();
  const plan = planExitLocks(vtxos, exits);
  const holder = { type: "action" as const, id: EXIT_LOCK_HOLDER_ID };
  const locked: string[] = [];
  if (plan.lock.length > 0) {
    try {
      await w.lockVtxos({ vtxoIds: plan.lock, holder });
      locked.push(...plan.lock);
    } catch {
      for (const id of plan.lock) {
        try {
          await w.lockVtxos({ vtxoIds: [id], holder });
          locked.push(id);
        } catch (e) {
          console.warn(`syncExitLocks: could not lock ${id}`, e);
        }
      }
    }
  }
  const unlocked: string[] = [];
  for (const id of plan.unlock) {
    try {
      await w.unlockVtxos({ vtxoIds: [id], expectedHolder: holder });
      unlocked.push(id);
    } catch (e) {
      console.warn(`syncExitLocks: could not unlock ${id}`, e);
    }
  }
  // Anything still to broadcast or claim keeps bark's chain traffic off
  // Second's esplora (walletWorkerGuard.ts, exitChainRedirect).
  exitChainRedirect.set(exits.some((e) => !FINISHED_EXIT_STATES.has(e.state.type)));
  return {
    lock: locked,
    unlock: unlocked,
    expiryHeights: exitExpiryHeights(vtxos, exits),
    chainFallbacks: exitChainRedirect.fallbacks,
  };
}

const FINISHED_EXIT_STATES: ReadonlySet<string> = new Set(["claimed", "vtxo-already-spent", "canceled"]);

// The gate itself, applied to every `call` before the method name is even
// used to index the live WASM object. classifyWalletCall / classifyOnchainCall
// are the allowlist: a method they don't recognise is refused outright, so
// the SDK's whole ~120-method surface (offboardAll, OnchainWallet.send,
// free, …) is unreachable from a crafted message. See walletSpendPolicy.ts.
async function enforceSpendPolicy(msg: Extract<Request, { type: "call" }>): Promise<void> {
  const verdict =
    msg.target === "onchain" ? classifyOnchainCall(msg.method) : classifyWalletCall(msg.method, msg.args);
  switch (verdict.kind) {
    case "denied":
      throw new Error(METHOD_NOT_ALLOWED);
    case "allow":
      // refreshVtxosDelegatedAndLock charges itself, only once its inputs
      // are locked (see its handler below).
      if (msg.target === "wallet" && msg.method === "refreshVtxosDelegated" && !refreshSubmitBudget.tryCharge(Date.now())) {
        throw new Error(REFRESH_LIMIT_EXCEEDED);
      }
      return;
    case "needs-auth":
      await requireSpendAuth(msg.auth);
      return;
    case "capped": {
      if (msg.auth) {
        // Under the threshold but a password was supplied anyway — still
        // verify it (a wrong one must fail), but don't consume the
        // unauthorized budget, since this spend is actually authorized.
        await requireSpendAuth(msg.auth);
        return;
      }
      // Charged now, not after the call succeeds: see
      // createUnauthorizedSpendBudget for why a failure is not refunded.
      if (!unauthorizedBudget.tryReserve(verdict.amountSats, Date.now())) {
        throw new Error(SPEND_LIMIT_EXCEEDED);
      }
      return;
    }
    default:
      // Unreachable today (the union above is closed) — a fail-closed guard
      // so that widening CallVerdict without a matching case here refuses the
      // call rather than silently letting it through.
      throw new Error(METHOD_NOT_ALLOWED);
  }
}

// Whether a CryptoKey survives a postMessage out of this worker. Every
// engine this app supports implements CryptoKey as a serializable object,
// but the failure mode if one doesn't is nasty and silent-looking: the
// response postMessage throws "could not be cloned" and the whole unlock
// fails, rather than just the (best-effort, non-essential) backup feature.
// Testing it in here instead means a browser that can't do it degrades to
// "no cloud backup this session" — logged, and visible as a stale
// "Poslední záloha" timestamp in Settings — while the unlock still works.
function canCloneCryptoKey(key: CryptoKey): boolean {
  if (typeof structuredClone !== "function") return false;
  try {
    structuredClone(key);
    return true;
  } catch {
    return false;
  }
}

async function resolveMnemonic(source: PrepareSource): Promise<string> {
  switch (source.kind) {
    case "mnemonic":
      return source.mnemonic;
    case "vault":
      try {
        return await decryptMnemonic(source.vault, source.password);
      } catch {
        // Wrong password or a corrupted vault — deliberately not
        // distinguished, exactly as before this moved off the main thread
        // (AES-GCM can't tell them apart, and neither could the UI).
        throw new Error(VAULT_DECRYPT_FAILED);
      }
    case "bioVault": {
      let plain: Uint8Array;
      try {
        const buf = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromB64(source.ivB64) as BufferSource },
          source.unwrapKey,
          fromB64(source.cipherB64) as BufferSource,
        );
        plain = new Uint8Array(buf);
      } catch {
        throw new Error(BIO_DECRYPT_FAILED);
      }
      try {
        return new TextDecoder().decode(plain);
      } finally {
        zeroBytes(plain);
      }
    }
  }
}

// Chains every request onto this promise so they run strictly one at a
// time, in arrival order — see the file-level comment above.
let queue: Promise<unknown> = Promise.resolve();

async function runRequest(msg: Request): Promise<unknown> {
  switch (msg.type) {
    case "ensureWasm":
      await ensureWasm();
      return undefined;
    case "generateMnemonic":
      await ensureWasm();
      return rawGenerateMnemonic();
    case "validateMnemonic":
      await ensureWasm();
      return rawValidateMnemonic(msg.mnemonic);
    case "extractTxFromPsbt":
      await ensureWasm();
      return rawExtractTxFromPsbt(msg.psbtBase64);
    case "prepareSession": {
      // No ensureWasm() here: nothing in this branch touches WASM — it is
      // pure WebCrypto (PBKDF2 + AES-GCM + HKDF). Note that does NOT make
      // it independent of the WASM load in practice: this shares the FIFO
      // queue with the ensureWasm() request App.tsx fires at mount, so on a
      // cold load it still waits behind that download. Not calling it is
      // simply about not adding a dependency this branch doesn't have.
      // No legitimate caller prepares a session while one is already open —
      // App.tsx only ever opens from a locked screen, and locking closes
      // first. An attacker doing it would be re-pointing the seed-hash
      // binding below at a seed of their own (so their own vault would
      // authorize spends) while the victim's wallet stays open underneath.
      //
      // Also refuse while a *previous* prepareSession is still held but not
      // yet consumed by openHeld — heldMnemonic/pendingSeedHash are single
      // module-level variables, so a second prepareSession landing in that
      // window would silently overwrite them with its own seed. The
      // legitimate caller's already-queued openHeld would then open THAT
      // seed instead of the one the user actually unlocked with — a
      // compromised main thread (the realm this whole worker split exists
      // to distrust) could use exactly this to swap in a wallet of its own
      // choosing between a real prepareSession and its matching openHeld.
      if (currentWallet !== null || heldMnemonic !== null) throw new Error(WALLET_ALREADY_OPEN);
      const mnemonic = await resolveMnemonic(msg.source);
      setHeldMnemonic(mnemonic);
      // Bound to the *pending* session, promoted to sessionSeedHash only by
      // a successful open — so a prepare that never opens can't authorize
      // spends against whatever was open before it.
      const seedBytes = new TextEncoder().encode(mnemonic);
      try {
        pendingSeedHash = await sha256(seedBytes);
      } finally {
        zeroBytes(seedBytes);
      }

      // The BIP39 seed, computed once for both derivations below (each is a
      // 2048-round PBKDF2 on its own). null if even that failed; both are
      // best-effort and must never stand between the user and their wallet.
      let seed: Uint8Array | null = null;
      try {
        seed = await bip39Seed(mnemonic);
      } catch (e) {
        console.error("[wallet.worker] BIP39 seed derivation failed", e);
      }

      try {
        pendingChatKey?.fill(0);
        pendingChatKey = seed ? await deriveChatKeyFromSeed(seed) : null;
      } catch (e) {
        pendingChatKey = null;
        console.error("[wallet.worker] chat key derivation failed", e);
      }

      let backupKeys: BackupKeys | null = null;
      try {
        if (!seed) throw new Error("no seed");
        const keys = await deriveBackupKeysFromSeed(seed);
        backupKeys = canCloneCryptoKey(keys.encryptionKey) ? keys : null;
        if (backupKeys === null) {
          console.error("[wallet.worker] CryptoKey is not structured-cloneable here; cloud backup disabled this session");
        }
      } catch (e) {
        // Best-effort, exactly as it was when this ran on the main thread:
        // backups are a safety net, and failing to derive their keys must
        // never stop the user from reaching their wallet.
        console.error("[wallet.worker] backup key derivation failed", e);
      }
      // Both derivations imported their own copy; this one has no further use.
      seed?.fill(0);

      let rehashedVault: EncryptedVault | null = null;
      if (msg.source.kind === "vault" && vaultNeedsRehash(msg.source.vault)) {
        // Silent upgrade to the current PBKDF2 iteration count now that
        // both the password and the plaintext seed are in hand. Best-effort
        // — never blocks or fails the actual unlock. The caller is what
        // persists this, and also what re-tags the exit destination
        // afterwards (the new vault has a fresh salt, which invalidates the
        // old tag — see App.tsx).
        try {
          rehashedVault = await encryptMnemonic(mnemonic, msg.source.password);
        } catch (e) {
          console.error("[wallet.worker] vault rehash failed", e);
        }
      }

      const result: PrepareResult = { backupKeys, rehashedVault };
      return result;
    }
    case "openHeld": {
      if (heldMnemonic === null) throw new Error(NO_HELD_MNEMONIC);
      const mnemonic = heldMnemonic;
      // Re-arm the expiry backstop for the duration of this attempt: the
      // open below can legitimately run for minutes (a first-import
      // recovery scan), and the retry that follows a failure needs the seed
      // to still be here.
      setHeldMnemonic(mnemonic);
      await ensureWasm();
      // Defensive: this app only ever holds one wallet at a time, but if a
      // previous instance is somehow still around, free it before opening
      // a new one rather than leaking it. Ark wallet first — it borrowed
      // from the onchain one, so it must release that borrow first.
      if (currentWallet) {
        currentWallet.free();
        currentWallet = null;
      }
      if (currentOnchainWallet) {
        currentOnchainWallet.free();
        currentOnchainWallet = null;
      }
      // Opt-in only (see the "Použít záložní zdroj dat" checkbox on the
      // unlock screen in App.tsx) — swapping the chain source unprompted
      // would mean silently trusting a different third party with every
      // future balance/history query, not just the rare case this exists
      // for (second.tech's own esplora mirror being down alongside the Ark
      // server itself). serverAddress is left as-is either way: exiting
      // doesn't need it, and there is no fallback round coordinator to swap
      // it for even if there were.
      const config = msg.useFallbackChainSource ? { ...CONFIG, esploraAddress: FALLBACK_ESPLORA_ADDRESS } : CONFIG;
      // An exit the app believes is live (exitMayBeLive): off Second's esplora
      // from the very first request. syncExitLocks corrects it either way.
      exitChainRedirect.reset();
      exitChainRedirect.set(msg.exitChain === true);
      const onchain = await OnchainWallet.default({
        network: NETWORK,
        mnemonic,
        config,
        dbName: ONCHAIN_DB_NAME,
      });
      let wallet: Wallet;
      try {
        // openWithOnchain (not open!) borrows the onchain handle instead of
        // consuming it — Wallet.open's own doc comment warns that passing an
        // OnchainWallet there invalidates it for further use ("null pointer
        // passed to rust" on the next call), which would break the onchain
        // tab entirely.
        wallet = await Wallet.openWithOnchain(NETWORK, mnemonic, config, onchain, {
          indexedDbName: DB_NAME,
          createIfNotExists: true,
          // Off only when the refresh engine runs live (beta). Everything
          // else the daemon did is covered by the app: sync() every refresh()
          // cycle (mailbox, rounds, LN, boards), the 60s exit poll
          // (progressExits = progress_exits_with_cpfp, same as the daemon)
          // and the app's own onchain poll.
          ...(msg.runDaemon === false ? { runDaemon: false } : {}),
        });
      } catch (e) {
        // openWithOnchain failed after the onchain handle was already
        // created — without this, it would never get free()'d (it's not
        // assigned to currentOnchainWallet until both opens succeed below),
        // leaking a live WASM handle every time this failure path is hit.
        onchain.free();
        throw e;
      }
      currentWallet = wallet;
      currentOnchainWallet = onchain;
      // The WASM wallet owns the seed from here on, so drop this realm's
      // own JS copy — see heldMnemonic's comment for why it survives a
      // failed open but not a successful one.
      setHeldMnemonic(null);
      // This wallet is now the one spend authorization is checked against.
      sessionSeedHash = pendingSeedHash;
      pendingSeedHash = null;
      sessionChatKey?.fill(0);
      sessionChatKey = pendingChatKey;
      pendingChatKey = null;
      // Same wallet as before keeps its budget; a different one starts at 0.
      if (sessionSeedHash) {
        unauthorizedBudget.bindToSeed(toHex(sessionSeedHash));
        refreshSubmitBudget.bindToSeed(toHex(sessionSeedHash));
      }
      // The receive address, read here while nothing else is queued yet. As a separate call from
      // Dashboard it waited behind the post-unlock sync/maintenance work, so
      // the profile sheet and Přijmout said "no address yet" for a while
      // after every reload. Awaited, never raced against a timer: returning
      // while it still ran would let the next queued call into the WASM
      // instance alongside it. A brand-new wallet has no index 0 yet and
      // throws; Dashboard then falls back to its own newAddress() path.
      let address: string | null = null;
      try {
        address = await wallet.peekAddress(0);
      } catch {
        address = null;
      }
      // fingerprint() is a sync WASM call — read it once here instead of
      // making the client round-trip for it on every access.
      return { fingerprint: wallet.fingerprint(), address };
    }
    case "call": {
      if (!isCallTarget(msg.target)) throw new Error(METHOD_NOT_ALLOWED);
      const target = msg.target === "onchain" ? currentOnchainWallet : currentWallet;
      if (!target) throw new Error(`${WALLET_NOT_OPEN} (${msg.target}.${msg.method})`);
      // Allowlist + spend authorization FIRST — before msg.method is used to
      // index the live WASM object at all. This is the only place in the app
      // where "may this actually spend?" is decided somewhere the main
      // thread can't simply skip past, and it is also what keeps a crafted
      // message from reaching a method the app never uses. See
      // enforceSpendPolicy / walletSpendPolicy.ts.
      await enforceSpendPolicy(msg);
      if (msg.target === "wallet") msg.args = sanitizeWalletCallArgs(msg.method, msg.args);
      if (msg.target === "wallet" && msg.method === "syncExitLocks") {
        return await syncExitLocks(currentWallet!);
      }
      if (msg.target === "wallet" && msg.method === "startExitForCoins") {
        // One coin at a time: bark's start_exit_for_vtxos stops at the first
        // dust or non-standard coin and leaves the rest unstarted
        // (exit/mod.rs); startExitForEntireWallet skips those itself but
        // also takes coins that are inputs of a pending round (bark's
        // UNSPENT_STATES include Locked), which is what the caller now
        // leaves out. Locks in the same queue item, as below.
        // The worker re-plans from its own read in this same queue item and
        // starts only what that plan allows, so a coin a round or a payment
        // took since the main thread looked is left out (external audit
        // 2026-09-27, L2).
        const parsed = parseExitStartArgs(msg.args);
        if (!parsed) throw new Error("Invalid startExitForCoins arguments");
        const w = currentWallet!;
        let roundInputs: Set<string> | null;
        try {
          roundInputs = await pendingRoundInputIds(w);
        } catch (e) {
          if (!parsed.includeInRound) throw new Error(`${EXIT_ROUND_INPUTS_UNKNOWN}: ${e instanceof Error ? e.message : String(e)}`);
          roundInputs = null;
        }
        const allowed = new Set(planExitStart(await w.vtxos(), roundInputs, parsed.includeInRound).ids);
        const result: ExitStartResult = { started: [], skipped: [] };
        // Before the first exit request goes out (exitChainRedirect); only
        // once the start is really going ahead. syncExitLocks below settles
        // it from what bark actually started.
        if (parsed.ids.some((id) => allowed.has(id))) exitChainRedirect.set(true);
        for (const id of parsed.ids) {
          if (!allowed.has(id)) {
            result.skipped.push({ id, error: EXIT_COIN_NOT_ELIGIBLE });
            continue;
          }
          try {
            await currentWallet!.startExitForVtxos([id]);
            result.started.push(id);
          } catch (e) {
            result.skipped.push({ id, error: e instanceof Error ? e.message : String(e) });
          }
        }
        await syncExitLocks(currentWallet!).catch((e) => console.warn("syncExitLocks failed", e));
        return result;
      }
      if (msg.target === "wallet" && msg.method === "startExitForEntireWallet") exitChainRedirect.set(true);
      if (msg.target === "wallet" && (msg.method === "startExitForEntireWallet" || msg.method === "cancelExit")) {
        // Lock the newly exiting coins (or release a canceled one) in the
        // same queue item, so no payment or refresh queued behind this call
        // can take a coin between the two. See exitLocks.ts for why.
        const result = await (currentWallet as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[msg.method](
          ...msg.args,
        );
        await syncExitLocks(currentWallet!).catch((e) => console.warn("syncExitLocks failed", e));
        return result;
      }
      if (msg.target === "wallet" && msg.method === "refreshVtxosDelegatedAndLock") {
        // Lock (a check), submit, unlock, in this one queue item (refreshSubmit.ts).
        const [ids, holderId] = msg.args as [string[], string];
        return refreshAndRelease(currentWallet!, ids, holderId, () => refreshSubmitBudget.tryCharge(Date.now()));
      }
      const fn = (target as unknown as Record<string, unknown>)[msg.method];
      if (typeof fn !== "function") throw new Error(`Unknown wallet method: ${msg.method}`);
      const needsArbitraryDomain = msg.target === "wallet" && ARBITRARY_DOMAIN_METHODS.has(msg.method);
      const releaseArbitraryDomain = needsArbitraryDomain
        ? arbitraryDomain.allow(arbitraryDomainHostsFor(msg.method, msg.args))
        : null;
      try {
        return await (fn as (...a: unknown[]) => unknown).apply(target, msg.args);
      } finally {
        releaseArbitraryDomain?.();
      }
    }
    case "giftOpen": {
      await ensureWasm();
      // A previous claim that didn't tear down cleanly — free it rather than
      // leak the WASM handle. Ark wallet first: it borrows the onchain one.
      if (giftWallet) {
        giftWallet.free();
        giftWallet = null;
      }
      if (giftOnchainWallet) {
        giftOnchainWallet.free();
        giftOnchainWallet = null;
      }
      const onchain = await OnchainWallet.default({
        network: NETWORK,
        mnemonic: msg.mnemonic,
        config: CONFIG,
        dbName: msg.onchainDbName,
      });
      let wallet: Wallet;
      try {
        wallet = await Wallet.openWithOnchain(NETWORK, msg.mnemonic, CONFIG, onchain, {
          indexedDbName: msg.dbName,
          createIfNotExists: true,
          // No background daemon for a wallet that lives for one claim and is
          // then thrown away — the claim drives sync()/maintenance() itself.
          runDaemon: false,
        });
      } catch (e) {
        onchain.free();
        throw e;
      }
      giftWallet = wallet;
      giftOnchainWallet = onchain;
      return { fingerprint: wallet.fingerprint() };
    }
    case "giftCall": {
      if (!giftWallet) throw new Error("Gift wallet not open");
      // No SpendAuth to check — the ephemeral wallet holds nothing but the
      // single gift VTXO in transit, has no password, and its only job is to
      // forward that VTXO on. But it is still a live WASM Wallet, so the same
      // allowlist reasoning applies: a crafted giftCall could otherwise reach
      // offboardAll()/free()/etc. on it. GIFT_METHODS is the six methods the
      // claim/reclaim flow actually uses (see bark.ts).
      if (!isGiftMethodAllowed(msg.method)) throw new Error(METHOD_NOT_ALLOWED);
      const fn = (giftWallet as unknown as Record<string, unknown>)[msg.method];
      if (typeof fn !== "function") throw new Error(`Unknown gift wallet method: ${msg.method}`);
      // Never the "wallet" target, so ARBITRARY_DOMAIN_METHODS / the network
      // allowlist exception counter don't apply either (a gift claim only
      // ever talks to the same Ark + esplora hosts the allowlist already
      // permits).
      return await (fn as (...a: unknown[]) => unknown).apply(giftWallet, msg.args);
    }
    case "giftClose": {
      if (giftWallet) {
        giftWallet.free();
        giftWallet = null;
      }
      if (giftOnchainWallet) {
        giftOnchainWallet.free();
        giftOnchainWallet = null;
      }
      return undefined;
    }
    case "chatKey":
      return sendChatKey(msg.port);
    case "close": {
      // Covers the case where prepareSession succeeded but the open that
      // would have consumed it never did (a failed open, then a lock or a
      // navigation away) — otherwise the seed would sit in this realm until
      // the worker itself went away.
      setHeldMnemonic(null);
      exitChainRedirect.reset();
      // Spend authorization is per open wallet — a closed session must not
      // leave a binding behind that a later call could authorize against.
      sessionSeedHash = null;
      pendingSeedHash = null;
      dropChatKeys();
      // Same order as above: release the borrower before the lender.
      if (currentWallet) {
        currentWallet.free();
        currentWallet = null;
      }
      if (currentOnchainWallet) {
        currentOnchainWallet.free();
        currentOnchainWallet = null;
      }
      return undefined;
    }
  }
}

// Exported rather than assigned straight to self.onmessage: wallet.worker.ts
// (the bootstrap) needs to buffer any messages that arrive before this
// module has finished loading via dynamic import, then replay them through
// this same handler in order — see wallet.worker.ts for why that race is
// real.
// A copy, transferred: the port's other end is the chat worker.
function sendChatKey(port: MessagePort): true {
  if (currentWallet === null || sessionChatKey === null) throw new Error(WALLET_NOT_OPEN);
  const copy = sessionChatKey.slice();
  port.postMessage(copy, [copy.buffer]);
  port.close();
  return true;
}

export function handleMessage(msg: Request) {
  // The chat key is answered at once, not behind the queue: it touches no
  // wallet and no WASM, only the session's key (set and dropped by queued
  // open/close), and right after an unlock the queue can be busy syncing for
  // seconds while Zprávy waits to show its conversations. Same started/result
  // replies as a queued request, so the client's watchdog sees no difference.
  if (msg.type === "chatKey") {
    self.postMessage({ id: msg.id, started: true } satisfies StartedNotice);
    try {
      self.postMessage({ id: msg.id, ok: true, result: sendChatKey(msg.port) } satisfies Response);
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
    }
    return;
  }
  queue = queue.then(async () => {
    // Before any await inside runRequest: this is the transition from
    // "queued" to "running", and the client rearms its watchdog on it.
    const started: StartedNotice = { id: msg.id, started: true };
    self.postMessage(started);
    try {
      const result = await runRequest(msg);
      const response: Response = { id: msg.id, ok: true, result };
      self.postMessage(response);
    } catch (err) {
      const response: Response = {
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  });
}
