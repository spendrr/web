// Tests for the double-tap-to-lock detector (src/lib/ui/tapCounter.ts).
// Locking the wallet by accident is annoying, so what must hold is that only
// two deliberate taps count: not drags, holds, two fingers or distant taps.
import { describe, expect, it } from "vitest";
import { createTapCounter, TAP_MAX_APART_PX, TAP_MAX_GAP_MS, TAP_MAX_HOLD_MS, TAP_MAX_MOVE_PX } from "../src/lib/ui/tapCounter";

const down = (id: number, x: number, y: number, t: number, extra: { primary?: boolean; button?: number } = {}) => ({
  id,
  x,
  y,
  t,
  primary: extra.primary ?? true,
  button: extra.button ?? 0,
});

function tap(c: ReturnType<typeof createTapCounter>, id: number, x: number, y: number, t: number, hold = 60) {
  c.down(down(id, x, y, t));
  return c.up({ id, x, y, t: t + hold });
}

describe("tapCounter", () => {
  it("counts two quick taps on the same spot", () => {
    const c = createTapCounter();
    expect(tap(c, 1, 100, 100, 0)).toBe(1);
    expect(tap(c, 2, 102, 101, 200)).toBe(2);
  });

  it("does not count a second tap after the gap", () => {
    const c = createTapCounter();
    tap(c, 1, 100, 100, 0);
    expect(tap(c, 2, 100, 100, 60 + TAP_MAX_GAP_MS + 1)).toBe(1);
  });

  it("does not count taps far apart", () => {
    const c = createTapCounter();
    tap(c, 1, 100, 100, 0);
    expect(tap(c, 2, 100 + TAP_MAX_APART_PX + 5, 100, 200)).toBe(1);
  });

  it("a drag is not a tap and breaks the sequence", () => {
    const c = createTapCounter();
    tap(c, 1, 100, 100, 0);
    c.down(down(2, 100, 100, 150));
    expect(c.up({ id: 2, x: 100, y: 100 + TAP_MAX_MOVE_PX + 5, t: 190 })).toBe(0);
    expect(c.count).toBe(0);
    expect(tap(c, 3, 100, 100, 260)).toBe(1);
  });

  it("two quick scroll flicks never add up to taps", () => {
    const c = createTapCounter();
    c.down(down(1, 100, 100, 0));
    expect(c.up({ id: 1, x: 100, y: 40, t: 90 })).toBe(0);
    c.down(down(2, 100, 100, 150));
    expect(c.up({ id: 2, x: 100, y: 40, t: 240 })).toBe(0);
  });

  it("a long press is not a tap", () => {
    const c = createTapCounter();
    expect(tap(c, 1, 100, 100, 0, TAP_MAX_HOLD_MS + 1)).toBe(0);
  });

  it("a two-finger touch counts for nothing, then a clean pair still works", () => {
    const c = createTapCounter();
    c.down(down(1, 100, 100, 0));
    c.down(down(2, 160, 100, 5, { primary: false }));
    expect(c.up({ id: 1, x: 100, y: 100, t: 60 })).toBe(0);
    expect(c.up({ id: 2, x: 160, y: 100, t: 65 })).toBe(0);
    expect(tap(c, 3, 100, 100, 300)).toBe(1);
    expect(tap(c, 4, 100, 100, 480)).toBe(2);
  });

  it("a second finger landing between two taps breaks the pair", () => {
    const c = createTapCounter();
    tap(c, 1, 100, 100, 0);
    c.down(down(2, 100, 100, 100));
    c.down(down(3, 150, 100, 110, { primary: false }));
    c.up({ id: 2, x: 100, y: 100, t: 150 });
    c.up({ id: 3, x: 150, y: 100, t: 155 });
    expect(c.count).toBe(0);
  });

  it("ignores a right or middle click", () => {
    const c = createTapCounter();
    c.down(down(1, 100, 100, 0, { button: 2 }));
    expect(c.up({ id: 1, x: 100, y: 100, t: 40 })).toBe(0);
  });

  it("a third quick tap reads as three, so the caller can refuse it", () => {
    const c = createTapCounter();
    tap(c, 1, 100, 100, 0);
    tap(c, 2, 100, 100, 150);
    expect(tap(c, 3, 100, 100, 300)).toBe(3);
  });

  it("cancel clears everything", () => {
    const c = createTapCounter();
    tap(c, 1, 100, 100, 0);
    c.cancel();
    expect(c.count).toBe(0);
  });
});
