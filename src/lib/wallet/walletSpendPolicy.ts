// Pure spend-authorization policy for the wallet worker. No @secondts/bark
// import, so it can be unit-tested directly — walletWorkerImpl.ts cannot, it
// pulls the ~7.7MB WASM SDK in at module load. walletWorkerImpl.ts's
// enforceSpendPolicy is a thin wrapper that turns a verdict from here into
// requireSpendAuth() calls plus the rolling unauthorized-spend bookkeeping.
//
// SECURITY — this is an ALLOWLIST, deliberately.
//
// The worker treats the main thread as hostile (React, jsqr and the whole
// npm tree share that realm, and `Worker.prototype.postMessage` is reachable
// from any of it). A crafted `{type:"call", target, method, args}` message
// can name ANY method on the live WASM Wallet / OnchainWallet instance —
// wasm-bindgen exposes the full ~120-method surface, including several the
// app itself never calls that each move funds to a caller-chosen address in
// one step and self-broadcast:
//
//   - Wallet.offboardAll(bitcoinAddress)         — whole Ark balance out
//   - Wallet.offboardVtxos(vtxoIds, address)     — selected VTXOs out
//   - OnchainWallet.send(address, sats, feeRate) — whole onchain balance out
//   - Wallet.free() / OnchainWallet.free()       — poisons the WASM instance
//
// The previous gate was shaped as a deny-list (an early `return` for any
// non-"wallet" target, and a `switch` over six method names that treated
// everything else as "not a spend"), so all of the above sailed straight
// through with no password, no confirm screen and no cap. An allowlist
// inverts that: a method that isn't classified here is refused.
//
// When you add a wallet call to bark.ts's WalletClient / OnchainWalletClient
// interface, add it to the matching set below. tests/walletSpendPolicy.fuzz
// enumerates those interfaces and fails if one is left unclassified.

import { PASSWORD_REQUIRED_THRESHOLD_SATS } from "./walletSession";
import { decodeBolt11Amount } from "../send/destination";

// --- wallet target -----------------------------------------------------

// Reads, receive-side actions, fee estimates, round/exit bookkeeping — no
// funds leave the wallet, so no authorization is required. syncExitLocks is a
// worker-side call (not an SDK method) that only locks coins bark itself says
// are exiting and releases the ones whose exit is over (exitLocks.ts).
export const WALLET_READ_METHODS: ReadonlySet<string> = new Set([
  "balance",
  "sync",
  "maintenance",
  "maintenanceDelegated",
  "history",
  "allVtxos",
  "vtxos",
  "peekAddress",
  "newAddress",
  "bolt11Invoice",
  "cancelLightningReceive",
  "validateArkoorAddress",
  "estimateArkoorPaymentFee",
  "estimateSendOnchainFee",
  "estimateLightningSendFee",
  "estimateBoardFee",
  "estimateRefreshFee",
  "pendingRoundStates",
  "pendingRoundInputVtxos",
  "progressPendingRounds",
  "cancelPendingRound",
  "cancelAllPendingRounds",
  "nextRoundStartTime",
  "arkInfo",
  "progressExits",
  "getExitVtxos",
  "listClaimableExits",
  "hasPendingExits",
  "pendingExitsTotalSats",
  "estimateEmergencyExitFee",
  "syncExitLocks",
  "mailboxIdentifier",
  "mailboxAuthorization",
  "getFirstExpiringVtxoBlockheight",
  "refreshServer",
]);

// Move the user's OWN funds only — board on-chain coins into the Ark
// balance, or refresh a VTXO through a round. The destination is always the
// user's own wallet, so this is not a theft route and is left frictionless,
// matching the pre-existing explicit choice for boardAll(). Griefing (an
// attacker burning fees on pointless boards/refreshes) stays possible and is
// accepted in exchange for keeping the board/refresh dialogs password-free.
export const WALLET_OWN_FUNDS_METHODS: ReadonlySet<string> = new Set([
  "boardAll",
  "boardAmount",
  "refreshVtxosDelegated",
]);

