import { describe, expect, it } from "vitest";
import {
  INITIAL_GUARD,
  PROGRESS_BACKOFF_BASE_MS,
  PROGRESS_BACKOFF_MAX_MS,
  guardOnEnd,
  guardOnLoad,
  guardOnStart,
  mayAutoProgress,
} from "../src/lib/exit/exitProgressGuard";

describe("exit progress guard (external audit 2026-09-27, N3)", () => {
  it("backs off after a call the watchdog killed the worker under", () => {
    const inFlight = guardOnStart(INITIAL_GUARD, 1_000);
    const next = guardOnLoad(inFlight, 5_000, 2_000);
    expect(next.failures).toBe(1);
    expect(mayAutoProgress(next, 5_000)).toBe(false);
    expect(mayAutoProgress(next, 5_000 + PROGRESS_BACKOFF_BASE_MS)).toBe(true);
  });

  it("doubles the wait per timeout, capped", () => {
    let s = INITIAL_GUARD;
    for (let i = 0; i < 10; i++) s = guardOnEnd(guardOnStart(s, 0), 0, true);
    expect(s.failures).toBe(10);
    expect(s.notBefore).toBe(PROGRESS_BACKOFF_MAX_MS);
    const two = guardOnEnd(guardOnStart(guardOnEnd(guardOnStart(INITIAL_GUARD, 0), 0, true), 0), 0, true);
    expect(two.notBefore).toBe(2 * PROGRESS_BACKOFF_BASE_MS);
  });

  it("drops the marker of a session that just ended mid-call (lock, closed tab), no backoff", () => {
    const inFlight = guardOnStart(INITIAL_GUARD, 1_000);
    expect(guardOnLoad(inFlight, 5_000)).toEqual(INITIAL_GUARD);
    // A kill recorded BEFORE this call started belongs to an earlier one.
    expect(guardOnLoad(inFlight, 5_000, 500)).toEqual(INITIAL_GUARD);
  });

  it("clears on a call that returned, and leaves a finished state alone on load", () => {
    const failed = guardOnEnd(guardOnStart(INITIAL_GUARD, 0), 0, true);
    expect(guardOnEnd(guardOnStart(failed, 1), 2, false)).toEqual(INITIAL_GUARD);
    expect(guardOnLoad(failed, 3)).toEqual(failed);
  });
});
