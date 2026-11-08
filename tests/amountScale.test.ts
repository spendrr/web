import { describe, expect, it } from "vitest";
import { amountScaleClass } from "../src/lib/ui/amountScale";

describe("amountScaleClass", () => {
  it("steps up at the balance thresholds, by absolute value", () => {
    expect(amountScaleClass(0)).toBe("");
    expect(amountScaleClass(99_999)).toBe("");
    expect(amountScaleClass(100_000)).toBe(" txd-amount--scale-100k");
    expect(amountScaleClass(-1_000_000)).toBe(" txd-amount--scale-1m");
    expect(amountScaleClass(10_000_000)).toBe(" txd-amount--scale-10m");
    expect(amountScaleClass(-100_000_000)).toBe(" txd-amount--scale-100m");
  });
});
