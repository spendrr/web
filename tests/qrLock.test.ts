import { describe, expect, it } from "vitest";
import {
  boxFromCorners,
  coverMapper,
  createBoxPredictor,
  createLockSpring,
  coverVisibleRect,
  foldQuarterTurn,
  nearestQuarterTurn,
  type LockBox,
  type Point,
} from "../src/lib/ui/qrLock";

// Corners of a square of `side` centred on (cx, cy), turned by `deg`, in
// jsQR's order: top-left, top-right, bottom-right, bottom-left.
function square(cx: number, cy: number, side: number, deg: number): Point[] {
  const r = (deg * Math.PI) / 180;
  const h = side / 2;
  return [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ].map(([x, y]) => ({ x: cx + x * Math.cos(r) - y * Math.sin(r), y: cy + x * Math.sin(r) + y * Math.cos(r) }));
}

describe("coverMapper", () => {
  it("scales to fill and crops the overflow evenly", () => {
    const map = coverMapper(640, 480, 300, 300);
    expect(map({ x: 320, y: 240 })).toEqual({ x: 150, y: 150 });
    const corner = map({ x: 0, y: 0 });
    expect(corner.y).toBeCloseTo(0);
    expect(corner.x).toBeCloseTo(-50);
  });
});

describe("coverVisibleRect", () => {
  it("is the centred square a square element shows of a landscape frame", () => {
    expect(coverVisibleRect(1280, 720, 300, 300)).toEqual({ x: 280, y: 0, w: 720, h: 720 });
  });

  it("works the same for a portrait frame", () => {
    expect(coverVisibleRect(720, 1280, 300, 300)).toEqual({ x: 0, y: 280, w: 720, h: 720 });
  });

  it("is the whole frame when the element has the frame's shape", () => {
    expect(coverVisibleRect(640, 480, 320, 240)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
  });

  it("lands exactly on the element's edges through coverMapper", () => {
    const r = coverVisibleRect(1280, 720, 331, 331);
    const map = coverMapper(1280, 720, 331, 331);
    const tl = map({ x: r.x, y: r.y });
    const br = map({ x: r.x + r.w, y: r.y + r.h });
    expect(tl.x).toBeCloseTo(0);
    expect(tl.y).toBeCloseTo(0);
    expect(br.x).toBeCloseTo(331);
    expect(br.y).toBeCloseTo(331);
  });
});

describe("boxFromCorners", () => {
  it("finds centre, side (plus pad) and angle", () => {
    const box = boxFromCorners(square(100, 80, 60, 20), 10)!;
    expect(box.cx).toBeCloseTo(100);
    expect(box.cy).toBeCloseTo(80);
    expect(box.side).toBeCloseTo(70);
    expect(box.angle).toBeCloseTo(20);
  });

  it("folds a sideways or upside-down code to the same brackets", () => {
    expect(boxFromCorners(square(0, 0, 50, 90), 0)!.angle).toBeCloseTo(0);
    expect(boxFromCorners(square(0, 0, 50, 180), 0)!.angle).toBeCloseTo(0);
    expect(boxFromCorners(square(0, 0, 50, 120), 0)!.angle).toBeCloseTo(30);
    expect(boxFromCorners(square(0, 0, 50, 60), 0)!.angle).toBeCloseTo(-30);
  });

  it("rejects degenerate input", () => {
    expect(boxFromCorners(square(0, 0, 50, 0).slice(0, 3), 0)).toBeNull();
    expect(boxFromCorners(square(0, 0, 0, 0), 10)).toBeNull();
    expect(boxFromCorners([...square(0, 0, 50, 0).slice(0, 3), { x: NaN, y: 0 }], 0)).toBeNull();
  });
});

describe("quarter turns", () => {
  it("folds into [-45, 45)", () => {
    for (let a = -720; a <= 720; a += 7.5) {
      const f = foldQuarterTurn(a);
      expect(f).toBeGreaterThanOrEqual(-45);
      expect(f).toBeLessThan(45);
      expect(Math.abs((((a - f) % 90) + 90) % 90)).toBeCloseTo(0);
    }
  });

  it("picks the equivalent angle closest to the current one", () => {
    expect(nearestQuarterTurn(40, -40)).toBeCloseTo(-50);
    expect(nearestQuarterTurn(-40, 40)).toBeCloseTo(50);
    expect(nearestQuarterTurn(10, 0)).toBeCloseTo(10);
  });
});

describe("lock spring", () => {
  const start: LockBox = { cx: 150, cy: 150, side: 228, angle: 0 };
  const target: LockBox = { cx: 170, cy: 120, side: 120, angle: 12 };
  const run = (spring: ReturnType<typeof createLockSpring>, to: LockBox, ms: number) => {
    let box = start;
    for (let t = 0; t < ms; t += 16) box = spring.step(to, 0.016);
    return box;
  };

  it("settles on the target within about half a second", () => {
    const box = run(createLockSpring(start), target, 600);
    expect(Math.abs(box.cx - target.cx)).toBeLessThan(0.5);
    expect(Math.abs(box.cy - target.cy)).toBeLessThan(0.5);
    expect(Math.abs(box.side - target.side)).toBeLessThan(0.5);
    expect(Math.abs(box.angle - target.angle)).toBeLessThan(0.2);
  });

  it("overshoots a little, not a lot", () => {
    const spring = createLockSpring(start);
    let minSide = Infinity;
    for (let t = 0; t < 1000; t += 16) minSide = Math.min(minSide, spring.step(target, 0.016).side);
    const overshoot = (target.side - minSide) / (start.side - target.side);
    expect(overshoot).toBeGreaterThan(0.02);
    expect(overshoot).toBeLessThan(0.15);
  });

  it("follows a moving target without jumping", () => {
    const spring = createLockSpring(start);
    let prev = spring.step(target, 0.016);
    for (let i = 1; i < 60; i++) {
      const moving = { ...target, cx: target.cx + i * 2 };
      const next = spring.step(moving, 0.016);
      expect(Math.abs(next.cx - prev.cx)).toBeLessThan(15);
      prev = next;
    }
    // A target moving 2 px per frame is trailed closely, not left behind.
    expect(Math.abs(prev.cx - (target.cx + 59 * 2))).toBeLessThan(12);
  });

  it("turns the short way across the ±45 seam", () => {
    const spring = createLockSpring({ ...start, angle: 40 });
    let box = spring.step({ ...target, angle: -40 }, 0.016);
    for (let t = 0; t < 800; t += 16) box = spring.step({ ...target, angle: -40 }, 0.016);
    expect(box.angle).toBeCloseTo(50, 0);
  });

  it("stays finite after a very long frame", () => {
    const box = createLockSpring(start).step(target, 5);
    expect([box.cx, box.cy, box.side, box.angle].every(Number.isFinite)).toBe(true);
  });
});

describe("following a moving code", () => {
  const at = (cx: number): LockBox => ({ cx, cy: 100, side: 120, angle: 0 });

  it("keeps up with a steady movement when given the target's speed", () => {
    const speed = 200; // px/s, a brisk hand
    const withVel = createLockSpring(at(0));
    const without = createLockSpring(at(0));
    let a = at(0), b = at(0);
    for (let t = 0; t < 1.5; t += 0.016) {
      const target = at(speed * t);
      a = withVel.step(target, 0.016, { cx: speed, cy: 0, side: 0, angle: 0 });
      b = without.step(target, 0.016);
    }
    const goal = speed * 1.5;
    expect(Math.abs(a.cx - goal)).toBeLessThan(5);
    // Without it the spring trails by roughly damping / stiffness × speed.
    expect(goal - b.cx).toBeGreaterThan(10);
  });

  it("carries the last sighting forward, then stops", () => {
    const p = createBoxPredictor(0.15, 1);
    expect(p.predict(0)).toBeNull();
    p.see(at(100), 0);
    p.see(at(110), 0.05); // 200 px/s
    expect(p.predict(0.1)!.box.cx).toBeCloseTo(120);
    expect(p.predict(0.1)!.vel.cx).toBeCloseTo(200);
    const stale = p.predict(1)!;
    expect(stale.box.cx).toBeCloseTo(140);
    expect(stale.vel.cx).toBe(0);
  });

  it("smooths the speed of a jittery sighting", () => {
    const p = createBoxPredictor(0.15, 0.5);
    p.see(at(100), 0);
    p.see(at(100), 0.08);
    p.see(at(108), 0.16); // one 100 px/s jump
    expect(p.predict(0.16)!.vel.cx).toBeCloseTo(50);
  });

  it("measures turning the short way across the ±45 seam", () => {
    const p = createBoxPredictor(0.15, 1);
    p.see({ ...at(0), angle: 44 }, 0);
    p.see({ ...at(0), angle: -44 }, 0.1);
    expect(p.predict(0.1)!.vel.angle).toBeCloseTo(20);
  });
});