// VTXO locks, allowed only under the refresh engine's own holder ids
// (src/lib/refreshEngine/engine.ts, ENGINE.HOLDER_*). An unrestricted
// unlockVtxos could release a lock an in-flight Lightning send or round holds
// (the SDK's own guard is only the expected holder, which the caller picks),
// so the worker checks the holder itself.
export const WALLET_LOCK_METHODS: ReadonlySet<string> = new Set(["lockVtxos", "unlockVtxos"]);
export const ENGINE_LOCK_HOLDER_IDS: ReadonlySet<string> = new Set([
  "spendrr-refresh",
  "spendrr-refresh-quarantine",
]);

// refreshVtxosDelegatedAndLock(ids, holderId): a refresh (own funds) checked
// by a lock under the engine's refresh holder, nothing else.
export function isEngineRefreshAndLockCall(args: unknown[]): boolean {
  const [ids, holder] = args;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") && holder === "spendrr-refresh";
}

export function isEngineLockCall(method: string, args: unknown[]): boolean {
  const a = args[0] as { vtxoIds?: unknown; holder?: unknown; expectedHolder?: unknown } | undefined;
  if (!a || !Array.isArray(a.vtxoIds) || !a.vtxoIds.every((id) => typeof id === "string")) return false;
  const holder = (method === "lockVtxos" ? a.holder : a.expectedHolder) as { type?: unknown; id?: unknown } | undefined;
  return holder?.type === "action" && typeof holder.id === "string" && ENGINE_LOCK_HOLDER_IDS.has(holder.id);
}

// Send money out to a third party. Gated on the effective amount against
// PASSWORD_REQUIRED_THRESHOLD_SATS; below the threshold the rolling
// unauthorized-spend cap in walletWorkerImpl.ts applies instead.
export const WALLET_SEND_METHODS: ReadonlySet<string> = new Set([
  "sendArkoorPayment",
  "sendOnchain",
  "payLightningInvoice",
  "payLightningAddress",
  "payLightningOffer",
  "payLnurl",
]);

// Always require a SpendAuth, whatever the arguments say:
//   - broadcastTx: puts arbitrary signed bytes on the wire.
//   - drainExits: returns a FULLY SIGNED exit-claim PSBT paying the caller's
//     address. It was on the read list as "only builds an unsigned PSBT";
//     bark's Exit::drain_exits signs it itself (exit/mod.rs, create_psbt ->
//     sign_exit_claim_inputs), so a crafted message could get a spendable
//     claim of every claimable exit to its own address, extract it and
//     broadcast it anywhere, no broadcastTx needed (audit 2026-09-27). The fee
//     preview uses estimateEmergencyExitFee's claimFeeSats instead.
//   - signExitClaimInputs: produces a fully-signed exit-claim tx paying the
//     address baked into the PSBT.
//   - startExitForEntireWallet: moves the entire balance on-chain.
//   - cancelExit: moves no money itself, but a crafted message repeating it
//     before each coin's last exit transaction goes out keeps an exit from
//     ever finishing, until the coins expire and the server sweeps what is
//     already on-chain (external audit 2026-09-27, H2).
//   - startExitForCoins: the same for chosen coins (worker-side, see
//     walletWorkerImpl.ts); what the app uses since 2026-09-27.
// None carries a readable amount, so there is nothing to threshold — the
// answer is unconditionally "ask for the password".
export const WALLET_ALWAYS_AUTH_METHODS: ReadonlySet<string> = new Set([
  "broadcastTx",
  "drainExits",
  "signExitClaimInputs",
  "startExitForEntireWallet",
  "startExitForCoins",
  "cancelExit",
]);

// --- onchain target --------------------------------------------------------

// The onchain sub-wallet is read-only from the app's side — boarding is done
// through the Ark wallet's board* methods, never OnchainWallet.send(). Every
// method the app calls on it is a pure read; OnchainWallet.send() is
// deliberately absent so a crafted message asking for it is refused.
export const ONCHAIN_READ_METHODS: ReadonlySet<string> = new Set([
  "balance",
  "sync",
  "newAddress",
  "initialScan",
  "transactions",
  "tipHeight",
  "utxos",
  // Cached fee-rate estimates (board fee preview, boardFee.ts).
  "feeRates",
]);

// --- gift-link ephemeral wallet ------------------------------------------

