// Client for wallet.worker.ts, which owns the real WASM Wallet instance off
// the main thread. What opening resolves to is not a real `Wallet` (its
// WASM-bound class type can't cross a worker boundary) but a `WalletClient`
// — a Proxy that forwards every method call to the worker and awaits its
// response, so `wallet.balance()`, `wallet.sync()`, etc. read exactly like
// they did when the Wallet lived on the main thread directly.
//
// Opening is a two-step prepareSession() -> openHeldWallet() sequence (see
// those functions, and PrepareSource in walletSession.ts). It replaced a
// single openWallet(mnemonic) call, because the mnemonic no longer exists
// on this side of the boundary at all on the unlock path: the *password*
// goes into the worker and the seed never comes back out.
import { isStaleBuild, reloadOnceForNewBuild } from "../connectivity/staleBuild";
import type {
  ArkInfo,
  Balance,
  Bolt11InvoiceArgs,
  DrainExitsArgs,
  EmergencyExitFeeEstimate,
  ExitCancelResult,
  ExitClaimTransaction,
  ExitProgressStatus,
  ExitVtxo,
  FeeEstimate,
  FeeRates,
  LightningInvoice,
  LightningSendStatus,
  Movement,
  OnchainBalance,
  OnchainUtxo,
  PayLightningAddressArgs,
  PayLightningInvoiceArgs,
  PayLightningOfferArgs,
  PayLnurlArgs,
  PendingBoard,
  ProgressExitsArgs,
  RoundState,
  Vtxo,
  WalletTransaction,
  LockVtxosArgs,
  UnlockVtxosArgs,
} from "@secondts/bark";
import type { PrepareResult, PrepareSource, RefreshAndLockResult, SpendAuth } from "./walletSession";
import { WALLET_LOCKED_MESSAGE } from "./walletSession";
import type { ExitLockSync, ExitStartResult } from "../exit/exitLocks";
import { createDelegatedMaintenanceScheduler, createSettleMaintenance } from "../maintenance/delegatedMaintenance";
import { watchdogDelayFor } from "./workerWatchdog";
import { canTerminateOnLock } from "./lockDrain";
import { classifyGiftScan, type GiftScan } from "../gift/giftScanReport";
import { recordProgressKilled } from "../exit/exitProgressGuard";
import {
  confirmWatchdogKill,
  isOffline,
  onConnectivityChange,
  setWorkerNetProbe,
  watchdogPaused,
  watchdogShouldConsultProbe,
} from "../connectivity/connectivity";
import type { NetProbeReply, NetProbeRequest } from "../connectivity/netProbeWorker";
import { WALLET_OPEN_ELSEWHERE, walletTabLock } from "./walletTabLock";
import { beginSessionEngineMode } from "../refreshEngine/mode";

export interface OnchainWalletClient {
  balance(): Promise<OnchainBalance>;
  // Refreshes the onchain sub-wallet's view of the chain (new deposits,
  // confirmations). Separate from Wallet.sync() below, which only covers
  // the Ark side — balance() alone reads whatever was last synced, so
  // without calling this first a payment can sit confirmed on-chain while
  // the UI still reports it pending indefinitely.
  sync(): Promise<number>;
  newAddress(): Promise<string>;
  initialScan(birthdayHeight?: number | null): Promise<number>;
  // Per-tx confirmation detail — used as a diagnostic (Settings → Onchain
  // transakce) when the aggregate OnchainBalance.pendingSats disagrees with
  // what a block explorer shows for the same deposit.
  transactions(): Promise<WalletTransaction[]>;
  // Current chain tip height from the onchain sub-wallet's own chain source
  // — paired with a WalletTransaction's `confirmation.height` to show a
  // confirmation count (Settings → Onchain transakce) instead of just the
  // raw block height.
  tipHeight(): Promise<number>;
  // Per-UTXO breakdown — used by the stable-receive-address logic
  // (onchainReceiveAddress.ts) to detect whether the handed-out address has
  // actually been paid to yet, since balance() alone only gives one
  // aggregate total with no way to tell which specific deposit matched.
  utxos(): Promise<OnchainUtxo[]>;
  // Cached fee-rate estimates from the chain source (board fee preview).
  feeRates(): Promise<FeeRates>;
}

export interface WalletClient {
  readonly fingerprint: string;
  // The Ark receive address (peekAddress(0)) read by the worker as part of
  // the open, or null (a brand-new wallet with no index 0 yet).
  readonly openedAddress: string | null;
  readonly onchainWallet: OnchainWalletClient;
  // Returns a view of this same client whose calls carry a spend
  // authorization. The worker refuses money-moving calls without one above
  // PASSWORD_REQUIRED_THRESHOLD_SATS (and refuses broadcastTx /
  // startExitForEntireWallet outright), because every gate that used to
  // stand in front of those lived on the main thread, where a compromised
  // dependency can post straight to the worker and skip all of it. See
  // SpendAuth in walletSession.ts.
  //
  // Deliberately an explicit per-call decoration rather than a mode the
  // client is left in: an ambient "authorized" state is exactly the kind of
  // thing that outlives the payment it was meant for.
  withAuth(auth: SpendAuth): WalletClient;
  balance(): Promise<Balance>;
  sync(): Promise<void>;
  maintenance(): Promise<void>;
  // The non-blocking analog of maintenance() — same housekeeping (boards,
  // arkoors, exits, pending lightning payments) but any needed VTXO refresh
  // is scheduled (delegated) rather than waited for interactively, so it
  // can't get stuck in the round-event-stream wait documented on
  // maintenanceWithDeadline() below. A scheduled refresh is claimed
  // automatically the next time sync() runs (bark's sync_pending_rounds()),
  // which refresh() already calls unconditionally every cycle — no separate
  // "claim" call exists.
  maintenanceDelegated(): Promise<void>;
  history(): Promise<Movement[]>;
  allVtxos(): Promise<Vtxo[]>;
  // Spendable and locked coins only (bark reads just those two state ranges;
  // allVtxos() parses every record ever stored, spent ones included, and costs
  // seconds on a wallet with history). For readers that show or report live coins.
  vtxos(): Promise<Vtxo[]>;
  peekAddress(index: number): Promise<string>;
  newAddress(): Promise<string>;
  bolt11Invoice(args: Bolt11InvoiceArgs): Promise<LightningInvoice>;
  cancelLightningReceive(paymentHash: string): Promise<void>;
  payLightningInvoice(args: PayLightningInvoiceArgs): Promise<LightningSendStatus>;
  payLightningAddress(args: PayLightningAddressArgs): Promise<LightningSendStatus>;
  payLightningOffer(args: PayLightningOfferArgs): Promise<LightningSendStatus>;
  payLnurl(args: PayLnurlArgs): Promise<LightningSendStatus>;
  validateArkoorAddress(address: string): Promise<boolean>;
  sendArkoorPayment(arkAddress: string, amountSats: number): Promise<void>;
  sendOnchain(address: string, amountSats: number): Promise<string>;
  estimateArkoorPaymentFee(amountSats: number): Promise<FeeEstimate>;
  estimateSendOnchainFee(address: string, amountSats: number): Promise<FeeEstimate>;
  estimateLightningSendFee(amountSats: number): Promise<FeeEstimate>;
  estimateBoardFee(amountSats: number): Promise<FeeEstimate>;
  boardAll(): Promise<PendingBoard>;
  boardAmount(amountSats: number): Promise<PendingBoard>;
  estimateRefreshFee(vtxoIds: string[]): Promise<FeeEstimate>;
  // The non-blocking variant of refreshVtxos — registers the given VTXOs for
  // the next round and returns once that registration lands, not once the
  // round itself completes (rounds run on a fixed hourly interval on
  // ark.second.tech, confirmed live via arkInfo().roundIntervalSecs, so
  // waiting for actual completion here would mean a wallet.* call blocked
  // for up to ~an hour — the same failure mode WALLET_CALL_TIMEOUT_MS exists
  // to catch elsewhere). Progress is tracked separately via
  // pendingRoundStates()/progressPendingRounds() below.
  refreshVtxosDelegated(vtxoIds: string[]): Promise<RoundState | undefined>;
  pendingRoundStates(): Promise<RoundState[]>;
  // The actual input VTXOs of every pending round participation
  // (bark's locked_pending_inputs(), so delegated participations are
  // included even though they never lock their inputs). Dashboard uses it to
  // say exactly how much is in a refresh and whether the headline balance
  // already counts it — see refreshingBalance.ts.
  pendingRoundInputVtxos(): Promise<Vtxo[]>;
  progressPendingRounds(): Promise<void>;
  cancelPendingRound(roundId: number): Promise<void>;
  cancelAllPendingRounds(): Promise<void>;
  nextRoundStartTime(): Promise<number>;
  arkInfo(): Promise<ArkInfo | undefined>;
  startExitForEntireWallet(): Promise<void>;
  progressExits(args: ProgressExitsArgs): Promise<ExitProgressStatus[]>;
  getExitVtxos(): Promise<ExitVtxo[]>;
  listClaimableExits(): Promise<ExitVtxo[]>;
  hasPendingExits(): Promise<boolean>;
  pendingExitsTotalSats(): Promise<number>;
  cancelExit(vtxoId: string): Promise<ExitCancelResult>;
  // Returns an already SIGNED claim PSBT (bark signs inside drain_exits), so
  // the worker only runs it with a SpendAuth. An empty vtxoIds means "every
  // claimable exit" in the wrapper; exitActions.ts never passes one.
  drainExits(args: DrainExitsArgs): Promise<ExitClaimTransaction>;
  // Syncs the onchain wallet first, so it can take a while. An empty
  // vtxoIds prices every Spendable VTXO (the whole wallet before an exit);
  // fails as a whole on any non-standard one.
  estimateEmergencyExitFee(
    vtxoIds: string[],
    feeRateSatPerVb?: number | null,
    destination?: string | null,
  ): Promise<EmergencyExitFeeEstimate>;
  // Worker-side (walletWorkerImpl.ts), not an SDK method: locks the coins bark
  // says are exiting but still Spendable, releases the ones whose exit ended
  // (exitLocks.ts), and returns the exiting coins' expiry heights. Also run
  // by the worker itself right after startExitForEntireWallet and cancelExit.
  syncExitLocks(): Promise<ExitLockSync>;
  // Worker-side: starts an exit for each coin separately (so one dust or
  // non-standard coin can't stop the rest) and locks them in the same queue
  // item. Needs a SpendAuth.
  startExitForCoins(vtxoIds: string[], includeInRound: boolean): Promise<ExitStartResult>;
  signExitClaimInputs(psbtBase64: string): Promise<string>;
  broadcastTx(txHex: string): Promise<string>;
  // Public mailbox identifier and a 24h-expiring signed read authorization —
  // explicitly documented in the SDK as safe to hand to a third party to
  // *read* (not spend from) this wallet's Ark mailbox. Used by the push
  // notification setup to let our own Worker poll for incoming payments
  // without ever touching the mnemonic. See ARCHITECTURE.md's push section.
  mailboxIdentifier(): Promise<string>;
  // Valid for expirySecs from now; it can't be revoked. The worker caps it
  // (walletSpendPolicy.ts, MAILBOX_AUTH_MAX_SECS).
  mailboxAuthorization(expirySecs: number): Promise<string>;
  // Blockheight of the soonest-expiring VTXO in the wallet, or undefined if
  // there are none. Used to report an expiry watch point to the push backend
  // (src/lib/notifications.ts) — the server nudges the user to reopen the app
  // before that VTXO's refresh window (see ARCHITECTURE.md's push section) closes.
  getFirstExpiringVtxoBlockheight(): Promise<number | undefined>;
  // Refresh engine (src/lib/refreshEngine): re-reads the server's ArkInfo
  // (limits, fee table) the way the SDK daemon did at start. The worker only
  // lets locks through under the engine's own holder ids
  // (walletSpendPolicy.ts, isEngineLockCall).
  refreshServer(): Promise<void>;
  // lockVtxos() on the inputs, refreshVtxosDelegated(), unlockVtxos(), as ONE
  // worker queue item. The lock is only a check: a coin a payment already
  // took is never submitted at all (REFRESH_INPUTS_UNAVAILABLE, no key index
  // burned). It is gone once this returns; bark locks the inputs itself when
  // the server issues the round. Worker-side only (walletWorkerImpl.ts), not
  // an SDK method.
  refreshVtxosDelegatedAndLock(vtxoIds: string[], holderId: string): Promise<RefreshAndLockResult>;
  lockVtxos(args: LockVtxosArgs): Promise<void>;
  unlockVtxos(args: UnlockVtxosArgs): Promise<void>;
}

