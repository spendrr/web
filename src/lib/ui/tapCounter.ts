// Counts consecutive deliberate taps for the double-tap-to-lock area.
//
// A touch is a tap only if it is one primary pointer (left button), short,
// and barely moved. Anything else (a drag, a long press, a second finger, a
// right click) is not a tap and also breaks a sequence already under way, so
// two quick scroll attempts or a two-finger touch can never add up to a lock.
// Taps must also land near each other and close in time.
//
// Pure: events carry their own timestamp, so this is testable without a DOM.

export const TAP_MAX_MOVE_PX = 10;
export const TAP_MAX_HOLD_MS = 250;
// Between the two taps of a double-tap.
export const TAP_MAX_GAP_MS = 300;
export const TAP_MAX_APART_PX = 30;

interface Pt {
  x: number;
  y: number;
  t: number;
}

export interface TapDown extends Pt {
  id: number;
  primary: boolean;
  button: number;
}

export interface TapUp extends Pt {
  id: number;
}

export interface TapCounter {
  down(e: TapDown): void;
  // Number of consecutive taps ending with this touch, 0 if it was not a tap
  // (which also clears the sequence).
  up(e: TapUp): number;
  cancel(): void;
  reset(): void;
  readonly count: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function createTapCounter(): TapCounter {
  let start: (Pt & { id: number }) | null = null;
  let active = 0;
  let spoiled = false;
  let taps: Pt[] = [];

  const settle = () => {
    if (active === 0) {
      start = null;
      spoiled = false;
    }
  };

  return {
    down(e) {
      active += 1;
      if (active > 1 || !e.primary || e.button !== 0) {
        spoiled = true;
        taps = [];
        return;
      }
      start = { id: e.id, x: e.x, y: e.y, t: e.t };
    },
    up(e) {
      active = Math.max(0, active - 1);
      const s = start;
      const ok =
        s !== null &&
        !spoiled &&
        s.id === e.id &&
        dist(s, e) <= TAP_MAX_MOVE_PX &&
        e.t - s.t <= TAP_MAX_HOLD_MS;
      settle();
      if (!ok) {
        taps = [];
        return 0;
      }
      const prev = taps[taps.length - 1];
      if (prev && (e.t - prev.t > TAP_MAX_GAP_MS || dist(prev, e) > TAP_MAX_APART_PX)) taps = [];
      taps.push({ x: e.x, y: e.y, t: e.t });
      return taps.length;
    },
    cancel() {
      active = 0;
      start = null;
      spoiled = false;
      taps = [];
    },
    reset() {
      taps = [];
    },
    get count() {
      return taps.length;
    },
  };
}