// The throwaway wallet behind "send bitcoin as a link" only ever pulls the
// single in-transit gift VTXO from its mailbox and forwards it on. It has no
// password to authorize against, so sendArkoorPayment is unavoidably
// unauthenticated here — but the stake is one re-derivable gift VTXO, and
// the allowlist still keeps offboardAll()/free()/every other method off that
// surface too.
export const GIFT_METHODS: ReadonlySet<string> = new Set([
  "newAddress",
  "sync",
  "maintenance",
  "balance",
  "sendArkoorPayment",
  // Read-only: the report of the recovery scan the open ran (giftScan.ts).
  "recoveryStatus",
]);

// --- classification ------------------------------------------------------

export type CallVerdict =
  | { kind: "allow" } // read / own-funds move — run it, no auth
  | { kind: "needs-auth" } // require a SpendAuth unconditionally
  | { kind: "capped"; amountSats: number } // sub-threshold send — apply the rolling cap
  | { kind: "denied" }; // not on the allowlist — refuse

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// How many sats a send call moves, read out of its own arguments, or null
// when the arguments don't say. A null is treated by the caller as "over the
// threshold", never as zero — an amount we can't read is exactly the case
// where guessing low is the expensive mistake.
export function sendAmountSats(method: string, args: unknown[]): number | null {
  const first = args[0] as { amountSats?: unknown; invoice?: unknown } | undefined;
  switch (method) {
    case "sendOnchain":
    case "sendArkoorPayment":
      return positiveNumber(args[1]);
    case "payLightningAddress":
    case "payLnurl":
    case "payLightningOffer":
      return positiveNumber(first?.amountSats);
    case "payLightningInvoice": {
      // The invoice carries its own amount and the amountSats argument is
      // then normally absent — decode it here rather than trusting the main
      // thread to have done so, since the whole point of this gate is that
      // the main thread's reasoning about a send can't be relied on.
      //
      // Take the LARGER of the two rather than preferring the explicit
      // argument. An amount-bearing invoice paired with a smaller explicit
      // amountSats (a stale/mismatched typed amount alongside a scanned
      // invoice, from the main thread this gate doesn't trust) used to
      // price the send at the smaller number — pricing it as "capped" and
      // skipping the password even though the invoice itself demands the
      // larger amount. Whatever bark actually pays is never less than the
      // invoice's own amount, so max() is the safe reading either way: if
      // bark honors the explicit override, this only ever asks for a
      // password it didn't strictly need to; it never lets a real large
      // payment through uncapped.
      const explicit = positiveNumber(first?.amountSats);
      const decoded = typeof first?.invoice === "string" ? decodeBolt11Amount(first.invoice) : null;
      if (explicit === null) return decoded;
      if (decoded === null) return explicit;
      return Math.max(explicit, decoded);
    }
    default:
      return null;
  }
}

// Arguments the worker replaces before a call, whatever the caller sent.
// progressExits({feeRateSatPerVb}) is a read (it only moves exits bark
// already has), but bark uses that rate for every CPFP it builds and RBFs a
// pending one when the new rate is higher (exit/bdk.rs,
// progress_exits_with_cpfp / should_rbf). A crafted message repeating it with
// ever higher rates would burn the confirmed on-chain balance on fees, no
// password asked (external audit 2026-09-27, H1). The app never passes a
// rate, so bark's own default (the chain source's "fast" rate) is all it
// gets.
//
// mailboxAuthorization(expirySecs): the authorization lets whoever holds it
// read the mailbox until it expires and can't be revoked, so the lifetime is
// capped here; anything that isn't a positive number gets the cap.
//
// drainExits({vtxoIds, drainAll, ...}): drainAll claims every exit, the app
// only ever names the coins. It needs the password anyway; dropping the flag
// keeps an empty list an error rather than a sweep.
// The longest the app signs: a name proof (names/names.ts).
export const MAILBOX_AUTH_MAX_SECS = 31 * 24 * 60 * 60;

export function sanitizeWalletCallArgs(method: string, args: unknown[]): unknown[] {
  if (method === "progressExits") return [{}];
  if (method === "mailboxAuthorization") {
    const [secs] = args;
    const ok = typeof secs === "number" && Number.isFinite(secs) && secs >= 1;
    return [ok ? Math.min(Math.floor(secs), MAILBOX_AUTH_MAX_SECS) : MAILBOX_AUTH_MAX_SECS];
  }
  if (method === "drainExits" && typeof args[0] === "object" && args[0] !== null) {
    const { drainAll: _all, ...rest } = args[0] as Record<string, unknown>;
    void _all;
    return [rest, ...args.slice(1)];
  }
  return args;
}

