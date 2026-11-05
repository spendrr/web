import { describe, expect, it } from "vitest";
import { idleSkipSeconds, LN_IDLE_SKIP_SECONDS, shouldSkipTick } from "../worker/lnSweepIdle";

const calm = { health: { refusing: false }, pending: [] as unknown[], nextDueMs: null as number | null };

describe("idleSkipSeconds", () => {
  it("skips the full window with a healthy node and no open invoice", () => {
    expect(idleSkipSeconds(calm, true)).toBe(LN_IDLE_SKIP_SECONDS);
  });
  it("does not skip while an invoice is due, a switch is on, or the state just changed", () => {
    expect(idleSkipSeconds({ ...calm, pending: [{}] }, true)).toBe(0);
    expect(idleSkipSeconds({ ...calm, health: { refusing: true } }, true)).toBe(0);
    expect(idleSkipSeconds({ ...calm, health: { refusing: false, justTripped: true } }, true)).toBe(0);
    expect(idleSkipSeconds({ ...calm, health: { refusing: false, lifted: true } }, true)).toBe(0);
  });
  it("never skips with the node down", () => {
    expect(idleSkipSeconds(calm, false)).toBe(0);
  });
  it("stops the skip at the moment the next open invoice comes due", () => {
    expect(idleSkipSeconds({ ...calm, nextDueMs: 120_000 }, true)).toBe(120);
    expect(idleSkipSeconds({ ...calm, nextDueMs: 30 * 60_000 }, true)).toBe(LN_IDLE_SKIP_SECONDS);
    expect(idleSkipSeconds({ ...calm, nextDueMs: 59_000 }, true)).toBe(0);
    expect(idleSkipSeconds({ ...calm, nextDueMs: 0 }, true)).toBe(0);
  });
  it("does not skip when the ledger does not report when invoices come due", () => {
    const { nextDueMs: _n, ...old } = calm;
    expect(idleSkipSeconds(old, true)).toBe(0);
  });
});

describe("shouldSkipTick", () => {
  const T = 1_000_000;
  it("skips with a healthy node, no status report due, a marker and no newer invoice", () => {
    expect(shouldSkipTick(true, false, T, null)).toBe(true);
    expect(shouldSkipTick(true, false, T, T - 60_000)).toBe(true);
  });
  it("ticks when an invoice appeared at or after the marked tick", () => {
    expect(shouldSkipTick(true, false, T, T + 5_000)).toBe(false);
    expect(shouldSkipTick(true, false, T, T - 1_000)).toBe(false); // inside the clock margin
  });
  it("ticks when the invoice marker cannot be read, there is no marker, the node is down or a report is due", () => {
    expect(shouldSkipTick(true, false, T, "unknown")).toBe(false);
    expect(shouldSkipTick(true, false, null, null)).toBe(false);
    expect(shouldSkipTick(false, false, T, null)).toBe(false);
    expect(shouldSkipTick(true, true, T, null)).toBe(false);
  });
});
