import { describe, expect, it } from "vitest";
import { createDarknessTracker, DARK_HOLD_MS, DARK_LUMA_ENTER, DARK_LUMA_EXIT, meanLuma } from "../src/lib/ui/sceneDarkness";

function pixels(rgb: [number, number, number], count: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) data.set([...rgb, 255], i * 4);
  return data;
}

// Runs samples `stepMs` apart and returns the verdict after each.
function run(lumas: number[], stepMs = 500): boolean[] {
  const track = createDarknessTracker();
  return lumas.map((l, i) => track(l, i * stepMs));
}

describe("meanLuma", () => {
  it("is 0 for black, 255 for white, and weights green most", () => {
    expect(meanLuma(pixels([0, 0, 0], 16))).toBe(0);
    expect(meanLuma(pixels([255, 255, 255], 16))).toBeCloseTo(255);
    expect(meanLuma(pixels([0, 255, 0], 16))).toBeCloseTo(0.587 * 255);
  });

  it("averages over every pixel and ignores alpha", () => {
    const data = new Uint8ClampedArray([200, 200, 200, 0, 0, 0, 0, 255]);
    expect(meanLuma(data)).toBeCloseTo(100);
  });

  it("is NaN without a whole pixel", () => {
    expect(meanLuma([])).toBeNaN();
    expect(meanLuma([10, 20, 30])).toBeNaN();
  });
});

describe("darkness tracker", () => {
  const dark = DARK_LUMA_ENTER - 10;
  const light = DARK_LUMA_EXIT + 10;
  const between = (DARK_LUMA_ENTER + DARK_LUMA_EXIT) / 2;
  const samplesToHold = DARK_HOLD_MS / 500 + 1;

  it("starts light and turns dark only after the hold", () => {
    const out = run(Array(samplesToHold).fill(dark));
    expect(out.slice(0, -1).every((d) => !d)).toBe(true);
    expect(out.at(-1)).toBe(true);
  });

  it("restarts the hold when one bright frame interrupts it", () => {
    const out = run([dark, dark, light, dark, dark]);
    expect(out.every((d) => !d)).toBe(true);
  });

  it("keeps its verdict between the two thresholds", () => {
    expect(run(Array(10).fill(between)).every((d) => !d)).toBe(true);
    const out = run([...Array(samplesToHold).fill(dark), ...Array(10).fill(between)]);
    expect(out.slice(samplesToHold - 1).every((d) => d)).toBe(true);
  });

  it("turns light again only above the exit threshold, after the hold", () => {
    const out = run([...Array(samplesToHold).fill(dark), ...Array(samplesToHold).fill(light)]);
    expect(out.at(samplesToHold - 1)).toBe(true);
    expect(out.slice(samplesToHold, -1).every((d) => d)).toBe(true);
    expect(out.at(-1)).toBe(false);
  });

  it("ignores samples that are not a number", () => {
    const track = createDarknessTracker({ holdMs: 0 });
    expect(track(NaN, 0)).toBe(false);
    expect(track(dark, 1)).toBe(true);
    expect(track(NaN, 2)).toBe(true);
    expect(track(Infinity, 3)).toBe(true);
  });
});
