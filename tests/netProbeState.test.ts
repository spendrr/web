import { describe, expect, it } from "vitest";
import {
  BAD_OUTCOMES_TO_DECLARE,
  INITIAL_MACHINE,
  PROBE_PAUSE_CAP_MS,
  classifyProbe,
  isIdle,
  nextProbeDelay,
  stepProbe,
  watchdogMayPause,
  watchdogPausedByProbe,
  type ProbeMachine,
  type ProbeOutcome,
  type ProbeResult,
} from "../src/lib/connectivity/netProbeState";

function run(outcomes: ProbeOutcome[], start = 0, gap = 1_000): ProbeMachine {
  let m = INITIAL_MACHINE;
  outcomes.forEach((o, i) => {
    m = stepProbe(m, o, start + i * gap);
  });
  return m;
}

describe("classifyProbe", () => {
  const cases: [ProbeResult, ProbeOutcome][] = [
    [{ origin: true, mempool: true, ark: true }, "online"],
    [{ origin: true, mempool: null, ark: null }, "online"],
    [{ origin: true, mempool: true, ark: false }, "arkDown"],
    [{ origin: true, mempool: false, ark: false }, "arkDown"],
    [{ origin: true, mempool: null, ark: false }, "arkDown"],
    [{ origin: false, mempool: false, ark: false }, "offline"],
    // Both halves agreed on "no internet"; an Ark answer can't happen then
    // in practice, but it must not turn the verdict into "online".
    [{ origin: false, mempool: false, ark: true }, "offline"],
    [{ origin: false, mempool: null, ark: null }, "inconclusive"],
  ];
  it.each(cases)("%j -> %s", (r, expected) => {
    expect(classifyProbe(r)).toBe(expected);
  });

  // A Cloudflare / spendrr.app outage while the user's internet is fine:
  // must not block sends by reading as offline.
  it("does not call an origin outage offline when mempool answers", () => {
    expect(classifyProbe({ origin: false, mempool: true, ark: true })).toBe("online");
    expect(classifyProbe({ origin: false, mempool: true, ark: false })).toBe("arkDown");
  });
});

describe("stepProbe", () => {
  it("needs consecutive bad rounds before declaring offline", () => {
    const one = run(["offline"]);
    expect(one.state).toBe("online");
    expect(run(Array(BAD_OUTCOMES_TO_DECLARE).fill("offline")).state).toBe("offline");
  });

  it("does not count a mixed streak toward either verdict", () => {
    // Still worse than "online", so still needs its own streak.
    expect(run(["offline", "arkDown"]).state).toBe("online");
    expect(run(["arkDown", "offline"]).state).toBe("online");
    expect(run(["offline", "online", "offline"]).state).toBe("online");
  });

  it("recovers on the first online round, fully reset", () => {
    const m = stepProbe(run(["offline", "offline", "offline"]), "online", 10_000);
    expect(m).toEqual(INITIAL_MACHINE);
    expect(isIdle(m)).toBe(true);
  });

  it("moves offline -> arkDown at once (the internet just proved itself)", () => {
    const m = stepProbe(run(["offline", "offline"]), "arkDown", 5_000);
    expect(m.state).toBe("arkDown");
  });

  it("moves arkDown -> offline only after a full streak", () => {
    const base = run(["arkDown", "arkDown"]);
    expect(stepProbe(base, "offline", 5_000).state).toBe("arkDown");
    expect(stepProbe(stepProbe(base, "offline", 5_000), "offline", 6_000).state).toBe("offline");
  });

  it("leaves the state alone on an inconclusive round", () => {
    const off = run(["offline", "offline"]);
    const after = stepProbe(off, "inconclusive", 9_000);
    expect(after.state).toBe("offline");
    expect(after.streak).toBe(off.streak);
    expect(after.troubleSince).toBe(off.troubleSince);
    expect(stepProbe(INITIAL_MACHINE, "inconclusive", 0).state).toBe("online");
  });

  it("keeps troubleSince at the first bad round of the run", () => {
    const m = run(["offline", "arkDown", "offline", "offline"], 1_000, 5_000);
    expect(m.troubleSince).toBe(1_000);
  });
});

