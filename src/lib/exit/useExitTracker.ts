// Keeps the unilateral exit's state for the whole unlocked session: Dashboard
// owns it (it stays mounted while Settings is open) and hands it to the home
// card, the balance note and the exit screen in Settings, so all three show
// the same thing. What it shows comes from exitModel.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExitVtxo } from "@secondts/bark";
import { WORKER_RESTARTED_MESSAGE, pushWorkerWatchdogOverride, type WalletClient } from "../wallet/bark";
import {
  clearExitCompletion,
  dismissExitCompletion,
  getExitClaims,
  getExitCompletion,
  recordExitCompletions,
  setExitClaims,
  setExitLiveHint,
  type ExitCompletion,
} from "./emergencyExit";
import {
  buildExitOverview,
  feesStalled,
  mergeExitTxs,
  pendingCoversFees,
  pruneClaimRecords,
  type ExitClaimRecord,
  type ExitOverview,
  type ExitTxsSeen,
} from "./exitModel";
import {
  INITIAL_GUARD,
  guardOnEnd,
  guardOnLoad,
  guardOnStart,
  loadProgressGuard,
  mayAutoProgress,
  saveProgressGuard,
  takeProgressKilledAt,
  type ProgressGuardState,
} from "./exitProgressGuard";
import { ONCHAIN_SYNC_TIMEOUT_MS, TIMEOUT_MESSAGE, WALLET_CALL_TIMEOUT_MS, isWalletCallTimeout, withTimeout } from "../wallet/walletCall";

// progressExits(): exit progress is gated by block confirmations, so once a
// minute is plenty.
const PROGRESS_INTERVAL_MS = 60_000;
// First progress soon after an exit becomes known (e.g. right after starting
// one), not a full minute later.
const FIRST_PROGRESS_DELAY_MS = 5_000;
// A cheap read (no progress) to notice an exit this app didn't start — bark's
// sync() routes a VTXO someone force-exited on-chain into the exit flow.
const IDLE_CHECK_INTERVAL_MS = 5 * 60_000;
// estimateEmergencyExitFee() syncs the onchain wallet: not every minute.
const FEE_BUDGET_INTERVAL_MS = 10 * 60_000;
// One progressExits() walks every exit's transactions over the network and
// may build CPFPs; a large wallet can take well over the default 60 s worker
// watchdog, which would kill the worker and relock the wallet every minute.
// Same bound as an onchain sync. A call that still outlasts it is caught by
// exitProgressGuard.ts, which spaces the next attempts out instead of
// relocking the wallet again after every unlock.
const PROGRESS_TIMEOUT_MS = 20 * 60_000;

// Exit transactions seen during the running exit (exitModel.ts, mergeExitTxs),
// kept across relocks so the progress count never drops.
const TXS_SEEN_KEY = "btc-wallet-exit-txs-seen";

function loadTxsSeen(): ExitTxsSeen {
  try {
    const raw = localStorage.getItem(TXS_SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "boolean")) as ExitTxsSeen;
  } catch {
    return {};
  }
}

