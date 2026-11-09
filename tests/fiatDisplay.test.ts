import { describe, expect, it } from "vitest";
import { niceFiat } from "../src/lib/send/fiatDisplay";

describe("niceFiat", () => {
  it("leaves anything under 100 alone", () => {
    expect(niceFiat(0)).toBe(0);
    expect(niceFiat(4.8)).toBe(4.8);
    expect(niceFiat(99.4)).toBe(99.4);
  });
  it("rounds to two significant figures from 100 up", () => {
    expect(niceFiat(100)).toBe(100);
    expect(niceFiat(122.4)).toBe(120);
    expect(niceFiat(1619)).toBe(1600);
    expect(niceFiat(4996)).toBe(5000);
    expect(niceFiat(12_345)).toBe(12_000);
  });
  it("survives odd input", () => {
    expect(niceFiat(Number.NaN)).toBeNaN();
    expect(niceFiat(-4996)).toBe(-5000);
  });
});
