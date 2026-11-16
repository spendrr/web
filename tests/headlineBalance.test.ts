import { describe, expect, it } from "vitest";
import { headlineSats } from "../src/lib/wallet/headlineBalance";

describe("headlineSats", () => {
  it("does not move when a refresh locks its inputs", () => {
    const before = headlineSats({ spendableSats: 200_000, pendingInRoundSats: 0 });
    const locked = headlineSats({ spendableSats: 0, pendingInRoundSats: 200_000 });
    expect(locked).toBe(before);
  });
  it("only loses the refresh fee when the round finishes", () => {
    const done = headlineSats({ spendableSats: 199_900, pendingInRoundSats: 0 });
    expect(done).toBe(199_900);
  });
  it("is spendable alone without a round", () => {
    expect(headlineSats({ spendableSats: 5, pendingInRoundSats: 0 })).toBe(5);
  });
});