function saveTxsSeen(seen: ExitTxsSeen): void {
  try {
    if (Object.keys(seen).length === 0) localStorage.removeItem(TXS_SEEN_KEY);
    else localStorage.setItem(TXS_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage unavailable: the count just restarts from what bark lists.
  }
}

export interface ExitFeeBudget {
  // What the remaining exit transactions still cost to get on-chain, paid
  // from the confirmed on-chain balance.
  neededSats: number;
  // bark simulated the walk against the confirmed on-chain coins: false means
  // the exit would stall partway.
  fundable: boolean;
  txsToBroadcast: number;
  feeRateSatPerVb: number;
  // The on-chain balance read with it, unconfirmed included: bark only spends
  // confirmed coins, so unconfirmed money covering the rest means "wait for a
  // block", not "send more" (exitModel.ts, feesStalled).
  onchain: { confirmedSats: number; pendingSats: number } | null;
  at: number;
}

export interface ExitTracker {
  // True once the first read succeeded. Before that, "no exit" is unknown.
  loaded: boolean;
  overview: ExitOverview;
  completion: ExitCompletion | null;
  // The last read or progress failed; the data shown is from `checkedAt`.
  error: string | null;
  // A per-coin reason bark gave for not moving an exit forward.
  progressError: string | null;
  checkedAt: number | null;
  feeBudget: ExitFeeBudget | null;
  feeBudgetError: string | null;
  // The exit is stuck because the on-chain balance can't pay the next CPFP
  // (exitModel.ts, feesStalled). From the fee budget when it has answered,
  // and otherwise straight from bark's state (a transaction left in
  // awaiting-cpfp-broadcast, overview.feeStalledSats), which is known long
  // before the slow estimate. Unconfirmed money that covers the rest is a
  // wait for a block, not a stall, for a few blocks.
  feesMissing: boolean;
  // Chain requests since the open that went to Second's esplora because the
  // independent one failed (walletWorkerGuard.ts, exitChainRedirect).
  chainFallbacks: number;
  // Read now; with `progress`, also push the exit forward first.
  refresh: (opts?: { progress?: boolean }) => Promise<void>;
  // Stops progressExits() while the cancel screen is open.
  setPaused: (paused: boolean) => void;
  // A slow or failed progressExits() pushed the next automatic one back to
  // this time (exitProgressGuard.ts); null when not backing off. A manual
  // refresh({progress: true}) still runs.
  progressBackoffUntil: number | null;
  dismissCompletion: () => void;
  // Forgets the previous exit's summary; call when a new exit starts.
  clearCompletion: () => void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useExitTracker(wallet: WalletClient): ExitTracker {
  const [exits, setExits] = useState<ExitVtxo[]>([]);
  const [sdkClaimable, setSdkClaimable] = useState<string[] | null>([]);
  const [expiryHeights, setExpiryHeights] = useState<ReadonlyMap<string, number> | null>(null);
  const [chainTip, setChainTip] = useState<number | null>(null);
  const [chainFallbacks, setChainFallbacks] = useState(0);
  const [claims, setClaims] = useState<ExitClaimRecord[]>(() => getExitClaims());
  const [completion, setCompletion] = useState<ExitCompletion | null>(() => getExitCompletion());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [feeBudget, setFeeBudget] = useState<ExitFeeBudget | null>(null);
  const [feeBudgetError, setFeeBudgetError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  // Re-evaluates the claim grace period without new data.
  const [clock, setClock] = useState(() => Date.now());
  const [txsSeen, setTxsSeen] = useState<ExitTxsSeen>(() => loadTxsSeen());
  const [coveredSinceTip, setCoveredSinceTip] = useState<number | null>(null);

  const inFlight = useRef<Promise<boolean> | null>(null);
  // Loaded once per session: a marker still set means the last session's
  // progressExits() never returned (the worker died under it).
  const guard = useRef<ProgressGuardState | null>(null);
  if (guard.current === null) {
    guard.current = guardOnLoad(loadProgressGuard(), Date.now(), takeProgressKilledAt());
    saveProgressGuard(guard.current);
  }
  const [progressBackoffUntil, setProgressBackoffUntil] = useState<number | null>(() =>
    guard.current && guard.current.notBefore > Date.now() ? guard.current.notBefore : null,
  );
  const setGuard = useCallback((next: ProgressGuardState) => {
    guard.current = next;
    saveProgressGuard(next);
    setProgressBackoffUntil(next.notBefore > Date.now() ? next.notBefore : null);
  }, []);
  // Whether locks were synced since bark last reported no exits at all. An
  // empty list still needs ONE sync: after a reopen bark forgets a canceled
  // exit, and a spendrr-exit lock whose release failed back then would
  // otherwise hide that coin for good (exitLocks.ts releases it exactly when
  // its exit is missing). Idle reads after that skip it.
  const syncedWhileEmpty = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(
    (progress: boolean, manual = false): Promise<boolean> => {
      // Serialized: a manual refresh while the poll runs joins it.
      if (inFlight.current) return inFlight.current;
      const run = (async () => {
        try {
          if (progress && (manual || mayAutoProgress(guard.current!, Date.now()))) {
            const pop = pushWorkerWatchdogOverride(PROGRESS_TIMEOUT_MS);
            // Written before the call: if the worker dies under it, the
            // marker is what the next session finds.
            setGuard(guardOnStart(guard.current!, Date.now()));
            try {
              const statuses = await withTimeout(wallet.progressExits({}), PROGRESS_TIMEOUT_MS, TIMEOUT_MESSAGE);
              setGuard(guardOnEnd(guard.current!, Date.now(), false));
              if (alive.current) setProgressError(statuses.find((s) => s.error)?.error ?? null);
            } catch (e) {
              // Only a deadline or a watchdog kill backs off; an ordinary
              // error from bark or the chain source doesn't.
              setGuard(guardOnEnd(guard.current!, Date.now(), isWalletCallTimeout(e) || message(e) === WORKER_RESTARTED_MESSAGE));
              // Still read below: a progressExits() that keeps failing must
              // not freeze the view (a coin that became claimable, a claim
              // that confirmed) at the last good read.
              if (alive.current) setProgressError(message(e));
            } finally {
              pop();
            }
          }
          const list = await withTimeout(wallet.getExitVtxos(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
          let claimableIds: string[] | null;
          try {
            claimableIds = (await withTimeout(wallet.listClaimableExits(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE)).map(
              (v) => v.vtxoId,
            );
          } catch {
            // exitModel falls back to each exit's own state.
            claimableIds = null;
          }
          // Locks, plus the exiting coins' expiry heights (exitModel.ts,
          // EXIT_EXPIRY_WARN_BLOCKS) from the same worker call. A failure
          // keeps the last known heights: expiry never changes for a VTXO.
          let expiries: ReadonlyMap<string, number> | null = null;
          if (list.length > 0 || !syncedWhileEmpty.current) {
            try {
              const sync = await withTimeout(wallet.syncExitLocks(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
              expiries = new Map(Object.entries(sync.expiryHeights));
              if (alive.current) setChainFallbacks(sync.chainFallbacks ?? 0);
              syncedWhileEmpty.current = list.length === 0;
            } catch (e) {
              console.warn("syncExitLocks failed", e);
            }
          }
          // bark's per-exit tip stands still in the timelock (exitModel.ts);
          // a failure keeps the last known tip.
          let tip: number | null = null;
          if (list.length > 0) {
            try {
              tip = await withTimeout(wallet.onchainWallet.tipHeight(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
            } catch (e) {
              console.warn("tipHeight failed", e);
            }
          }
          const now = Date.now();
          const allClaims = getExitClaims();
          const pruned = pruneClaimRecords(allClaims, list, now);
          setExitClaims(pruned);
          const view = buildExitOverview(list, claimableIds, pruned, now, null, tip);
          setExitLiveHint(view.live);
          // Only for the running exit: the next one counts from zero.
          const seen = view.live ? mergeExitTxs(loadTxsSeen(), view.coins) : {};
          saveTxsSeen(seen);
          // A backoff from this exit must not carry over into the next one.
          if (!view.live && guard.current!.startedAt === null && guard.current!.failures > 0) setGuard(INITIAL_GUARD);
          // From the records BEFORE pruning: the claim of a coin that has
          // just become claimed is exactly the one pruning drops, and it is
          // where that coin's money went.
          const finished = recordExitCompletions(
            view.coins.filter((c) => c.phase === "claimed"),
            allClaims,
            now,
          );
          if (!alive.current) return true;
          setExits(list);
          setSdkClaimable(claimableIds);
          if (expiries) setExpiryHeights(expiries);
          if (tip !== null) setChainTip(tip);
          setTxsSeen(seen);
          setClaims(pruned);
          if (finished) setCompletion(finished);
          setLoaded(true);
          setError(null);
          setCheckedAt(now);
          setClock(now);
          return true;
        } catch (e) {
          // Keep what was shown: a failed read must never read as "no exit".
          if (alive.current) setError(message(e));
          return false;
        }
      })();
      inFlight.current = run;
      void run.finally(() => {
        inFlight.current = null;
      });
      return run;
    },
    [wallet, setGuard],
  );

  const overview = useMemo(
    () => buildExitOverview(exits, sdkClaimable, claims, clock, expiryHeights, chainTip, txsSeen),
    [exits, sdkClaimable, claims, clock, expiryHeights, chainTip, txsSeen],
  );

  // First read, then retry with backoff until one succeeds.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let attempt = 0;
    const tryRead = async () => {
      const ok = await read(false);
      if (cancelled) return;
      if (!ok) {
        attempt += 1;
        timer = window.setTimeout(tryRead, Math.min(30_000, 2_000 * 2 ** (attempt - 1)));
      }
    };
    void tryRead();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [read]);
  // Idle: look for an exit now and then.
  useEffect(() => {
    if (overview.live) return;
    const id = window.setInterval(() => void read(false), IDLE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [overview.live, read]);

  // Live: push the exit forward every minute.
  useEffect(() => {
    if (!overview.live || paused) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      await read(true);
      if (!cancelled) timer = window.setTimeout(tick, PROGRESS_INTERVAL_MS);
    };
    timer = window.setTimeout(tick, FIRST_PROGRESS_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [overview.live, paused, read]);

  // Let a claim's grace period run out on screen without waiting for a poll.
  useEffect(() => {
    if (claims.length === 0) return;
    const id = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [claims.length]);

  // What the remaining exit transactions cost, and whether the on-chain
  // balance covers them. bark skips a CPFP it can't fund without reporting an
  // error (exit/bdk.rs: InsufficientConfirmedFunds -> continue), so this is
  // the only way to tell a stalled exit from a slow one.
  const broadcastingKey = overview.broadcastingIds.join(",");
  useEffect(() => {
    if (broadcastingKey === "") {
      setFeeBudget(null);
      setFeeBudgetError(null);
      return;
    }
    let cancelled = false;
    const ids = broadcastingKey.split(",");
    const check = async () => {
      const pop = pushWorkerWatchdogOverride(ONCHAIN_SYNC_TIMEOUT_MS);
      try {
        const e = await withTimeout(wallet.estimateEmergencyExitFee(ids, null, null), ONCHAIN_SYNC_TIMEOUT_MS, TIMEOUT_MESSAGE);
        // Right after the estimate's own on-chain sync.
        const onchain = await withTimeout(wallet.onchainWallet.balance(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE).catch(
          () => null,
        );
        if (cancelled) return;
        setFeeBudget({
          neededSats: e.exitBroadcastFeeSats,
          fundable: e.fundable,
          txsToBroadcast: e.txsToBroadcast,
          feeRateSatPerVb: e.feeRateSatPerVb,
          onchain: onchain ? { confirmedSats: onchain.confirmedSats, pendingSats: onchain.pendingSats } : null,
          at: Date.now(),
        });
        setFeeBudgetError(null);
      } catch (e) {
        if (!cancelled) setFeeBudgetError(message(e));
      } finally {
        pop();
      }
    };
    void check();
    const id = window.setInterval(() => void check(), FEE_BUDGET_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [broadcastingKey, wallet]);

  // Since which block unconfirmed money has been covering the fee shortfall.
  const pendingCovers =
    overview.broadcastingIds.length > 0 &&
    feeBudget !== null &&
    !feeBudget.fundable &&
    pendingCoversFees(feeBudget.neededSats, feeBudget.onchain);
  const tipNow = overview.tipHeight;
  useEffect(() => {
    if (!pendingCovers) setCoveredSinceTip(null);
    else if (tipNow !== null) setCoveredSinceTip((since) => since ?? tipNow);
  }, [pendingCovers, tipNow]);

  const refresh = useCallback(
    async (opts?: { progress?: boolean }) => {
      setClaims(getExitClaims());
      await read(opts?.progress ?? false, true);
    },
    [read],
  );

  const dismissCompletion = useCallback(() => {
    dismissExitCompletion();
    setCompletion(getExitCompletion());
  }, []);

  const clearCompletion = useCallback(() => {
    clearExitCompletion();
    setCompletion(null);
    saveTxsSeen({});
    setTxsSeen({});
  }, []);

  return {
    clearCompletion,
    loaded,
    overview,
    completion,
    error,
    progressError,
    checkedAt,
    feeBudget,
    feeBudgetError,
    feesMissing: feesStalled({
      broadcasting: overview.broadcastingIds.length > 0,
      fundable: feeBudget?.fundable ?? null,
      feeStalled: overview.feeStalledSats > 0,
      neededSats: feeBudget?.neededSats ?? null,
      onchain: feeBudget?.onchain ?? null,
      coveredSinceTip,
      tip: tipNow,
    }),
    chainFallbacks,
    refresh,
    setPaused,
    progressBackoffUntil,
    dismissCompletion,
  };
}
