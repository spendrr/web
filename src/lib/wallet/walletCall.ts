// Some wallet.* calls talk to the Ark server over a connection that can, on
// some browser/network combinations, neither resolve nor reject — leaving
// the UI stuck (e.g. "Generuji adresu…") forever with no feedback. This
// races the call against a timeout so the user always ends up with either a
// result or a retryable error instead of silence.
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeTimeoutError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// wallet.worker.ts runs every wallet.* call through one strict FIFO queue
// (see its own comment) — this timer starts the moment the call is made, not
// when the worker actually starts processing it, so a call merely waiting
// behind another one already in the queue eats into its own budget before
// doing any real work. Two recurring background cycles compete for that same
// queue for as long as the app is open: Dashboard's Ark receive-watch
// refresh() (sync/balance/history/maintenance, every ~4s, permanently
// running once a receive address exists — not just during an active
// receive) and its onchain-balance poll (every 30s). The onchain poll's own
// sync() is *allowed* to run long — ONCHAIN_SYNC_TIMEOUT_MS below is 20
// minutes, because it scans every locally revealed address and that list
// only grows — so any time it genuinely takes more than this constant, every
// refresh() call queued behind it (and there can be several, given the 4s
// cadence) trips this timeout purely from queueing, with nothing actually
// wrong: reported to the user as "Počkej chvíli…" and, if it kept
// recurring, eventually "Nejsi online." despite a fine connection. This was
// 20s, then 35s (to also cover Dashboard's mount-time receive-address load,
// up to 30s on its own) — both still routinely lost that race. Matched to
// WORKER_REQUEST_TIMEOUT_MS (bark.ts) instead: the UI has no business
// calling a call "stuck" before the point the worker's own crash-recovery
// watchdog would even start to agree with it.
export const WALLET_CALL_TIMEOUT_MS = 60_000;
export const TIMEOUT_MESSAGE = "Počkej chvíli…";

// A timeout is NOT a failure — withTimeout only stops *waiting*, it has no
// way to cancel anything, so the call carries on running in the worker and
// may still succeed. For a read that distinction doesn't matter (retrying a
// balance() twice costs nothing), but for a payment it decides whether the
// UI may invite a retry: a send reported as failed leaves the user tapping
// Odeslat again on a still-filled form, and for a Lightning address / LNURL
// that fetches a *fresh* invoice, so the retry is a second real payment on
// top of a first one that may well settle. Tagged via `name` rather than by
// matching the message, which is translated and reused by every caller.
const TIMEOUT_ERROR_NAME = "WalletCallTimeout";

function makeTimeoutError(message: string): Error {
  const err = new Error(message);
  err.name = TIMEOUT_ERROR_NAME;
  return err;
}

// True only for a rejection withTimeout produced itself. A rejection that
// came *from* the call (the SDK refusing an address, insufficient funds, a
// worker-side policy refusal) is a real, settled failure and must keep its
// current handling — the point here is exclusively "we stopped waiting and
// don't know the outcome".
export function isWalletCallTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === TIMEOUT_ERROR_NAME;
}

// onchainWallet.sync() checks every locally revealed address every time
// (start_sync_with_revealed_spks_at in the bark SDK) — normally fast since a
// wallet reveals addresses one at a time through ordinary use, but the
// number of revealed addresses only ever grows, never shrinks, over a
// wallet's lifetime, so this is a generous ceiling rather than the expected
// case. See resetOnchainWalletDb() in bark.ts for the one-time repair this
// app already ran for a wallet whose local revealed-address count had grown
// unusually large from a since-removed support diagnostic.
export const ONCHAIN_SYNC_TIMEOUT_MS = 20 * 60_000;

// Every call that actually moves funds (a send in any of its five flavors,
// boardAll(), and the exit-claim drain/sign/broadcast trio) used to run with
// none of the protection above at all — no withTimeout, and critically no
// pushWorkerWatchdogOverride (bark.ts). bark.ts's own crash-recovery
// watchdog defaults to 25s per request: a Lightning payment sent with
// `wait: true` genuinely waits for the payment to settle (routing retries
// across the network can easily take longer than that on a slow path), and
// boardAll()/an Ark send can likewise mean waiting on round participation.
// Without an override in place, a call that was never actually stuck — just
// legitimately slow — tripped the watchdog exactly like a truly hung one
// would: it terminated the worker mid-payment, rejected the in-flight call,
// and forced the whole app back to the unlock screen, independent of the
// auto-lock setting and while the user was actively watching it happen (see
// onCriticalOpChange in Dashboard.tsx, which only defers the *inactivity*
// timer — it does nothing for this separate, worker-crash-recovery path).
// This is deliberately much shorter than ONCHAIN_SYNC_TIMEOUT_MS above
// (that one has to tolerate a legitimately unbounded local address scan) —
// a real payment or board that's still not done after this long really is
// worth recovering from, just not after only 25s.
export const SEND_WATCHDOG_MS = 3 * 60_000;
