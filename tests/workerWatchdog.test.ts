import { describe, expect, it } from "vitest";
import { QUEUE_START_DEADLINE_MS, watchdogDelayFor } from "../src/lib/wallet/workerWatchdog";

describe("watchdogDelayFor", () => {
  it("holds a running request to its own deadline", () => {
    expect(watchdogDelayFor({ started: true, effectiveTimeoutMs: 30_000 })).toBe(30_000);
  });

  // The 2026-09-19 shape: a 30s delegated-maintenance ceiling fired while
  // the call was still queued behind an interactive maintenance() that had
  // not returned, so the worker was torn down over a call that never ran.
  it("does not hold a queued request to its own deadline", () => {
    expect(watchdogDelayFor({ started: false, effectiveTimeoutMs: 30_000 })).toBe(QUEUE_START_DEADLINE_MS);
  });

  // The queue-start bound has to outlast the longest call that can legally
  // sit in front of one, otherwise it just reproduces the same false kill.
  // onchainWallet.sync()/initialScan() are explicitly given 20 minutes.
  it("allows a queued request to outwait the slowest legitimate call", () => {
    expect(QUEUE_START_DEADLINE_MS).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it("ignores the queue bound once the request is running, even if shorter", () => {
    expect(watchdogDelayFor({ started: true, effectiveTimeoutMs: 1_000 })).toBe(1_000);
  });
});
