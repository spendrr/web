import { describe, expect, it } from "vitest";
import { bboxContains, CoverageCache, ELEMENTS_CAP, loadElements, padBbox, type Bbox } from "../src/lib/btcmapCoverage";

type El = { lon: number; lat: number; id: number };
const at = (lon: number, lat: number, id = 0): El => ({ lon, lat, id });

describe("padBbox", () => {
  it("grows the view by half its size on each side", () => {
    expect(padBbox([10, 50, 11, 51])).toEqual([9.5, 49.5, 11.5, 51.5]);
  });
  it("leaves a view alone when the grown box would pass the server's span limit", () => {
    expect(padBbox([0, 0, 8, 8])).toEqual([0, 0, 8, 8]);
  });
  it("stays on the globe", () => {
    const [minLon, minLat, maxLon, maxLat] = padBbox([-179.9, -85.05, -179, -84]);
    expect(minLon).toBe(-180);
    expect(minLat).toBeLessThanOrEqual(-85.05); // the box still contains Leaflet's southernmost view
    expect(maxLon).toBeGreaterThan(-179);
    expect(maxLat).toBeGreaterThan(-84);
  });
});

describe("bboxContains", () => {
  it("is true for a box inside, false for one that sticks out", () => {
    expect(bboxContains([0, 0, 10, 10], [1, 1, 9, 9])).toBe(true);
    expect(bboxContains([0, 0, 10, 10], [1, 1, 11, 9])).toBe(false);
  });
});

describe("loadElements", () => {
  it("asks once for a padded box, then answers views inside it locally", async () => {
    const cache = new CoverageCache<El>();
    const asked: Bbox[] = [];
    const fetchBbox = async (b: Bbox) => {
      asked.push(b);
      return [at(10.2, 50.2, 1), at(11.2, 51.2, 2), at(9.7, 49.7, 3)];
    };
    const first = await loadElements(cache, [10, 50, 11, 51], fetchBbox);
    expect(first?.map((e) => e.id)).toEqual([1]);
    expect(asked).toEqual([[9.5, 49.5, 11.5, 51.5]]);
    // panned by a third of a screen: inside the padded box, no request
    const second = await loadElements(cache, [10.3, 50.3, 11.3, 51.3], fetchBbox);
    expect(second?.map((e) => e.id)).toEqual([2]);
    expect(asked.length).toBe(1);
    // panned far away: a new request
    await loadElements(cache, [20, 50, 21, 51], fetchBbox);
    expect(asked.length).toBe(2);
  });

  it("forgets a response after five minutes", async () => {
    let t = 0;
    const cache = new CoverageCache<El>(() => t);
    let calls = 0;
    const fetchBbox = async () => {
      calls++;
      return [at(10.5, 50.5)];
    };
    await loadElements(cache, [10, 50, 11, 51], fetchBbox);
    t = 4 * 60_000;
    await loadElements(cache, [10.1, 50.1, 10.9, 50.9], fetchBbox);
    expect(calls).toBe(1);
    t = 6 * 60_000;
    await loadElements(cache, [10.1, 50.1, 10.9, 50.9], fetchBbox);
    expect(calls).toBe(2);
  });

  it("never reuses a capped response, and asks for the exact view while the area is dense", async () => {
    const cache = new CoverageCache<El>();
    const many = Array.from({ length: ELEMENTS_CAP }, (_, i) => at(10.5, 50.5, i));
    const asked: Bbox[] = [];
    const fetchBbox = async (b: Bbox) => {
      asked.push(b);
      return many;
    };
    await loadElements(cache, [10, 50, 11, 51], fetchBbox);
    // the padded box came back capped: one more request for the exact view
    expect(asked).toEqual([[9.5, 49.5, 11.5, 51.5], [10, 50, 11, 51]]);
    await loadElements(cache, [10.1, 50.1, 11.1, 51.1], fetchBbox);
    // dense now: a single exact request, nothing reused
    expect(asked.length).toBe(3);
    expect(asked[2]).toEqual([10.1, 50.1, 11.1, 51.1]);
  });

  it("remembers a complete exact view even though the padded box was capped", async () => {
    const cache = new CoverageCache<El>();
    const many = Array.from({ length: ELEMENTS_CAP }, (_, i) => at(10.5, 50.5, i));
    const few = [at(10.5, 50.5, 1)];
    let calls = 0;
    const fetchBbox = async (b: Bbox) => {
      calls++;
      return b[0] === 10 ? few : many; // the exact view [10, ...] is small, the padded box is capped
    };
    await loadElements(cache, [10, 50, 11, 51], fetchBbox);
    expect(calls).toBe(2);
    await loadElements(cache, [10.2, 50.2, 10.8, 50.8], fetchBbox); // inside the exact view
    expect(calls).toBe(2);
  });

  it("returns null when the request fails and remembers nothing", async () => {
    const cache = new CoverageCache<El>();
    expect(await loadElements(cache, [10, 50, 11, 51], async () => null)).toBeNull();
    expect(cache.find([10, 50, 11, 51])).toBeNull();
  });
});
