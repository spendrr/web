// Keeps a progressExits() that is too slow from relocking the wallet over and
// over (external audit 2026-09-27, N3). One call walks every exit transaction
// of every exiting coin over the chain source; on a deep tree with many coins
// and a rate-limited esplora it can outlast the worker watchdog, which kills
// the worker and relocks the wallet. After the next unlock the tracker used
// to start the same call 5 s later, and the same thing happened again.
//
// A marker is written before each call and removed when it returns. Only two
// things count as a failure and push the next automatic attempt back: the
// call hitting its deadline, and the watchdog killing the worker while it
// was pending (bark.ts records that, recordProgressKilled). A marker left by
// an ordinary lock or a closed tab mid-call is just dropped: counting that
// paused the exit for 15 min after every short visit, exactly the visits a
// push reminder asks for. An ordinary error from bark or the chain source
// (a 429, a failed tx lookup) clears the backoff, so a flaky esplora doesn't
// park the exit for hours. (External audit 2026-09-28 on the N3 fix.)
// Pure core, tests/exitProgressGuard.test.ts; the storage half below.

export interface ProgressGuardState {
  // Set while a progressExits() is in flight.
  startedAt: number | null;
  failures: number;
  // No automatic progressExits() before this.
  notBefore: number;
}

export const PROGRESS_BACKOFF_BASE_MS = 15 * 60_000;
export const PROGRESS_BACKOFF_MAX_MS = 2 * 60 * 60_000;

export const INITIAL_GUARD: ProgressGuardState = { startedAt: null, failures: 0, notBefore: 0 };

function backoff(failures: number): number {
  return Math.min(PROGRESS_BACKOFF_MAX_MS, PROGRESS_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

function fail(s: ProgressGuardState, now: number): ProgressGuardState {
  const failures = s.failures + 1;
  return { startedAt: null, failures, notBefore: now + backoff(failures) };
}

// On a new session. A call still marked in flight is a failure only if the
// worker was killed after it started (`killedAt`); otherwise the session
// just ended under it.
export function guardOnLoad(s: ProgressGuardState, now: number, killedAt: number | null = null): ProgressGuardState {
  if (s.startedAt === null) return s;
  if (killedAt !== null && killedAt >= s.startedAt) return fail(s, now);
  return { ...s, startedAt: null };
}

export function guardOnStart(s: ProgressGuardState, now: number): ProgressGuardState {
  return { ...s, startedAt: now };
}

// `timedOut`: the call hit its deadline. Any other outcome, success or an
// ordinary error bark reported, clears the backoff.
export function guardOnEnd(s: ProgressGuardState, now: number, timedOut: boolean): ProgressGuardState {
  return timedOut ? fail(s, now) : INITIAL_GUARD;
}

export function mayAutoProgress(s: ProgressGuardState, now: number): boolean {
  return now >= s.notBefore;
}

// --- storage -------------------------------------------------------------------

const KEY = "btc-wallet-exit-progress-guard";

export function loadProgressGuard(): ProgressGuardState {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ProgressGuardState>) : null;
    if (
      v &&
      (v.startedAt === null || typeof v.startedAt === "number") &&
      typeof v.failures === "number" &&
      typeof v.notBefore === "number"
    ) {
      return { startedAt: v.startedAt ?? null, failures: v.failures, notBefore: v.notBefore };
    }
  } catch {
    // Corrupt: start over.
  }
  return INITIAL_GUARD;
}

export function saveProgressGuard(s: ProgressGuardState): void {
  try {
    if (s.startedAt === null && s.failures === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Full or blocked storage: the guard just doesn't survive a reload.
  }
}

const KILLED_KEY = "btc-wallet-exit-progress-killed-at";

// bark.ts, when the watchdog resets the worker with a progressExits pending.
export function recordProgressKilled(at: number): void {
  try {
    localStorage.setItem(KILLED_KEY, String(at));
  } catch {
    // Ignored: the next session then reads the marker as a clean close.
  }
}

// Read once and forgotten.
export function takeProgressKilledAt(): number | null {
  try {
    const raw = localStorage.getItem(KILLED_KEY);
    localStorage.removeItem(KILLED_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export function clearProgressGuard(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(KILLED_KEY);
  } catch {
    // Ignored.
  }
}
