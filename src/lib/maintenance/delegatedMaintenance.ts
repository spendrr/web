// A delegated refresh participation does NOT lock its input VTXOs locally
// (bark's join_delegated_round_inner never calls lock_vtxos, unlike the
// interactive paths), so until the round finishes the VTXO stays Spendable
// and get_vtxos_to_refresh keeps returning it. Calling maintenanceDelegated()
// on every refresh cycle therefore re-submits the same participation every
// few seconds, and each build_refresh_participation() also persists a fresh
// vtxo key index. Only schedule when no *delegated* round state is pending,
// and serialize the check + schedule so two callers (refresh(), the backup
// settle loop) cannot both pass the check.
import type { RoundFlowKind } from "@secondts/bark";

// Only the field this module reads, so the scheduler can be unit-tested
// without constructing a whole SDK RoundState. The SDK's own RoundState
// (`state: RoundFlowKind`) is structurally assignable to this.
export interface PendingRoundState {
  readonly state?: RoundFlowKind;
}

export interface PendingRoundsSource {
  // Scopes the cooldown below to one wallet. Optional so a test (or any
  // caller that doesn't care) can pass a bare stub.
  readonly fingerprint?: string;
  pendingRoundStates(): Promise<readonly PendingRoundState[]>;
}

// Floor on how often a delegated refresh may be submitted at all, on top of
// the pending-state gate below.
//
// The gate can only suppress a duplicate it can SEE, and there is one it
// structurally cannot: join_delegated_round_inner submits to the server
// (round/mod.rs:1749) before it stores the local round state (:1753), so a
// worker terminated in that window leaves a live participation on the server
// with no local trace whatsoever. pendingRoundStates() then reads empty, the
// gate passes, and the next cycle submits another one. Each submission also
// persists a fresh vtxo key index (derive_store_next_keypair, lib.rs:2187),
// so unbounded retries walk toward the recovery scan's key gap limit (bark's
// default 250), which is
// the one failure in this app that has already cost real money.
//
// A time floor bounds every such path at once, including ones not thought of
// here, without needing to know what the server does with a duplicate
// (closed source, and not something this app should be guessing at). Ten
// minutes is far below the ~hourly round interval, so it cannot delay a
// refresh that would otherwise have made it into a round, while turning a
// worst case of ~900 submissions an hour into 6. It does NOT eliminate the
// orphan case, it only bounds it; what made that case common in the first
// place was spurious worker kills, addressed separately by the watchdog's
// queued/running split (workerWatchdog.ts).
//
// Consequence worth knowing: maintenance_delegated() is sync() +
// progress_pending_rounds() + scheduling in one SDK call, so cooling down
// the call also cools down progress_pending_rounds(). Nothing depends on it
// running every cycle. refresh() calls wallet.sync() unconditionally and
// sync() carries sync_pending_rounds(), which is what actually claims a
// delegated round once it confirms (round/mod.rs:455-517, 1129-1220); the
// only thing left to progress_pending_rounds is an *interactive* state, and
// those are driven by the daemon's round event stream anyway. On a ~hourly
// round cadence a 10 minute granularity there costs nothing.
export const SCHEDULE_COOLDOWN_MS = 10 * 60_000;

// Persisted, not in-memory: the whole point is to survive the worker
// teardown (or tab reload) that created the untracked participation.
export interface AttemptLog {
  now(): number;
  lastAt(key: string): number | null;
  record(key: string, at: number): void;
}

const ATTEMPT_KEY_PREFIX = "btc-wallet-last-delegated-schedule:";

export const browserAttemptLog: AttemptLog = {
  now: () => Date.now(),
  lastAt: (key) => {
    try {
      const raw = localStorage.getItem(ATTEMPT_KEY_PREFIX + key);
      if (raw === null) return null;
      const at = Number(raw);
      // A rewritten or corrupt value must not be able to park the cooldown
      // in the far future and switch refresh off for good, so anything
      // non-finite or ahead of the clock reads as "no record".
      return Number.isFinite(at) && at <= Date.now() ? at : null;
    } catch {
      return null;
    }
  },
  record: (key, at) => {
    try {
      localStorage.setItem(ATTEMPT_KEY_PREFIX + key, String(at));
    } catch {
      // Best-effort. Losing the record costs one extra submission at worst,
      // and a storage failure must not stop maintenance from running.
    }
  },
};

// The one kind that must block a new schedule: its inputs are still
// Spendable, so a second call would hand the very same VTXOs to a second
// participation (the bug this whole module exists for).
const BLOCKING_KIND: RoundFlowKind = "delegated-pending";