// wallet.worker.ts serializes every request into one FIFO queue on its side
// (see that file's own comment) — which means a single wallet.* call that
// never resolves or rejects (a documented, real failure mode of some
// browser/network combinations) doesn't just hang its own caller, it wedges
// every *subsequent* request behind it forever, with nothing here ever
// noticing. This module used to have no timeout of its own at all — only
// Dashboard.tsx's UI-level withTimeout, which races its own promise but
// can't cancel or unstick the underlying worker request. This watchdog is
// what actually recovers: once a single request has been outstanding too
// long, assume the worker (or its queue) is stuck, terminate it, reject
// everything still pending, and let the next getWorker() call spin up a
// fresh one — while telling the app (via the onWorkerLost callback) that
// the in-memory wallet is gone and the user needs to unlock again, since
// the mnemonic only ever lived inside the now-terminated worker.
//
// Started at 25s. In practice that turned out too tight for plenty of
// perfectly healthy calls — not just the handful with their own explicit
// pushWorkerWatchdogOverride (sync/maintenance, sends, boardAll, exit
// claims, some Settings screens) but seemingly any wallet.*/onchainWallet.*
// call on a slow connection or under real load, which kept showing up as
// "the app locked itself for no reason" reports with nothing actually stuck.
// Chasing every individual slow call site with its own override was a
// losing game — this raises the *baseline* instead, so a call nobody has
// explicitly widened yet still gets real breathing room before this assumes
// the worker is dead rather than just busy. A genuinely wedged worker still
// recovers, just a bit slower.
const WORKER_REQUEST_TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let onWorkerLost: ((reason: string) => void) | null = null;

// Called once, from App.tsx, so it can force the screen back to "unlock"
// when the worker had to be reset out from under an open session. Takes the
// same technical reason string resetWorker() below already logs to the
// console — until this existed, a forced relock was completely silent from
// the user's side: the unlock screen just reappeared with no indication
// anything unusual had happened, making a real watchdog trip
// indistinguishable from an ordinary manual lock. App.tsx surfaces this as a
// banner on the unlock screen instead, so a report like "it locked itself
// while I wasn't even doing anything" comes with an actual reason attached
// next time, rather than nothing to go on.
export function setWorkerLostHandler(handler: ((reason: string) => void) | null): void {
  onWorkerLost = handler;
}

// What every pending request is rejected with when the watchdog resets the
// worker.
export const WORKER_RESTARTED_MESSAGE = "Wallet worker restarted after becoming unresponsive — please unlock again.";

function resetWorker(reason: string): void {
  console.error(`[bark] resetting wallet worker: ${reason}`);
  if (worker) {
    worker.terminate();
    worker = null;
  }
  // The terminated worker held the only wallet handle this tab had, and with
  // it the IndexedDB connections, so another tab may open the wallet now.
  walletTabLock.release();
  // exitProgressGuard.ts tells a killed progressExits from a session that
  // merely ended during one by this record.
  for (const pending of pendingRequests.values()) {
    if (pending.payload.type === "call" && pending.payload.method === "progressExits") {
      recordProgressKilled(Date.now());
      break;
    }
  }
  const err = new Error(WORKER_RESTARTED_MESSAGE);
  for (const [id, pending] of pendingRequests) {
    window.clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.reject(err);
  }
  settleAllNetProbes();
  onWorkerLost?.(reason);
}

export { WALLET_LOCKED_MESSAGE } from "./walletSession";

