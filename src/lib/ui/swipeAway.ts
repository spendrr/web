// Swipe sideways to dismiss an island toast. Without it a message that stays up (the Ark
// server is not answering) covers the header for as long as the problem lasts.
//
// Plain functions, no hooks: Dashboard returns early in several places, so a hook there
// would break the order of calls. State of the gesture in progress lives in a WeakMap,
// the element is moved directly (the CSS `translate` property composes with the island's
// own `transform` animation, which an inline `transform` would fight).
import type { PointerEvent } from "react";

const LOCK_PX = 6;
const FAR_PX = 70;
const FLICK_PX = 30;
const FLICK_PX_PER_MS = 0.5;
const OUT_MS = 180;

// Whether a finished drag dismisses: far enough, or a short but quick flick.
export function swipeDismisses(dx: number, ms: number): boolean {
  const d = Math.abs(dx);
  return d >= FAR_PX || (d >= FLICK_PX && d / Math.max(ms, 1) >= FLICK_PX_PER_MS);
}

interface Gesture {
  id: number;
  x0: number;
  y0: number;
  t0: number;
  dx: number;
  locked: boolean;
}

const gestures = new WeakMap<Element, Gesture>();

export function swipeAway(onAway: () => void) {
  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
      gestures.set(e.currentTarget, { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, dx: 0, locked: false });
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const el = e.currentTarget;
      const g = gestures.get(el);
      if (!g || g.id !== e.pointerId) return;
      const dx = e.clientX - g.x0;
      if (!g.locked) {
        if (Math.abs(e.clientY - g.y0) > Math.abs(dx)) return;
        if (Math.abs(dx) < LOCK_PX) return;
        g.locked = true;
        el.setPointerCapture(e.pointerId);
        el.style.transition = "none";
      }
      g.dx = dx;
      el.style.translate = `${dx}px 0`;
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const el = e.currentTarget;
      const g = gestures.get(el);
      gestures.delete(el);
      if (!g || !g.locked) return;
      if (swipeDismisses(g.dx, e.timeStamp - g.t0)) {
        el.style.transition = `translate ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`;
        el.style.translate = `${Math.sign(g.dx) * window.innerWidth}px 0`;
        el.style.opacity = "0";
        window.setTimeout(onAway, OUT_MS);
      } else {
        el.style.transition = "translate 0.25s cubic-bezier(0.3, 1.35, 0.5, 1)";
        el.style.translate = "0 0";
      }
    },
    onPointerCancel(e: PointerEvent<HTMLElement>) {
      const el = e.currentTarget;
      if (gestures.get(el)?.locked) {
        el.style.transition = "translate 0.25s ease";
        el.style.translate = "0 0";
      }
      gestures.delete(el);
    },
  };
}
