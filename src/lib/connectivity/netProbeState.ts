// Pure state machine behind the active connectivity probe (connectivity.ts).
// No DOM, no timers, no fetch: everything here takes `now` and probe results
// as arguments, so tests/netProbeState.test.ts can drive it directly.
//
// Why a probe at all: navigator.onLine only knows about network interfaces.
// Wi-Fi joined to a dead router, a hotel portal or a phone with no signal all
// read as "online", and the SDK then retries forever instead of failing,
// which the worker watchdog used to read as a wedged worker.

// One round of the probe. `origin` is this app's own origin, reached from the
// main thread. `mempool` (mempool.space, independent of both Cloudflare and
// second.tech) and `ark` (the Ark server) are reached from the wallet worker,
// the only realm allowed to talk to them; null means that half gave no answer
// at all (no worker yet, or the worker didn't reply in time), which is not
// the same as a failed request.
export interface ProbeResult {
  origin: boolean;
  mempool: boolean | null;
  ark: boolean | null;
}

export type ProbeOutcome = "online" | "arkDown" | "offline" | "inconclusive";
export type NetState = "online" | "arkDown" | "offline";

export function classifyProbe(r: ProbeResult): ProbeOutcome {
  // Two independent targets for "is there internet": a Cloudflare or
  // spendrr.app outage alone must never read as the user being offline,
  // because offline blocks sends.
  const internet = r.origin || r.mempool === true;
  if (internet) return r.ark === false ? "arkDown" : "online";
  // Our origin failed and the worker never answered: one data point only,
  // and the one that says least about the user's own link. Keep whatever the
  // state was and try again.
  if (r.mempool === null) return "inconclusive";
  return "offline";
}

export interface ProbeMachine {
  state: NetState;
  // Consecutive bad outcomes of the same kind, and which kind.
  streakKind: "arkDown" | "offline" | null;
  streak: number;
  // Probes since the last "online" outcome; drives the backoff.
  attempts: number;
  // When the current run of bad outcomes began (first bad outcome after an
  // online one). Bounds how long the watchdog may stay paused on the probe's
  // word, see watchdogMayPause.
  troubleSince: number | null;
}

export const INITIAL_MACHINE: ProbeMachine = {
  state: "online",
  streakKind: null,
  streak: 0,
  attempts: 0,
  troubleSince: null,
};

// Two bad rounds in a row before calling it: one lost packet or a slow
// handshake must not flash "Jsi offline" and block a send.
export const BAD_OUTCOMES_TO_DECLARE = 2;

const RANK: Record<NetState, number> = { offline: 0, arkDown: 1, online: 2 };

export function stepProbe(m: ProbeMachine, outcome: ProbeOutcome, now: number): ProbeMachine {
  if (outcome === "inconclusive") return { ...m, attempts: m.attempts + 1 };
  if (outcome === "online") return INITIAL_MACHINE;
  const streak = m.streakKind === outcome ? m.streak + 1 : 1;
  // Moving to a better state is immediate (offline -> arkDown: the internet
  // just proved itself), moving to a worse one needs the full streak.
  const better = RANK[outcome] > RANK[m.state];
  const state = better || streak >= BAD_OUTCOMES_TO_DECLARE ? outcome : m.state;
  return {
    state,
    streakKind: outcome,
    streak,
    attempts: m.attempts + 1,
    troubleSince: m.troubleSince ?? now,
  };
}

// Nothing is probed while everything works: no traffic in the normal case.
export function isIdle(m: ProbeMachine): boolean {
  return m.state === "online" && m.attempts === 0;
}

const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

// Delay before the next probe, or null when idle.
export function nextProbeDelay(m: ProbeMachine): number | null {
  if (isIdle(m)) return null;
  return BACKOFF_MS[Math.min(Math.max(m.attempts - 1, 0), BACKOFF_MS.length - 1)];
}

// How long the worker watchdog may stay paused on the probe's word. A plain
// navigator.onLine=false pause has no cap (the browser knows for sure); this
// one does, so a worker that really is wedged can't hide behind a probe that
// keeps failing for some other reason. Past it, the watchdog behaves as if
// the probe didn't exist. Long enough for a real dead-Wi-Fi spell (a train,
// a hotel): killing the session then only forces an unlock that cannot finish
// without a network either. Both halves of the probe have to agree before it
// says "offline", so a false one that would need this cap is unlikely.
export const PROBE_PAUSE_CAP_MS = 30 * 60_000;

export function watchdogMayPause(m: ProbeMachine, now: number): boolean {
  return m.troubleSince !== null && now - m.troubleSince < PROBE_PAUSE_CAP_MS;
}

// The watchdog pauses while the state is bad (and within the cap).
export function watchdogPausedByProbe(m: ProbeMachine, now: number): boolean {
  return m.state !== "online" && watchdogMayPause(m, now);
}
