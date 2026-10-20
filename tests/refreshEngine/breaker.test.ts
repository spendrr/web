import { describe, expect, it } from "vitest";
import {
  backoffMs,
  BREAKER,
  charge,
  EMPTY_BREAKER,
  manualReset,
  mayAttempt,
  normalizeBreaker,
  recordFailure,
  recordSuccess,
  resumeOnNewVersion,
  type BreakerState,
} from "../../src/lib/refreshEngine/breaker";

const T = 1_800_000_000_000;
const MIN = 60_000;

describe("breaker", () => {
  it("trips after 5 failures in a row, not 4", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 4; i++) s = recordFailure(s, T + i, "v1");
    expect(s.tripped).toBeNull();
    s = recordFailure(s, T + 5, "v1");
    expect(s.tripped?.reason).toBe("failures");
    expect(mayAttempt(s, T + 10 ** 9)).toEqual({ ok: false, why: "tripped", reason: "failures" });
  });

  it("a success clears the streak", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 4; i++) s = recordFailure(s, T, "v1");
    s = recordSuccess(s);
    s = recordFailure(s, T, "v1");
    expect(s.tripped).toBeNull();
    expect(s.consecutiveFailures).toBe(1);
  });

  it("6 submissions per 24 h pass, the 7th waits for a free slot (never trips)", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 6; i++) {
      const r = charge(s, T + i * MIN);
      expect(r.ok).toBe(true);
      s = r.state;
    }
    const r = charge(s, T + 10 * MIN);
    expect(r.ok).toBe(false);
    expect(r.state.tripped).toBeNull();
    expect(r.state.attempts).toHaveLength(6);
    expect(mayAttempt(s, T + 10 * MIN)).toEqual({ ok: false, why: "rate", until: T + BREAKER.WINDOW_MS });
    expect(mayAttempt(s, T + BREAKER.WINDOW_MS).ok).toBe(true);
  });

  it("an old stored 'rate' trip is dropped", () => {
    const old = { ...EMPTY_BREAKER, tripped: { reason: "rate", at: T, appVersion: "v1" } } as unknown as BreakerState;
    expect(normalizeBreaker(old).tripped).toBeNull();
  });

  it("the window rolls", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 6; i++) s = charge(s, T + i).state;
    expect(charge(s, T + BREAKER.WINDOW_MS).ok).toBe(true);
  });

  it("manual reset lifts a trip but not the 24 h count", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 6; i++) s = charge(s, T + i).state;
    for (let i = 0; i < 5; i++) s = recordFailure(s, T + 10, "v1");
    s = manualReset(s);
    expect(s.tripped).toBeNull();
    expect(charge(s, T + 20).ok).toBe(false);
  });

  it("a new app version resumes, the same one doesn't", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 5; i++) s = recordFailure(s, T, "v1");
    expect(resumeOnNewVersion(s, "v1").tripped).not.toBeNull();
    const r = resumeOnNewVersion(s, "v2");
    expect(r.tripped).toBeNull();
    expect(r.consecutiveFailures).toBe(0);
  });

  it("backoff: 10, 20, 40 min, capped at 6 h; urgent skips it", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(10 * MIN);
    expect(backoffMs(2)).toBe(20 * MIN);
    expect(backoffMs(3)).toBe(40 * MIN);
    expect(backoffMs(40)).toBe(BREAKER.MAX_BACKOFF_MS);
    const s = recordFailure(recordFailure(EMPTY_BREAKER, T, "v1"), T, "v1");
    expect(mayAttempt(s, T + 19 * MIN)).toEqual({ ok: false, why: "backoff", until: T + 20 * MIN });
    expect(mayAttempt(s, T + 20 * MIN)).toEqual({ ok: true });
    expect(mayAttempt(s, T + MIN, { urgent: true })).toEqual({ ok: true });
  });

  it("urgent never skips a trip", () => {
    let s: BreakerState = EMPTY_BREAKER;
    for (let i = 0; i < 5; i++) s = recordFailure(s, T, "v1");
    expect(mayAttempt(s, T, { urgent: true }).ok).toBe(false);
  });
});