describe("probe schedule", () => {
  it("sends nothing while idle", () => {
    expect(nextProbeDelay(INITIAL_MACHINE)).toBeNull();
  });

  it("follows up quickly on a first bad round, then backs off to a ceiling", () => {
    const delays: number[] = [];
    let m = INITIAL_MACHINE;
    for (let i = 0; i < 8; i++) {
      m = stepProbe(m, "offline", i);
      delays.push(nextProbeDelay(m)!);
    }
    expect(delays[0]).toBe(5_000);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    expect(Math.max(...delays)).toBe(30_000);
  });

  // An inconclusive round with nothing wrong so far still has to be retried,
  // otherwise a probe that started from a watchdog would just stop.
  it("keeps probing after an inconclusive round", () => {
    expect(nextProbeDelay(stepProbe(INITIAL_MACHINE, "inconclusive", 0))).not.toBeNull();
  });
});

describe("watchdog pause", () => {
  it("never pauses while online", () => {
    expect(watchdogPausedByProbe(INITIAL_MACHINE, 0)).toBe(false);
    // One bad round is a suspicion, not a verdict.
    expect(watchdogPausedByProbe(run(["offline"]), 1)).toBe(false);
  });

  it("pauses while offline or arkDown, up to the cap", () => {
    for (const kind of ["offline", "arkDown"] as const) {
      const m = run([kind, kind], 0, 1_000);
      expect(watchdogPausedByProbe(m, 2_000)).toBe(true);
      expect(watchdogPausedByProbe(m, PROBE_PAUSE_CAP_MS - 1)).toBe(true);
      expect(watchdogPausedByProbe(m, PROBE_PAUSE_CAP_MS)).toBe(false);
    }
  });

  // The cap runs from the start of the whole bad run, so flipping between
  // offline and arkDown can't keep extending it.
  it("does not restart the cap when the kind of trouble changes", () => {
    let m = run(["offline", "offline"], 0);
    m = stepProbe(m, "arkDown", PROBE_PAUSE_CAP_MS - 10);
    expect(watchdogMayPause(m, PROBE_PAUSE_CAP_MS + 1)).toBe(false);
  });

  it("gets a fresh cap after a real recovery", () => {
    let m = run(["offline", "offline"], 0);
    m = stepProbe(m, "online", PROBE_PAUSE_CAP_MS + 5);
    m = stepProbe(m, "offline", PROBE_PAUSE_CAP_MS + 10);
    m = stepProbe(m, "offline", PROBE_PAUSE_CAP_MS + 20);
    expect(watchdogPausedByProbe(m, PROBE_PAUSE_CAP_MS + 30)).toBe(true);
  });

  // Random sequences: the invariants that the rest of the app leans on.
  it("holds its invariants over random outcome sequences", () => {
    const kinds: ProbeOutcome[] = ["online", "arkDown", "offline", "inconclusive"];
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 500; trial++) {
      let m = INITIAL_MACHINE;
      let now = 0;
      let prev: ProbeOutcome | null = null;
      for (let i = 0; i < 30; i++) {
        const o = kinds[Math.floor(rnd() * kinds.length)];
        now += 1_000 + Math.floor(rnd() * 60_000);
        const before = m;
        m = stepProbe(m, o, now);
        if (o === "online") expect(m).toEqual(INITIAL_MACHINE);
        if (m.state === "online") expect(watchdogPausedByProbe(m, now)).toBe(false);
        if (m.troubleSince !== null) expect(m.troubleSince).toBeLessThanOrEqual(now);
        // A worse state is only ever entered on the second consecutive
        // identical bad outcome.
        if (m.state !== before.state && m.state !== "online" && before.state !== "offline") {
          const worse = before.state === "online" || m.state === "offline";
          if (worse) expect(prev === o && m.streak >= BAD_OUTCOMES_TO_DECLARE).toBe(true);
        }
        if (o !== "inconclusive") prev = o;
      }
    }
  });
});
