// "Motion design": the transitions and feedback animations from the
// 2026-09-25 motion pass — screen-to-screen morphs, the arming fill on the
// confirm button, the sending sheen, the scanner locking onto a code, the
// shake on an error, the staggered first load of the activity list, and the
// dissolve + return home after a payment arrives on the Receive screen.
//
// On for everyone, no switch (a stored "off" from the dropped Settings → Vzhled
// switch is ignored). prefers-reduced-motion always wins: nothing here runs
// for someone who has asked their system for less motion.
//
// CSS reads `data-motion="on"` on <html>; JS reads isMotionOn(). Both follow
// the OS setting live.
import { useSyncExternalStore } from "react";

const CHANGE_EVENT = "motion-design-change";

// Same curves as the --ease-* tokens in index.css, for WAAPI calls.
export const EASE = {
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
  in: "cubic-bezier(0.5, 0, 0.75, 0)",
  morph: "cubic-bezier(0.2, 0.9, 0.25, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

// The unlock screen's wrong-password shake (App.tsx's UNLOCK_SHAKE), shared
// so every error in the app shakes the same way.
export const SHAKE_KEYFRAMES: Keyframe[] = Array.from({ length: 25 }, (_, i) => {
  const p = i / 24;
  return { transform: `translateX(${(Math.sin(p * Math.PI * 4) * 6 * (1 - p)).toFixed(2)}px)` };
});

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// Whether the motion pass actually runs right now.
export function isMotionOn(): boolean {
  return !prefersReducedMotion();
}

export function applyMotionDesign(): void {
  const root = document.documentElement;
  if (isMotionOn()) root.setAttribute("data-motion", "on");
  else root.removeAttribute("data-motion");
}

// Called once from main.tsx: sets the attribute and keeps it in step with the
// OS setting for the life of the page.
export function initMotionDesign(): void {
  applyMotionDesign();
  const onAnyChange = () => {
    applyMotionDesign();
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", onAnyChange);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function useMotionOn(): boolean {
  return useSyncExternalStore(subscribe, isMotionOn);
}

// The visible "skin" of a morphing element: fill, outline, corner radius and
// the hard offset shadow. A View Transition only scales flat snapshots, and a
// snapshot's outline and shadow can't follow a box that changes shape (they
// get cropped and then pop). So the morphing box itself carries the skin and
// interpolates it from the source element's to the target's; the snapshots
// only fade out at the start and in at the end, where they match the skin.
export type Skin = { backgroundColor: string; borderRadius: string; boxShadow: string };
export type SkinOverride = Partial<{ background: string; borderColor: string; borderWidth: string; radius: string }>;


export function skinOf(el: Element, override: SkinOverride = {}): Skin {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const radius = override.radius ?? `${Math.min(parseFloat(cs.borderTopLeftRadius) || 0, Math.min(r.width, r.height) / 2)}px`;
  const borderWidth = override.borderWidth ?? cs.borderTopWidth;
  const borderColor = override.borderColor ?? cs.borderTopColor;
  // The outline is an inset shadow rather than a border, so it never changes
  // the box's size; the outer one is the element's own offset shadow.
  const outer = cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow : "rgba(0, 0, 0, 0) 0px 0px 0px 0px";
  // A dimmed element (a disabled button is opacity 0.45, e.g. the Send form's
  // button before a destination is filled in) has to be dimmed in the skin
  // too, or the box lands fully coloured and then snaps to the grey button.
  // Folded into each colour's alpha: an opacity on the group itself would
  // also dim the snapshots, which already carry the element's opacity.
  const alpha = Math.max(0, Math.min(1, parseFloat(cs.opacity)));
  const dim = (color: string) =>
    Number.isFinite(alpha) && alpha < 1 ? `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)` : color;
  const dimShadows = (shadow: string) => shadow.replace(/(rgba?|color)\([^)]*\)/g, (c) => dim(c));
  return {
    backgroundColor: dim(override.background ?? cs.backgroundColor),
    borderRadius: radius,
    boxShadow: `${dim(borderColor)} 0px 0px 0px ${borderWidth} inset, ${dimShadows(outer)}`,
  };
}

type ViewTransitionHandle = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

export type MorphSpec = {
  // view-transition-name of the pair, as named in motion.css.
  name: string;
  from: () => { el: Element; override?: SkinOverride } | null;
  to: () => { el: Element; override?: SkinOverride } | null;
  duration?: number;
  // No transition at all when either end is missing (see withViewTransition).
  requireBothEnds?: boolean;
};

// Runs `update` inside a View Transition when the motion pass is on and the
// browser has the API; otherwise just runs it. `attrs` go on <html> for the
// duration, so CSS can pick the direction and which elements morph. A newer
// transition skips an older one, so only the newest cleans its attributes up.
// `morph` gives the pair's group the interpolated skin (see skinOf).
let transitionToken = 0;
export function withViewTransition(update: () => void, attrs: Record<string, string> = {}, morph?: MorphSpec): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => ViewTransitionHandle;
  };
  if (!isMotionOn() || !doc.startViewTransition || document.hidden) {
    update();
    return;
  }
  // A morph with one end missing (Receive's Lightning tab has no QR, and the
  // tab is remembered for the next visit) leaves the other end hanging alone
  // in its own layer: no transition at all instead. The start is checked
  // here, the target once it is rendered, where the transition is skipped.
  let fromEnd: ReturnType<MorphSpec["from"]> = null;
  try {
    fromEnd = morph ? morph.from() : null;
  } catch {
    fromEnd = null;
  }
  if (morph?.requireBothEnds && !fromEnd) {
    update();
    return;
  }
  const token = ++transitionToken;
  const root = document.documentElement;
  const names = Object.keys(attrs);
  for (const n of names) root.setAttribute(`data-${n}`, attrs[n]);
  let fromSkin: Skin | null = null;
  let toSkin: Skin | null = null;
  try {
    if (fromEnd) fromSkin = skinOf(fromEnd.el, fromEnd.override);
  } catch {
    fromSkin = null;
  }
  let missingTarget = false;
  // Switches motion.css to short fades at both ends of the morph, leaving
  // the middle to the skin. Set before the snapshot so the timing is right
  // from the first frame.
  if (fromSkin) root.setAttribute("data-morph-skin", "");
  let transition: ViewTransitionHandle;
  try {
    transition = doc.startViewTransition(() => {
      update();
      // The new state is rendered by now (update flushes synchronously).
      try {
        const t = morph?.to();
        if (morph?.requireBothEnds && !t) missingTarget = true;
        if (t) toSkin = skinOf(t.el, t.override);
      } catch {
        toSkin = null;
      }
    });
  } catch {
    for (const n of names) root.removeAttribute(`data-${n}`);
    root.removeAttribute("data-morph-skin");
    update();
    return;
  }
  transition.updateCallbackDone
    .then(() => {
      if (missingTarget) transition.skipTransition();
    })
    .catch(() => {});
  transition.ready
    .then(() => {
      if (!morph || !fromSkin || !toSkin) return;
      root.animate([fromSkin, toSkin], {
        duration: morph.duration ?? 460,
        easing: EASE.morph,
        fill: "both",
        pseudoElement: `::view-transition-group(${morph.name})`,
      });
    })
    .catch(() => {});
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (token !== transitionToken) return;
      for (const n of names) root.removeAttribute(`data-${n}`);
      root.removeAttribute("data-morph-skin");
    });
}

export function shake(el: Element | null): void {
  if (!el || !isMotionOn()) return;
  try {
    el.animate(SHAKE_KEYFRAMES, { duration: 480, easing: "linear" });
  } catch {
    // Best-effort only.
  }
}