// A deliberate lock: same teardown as resetWorker() minus the "worker lost"
// handler and the progressExits-killed record (an ordinary lock mid-call is not
// a failure, see exitProgressGuard.ts). What is still pending is read-only work
// (lockDrain.ts) and is rejected.
function dropWorkerForLock(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  const err = new Error(WALLET_LOCKED_MESSAGE);
  for (const [id, pending] of pendingRequests) {
    window.clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.reject(err);
  }
  settleAllNetProbes();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./wallet.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (
      e: MessageEvent<
        { id: number; started?: true; ok?: boolean; result?: unknown; error?: string } | NetProbeReply
      >,
    ) => {
      // Answered by the worker's bootstrap, outside the request queue.
      if ("netProbe" in e.data) {
        settleNetProbe(e.data);
        return;
      }
      const { id, started, ok, result, error } = e.data;
      const pending = pendingRequests.get(id);
      if (!pending) return;
      // The worker posts this the moment it pulls the request off its own
      // FIFO queue, i.e. when execution actually begins. Until then the
      // request has only been *waiting*, so restart the clock: see
      // armWatchdog for why the two phases need different deadlines.
      if (started) {
        pending.started = true;
        armWatchdog(id, pending);
        return;
      }
      window.clearTimeout(pending.timer);
      pendingRequests.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(error));
    };
    // A worker error event (uncaught exception in the worker's top-level
    // code, or during module loading) or a messageerror (a posted message
    // that couldn't be deserialized) both mean this worker instance can no
    // longer be trusted to ever answer anything still pending on it.
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      // A script that fails to load (typically: offline, and the worker
      // chunk isn't cached) fires a plain Event with no message, which used
      // to surface as "worker error: undefined".
      const what = e.message || (isOffline() ? "script failed to load (offline)" : "script failed to load");
      if (e.message || isOffline()) {
        resetWorker(`worker error: ${what}`);
        return;
      }
      // Online and the script did not load: most likely a tab older than the
      // latest deploy. Reload into the new build instead of showing a "lost
      // connection" banner for something that is not a fault.
      void isStaleBuild().then((stale) => {
        if (stale && reloadOnceForNewBuild()) {
          worker?.terminate();
          worker = null;
          return;
        }
        resetWorker(`worker error: ${what}`);
      });
    };
    worker.onmessageerror = () => {
      resetWorker("worker messageerror (malformed/unclonable message)");
    };
  }
  return worker;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
  payload: Record<string, unknown>;
  effectiveTimeoutMs: number;
  // False while the request is still sitting in the worker's FIFO queue,
  // true once the worker has posted its "started" ack.
  started: boolean;
}

const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 1;

// (Re)arms one request's watchdog. Arming nothing while the tab is hidden is
// deliberate and predates this: see the visibilitychange listener below.
function armWatchdog(id: number, pending: PendingRequest): void {
  window.clearTimeout(pending.timer);
  if ((typeof document !== "undefined" && document.visibilityState === "hidden") || watchdogPaused()) {
    pending.timer = 0;
    return;
  }
  const timer = window.setTimeout(() => {
    if (!pendingRequests.has(id)) return;
    const what = pending.started ? "timed out" : "never started (worker not draining its queue)";
    const reason = `request ${id} (${describePayload(pending.payload)}) ${what}`;
    if (!watchdogShouldConsultProbe()) {
      resetWorker(reason);
      return;
    }
    // Beta: before killing the session, ask the network whether it explains
    // the silence (a dead Wi-Fi that navigator.onLine still calls online).
    // If it does, the probe's state change pauses the watchdog like
    // offline does; if it only half does (one bad round, not yet a verdict),
    // give the request another full window and ask again then.
    void confirmWatchdogKill().then((kill) => {
      // Settled, re-armed, or paused (timer cleared to 0) in the meantime.
      if (pendingRequests.get(id) !== pending || pending.timer !== timer) return;
      if (kill) resetWorker(reason);
      else armWatchdog(id, pending);
    });
  }, watchdogDelayFor(pending));
  pending.timer = timer;
}

// The watchdog timer above counts plain wall-clock time, but a phone
// locking its screen (or the tab backgrounding) throttles JS timers and
// network on both sides of the postMessage boundary — the worker isn't
// actually stuck, it's just paused by the OS along with everything else.
// Without this, a perfectly healthy wallet.sync()/peekAddress/onchain.sync()
// that happened to be in flight when the screen locked would blow past the
// 60s timeout purely from being backgrounded, and the user would come back
// to find the app had torn down the worker and kicked them to the unlock
// screen for no real reason ("appka mě sama vrátila"). Fix: while hidden,
// stop counting down (clear the pending timers outright) and on becoming
// visible again, give every still-pending request a fresh full timeout
// window instead of the accumulated one — the worker/network typically
// catches up within a second or two of the tab waking up, so a fresh
// window is enough for a genuinely healthy request to resolve, while a
// truly wedged worker still gets caught once that fresh window elapses.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      for (const pending of pendingRequests.values()) {
        window.clearTimeout(pending.timer);
        pending.timer = 0;
      }
    } else {
      for (const [id, pending] of pendingRequests) {
        armWatchdog(id, pending);
      }
    }
  });
}

// Offline: same pause as a hidden tab. With no network the SDK
// retries instead of failing, so a healthy call can run for as long as the
// outage lasts; the watchdog used to read that as a wedged worker and tear
// the session down about a minute in. Back online, every pending request
// gets a fresh full window, so a worker that really is stuck is still caught,
// just once there is a network to prove it with. What counts as offline, and
// for how long it may pause this, is connectivity.ts's watchdogPaused():
// navigator.onLine=false for everyone, plus the active probe on the beta
// (offline, or the Ark server unreachable, capped).
if (typeof window !== "undefined") {
  let wasPaused = watchdogPaused();
  onConnectivityChange(() => {
    const paused = watchdogPaused();
    if (paused === wasPaused) return;
    wasPaused = paused;
    for (const [id, pending] of pendingRequests) {
      if (paused) {
        window.clearTimeout(pending.timer);
        pending.timer = 0;
      } else {
        armWatchdog(id, pending);
      }
    }
  });
}

// The worker half of the connectivity probe (netProbeWorker.ts). Never
// creates a worker just to probe: with none running there is no wallet call
// for the probe to explain, and connectivity.ts reads null as "no answer".
const NET_PROBE_REPLY_TIMEOUT_MS = 8_000;
const pendingNetProbes = new Map<number, (r: NetProbeReply | null) => void>();
let nextNetProbeId = 1;

function settleNetProbe(reply: NetProbeReply): void {
  const done = pendingNetProbes.get(reply.netProbe);
  if (!done) return;
  pendingNetProbes.delete(reply.netProbe);
  done(reply);
}

function settleAllNetProbes(): void {
  for (const done of pendingNetProbes.values()) done(null);
  pendingNetProbes.clear();
}

function probeViaWorker(): Promise<{ mempool: boolean; ark: boolean } | null> {
  const w = worker;
  if (!w) return Promise.resolve(null);
  const probeId = nextNetProbeId++;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingNetProbes.delete(probeId);
      resolve(null);
    }, NET_PROBE_REPLY_TIMEOUT_MS);
    pendingNetProbes.set(probeId, (reply) => {
      window.clearTimeout(timer);
      resolve(reply ? { mempool: reply.mempool, ark: reply.ark } : null);
    });
    const req: NetProbeRequest = { type: "netProbe", probeId };
    w.postMessage(req);
  });
}
setWorkerNetProbe(probeViaWorker);

// Temporary override for the watchdog default below — see
// pushWorkerWatchdogOverride's own comment. null means "use the normal 25s
// default".
let watchdogOverrideMs: number | null = null;
let watchdogOverrideCount = 0;

// Widens (or restores) the request() timeout below for *every* wallet.*
// call, not just one. Needed anywhere onchainWallet.sync() might legitimately
// take a while — it checks every locally revealed address every time
// (start_sync_with_revealed_spks_at) — such as Dashboard's own 30s
// background onchain-balance poll, EmergencyExit's balance check, and
// Settings' "Onchain transakce" sync button. A per-call override on just one
// caller isn't enough: while it runs, an unrelated caller sharing the same
// worker queue can sit queued long enough to trip its own default 25s
// watchdog and call resetWorker() — tearing down the whole worker and
// forcing a re-unlock that has nothing to do with whichever call actually
// needed more time.
//
// Reference-counted rather than a plain on/off flag: multiple callers can
// each widen it concurrently without one's cleanup prematurely narrowing it
// back to 25s while another still needs it wide. Returns a function that
// undoes exactly this one push.
export function pushWorkerWatchdogOverride(ms: number): () => void {
  watchdogOverrideCount++;
  if (watchdogOverrideMs === null || ms > watchdogOverrideMs) watchdogOverrideMs = ms;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchdogOverrideCount = Math.max(0, watchdogOverrideCount - 1);
    if (watchdogOverrideCount === 0) watchdogOverrideMs = null;
  };
}

// Separate from the watchdog override above (that one is nearly always
// active — refresh() itself pushes one every ~4s cycle, so it can't tell
// "something known-slow is hogging the queue right now" from "business as
// usual"). This exists specifically for onchainWallet.sync()/initialScan(),
// the two calls documented above as legitimately slow enough (large
// revealed-address counts, gap-limited scans) to starve the single FIFO
// queue for tens of seconds at a stretch — long enough that the Ark
// receive-watch's own refresh() cycle (running every ~4s for the whole
// session) queues behind them and trips its UI-level timeout purely from
// waiting, showing "Počkej chvíli…" for something that isn't actually
// broken. Dashboard's reportLoadError checks this to suppress that specific
// false alarm — still logged to the console, just not shown to the user —
// rather than chasing the symptom with an ever-larger timeout that only
// delays the same false alarm instead of preventing it.
let onchainScanCount = 0;
export function isOnchainScanActive(): boolean {
  return onchainScanCount > 0;
}
export function pushOnchainScanActive(): () => void {
  onchainScanCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    onchainScanCount = Math.max(0, onchainScanCount - 1);
  };
}

