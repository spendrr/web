// Circuit breaker for refresh submissions. Pure, so the same rules can run in
// the engine (to decide) and in the wallet worker (to enforce, like
// walletSpendPolicy.ts does for sends): every refreshVtxosDelegated() call
// persists a fresh vtxo key index (derive_store_next_keypair, lib.rs:2187)
// and walks toward the recovery scan's key gap limit (bark's default 250),
// so a loop of failing
// submissions is not free even when nothing moves.
//
// Agreed rules (2026-09-26): stop automatic refresh after 5 failures in a row;
// it resumes on a success (manual path), "Zkusit znovu" in Settings, or a new
// app version. At most 6 submissions in any rolling 24 h: a 7th WAITS until
// the window frees a slot (changed from "trips the breaker" with the user the
// same day: isolation and a >10 M sats balance can legitimately need several
// in a day, and waiting protects the key indices just as well).

export const BREAKER = {
  MAX_CONSECUTIVE_FAILURES: 5,
  MAX_ATTEMPTS_PER_WINDOW: 6,
  WINDOW_MS: 24 * 60 * 60_000,
  // Backoff after a failure: 10 min, doubling, at most 6 h.
  BASE_BACKOFF_MS: 10 * 60_000,
  MAX_BACKOFF_MS: 6 * 60 * 60_000,
} as const;

export type TripReason = "failures";

export interface BreakerState {
  // Timestamps of submissions inside the window (older ones are dropped).
  attempts: number[];
  consecutiveFailures: number;
  lastFailureAt: number | null;
  tripped: { reason: TripReason; at: number; appVersion: string } | null;
}

export const EMPTY_BREAKER: BreakerState = {
  attempts: [],
  consecutiveFailures: 0,
  lastFailureAt: null,
  tripped: null,
};

export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BREAKER.BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), BREAKER.MAX_BACKOFF_MS);
}

export function pruneAttempts(s: BreakerState, now: number): BreakerState {
  return { ...s, attempts: s.attempts.filter((t) => now - t < BREAKER.WINDOW_MS && t <= now) };
}

// A new app version gets a fresh start: the failure may have been ours.
export function resumeOnNewVersion(s: BreakerState, appVersion: string): BreakerState {
  if (s.tripped && s.tripped.appVersion !== appVersion) {
    return { ...s, tripped: null, consecutiveFailures: 0, lastFailureAt: null };
  }
  return s;
}

export type Verdict =
  | { ok: true }
  | { ok: false; why: "tripped"; reason: TripReason }
  | { ok: false; why: "backoff"; until: number }
  | { ok: false; why: "rate"; until: number };

// `urgent` = resubmitting an uncertain submit: it skips the backoff (it has to
// land before the round), never the trip or the rate limit.
export function mayAttempt(s: BreakerState, now: number, opts: { urgent?: boolean } = {}): Verdict {
  if (s.tripped) return { ok: false, why: "tripped", reason: s.tripped.reason };
  if (!opts.urgent && s.lastFailureAt !== null) {
    const until = s.lastFailureAt + backoffMs(s.consecutiveFailures);
    if (now < until) return { ok: false, why: "backoff", until };
  }
  const until = rateFreeAt(s, now);
  if (until !== null) return { ok: false, why: "rate", until };
  return { ok: true };
}

// When the next submission slot opens, or null when one is open now.
export function rateFreeAt(s: BreakerState, now: number): number | null {
  const p = pruneAttempts(s, now);
  if (p.attempts.length < BREAKER.MAX_ATTEMPTS_PER_WINDOW) return null;
  return Math.min(...p.attempts) + BREAKER.WINDOW_MS;
}

// Call right BEFORE a submission, and persist the result before the call: an
// attempt that never returns (worker killed) still counts. Returns the state
// with the attempt charged, or unchanged (tripped, or the window is full and
// the submission has to wait) with nothing charged.
export function charge(s: BreakerState, now: number): { state: BreakerState; ok: boolean } {
  const p = pruneAttempts(s, now);
  if (p.tripped) return { state: p, ok: false };
  if (p.attempts.length >= BREAKER.MAX_ATTEMPTS_PER_WINDOW) return { state: p, ok: false };
  return { state: { ...p, attempts: [...p.attempts, now] }, ok: true };
}

// A stored trip with a reason this version doesn't know (the old "rate") is
// dropped rather than kept forever.
export function normalizeBreaker(s: BreakerState): BreakerState {
  return s.tripped && s.tripped.reason !== "failures" ? { ...s, tripped: null } : s;
}

export function recordSuccess(s: BreakerState): BreakerState {
  return { ...s, consecutiveFailures: 0, lastFailureAt: null, tripped: null };
}

export function recordFailure(s: BreakerState, now: number, appVersion: string): BreakerState {
  const consecutiveFailures = s.consecutiveFailures + 1;
  const tripped =
    s.tripped ??
    (consecutiveFailures >= BREAKER.MAX_CONSECUTIVE_FAILURES ? { reason: "failures" as const, at: now, appVersion } : null);
  return { ...s, consecutiveFailures, lastFailureAt: now, tripped };
}

// "Zkusit znovu": clears the trip and the failure streak. The 24 h attempt
// log stays, so pressing it repeatedly can't lift the rate limit.
export function manualReset(s: BreakerState): BreakerState {
  return { ...s, tripped: null, consecutiveFailures: 0, lastFailureAt: null };
}
