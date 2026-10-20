import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isBumpReceiving, setBumpReceiving } from "../src/lib/wallet/paymentPriority";

describe("bump receiving toast suppression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    setBumpReceiving(false);
    vi.useRealTimers();
  });

  it("is off by default and on while the receiving sheet is up", () => {
    setBumpReceiving(false);
    vi.advanceTimersByTime(60_000);
    expect(isBumpReceiving()).toBe(false);
    setBumpReceiving(true);
    expect(isBumpReceiving()).toBe(true);
  });

  it("stays on for a short grace after the sheet goes away, then ends", () => {
    setBumpReceiving(true);
    setBumpReceiving(false);
    vi.advanceTimersByTime(14_000);
    expect(isBumpReceiving()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isBumpReceiving()).toBe(false);
  });

  it("expires by itself if the sheet never reports back", () => {
    setBumpReceiving(true);
    vi.advanceTimersByTime(91_000);
    expect(isBumpReceiving()).toBe(false);
  });
});