// Describes a request for the resetWorker() reason string — payload.type is
// always the generic literal "call" for every wallet.*/onchainWallet.*
// method (see makeProxyClient below), which used to make every timeout
// report read as just "(call)" with no way to tell which of dozens of
// possible methods actually hung. Include the target/method for that case so
// a real report (see request()'s own timeout below) actually points
// somewhere.
function describePayload(payload: Record<string, unknown>): string {
  if (payload.type === "call") return `${String(payload.target)}.${String(payload.method)}`;
  return String(payload.type);
}

// Diagnostic call log — every request() below (i.e. every wallet.*/
// onchainWallet.* call, plus ensureWasm/prepareSession/openHeld/close) is
// recorded here for Settings → Onchain transakce to show live, so a stuck
// round or a hung call can be seen from the phone itself without remote
// devtools. Deliberately logs only what request() itself constructs — never
// the raw `payload` — because payload.auth carries the plaintext SpendAuth
// password and payload.source (prepareSession) can carry the plaintext
// mnemonic; describePayload() above already strips both down to a safe
// "target.method"/"type" label, and args below are sanitized separately.
export interface CallLogEntry {
  readonly id: number;
  readonly time: number;
  readonly label: string;
  args?: unknown[];
  status: "pending" | "ok" | "error";
  durationMs?: number;
  error?: string;
}

// Persisted (not just in-memory) so the log covers real usage across many
// separate app opens ("what did the wallet do the last few days"), not just
// whatever happened to still be open when something went wrong — a stuck
// round is exactly the kind of thing someone notices *after* reopening the
// app, by which point an in-memory-only log would already be gone.
//
// IndexedDB rather than localStorage: the background sync/maintenance poll
// alone is ~2 calls/8s, so a continuously-open tab can produce thousands of
// entries/hour. localStorage would mean re-serializing the *entire* log to
// one JSON string on every write (real cost at that volume) and risks
// hitting its ~5-10MB quota outright, which fails the whole write silently.
// IndexedDB writes one record at a time and has a much larger practical
// quota — same tradeoff the wallet's own VTXO/history data already made
// (btc-wallet-mainnet). Bounded by both age and count so it still can't grow
// without limit.
const CALL_LOG_DB_NAME = "btc-wallet-call-log";
const CALL_LOG_DB_VERSION = 1;
const CALL_LOG_STORE = "entries";
const CALL_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CALL_LOG_MAX_ENTRIES = 20_000;

let callLogDbPromise: Promise<IDBDatabase | null> | null = null;

function openCallLogDb(): Promise<IDBDatabase | null> {
  callLogDbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(CALL_LOG_DB_NAME, CALL_LOG_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CALL_LOG_STORE)) {
          db.createObjectStore(CALL_LOG_STORE, { keyPath: "id" }).createIndex("time", "time");
        }
      };
      req.onsuccess = () => resolve(req.result);
      // Diagnostic feature only — degrade to in-memory-only for this session
      // rather than let IndexedDB unavailability (private browsing, etc.)
      // affect anything real.
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return callLogDbPromise;
}

// Batched rather than one transaction per call: `request()` used to fire an
// immediate callLogDbPut() on both the "pending" write and the later
// "settle" write, i.e. two fresh IndexedDB transactions per wallet.* call.
// Each transaction is real main-thread work (commit ack round-trips through
// the browser's storage backend) — cheap enough on a fast desktop to be
// invisible, but on a phone this stacked with everything else on the main
// thread (React re-renders from notifyCallLog(), the background watches'
// own ~2 calls/8s) and measurably delayed the main thread's onmessage
// handler for the *actual* worker replies — which is exactly what
// request()'s own durationMs measures, so the diagnostic log's own writes
// were inflating the numbers it was being read to diagnose. Collecting
// entries and flushing them as one multi-put transaction every
// CALL_LOG_FLUSH_DELAY_MS cuts that from ~2 transactions/call to a handful
// per second regardless of call volume.
const CALL_LOG_FLUSH_DELAY_MS = 1_000;
let pendingDbWrites: CallLogEntry[] = [];
let dbFlushTimer: number | null = null;

async function flushCallLogDbWrites(): Promise<void> {
  dbFlushTimer = null;
  if (pendingDbWrites.length === 0) return;
  const batch = pendingDbWrites;
  pendingDbWrites = [];
  const db = await openCallLogDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CALL_LOG_STORE, "readwrite");
      const store = tx.objectStore(CALL_LOG_STORE);
      for (const entry of batch) store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort diagnostic persistence — never let a write failure here
    // affect the actual wallet call it's logging.
  }
}

function scheduleCallLogDbWrite(entry: CallLogEntry): void {
  // Snapshot, not a live reference: `entry` is mutated in place by settle()
  // (status/durationMs/error), and a pending write already queued for the
  // same id would otherwise pick up the later mutation and write the
  // "settled" version under the earlier "pending" flush — harmless since
  // they share an id and the store is keyed on it, but the copy keeps this
  // function's contract (write what was true when called) honest.
  pendingDbWrites.push({ ...entry });
  if (dbFlushTimer === null) dbFlushTimer = window.setTimeout(() => void flushCallLogDbWrites(), CALL_LOG_FLUSH_DELAY_MS);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dbFlushTimer !== null) {
      window.clearTimeout(dbFlushTimer);
      void flushCallLogDbWrites();
    }
  });
}

async function callLogDbDelete(id: number): Promise<void> {
  const db = await openCallLogDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CALL_LOG_STORE, "readwrite");
      tx.objectStore(CALL_LOG_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Same as callLogDbPut above — best-effort.
  }
}

async function callLogDbClear(): Promise<void> {
  const db = await openCallLogDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CALL_LOG_STORE, "readwrite");
      tx.objectStore(CALL_LOG_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Same as callLogDbPut above — best-effort.
  }
}

const callLog: CallLogEntry[] = [];
let callLogNextId = 1;
const callLogListeners = new Set<() => void>();

function enforceCallLogCap(): void {
  while (callLog.length > CALL_LOG_MAX_ENTRIES) {
    const removed = callLog.shift();
    if (removed) void callLogDbDelete(removed.id);
  }
}

// Loads the persisted log at startup: prunes anything past the age cutoff,
// repairs any entry still "pending" (the tab/worker closed mid-request, so
// it will never resolve now — left as "pending" it would misleadingly read
// as still hanging right now instead of just history), and seeds the
// in-memory array + next id from what's left. Fire-and-forget from module
// load — getCallLog() reads whatever's in `callLog` at the time, same as
// any other async-loaded state in this app; the UI updates via
// notifyCallLog() once this resolves.
async function initCallLog(): Promise<void> {
  const db = await openCallLogDb();
  if (!db) return;
  const cutoff = Date.now() - CALL_LOG_MAX_AGE_MS;
  try {
    const loaded = await new Promise<CallLogEntry[]>((resolve, reject) => {
      const tx = db.transaction(CALL_LOG_STORE, "readwrite");
      const store = tx.objectStore(CALL_LOG_STORE);
      const result: CallLogEntry[] = [];
      const cursorReq = store.index("time").openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const e = cursor.value as CallLogEntry;
        if (e.time < cutoff) {
          cursor.delete();
        } else if (e.status === "pending") {
          const fixed: CallLogEntry = { ...e, status: "error", error: "Přerušeno (appka byla zavřena)" };
          cursor.update(fixed);
          result.push(fixed);
        } else {
          result.push(e);
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
    callLog.push(...loaded);
    enforceCallLogCap();
    callLogNextId = callLog.reduce((max, e) => Math.max(max, e.id), 0) + 1;
    notifyCallLog();
  } catch {
    // Best-effort — an empty in-memory log for this session is a fine
    // fallback for a diagnostic feature.
  }
}
// Deferred to idle time, not fired immediately at module load: this is a
// diagnostic-only feature, but its cursor walk runs on the main thread (this
// module lives there, unlike the actual wallet.* calls) and after even a few
// days of continuous background polling (~2 calls/8s) the log routinely
// holds thousands of entries — measured at ~360ms to walk 15k records on a
// fast desktop, worse on a phone. Running that eagerly landed it squarely on
// top of the app's own startup render (fetchBalanceAndHistory's result
// arriving and React committing it), which is what actually made the
// balance/history look like they'd gotten slower to appear after this
// feature shipped — the wallet.* calls themselves were never affected (they
// run in the worker thread), only the main thread's ability to promptly
// process their results while busy with this cursor walk. requestIdleCallback
// waits for a genuine gap after the critical rendering work; the setTimeout
// fallback (Safari has no requestIdleCallback) at least yields past the
// current task instead of running synchronously inline with it.
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => void initCallLog());
} else {
  setTimeout(() => void initCallLog(), 0);
}

function notifyCallLog(): void {
  for (const cb of callLogListeners) cb();
}

export function getCallLog(): readonly CallLogEntry[] {
  return callLog;
}

export function subscribeCallLog(cb: () => void): () => void {
  callLogListeners.add(cb);
  return () => callLogListeners.delete(cb);
}

export function clearCallLog(): void {
  callLog.length = 0;
  notifyCallLog();
  void callLogDbClear();
}

// Only `payload.args` (the call's own arguments — addresses, amounts, vtxo
// ids, invoice strings) is ever considered here, never payload.auth or
// payload.source. Depth-limited and string-truncated so one call with a
// large payload (e.g. a PSBT) can't blow up the log UI.
function sanitizeArgs(args: unknown): unknown[] | undefined {
  if (!Array.isArray(args)) return undefined;
  const truncate = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
  const sanitize = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return truncate(v);
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return `${v}n`;
    if (Array.isArray(v)) return depth >= 2 ? "[…]" : v.map((x) => sanitize(x, depth + 1));
    if (typeof v === "object") {
      if (depth >= 2) return "{…}";
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = sanitize(val, depth + 1);
      return out;
    }
    return String(v);
  };
  return args.map((a) => sanitize(a, 0));
}

