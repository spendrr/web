import { describe, expect, it } from "vitest";
import { exitFundable } from "../src/lib/exit/exitFunding";

describe("exitFundable", () => {
  it("covers when the confirmed balance reaches the needed fee", () => {
    expect(exitFundable(1_000, 1_000, false)).toBe(true);
    expect(exitFundable(1_000, 5_000, false)).toBe(true);
  });
  it("does not cover when it falls short, whatever the SDK flag says", () => {
    expect(exitFundable(1_000, 999, true)).toBe(false);
    expect(exitFundable(1_000, 0, true)).toBe(false);
  });
  it("uses the SDK flag only when the balance is unreadable", () => {
    expect(exitFundable(1_000, null, true)).toBe(true);
    expect(exitFundable(1_000, null, false)).toBe(false);
  });
});
