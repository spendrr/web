// When the minute cron may skip the Lightning ledger's tick (a Durable Object
// request, 1,440 a day when made every minute). The probe of the node still
// runs every minute, so an outage is seen at once; only the ledger bookkeeping
// (prune slots, list due invoices) waits while nothing is due. A status report
// tick (every 5th minute) always runs, so an idle ledger ticks every 5 minutes.
//
// The skip never reaches past the moment the next open invoice comes due, so no
// invoice is looked at later than its own schedule says. The marker lives in the
// colo's cache: when it is missing (another colo, a purge) the tick simply runs,
// which is the old behaviour.
export const LN_IDLE_SKIP_SECONDS = 240;
// Object in the private bucket that the invoice path overwrites when it opens an
// invoice; its upload time says when the newest invoice appeared.
export const LN_DIRTY_KEY = "ln/dirty";
// R2 and the Worker keep their own clocks: an invoice this close before the tick
// counts as possibly missed.
const DIRTY_MARGIN_MS = 2_000;

// Seconds the ledger may be left alone after this tick; 0 means tick again next minute.
export function idleSkipSeconds(
  tick: {
    health: { refusing: boolean; justTripped?: boolean; lifted?: boolean };
    pending: readonly unknown[];
    nextDueMs?: number | null;
  },
  nodeUp: boolean,
): number {
  if (!nodeUp || tick.pending.length > 0 || tick.health.refusing || tick.health.justTripped || tick.health.lifted) return 0;
  // A ledger that does not say when its open invoices come due (an older one) is not idle while any could be open.
  if (tick.nextDueMs === undefined) return 0;
  if (tick.nextDueMs === null) return LN_IDLE_SKIP_SECONDS;
  // The marker expires on a whole minute at the earliest, so a due time inside the next minute means no skip.
  return tick.nextDueMs < 60_000 ? 0 : Math.min(LN_IDLE_SKIP_SECONDS, Math.floor(tick.nextDueMs / 1000));
}

// `markerStartedAt`: when the tick that set the marker began (null: no marker).
// `dirtyAt`: upload time of the newest-invoice object (null: none yet, "unknown":
// could not be read, which never allows a skip).
export function shouldSkipTick(
  nodeUp: boolean,
  statusReportDue: boolean,
  markerStartedAt: number | null,
  dirtyAt: number | null | "unknown",
): boolean {
  if (!nodeUp || statusReportDue || markerStartedAt === null || dirtyAt === "unknown") return false;
  return dirtyAt === null || dirtyAt < markerStartedAt - DIRTY_MARGIN_MS;
}