function request(payload: Record<string, unknown>, timeoutMs?: number, transfer: Transferable[] = []): Promise<unknown> {
  const effectiveTimeoutMs = timeoutMs ?? watchdogOverrideMs ?? WORKER_REQUEST_TIMEOUT_MS;
  const id = nextRequestId++;
  const logEntry: CallLogEntry = {
    id: callLogNextId++,
    time: Date.now(),
    label: describePayload(payload),
    args: payload.type === "call" ? sanitizeArgs(payload.args) : undefined,
    status: "pending",
  };
  callLog.push(logEntry);
  enforceCallLogCap();
  notifyCallLog();
  scheduleCallLogDbWrite(logEntry);
  const startedAt = performance.now();
  const settle = (status: "ok" | "error", error?: string): void => {
    logEntry.status = status;
    logEntry.durationMs = Math.round(performance.now() - startedAt);
    if (error !== undefined) logEntry.error = error;
    notifyCallLog();
    scheduleCallLogDbWrite(logEntry);
  };
  return new Promise((resolve, reject) => {
    // If the tab is already hidden when this request goes out, don't arm a
    // timer at all — the visibilitychange listener above only reacts to the
    // *transition* to hidden, so a request started while already hidden
    // would otherwise get a timer that (mostly) counts down against a
    // throttled/backgrounded page. It'll get a fresh full window once the
    // tab becomes visible again, same as everything else.
    const loggedResolve = (v: unknown): void => {
      settle("ok");
      resolve(v);
    };
    const loggedReject = (e: unknown): void => {
      settle("error", e instanceof Error ? e.message : String(e));
      reject(e);
    };
    const pending: PendingRequest = {
      resolve: loggedResolve,
      reject: loggedReject,
      timer: 0,
      payload,
      effectiveTimeoutMs,
      started: false,
    };
    pendingRequests.set(id, pending);
    armWatchdog(id, pending);
    try {
      getWorker().postMessage({ id, ...payload }, transfer);
    } catch (e) {
      // A payload the structured-clone algorithm refuses (the biometric
      // unlock posts a CryptoKey, for instance). The throw inside this
      // executor already rejects the promise, but without this the pending
      // entry and its armed timer would stay behind and the watchdog would
      // later tear down a perfectly healthy worker over a request that was
      // never actually sent.
      window.clearTimeout(pending.timer);
      pendingRequests.delete(id);
      settle("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
}

// Shares OPEN_TIMEOUT_MS with prepareSession/openHeldWallet below: this is request #1,
// fired unconditionally at mount to prefetch the ~7.7MB WASM bundle, so on a slow (but
// healthy, fully visible) connection it can legitimately take longer than the generic
// baseline timeout — which used to tear down a worker that was never actually stuck.
export async function ensureWasm(): Promise<void> {
  await request({ type: "ensureWasm" }, OPEN_TIMEOUT_MS);
}

// wallet.maintenance() — not sync() — is the call repeatedly observed
// hanging for minutes at a stretch against a stalled Ark server (a wedged
// round the server never resolves): it sits inside the SDK's own
// round-event-stream wait. Dashboard.tsx's refresh() wraps its whole
// sync()+maintenance() cycle in pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS)
// (20 minutes) so a call merely *queued* behind the onchain poll's
// legitimately slow scan doesn't trip the watchdog — but that same width
// then also covers maintenance() once it's actually executing and stuck,
// not just queued. Since the worker only ever runs one wallet.* call at a
// time (this file's own queue), every other call — a user's own Odeslat, or
// opening VTXO mince — sits behind it for the whole stretch, observed live
// up to ~14 minutes for one single attempt. An explicit `timeoutMs` here
// always wins over any active override (`timeoutMs ?? watchdogOverrideMs ??
// …` in request() above), so refresh()'s own maintenance() call gets a
// fixed, predictable ceiling no matter how wide the shared override
// currently is — trading "maintenance() might rarely time out early purely
// from queueing" for "a stuck maintenance() no longer holds the whole queue
// hostage for minutes." Scoped to refresh()'s own repeating call only, not
// backup.ts's one-off post-restore maintenance() call.
export const REFRESH_MAINTENANCE_TIMEOUT_MS = 60_000;
export async function maintenanceWithDeadline(): Promise<void> {
  await request({ type: "call", target: "wallet", method: "maintenance", args: [] }, REFRESH_MAINTENANCE_TIMEOUT_MS);
}

// Starting width for the delegated call's own deadline: unlike maintenance(),
// this should never block on round completion, so it shouldn't need
// anywhere near REFRESH_MAINTENANCE_TIMEOUT_MS's 60s in practice — kept in
// the same order of magnitude for the first rollout since this app has no
// live data yet on how long the non-refresh housekeeping (board/arkoor/
// lightning checks) can legitimately take on a slow connection. Revisit
// once observed live.
export const MAINTENANCE_DELEGATED_TIMEOUT_MS = 30_000;
export async function maintenanceDelegatedWithDeadline(): Promise<void> {
  await request({ type: "call", target: "wallet", method: "maintenanceDelegated", args: [] }, MAINTENANCE_DELEGATED_TIMEOUT_MS);
}

// What callers should use: skips scheduling while a delegated round state is
// still pending, see delegatedMaintenance.ts for why. Returns whether it
// scheduled.
export const scheduleMaintenanceDelegated = createDelegatedMaintenanceScheduler(maintenanceDelegatedWithDeadline);

// The same thing plus a plain sync() when the schedule was skipped, for the
// one caller that has no other server round-trip of its own (backup.ts's
// settle loop). See createSettleMaintenance's own comment.
export const settleMaintenanceDelegated = createSettleMaintenance(scheduleMaintenanceDelegated);

export async function generateMnemonic(): Promise<string> {
  return (await request({ type: "generateMnemonic" })) as string;
}

// Turns a *signed* PSBT into the raw transaction hex broadcastTx() expects.
// signExitClaimInputs() returns a signed PSBT in base64, not a finished
// transaction — feeding its result straight to broadcastTx() (which parses
// hex) fails on the second character of the PSBT magic "cHNidP8", as
// `InvalidCharError { invalid: 72 }`, i.e. the 'H'. That was the last step
// of the unilateral exit, and it had never run against real funds.
export async function extractTxFromPsbt(psbtBase64: string): Promise<string> {
  return (await request({ type: "extractTxFromPsbt", psbtBase64 })) as string;
}

export async function validateMnemonic(mnemonic: string): Promise<boolean> {
  return (await request({ type: "validateMnemonic", mnemonic })) as boolean;
}

// Shared by both the Ark and onchain clients: a Proxy whose `get` trap
// forwards any method call to the worker for the given target, instead of
// hand-listing every method (and needing to keep that list in sync with the
// SDK). See the "then" comment below for the one property this can't treat
// generically.
function makeProxyClient<T extends object>(
  target: "wallet" | "onchain",
  extra: Partial<T> = {},
  auth?: SpendAuth,
): T {
  const base = { ...extra } as T;
  return new Proxy(base, {
    get(obj, prop) {
      if (prop in obj) return (obj as Record<string | symbol, unknown>)[prop];
      // `openWallet` is itself an async function, so its return value goes
      // through the Promise resolution algorithm, which checks whether the
      // value is "thenable" (has a callable `.then`) before resolving it.
      // Without this guard, the Proxy answers that check by handing back a
      // function for "then" like it would for any other method name — the
      // engine treats the whole client as a thenable and calls
      // `client.then(resolve, reject)` to chain it, which falls through to
      // the generic dispatch below and tries to postMessage() the native
      // resolve/reject functions to the worker, crashing with
      // "could not be cloned". Answering `undefined` here keeps the client
      // a plain non-thenable object.
      if (prop === "then" || typeof prop !== "string") return undefined;
      // Carries the same `extra` (fingerprint/onchainWallet) so the
      // decorated client stays a drop-in for the plain one.
      if (prop === "withAuth") return (next: SpendAuth) => makeProxyClient<T>(target, extra, next);
      return (...args: unknown[]) =>
        request(auth ? { type: "call", target, method: prop, args, auth } : { type: "call", target, method: prop, args });
    },
  }) as T;
}

// Opening the wallet isn't always cheap: whenever the local Ark DB doesn't
// already exist (a fresh import, or after the local DB was wiped and
// recreated), Wallet.openWithOnchain() runs bark's full seed-recovery mailbox scan
// in-process before it resolves (bark/src/recovery.rs's own doc comment:
// "reads back every id ever posted there"). That can easily take longer
// than the worker watchdog's default 25s, especially for a wallet with any
// real history — and unlike every other slow call in this app, there's no
// component around to push a watchdog override first, since nothing is
// mounted yet while the user is still on the unlock screen. Without its own
// generous timeout here, a slow-but-legitimate recovery scan self-triggers
// the watchdog, tears down the very worker mid-open, and rejects the open()
// call with "please unlock again" — which is exactly the rescan feature
// defeating itself the moment it's used.
const OPEN_TIMEOUT_MS = 20 * 60_000;

// Resolves the session's mnemonic *inside the worker* and returns only what
// the main thread legitimately needs back (see PrepareSource/PrepareResult
// in walletSession.ts). For the password path this is what keeps the
// plaintext seed out of the React realm entirely: the password goes in, and
// nothing seed-shaped comes out.
//
// Must be followed by openHeldWallet() to actually open the wallet — split
// in two because the cloud-backup restore has to run *between* them (it
// writes the very IndexedDB databases the open would otherwise already hold
// a live WASM handle on), and it needs the backup keys this returns.
//
// Shares OPEN_TIMEOUT_MS with the open below rather than getting a tighter
// window of its own, even though the work itself is only PBKDF2 + HKDF
// (sub-second on a desktop, a few seconds on a slow phone). The reason is
// the worker's FIFO queue: App.tsx fires ensureWasm() at mount, so this
// request routinely sits queued behind a ~7.7MB WASM download, and the
// watchdog counts from when the request is *posted*, not when it starts
// running. A 3-minute window here — which is what this had first — would
// mean a slow connection tripping the watchdog mid-unlock, terminating the
// worker and reporting it as "the wallet worker restarted", for a request
// that had not even begun.
//
// Takes the cross-tab wallet lock first (walletTabLock.ts): a second tab
// gets WALLET_OPEN_ELSEWHERE before its worker ever sees a seed, so it can
// never end up with a second bark instance on the same IndexedDB. Held until
// closeWallet() or a worker reset.
let sessionEpoch = 0;

// Money chat (beta): asks the wallet worker to post the open session's chat key
// into `port`. chatClient.ts passes a port whose other end is the chat worker,
// so the key does not pass through this realm; nothing stops other main-thread
// code from passing its own (see sessionChatKey in walletWorkerImpl.ts).
export async function deliverChatKey(port: MessagePort): Promise<void> {
  await request({ type: "chatKey", port }, undefined, [port]);
}

export async function prepareSession(source: PrepareSource): Promise<PrepareResult> {
  if (!(await walletTabLock.acquire())) throw new Error(WALLET_OPEN_ELSEWHERE);
  sessionEpoch++;
  return (await request({ type: "prepareSession", source }, OPEN_TIMEOUT_MS)) as PrepareResult;
}

// exitChain: an exit may be live (exitMayBeLive), so the worker keeps bark's
// chain traffic off Second's esplora from the first request
// (walletWorkerGuard.ts, exitChainRedirect).
export async function openHeldWallet(useFallbackChainSource?: boolean, exitChain?: boolean): Promise<WalletClient> {
  // Beta, refresh engine "live": the SDK daemon's own interactive round joins
  // would compete with the engine for the same coins, so it doesn't run.
  const runDaemon = beginSessionEngineMode() !== "live";
  const { fingerprint, address } = (await request(
    { type: "openHeld", useFallbackChainSource, exitChain, runDaemon },
    OPEN_TIMEOUT_MS,
  )) as { fingerprint: string; address?: string | null };
  const onchainWallet = makeProxyClient<OnchainWalletClient>("onchain");
  // openedAddress is always an own key, even when null: the proxy answers any
  // missing property with a worker-call function.
  return makeProxyClient<WalletClient>("wallet", { fingerprint, openedAddress: address ?? null, onchainWallet });
}

// The client argument is unused (the worker owns the handle) and optional,
// because there is one caller that has to close a session it never got a
// client for: an open that failed after prepareSession already resolved the
// seed. Without that call the worker keeps the plaintext mnemonic while the
// app sits on the unlock screen looking locked — see App.tsx's openSession.
export async function closeWallet(_client?: WalletClient): Promise<void> {
  // Any gift op mid-flight is on its own disposable worker — drop it too so
  // a lock/reset doesn't leave a stray WASM instance running.
  terminateGiftWorker();
  const epoch = sessionEpoch;
  try {
  // Queueing "close" behind earlier calls made the next unlock wait for them
  // too (a sync or maintenance still running at lock time held prepareSession
  // back for as long as it took), and left the keys in the old worker's
  // memory. Terminating drops all of that. Only while nothing that moves money
  // or changes locks is queued or running (lockDrain.ts): then the old path
  // below lets it finish first, as before. Not an unresponsive worker, so no
  // onWorkerLost: the caller is the one locking.
  //
  // Synchronous up to here, so no other session can have started since the
  // epoch was read. No worker means nothing holds a wallet; do not spawn one
  // just to close it.
  if (!worker) {
    if (sessionEpoch === epoch) walletTabLock.release();
    return;
  }
  // Only a lock of a session that was open (Dashboard, resetWallet pass its
  // client). The failed-open cleanup passes none: no wallet is open there, and
  // a wrong password must not cost a worker restart per attempt.
  if (_client !== undefined && canTerminateOnLock(pendingRequests.values())) {
    dropWorkerForLock();
    if (sessionEpoch === epoch) walletTabLock.release();
    // The unlock screen is next: compile the WASM while the password is typed,
    // as the first mount does (App.tsx), instead of on the unlock click.
    void ensureWasm().catch(() => {});
    return;
  }
    await request({ type: "close" });
  } finally {
    // After the worker has freed the wallet (its queue runs the close only
    // once every earlier call is done), not before: releasing first would let
    // another tab open the DB while this one still has calls in flight. If
    // the close itself failed, the watchdog's resetWorker() has terminated
    // the worker, which releases the DB just the same.
    //
    // Only if no new session started meanwhile: Dashboard's unmount fires
    // this without awaiting it, so an auto-lock followed by a quick unlock in
    // this same tab queues prepareSession behind this close, and releasing
    // here would drop the lock out from under the new session.
    if (sessionEpoch === epoch) walletTabLock.release();
  }
}

// Wallet.open keys its local cache by db name, not by mnemonic — opening a
// *different* mnemonic against a database that still holds a previous
// wallet's data throws ("incorrect mnemonic"). Call this whenever the vault
// is deleted so a new/imported wallet isn't blocked by stale local state.
// Plain IndexedDB, not WASM — works the same from the main thread whether
// the wallet itself lives here or in the worker. Deletes both the Ark
// wallet's database and the onchain wallet's own separate one (see
// ONCHAIN_DB_NAME in wallet.worker.ts) — leaving the onchain DB behind would
// leak the same "incorrect mnemonic" problem for the onchain half alone.
function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export async function deleteWalletDb(): Promise<void> {
  await Promise.all([deleteDb("btc-wallet-mainnet"), deleteDb("btc-wallet-mainnet-onchain")]);
}

// --- Gift-link ephemeral wallet ----------------------------------------
// "Send bitcoin as a link" opens a throwaway wallet from a one-time
// mnemonic (see walletWorkerImpl.ts's giftOpen/giftCall/giftClose). It runs
// in a SEPARATE worker instance of the same chunk — not the main wallet
// worker — so a slow or hung gift op (a reclaim of an already-claimed gift
// whose maintenance() never settles, most notably) can only ever cost this
// disposable worker, never the user's real session: its timeout terminates
// and forgets the gift worker without touching `worker` or calling
// onWorkerLost. The ephemeral IndexedDB (btc-wallet-gift-<id>*) is deleted
// after every use; the funds live in the wallet's Ark mailbox on the
// server, re-derivable from the mnemonic, so the local DB is disposable.

let giftWorker: Worker | null = null;
const giftPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
let giftNextRequestId = 1;

// Generous — a first open runs bark's recovery scan, and maintenance() over
// a real network can legitimately take a while. This only bounds how long a
// genuinely wedged gift worker lives before it's recreated; the caller's
// own GIFT_MAILBOX_BUDGET_MS race is what makes the *UI* give up quickly.
const GIFT_WORKER_TIMEOUT_MS = 90_000;

function resetGiftWorker(reason: string): void {
  console.error(`[bark] gift worker reset: ${reason}`);
  if (giftWorker) {
    giftWorker.terminate();
    giftWorker = null;
  }
  const err = new Error(reason);
  for (const [id, p] of giftPending) {
    window.clearTimeout(p.timer);
    giftPending.delete(id);
    p.reject(err);
  }
  // Deliberately NOT onWorkerLost() — the real session lives on `worker`.
}

// Frees the gift worker (and with it the ~7 MB WASM instance) once a gift
// operation is done. Recreated on demand by the next giftRequest().
export function terminateGiftWorker(): void {
  resetGiftWorker("gift worker no longer needed");
}

function getGiftWorker(): Worker {
  if (!giftWorker) {
    // Same chunk URL as the main worker, so public/fetch-guard.js's
    // wallet-worker allowlist accepts it.
    giftWorker = new Worker(new URL("./wallet.worker.ts", import.meta.url), { type: "module" });
    giftWorker.onmessage = (
      e: MessageEvent<{ id: number; started?: true; ok?: boolean; result?: unknown; error?: string }>,
    ) => {
      const { id, started, ok, result, error } = e.data;
      // Same worker chunk as the main one, so it posts the same "started"
      // ack (see armWatchdog). This worker is short-lived and one-shot, so
      // it has no queue-vs-running distinction worth tracking; just don't
      // let the ack fall through to the settle path below, where its absent
      // `ok` would read as a failure and reject the gift call outright.
      if (started) return;
      const p = giftPending.get(id);
      if (!p) return;
      window.clearTimeout(p.timer);
      giftPending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    giftWorker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      resetGiftWorker(`gift worker error: ${e.message}`);
    };
    giftWorker.onmessageerror = () => resetGiftWorker("gift worker messageerror");
  }
  return giftWorker;
}

function giftRequest(payload: Record<string, unknown>, timeoutMs = GIFT_WORKER_TIMEOUT_MS): Promise<unknown> {
  const id = giftNextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (giftPending.has(id)) resetGiftWorker(`gift request ${id} (${describePayload(payload)}) timed out`);
    }, timeoutMs);
    giftPending.set(id, { resolve, reject, timer });
    try {
      getGiftWorker().postMessage({ id, ...payload });
    } catch (e) {
      window.clearTimeout(timer);
      giftPending.delete(id);
      reject(e as Error);
    }
  });
}