export function classifyWalletCall(method: string, args: unknown[]): CallVerdict {
  if (WALLET_ALWAYS_AUTH_METHODS.has(method)) return { kind: "needs-auth" };
  if (WALLET_SEND_METHODS.has(method)) {
    const amount = sendAmountSats(method, args);
    if (amount === null || amount >= PASSWORD_REQUIRED_THRESHOLD_SATS) return { kind: "needs-auth" };
    return { kind: "capped", amountSats: amount };
  }
  if (WALLET_OWN_FUNDS_METHODS.has(method)) return { kind: "allow" };
  if (WALLET_READ_METHODS.has(method)) return { kind: "allow" };
  if (WALLET_LOCK_METHODS.has(method)) return isEngineLockCall(method, args) ? { kind: "allow" } : { kind: "denied" };
  if (method === "refreshVtxosDelegatedAndLock") return isEngineRefreshAndLockCall(args) ? { kind: "allow" } : { kind: "denied" };
  return { kind: "denied" };
}

export function classifyOnchainCall(method: string): CallVerdict {
  return ONCHAIN_READ_METHODS.has(method) ? { kind: "allow" } : { kind: "denied" };
}

export function isGiftMethodAllowed(method: string): boolean {
  return GIFT_METHODS.has(method);
}

// --- rolling cap on refresh submissions -----------------------------------

// Backstop for REFRESH_LIMIT_EXCEEDED (walletSession.ts): at most `max`
// refreshVtxosDelegated() calls in any rolling `windowMs`, charged before the
// call. Bound to the seed like the spend budget; resets only when the worker
// itself goes away, so the engine's persisted breaker is the primary limit and
// this one covers a lost or rewritten localStorage within a session.
export interface RefreshSubmitBudget {
  bindToSeed(seedKey: string): void;
  tryCharge(now: number): boolean;
}

export function createRefreshSubmitBudget(max: number, windowMs: number): RefreshSubmitBudget {
  let seed: string | null = null;
  let times: number[] = [];
  return {
    bindToSeed(seedKey) {
      if (seedKey === seed) return;
      seed = seedKey;
      times = [];
    },
    tryCharge(now) {
      times = times.filter((t) => now - t < windowMs && t <= now);
      if (times.length >= max) return false;
      times.push(now);
      return true;
    },
  };
}

// --- rolling budget for sends without a SpendAuth ------------------------

// The bookkeeping behind UNAUTHORIZED_SPEND_CAP_SATS, pure so it can be
// tested (walletWorkerImpl.ts owns the one instance).
//
// Charged BEFORE the SDK call, never refunded. It used to be charged only
// after the call resolved, so a send that threw but still moved money (a
// Lightning HTLC that settles after the SDK gave up, a worker killed by the
// watchdog mid-call) cost nothing, and repeating it moved an unbounded
// amount. Refunding failures was meant to stop an attacker locking the user
// out of small payments, but an attacker who can post messages can do that
// anyway by spending the budget to themselves.
//
// Kept across lock/unlock of the SAME wallet (bindToSeed with the same key is
// a no-op). It used to reset on every open, which made the cap per unlock
// rather than per day: an attacker only had to post `close` and wait for the
// next unlock. Opening a different wallet starts from zero. What still resets
// it is the worker itself going away (a reload, the watchdog), since the
// worker has nowhere to keep it that the main thread could not rewrite.
export interface UnauthorizedSpendBudget {
  bindToSeed(seedKey: string): void;
  tryReserve(amountSats: number, now: number): boolean;
}

export function createUnauthorizedSpendBudget(capSats: number, windowMs: number): UnauthorizedSpendBudget {
  let seed: string | null = null;
  let spent = 0;
  let windowStartedAt = 0;
  return {
    bindToSeed(seedKey) {
      if (seedKey === seed) return;
      seed = seedKey;
      spent = 0;
      windowStartedAt = 0;
    },
    tryReserve(amountSats, now) {
      if (now - windowStartedAt > windowMs) {
        windowStartedAt = now;
        spent = 0;
      }
      if (spent + amountSats > capSats) return false;
      spent += amountSats;
      return true;
    },
  };
}