// Every other kind is known not to block, and the distinction is
// load-bearing rather than cosmetic:
//
// - "pending"/"ongoing" are interactive participations, and both paths that
//   create one lock their inputs first (round/mod.rs:1616 in join_next_round,
//   :1784 in join_attempt_interactive). Locked VTXOs are not Spendable, so
//   get_vtxos_to_refresh (lib.rs:2256 -> spendable_vtxos, lib.rs:1685) can't
//   return them and there is nothing to double-submit. Blocking on them was
//   actively harmful: sync() deliberately skips ongoing participations
//   (round/mod.rs:1887), and progress_pending_rounds, the only thing that
//   moves one along from our side, lives *inside* the maintenanceDelegated()
//   call this gate was skipping. One stale interactive state left behind by
//   the daemon's own round join therefore switched VTXO refresh off on V2
//   entirely and silently, until either a daemon round event or a manual
//   cancel in Settings -> VTXO mince happened to clear it.
// - "awaiting-confirmations" means the round is done and its inputs are
//   already forfeited, so they are not due any more either. Blocking here
//   would just stall any *other* VTXO's refresh for the whole confirmation
//   wait.
// - "failed"/"canceled" have released their inputs (persist_round_failure)
//   and get dropped from the DB by the next sync_pending_rounds anyway.
const NON_BLOCKING_KINDS: ReadonlySet<string> = new Set<RoundFlowKind>([
  "pending",
  "ongoing",
  "awaiting-confirmations",
  "failed",
  "canceled",
]);

// Exported for the tests: whether one round state should stop us scheduling.
export function blocksDelegatedSchedule(state: PendingRoundState | null | undefined): boolean {
  const kind = state?.state;
  if (kind === BLOCKING_KIND) return true;
  if (typeof kind === "string" && NON_BLOCKING_KINDS.has(kind)) return false;
  // Unrecognised or missing kind. Fail closed (treat it as blocking): the
  // cost of that is a paused refresh, which the expiry-push nudge still
  // covers, whereas failing open re-submits a participation every 4s and
  // burns a key index each time toward the recovery scan's key gap limit.
  // Unreachable with the pinned SDK (RoundFlowKind is a closed union of the
  // six strings above), so the warning is really "the SDK changed shape".
  console.warn("[bark] unrecognised round state kind, blocking delegated refresh:", kind);
  return true;
}

export type DelegatedMaintenanceScheduler = (wallet: PendingRoundsSource) => Promise<boolean>;

export function createDelegatedMaintenanceScheduler(
  schedule: () => Promise<void>,
  attempts: AttemptLog = browserAttemptLog,
  cooldownMs: number = SCHEDULE_COOLDOWN_MS,
): DelegatedMaintenanceScheduler {
  let chain: Promise<unknown> = Promise.resolve();
  return (wallet) => {
    const run = chain.then(async () => {
      const key = wallet.fingerprint ?? "";
      const now = attempts.now();
      const last = attempts.lastAt(key);
      // Checked before pendingRoundStates(), so a cooled-down cycle costs no
      // wallet call at all rather than one per 4s poll.
      if (last !== null && now - last < cooldownMs) return false;
      const pending = await wallet.pendingRoundStates();
      if (pending.some(blocksDelegatedSchedule)) return false;
      // Recorded BEFORE the call, not after: an attempt that never returns
      // (the terminated-worker window above) is exactly the one whose
      // repeat this is meant to bound, and it would leave no record at all
      // if this ran afterwards. A failed attempt counts too, which also
      // stops a permanently rejected refresh (the known phantom VTXO) from
      // re-erroring every 4s.
      attempts.record(key, now);
      await schedule();
      return true;
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

export interface SettleMaintenanceWallet extends PendingRoundsSource {
  sync(): Promise<unknown>;
}

export type SettleMaintenance = (wallet: SettleMaintenanceWallet) => Promise<void>;

// What backup.ts's waitForLocalStateToSettle runs in place of the
// interactive maintenance() on V2.
//
// The scheduler above returning false means it did nothing at all, not even
// the sync() that maintenance_delegated() would have done on its way to the
// scheduling decision (lib.rs:1764). That matters here and nowhere else:
// Dashboard's refresh() always calls wallet.sync() itself one line earlier,
// but the settle loop has no other server round-trip, so a skipped schedule
// would reduce it to polling allVtxos() twice 3s apart and calling that
// "settled". Since the loop exists to stop an incomplete post-recovery-scan
// snapshot being frozen into the cloud backup (the 2026-09-13 incident in
// waitForLocalStateToSettle's own comment), silently dropping its only
// chance to pull new state in is exactly the failure it guards against.
export function createSettleMaintenance(schedule: DelegatedMaintenanceScheduler): SettleMaintenance {
  return async (wallet) => {
    if (await schedule(wallet)) return;
    await wallet.sync();
  };
}
