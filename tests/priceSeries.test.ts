import { describe, expect, it } from "vitest";
import { appendRing, buildHistory, ringColumn, seriesNameFor, RING_KEEP_MS, type Point, type RingPoint } from "../worker/priceSeries";

const H = 3_600_000;
const NOW = 2_000_000_000_000;
const hourly = (fromAgoH: number, toAgoH: number): Point[] => {
  const out: Point[] = [];
  for (let h = fromAgoH; h >= toAgoH; h--) out.push([NOW - h * H, 100 + h]);
  return out;
};

describe("seriesNameFor", () => {
  it("maps the five ranges onto three fetched series", () => {
    expect(seriesNameFor(1)).toBe("d1");
    for (const d of [7, 30, 90]) expect(seriesNameFor(d)).toBe("d90");
    expect(seriesNameFor(365)).toBe("d365");
    expect(seriesNameFor(2)).toBeNull();
  });
});

describe("appendRing", () => {
  it("drops points older than a day and a bit, keeps order, ignores a step back in time", () => {
    let ring: RingPoint[] = [];
    ring = appendRing(ring, [NOW - RING_KEEP_MS - 1, 1, 1, 1], NOW);
    expect(ring).toHaveLength(0);
    ring = appendRing(ring, [NOW - 1000, 2, 2, 2], NOW);
    ring = appendRing(ring, [NOW - 2000, 3, 3, 3], NOW); // clock step back
    expect(ring.map((p) => p[1])).toEqual([2]);
    ring = appendRing(ring, [NOW, 4, 4, 4], NOW);
    expect(ring.map((p) => p[1])).toEqual([2, 4]);
  });
});

describe("buildHistory", () => {
  it("ends at the current price even when the fetched series is hours old", () => {
    const series = hourly(100, 3); // last point 3 hours old
    const tail: Point[] = [
      [NOW - 2 * H, 200],
      [NOW - H, 201],
      [NOW - 60_000, 202],
    ];
    const out = buildHistory(series, 7, tail, NOW);
    expect(out[out.length - 1]).toEqual([NOW - 60_000, 202]);
  });

  it("cuts a long series to the asked range", () => {
    const series = hourly(24 * 60, 0); // 60 days hourly
    const out = buildHistory(series, 7, [], NOW);
    expect(out[0][0]).toBeGreaterThanOrEqual(NOW - 7 * 24 * H);
    expect(out.length).toBeLessThanOrEqual(7 * 24 + 1);
    expect(out.length).toBeGreaterThan(7 * 24 - 2);
  });

  it("thins the tail on an hourly chart but always keeps the last point", () => {
    const series = hourly(24 * 8, 3);
    const tail: Point[] = [];
    for (let m = 170; m >= 0; m -= 6) tail.push([NOW - m * 60_000, 300 + m]); // every 6 min for ~3h
    const out = buildHistory(series, 7, tail, NOW);
    const added = out.filter((p) => p[0] > NOW - 3 * H);
    expect(added.length).toBeLessThan(6);
    expect(out[out.length - 1][0]).toBe(tail[tail.length - 1][0]);
  });

  it("keeps every logged point on the 1 day chart", () => {
    const series = hourly(30, 3);
    const tail: Point[] = [];
    for (let m = 170; m >= 0; m -= 6) tail.push([NOW - m * 60_000, 300]);
    const out = buildHistory(series, 1, tail, NOW);
    expect(out.length - series.filter((p) => p[0] >= NOW - 24 * H).length).toBe(tail.length);
  });

  it("never puts a logged point at or before the series' own last point", () => {
    const series = hourly(24 * 8, 0);
    const out = buildHistory(series, 7, [[NOW - 5 * H, 9], [NOW, 9]], NOW);
    const ts = out.map((p) => p[0]);
    expect(new Set(ts).size).toBe(ts.length);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("with an empty tail returns the series unchanged", () => {
    const series = hourly(10, 0);
    expect(buildHistory(series, 1, [], NOW)).toEqual(series);
  });
});

describe("ringColumn", () => {
  it("picks one currency", () => {
    const ring: RingPoint[] = [[1, 10, 20, 30]];
    expect(ringColumn(ring, "czk")).toEqual([[1, 10]]);
    expect(ringColumn(ring, "eur")).toEqual([[1, 20]]);
    expect(ringColumn(ring, "usd")).toEqual([[1, 30]]);
  });
});
