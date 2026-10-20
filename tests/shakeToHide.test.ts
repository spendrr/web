import { describe, expect, it } from "vitest";
import { createShakeDetector, type MotionSample } from "../src/lib/ui/shakeToHide";

const HZ = 60;
const DT = 1000 / HZ;

type Vec3 = { x: number; y: number; z: number };
const X = { x: 1, y: 0, z: 0 };

// One stroke of the hand along `dir`: accelerate, then brake, over `ms`.
function stroke(dir: Vec3, amplitude: number, ms: number, sign = 1): Vec3[] {
  const n = Math.round(ms / DT);
  return Array.from({ length: n }, (_, i) => {
    const a = sign * amplitude * Math.sin((2 * Math.PI * i) / n);
    return { x: dir.x * a, y: dir.y * a, z: dir.z * a };
  });
}

const still = (ms: number): Vec3[] => Array.from({ length: Math.round(ms / DT) }, () => ({ x: 0.1, y: 0, z: 0.05 }));

// Strokes alternating direction, as in there-back-there.
function strokes(count: number, dir: Vec3, amplitude: number, ms: number): Vec3[] {
  return Array.from({ length: count }, (_, i) => stroke(dir, amplitude, ms, i % 2 ? -1 : 1)).flat();
}

function run(trace: Vec3[], gravity?: Vec3): number {
  const detect = createShakeDetector();
  let fired = 0;
  trace.forEach((a, i) => {
    const s: MotionSample = gravity
      ? { t: i * DT, linear: null, withGravity: { x: a.x + gravity.x, y: a.y + gravity.y, z: a.z + gravity.z } }
      : { t: i * DT, linear: a, withGravity: null };
    if (detect(s)) fired++;
  });
  return fired;
}

describe("shake detection", () => {
  it("fires on there-back-there", () => {
    expect(run([...still(300), ...strokes(3, X, 20, 180), ...still(300)])).toBe(1);
  });

  it("fires on a longer shake once per debounce window", () => {
    expect(run([...still(300), ...strokes(6, X, 25, 150), ...still(300)])).toBe(1);
  });

  it("fires on a diagonal shake", () => {
    const d = { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 };
    expect(run([...still(300), ...strokes(3, d, 20, 180), ...still(300)])).toBe(1);
  });

  it("fires from accelerationIncludingGravity alone", () => {
    expect(run([...still(500), ...strokes(3, X, 22, 180), ...still(300)], { x: 0, y: 9.81, z: 0 })).toBe(1);
  });

  it("ignores a single swing", () => {
    expect(run([...still(300), ...stroke(X, 30, 200), ...still(300)])).toBe(0);
  });

  it("ignores a swing there and back", () => {
    expect(run([...still(300), ...strokes(2, X, 30, 200), ...still(300)])).toBe(0);
  });

  it("ignores a phone set down on a table", () => {
    const Z = { x: 0, y: 0, z: 1 };
    const ringing = [45, -35, 28, -20, 14, -9, 5].map((v) => ({ x: 0.3 * v, y: 0, z: v }));
    expect(run([...still(300), ...stroke(Z, 8, 300, -1), ...ringing, ...still(500)])).toBe(0);
  });

  it("ignores several quick taps on a table", () => {
    const tap = [40, -30, 20, -12].map((v) => ({ x: 0, y: 0, z: v }));
    expect(run([...still(200), ...tap, ...still(120), ...tap, ...still(120), ...tap, ...still(300)])).toBe(0);
  });

  it("ignores a shake too weak to mean it", () => {
    expect(run([...still(300), ...strokes(4, X, 8, 180), ...still(300)])).toBe(0);
  });
});