function giftDbNames(giftId: string): { dbName: string; onchainDbName: string } {
  const dbName = `btc-wallet-gift-${giftId}`;
  return { dbName, onchainDbName: `${dbName}-onchain` };
}

async function deleteGiftDb(giftId: string): Promise<void> {
  const { dbName, onchainDbName } = giftDbNames(giftId);
  await Promise.all([deleteDb(dbName), deleteDb(onchainDbName)]);
}

// Every gift operation runs on ONE shared gift worker with ONE giftWallet
// slot: giftOpen frees whatever gift wallet is already open, and every
// operation's finally terminates the worker. Two operations at once therefore
// kill each other — verified live: two concurrent claims on unfunded wallets,
// and one came back "gift worker no longer needed" instead of its real
// result. Reachable in practice: the Dashboard auto-return sweep runs on mount
// and on every return to the foreground, alongside a manual "Vzít zpět", a
// new gift being composed, or the Settings status check. Chained here so they
// run strictly one after another. Only the outermost entry points take it —
// reclaimGiftToAddress just delegates to claimGiftToAddress, so nesting (and
// with it a deadlock) can't happen.
let giftChain: Promise<unknown> = Promise.resolve();
function withGiftLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = giftChain.then(fn, fn);
  giftChain = run.catch(() => {});
  return run;
}

