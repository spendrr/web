// The two-phase deadline behind bark.ts's worker watchdog.
//
// Every wallet.* call is timed, and a call that blows its deadline doesn't
// just fail: it terminates and recreates the whole worker, rejects every
// other in-flight request and drops the user back to the unlock screen. That
// is the right response to a wedged WASM instance and the wrong response to
// a healthy one that is merely busy, and until this split existed the
// watchdog could not tell the two apart, because it measured from the moment
// a request was *posted* rather than from when the worker began running it.
//
// With one FIFO queue in the worker, "posted" and "running" can be minutes
// apart by design (onchainWallet.sync()'s gap-limited scan is explicitly
// given 20 minutes). So a routine call could be killed, and the session with
// it, purely for having queued behind a slow one. pushWorkerWatchdogOverride
// exists to widen everyone's deadline against exactly that, which then also
// widens the deadline of whatever really is stuck. It is also how
// maintenanceDelegatedWithDeadline's 30s ceiling fired during the 2026-09-19
// stuck-queue incident without the delegated call ever having run.
//
// The worker now posts a "started" ack when a request leaves its queue, and
// the client picks the deadline from the phase the request is in.
export const QUEUE_START_DEADLINE_MS = 20 * 60_000;

export interface WatchdogPhase {
  // False while the request is still queued in the worker, true once its
  // "started" ack has arrived.
  started: boolean;
  // The deadline for this specific call's own execution, from its caller.
  effectiveTimeoutMs: number;
}

// While running, a call is held to its own deadline. While queued it is held
// only to QUEUE_START_DEADLINE_MS, which is about the worker being alive at
// all rather than about this call: whatever sits at the head of the queue is
// running and has its own deadline, so a stalled queue is always cleared by
// the head timing out, never by the calls waiting behind it.
export function watchdogDelayFor(pending: WatchdogPhase): number {
  return pending.started ? pending.effectiveTimeoutMs : QUEUE_START_DEADLINE_MS;
}
