// Replays real recordings from two phones (Settings > Záznamník ťuknutí,
// 2026-09-19: two phones, both in cases; "tap-other"
// is 40 taps done "as when paying": bump, lift to look, lower) through
// the real TapDetector and the server's real pairing rule. The recordings
// are labelled with how many times each gesture was actually performed, so
// this measures what matters: real taps that end up paired, and handling
// that ends up paired when it shouldn't.
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapDetector, type TapFeatures, type TapStrength } from "../src/lib/bump/bump";
import { pairLevel } from "../worker/bump";

interface Recording {
  gesture: string;
  device: string;
  count: number | null;
  t: number[];
  ax: (number | null)[];
  ay: (number | null)[];
  az: (number | null)[];
  gx: (number | null)[];
  gy: (number | null)[];
  gz: (number | null)[];
  touches: number[];
}

const { recordings } = JSON.parse(
  gunzipSync(readFileSync(new URL("./fixtures/bump-lab-2026-09-19b.json.gz", import.meta.url))).toString(),
) as { recordings: Recording[] };

interface Hit {
  t: number;
  strength: TapStrength;
  features: TapFeatures;
}

function replay(rec: Recording): Hit[] {
  const hits: Hit[] = [];
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let touchIdx = 0;
  let lastTouch = -Infinity;
  const detector = new TapDetector(
    6,
    (_peak, t, strength, features) => hits.push({ t, strength, features }),
    () => now - lastTouch < 500,
  );
  for (let i = 0; i < rec.t.length; i++) {
    now = rec.t[i];
    while (touchIdx < rec.touches.length && rec.touches[touchIdx] <= now) lastTouch = rec.touches[touchIdx++];
    const v = (a: (number | null)[]) => a[i];
    detector.handle({
      timeStamp: now,
      acceleration: { x: v(rec.ax), y: v(rec.ay), z: v(rec.az) },
      accelerationIncludingGravity: { x: v(rec.gx), y: v(rec.gy), z: v(rec.gz) },
    } as unknown as DeviceMotionEvent);
  }
  return hits;
}

// Two phones on the same wifi (the most permissive locality level), typical
// clock uncertainty from the recordings.
function pairs(a: Hit[], b: Hit[]): [Hit, Hit][] {
  const out: [Hit, Hit][] = [];
  const used = new Set<Hit>();
  for (const x of a) {
    const y = b
      .filter((h) => !used.has(h))
      .sort((p, q) => Math.abs(p.t - x.t) - Math.abs(q.t - x.t))
      .find((h) =>
        pairLevel(
          { kind: x.strength, address: "A", tapTime: x.t, uncertaintyMs: 16, vertical: x.features.vertical, cf: {}, net: "n", shaped: true },
          { kind: h.strength, address: "B", tapTime: h.t, uncertaintyMs: 16, vertical: h.features.vertical, cf: {}, net: "n", shaped: true },
        ) > 0,
      );
    if (y) {
      used.add(y);
      out.push([x, y]);
    }
  }
  return out;
}

const hitsByRec = new Map<Recording, Hit[]>();
const hitsOf = (r: Recording) => {
  if (!hitsByRec.has(r)) hitsByRec.set(r, replay(r));
  return hitsByRec.get(r)!;
};
const both = (gesture: string) => {
  const rs = recordings.filter((r) => r.gesture === gesture);
  return rs.length === 2 ? (rs as [Recording, Recording]) : null;
};

afterEach(() => vi.restoreAllMocks());

describe("recorded taps pair", () => {
  // Minimums sit a little under what the detector currently achieves, so a
  // change that loses real taps fails here. Before the shape check and
  // lower thresholds the same data paired 25, 19 and 22.
  it.each([
    ["tap-top", 25],
    ["tap-side", 19],
    ["tap-soft", 26],
    // Recorded 2026-09-19 afternoon. 35 before the peak-relative post-motion
    // allowance; the rest are in three bursts of heavy handling where
    // neither phone's spike looks like a bump.
    ["tap-other", 38],
  ])("%s", (gesture, min) => {
    const [a, b] = both(gesture)!;
    const p = pairs(hitsOf(a), hitsOf(b));
    // Real taps land within ~35ms. One pair in "tap-other" sits at 71ms,
    // inside a burst of heavy handling: allowed (the server's window is
    // 80ms plus clock uncertainty), but never more than one.
    expect(p.filter(([x, y]) => Math.abs(x.t - y.t) >= 60).length).toBeLessThanOrEqual(1);
    expect(p.length).toBeGreaterThanOrEqual(min);
    // No more pairs than taps performed (+2: both recordings of top-edge
    // taps show two double-bumps the count didn't include).
    expect(p.length).toBeLessThanOrEqual(a.count! + 2);
  });
});

describe("recorded handling doesn't pair", () => {
  it("both phones held in one hand", () => {
    const [a, b] = both("hold-both")!;
    expect(pairs(hitsOf(a), hitsOf(b))).toEqual([]);
  });

  // Before the shape check these sent roughly one candidate per second.
  it.each(["wave", "walk", "hold-both"])("%s: nothing leaves the phone at all", (gesture) => {
    for (const r of recordings.filter((x) => x.gesture === gesture)) expect(hitsOf(r)).toEqual([]);
  });

  // Recorded one phone at a time, so there is no real partner: pair every
  // candidate with an identical copy of itself, as if the other phone felt
  // exactly the same thing at exactly the same instant. Far harsher than
  // reality (two phones never jolt identically).
  const againstTwin = (gesture: string) =>
    recordings
      .filter((x) => x.gesture === gesture)
      .reduce((n, r) => n + pairs(hitsOf(r), hitsOf(r).map((h) => ({ ...h }))).length, 0);

  it("put-downs are tap-shaped, but vetoed as vertical", () => {
    expect(recordings.filter((x) => x.gesture === "putdown").some((r) => hitsOf(r).length > 0)).toBe(true);
    expect(againstTwin("putdown")).toBe(0);
  });

  // The known residue: 3 of 12 lift-offs were tap-shaped and not vertical
  // enough for the veto (+0.53, +0.31, and +0.88, which is exactly as
  // vertical as the most vertical recorded real tap).
  it("pickups, at most the known residue", () => {
    expect(againstTwin("pickup-both")).toBeLessThanOrEqual(3);
  });
});