// The Ark address an outgoing gift is funded to — the ephemeral wallet's
// first address. newAddress() (not peekAddress(0)): the SDK only lets you
// peek a key it has already derived, and a freshly opened wallet has none
// ("VTXO key 0 does not exist, please derive it first"). The ephemeral DB is
// deleted right after; the claim/reclaim re-opens from the mnemonic and its
// recovery scan (key gap limit, bark's default 250) re-finds the VTXO at that index.
export function deriveGiftFundingAddress(giftMnemonic: string, giftId: string): Promise<string> {
  return withGiftLock(async () => {
    const { dbName, onchainDbName } = giftDbNames(giftId);
    try {
      await giftRequest({ type: "giftOpen", mnemonic: giftMnemonic, dbName, onchainDbName });
      return (await giftRequest({ type: "giftCall", method: "newAddress", args: [] })) as string;
    } finally {
      terminateGiftWorker();
      await deleteGiftDb(giftId);
    }
  });
}

export interface GiftClaimResult {
  claimedSats: number;
}

export const GIFT_EMPTY_MESSAGE = "Dárek je prázdný nebo už byl vyzvednut.";

// What the mailbox budget below running out means — and it is NOT the same
// as GIFT_EMPTY_MESSAGE, though it is usually the same situation.
//
// An already-claimed gift does not show up as an empty balance. Its mailbox
// pull simply never finishes: observed live on 2026-09-10 (commit d08d1cf),
// when a second open of a claimed link spun on "Přijímám…" until the
// 20-minute open timeout, which is the whole reason this budget exists. So
// in practice a timeout here almost always means "someone already took it".
//
// "Almost" is the catch: a genuinely slow connection on a gift nobody has
// touched looks identical. Treating it exactly like GIFT_EMPTY_MESSAGE used
// to mark the link claimed on that device for good and wipe a brand-new
// recipient's only copy of their generated vault password; treating it as
// nothing but slowness (a 2026-09-11 change) made claimed gifts impossible to
// recognise at all. It gets its own message so every caller can take the
// likely reading without doing anything irreversible on it — see
// peekGiftStatus and giftReclaim.ts for how each one does that.
export const GIFT_SLOW_MESSAGE = "Dárek už byl nejspíš vyzvednut, nebo je pomalé spojení. Zkus to za chvíli znovu.";

// Budget for the mailbox pull *after* the wallet is open. Past this with no
// spendable balance, the gift is gone (or the link's been opened twice) —
// fail fast instead of spinning on "Přijímám…". The gift worker's own
// longer timeout still backstops a truly wedged call, and killing the gift
// worker never touches the user's session.
const GIFT_MAILBOX_BUDGET_MS = 18_000;

// Opens the ephemeral wallet from a gift link's mnemonic, pulls the gift
// VTXO out of its mailbox (maintenance() is what does that — sync() alone
// misses mailbox deliveries) and forwards the whole spendable balance to
// `recipientArkAddress`.
const giftCall = (method: string, args: unknown[] = []) => giftRequest({ type: "giftCall", method, args });

// The open gift wallet's spendable balance after pulling its mailbox. Shared
// by the claim and the status check so both look at a gift the same way —
// this is the one sequence proven live (the 2026-09-10 mainnet send → claim)
// to actually see a delivered gift.
async function pullGiftBalance(): Promise<number> {
  // Force key 0 to exist before the mailbox scan tries to match a VTXO
  // locked to it — same "derive it first" constraint as the funding side.
  await giftCall("newAddress");
  await giftCall("sync");
  await giftCall("maintenance");
  let balance = (await giftCall("balance")) as { spendableSats: number };
  if (!balance.spendableSats) {
    await giftCall("maintenance").catch(() => {});
    balance = (await giftCall("balance")) as { spendableSats: number };
  }
  return balance.spendableSats;
}

function raceBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("__gift_budget__")), ms)),
  ]);
}

export function claimGiftToAddress(
  giftMnemonic: string,
  giftId: string,
  recipientArkAddress: string,
): Promise<GiftClaimResult> {
  return withGiftLock(async () => {
    const { dbName, onchainDbName } = giftDbNames(giftId);
    // Deleting this DB is what makes a claim non-retryable through its own
    // local state — the next attempt falls back to bark's key-gap-limited
    // recovery scan, the same lossy path documented at the top of this file
    // as the root cause of a real ~100k-sat loss. Only flip this once the
    // outcome is definitely terminal: a confirmed-empty mailbox (nothing was
    // ever pulled), or a completed pull *and* a completed forward (nothing
    // is left behind to lose). Every other exit — giftOpen itself failing,
    // the mailbox pull racing out past GIFT_MAILBOX_BUDGET_MS while
    // maintenance() may still be running, or sendArkoorPayment throwing
    // after a successful pull (the "vtxo … is not spendable" transient the
    // SDK routinely returns mid-round) — leaves it false, so `finally`
    // below leaves the DB in place. A retry then reopens the SAME local
    // database (giftOpen only needs the mnemonic to match, which it always
    // does here) and finds whatever was already pulled still sitting in it,
    // instead of needing the lossy scan to re-find it.
    let safeToDeleteDb = false;
    try {
      await giftRequest({ type: "giftOpen", mnemonic: giftMnemonic, dbName, onchainDbName });

      let claimedSats: number;
      try {
        claimedSats = await raceBudget(pullGiftBalance(), GIFT_MAILBOX_BUDGET_MS);
      } catch (e) {
        if (e instanceof Error && e.message === "__gift_budget__") throw new Error(GIFT_SLOW_MESSAGE);
        throw e;
      }
      if (!claimedSats) {
        // The pull genuinely completed and found nothing — there is
        // nothing local left to strand.
        safeToDeleteDb = true;
        throw new Error(GIFT_EMPTY_MESSAGE);
      }

      await giftCall("sendArkoorPayment", [recipientArkAddress, claimedSats]);
      // Both the pull and the forward completed — nothing is left behind.
      safeToDeleteDb = true;
      return { claimedSats };
    } finally {
      terminateGiftWorker();
      if (safeToDeleteDb) await deleteGiftDb(giftId);
    }
  });
}

// "claimed": the pull completed and the wallet was empty (definite).
// "slow": the pull ran out of budget, which is how a claimed gift usually
// presents but also what a bad connection looks like. "unknown": the wallet
// did not even open in time.
export type GiftPeek = "unclaimed" | "claimed" | "slow" | "unknown";

// Shorter than the claim's GIFT_MAILBOX_BUDGET_MS, and the two are separate on
// purpose. Running out of budget reads as "claimed" in both places now, so a
// tighter one misreads more slow-but-untouched gifts as taken. Here that
// costs nothing lasting — it only picks a label, which is never written to
// the gift's record and is re-checked on the next open. On the claim it
// would tell a real recipient on a slow phone that their gift is "probably
// already claimed", on the one path where money actually moves and with no
// measurements of how long a real mobile pull takes. So only this one moves.
const GIFT_PEEK_BUDGET_MS = 10_000;
const GIFT_PEEK_OPEN_TIMEOUT_MS = 30_000;

// Whether an outgoing gift's ephemeral wallet still holds the gift — the
// sender's only way to learn a recipient claimed it, since a claim happens
// entirely on the recipient's device and nothing reports back.
//
// It never moves money. That is the whole reason it is its own function and
// not a "dry run" of reclaimGiftToAddress: reclaiming an unclaimed gift sends
// it straight back to the sender, so "checking" through that path would
// snatch a live gift away from its recipient.
//
// Three different answers, kept apart so the list can be honest about which
// it has: a pull that completes with nothing in the wallet is "claimed" (the
// same proof the claim flow treats as terminal); a pull that runs out of
// budget is "slow" (a claimed gift's pull never finishes, but a bad
// connection looks identical, so the list says "nejspíš" and keeps the take
// back button); a wallet that does not open in time is "unknown". Never
// written to the gift's record.
export function peekGiftStatus(giftMnemonic: string, giftId: string): Promise<GiftPeek> {
  return withGiftLock(async () => {
    const { dbName, onchainDbName } = giftDbNames(giftId);
    // Same reasoning as claimGiftToAddress's safeToDeleteDb: pullGiftBalance()
    // is the exact same mailbox-pulling call either way (a "peek" doesn't
    // skip maintenance() — it only skips the send afterwards), so a budget
    // timeout here can leave the same not-yet-forwarded VTXO sitting in this
    // ephemeral wallet's local state. Deleting the DB in that case would
    // strand it exactly as it would from the claim path.
    let safeToDeleteDb = false;
    try {
      // Its own, much shorter deadline than the claim's 90 s: a look that
      // cannot even open the wallet within this is "unknown", and the list
      // behind it must not wait minutes for one row.
      await giftRequest({ type: "giftOpen", mnemonic: giftMnemonic, dbName, onchainDbName }, GIFT_PEEK_OPEN_TIMEOUT_MS);
      const sats = await raceBudget(pullGiftBalance(), GIFT_PEEK_BUDGET_MS);
      // The pull completed one way or the other — nothing is left half-done.
      safeToDeleteDb = true;
      return sats > 0 ? "unclaimed" : "claimed";
    } catch (e) {
      return e instanceof Error && e.message === "__gift_budget__" ? "slow" : "unknown";
    } finally {
      terminateGiftWorker();
      if (safeToDeleteDb) await deleteGiftDb(giftId);
    }
  });
}

// Beta status look (giftScan.ts has the rules): opens a FRESH local wallet DB from the gift's seed, because the
// recovery scan runs only on the open that creates it, and reads its report. It pulls nothing and sends nothing,
// so it cannot snatch a gift from its recipient; the DB is dropped afterwards (it never held a VTXO). Every
// failure is "unknown", which the list shows as "not checked", never as a claim.
export function scanGiftStatus(giftMnemonic: string, giftId: string): Promise<GiftScan> {
  return withGiftLock(async () => {
    const dbName = `btc-wallet-gift-scan-${giftId}-${Date.now().toString(36)}`;
    const onchainDbName = `${dbName}-onchain`;
    try {
      await giftRequest({ type: "giftOpen", mnemonic: giftMnemonic, dbName, onchainDbName }, GIFT_PEEK_OPEN_TIMEOUT_MS);
      return classifyGiftScan(await giftCall("recoveryStatus"));
    } catch {
      return "unknown";
    } finally {
      terminateGiftWorker();
      await Promise.all([deleteDb(dbName), deleteDb(onchainDbName)]).catch(() => {});
    }
  });
}

// Sweeps an unclaimed outgoing gift back to `ownArkAddress` (manual "Vzít
// zpět", or the 7-day auto-return). Same shape as a claim; a gift the
// recipient already took throws GIFT_EMPTY_MESSAGE here too and the caller
// marks it claimed.
export async function reclaimGiftToAddress(
  giftMnemonic: string,
  giftId: string,
  ownArkAddress: string,
): Promise<GiftClaimResult> {
  return claimGiftToAddress(giftMnemonic, giftId, ownArkAddress);
}


// One-time repair for wallets whose local onchain database was permanently
// bloated by a support diagnostic that used to live in Settings (removed —
// see ARCHITECTURE.md/git history): it revealed thousands of onchain addresses
// ahead of need while chasing a live "missing VTXO" case, and found nothing
// there. onchainWallet.sync() checks every locally revealed address every
// time (start_sync_with_revealed_spks_at), so past a few thousand that turns
// every future sync() into a call lasting minutes — which is why
// ONCHAIN_SYNC_TIMEOUT_MS (walletCall.ts) is as wide as it is, and why the
// app could feel stuck loading the balance or lock itself out from under the
// user (a slow sync() queued ahead of other calls tripping the worker
// watchdog). Deletes only the onchain wallet's own IndexedDB — the Ark
// wallet DB, its VTXOs, and history are untouched — so the next open
// re-derives onchain addresses from index 0 via the normal, gap-limited
// initialScan() that already runs for a fresh wallet. Called once from
// App.tsx, gated by its own localStorage flag so it never repeats.
export async function resetOnchainWalletDb(): Promise<void> {
  await deleteDb("btc-wallet-mainnet-onchain");
}
