import { useEffect, useLayoutEffect, useRef, useState } from "react";


// Revolut-style rolling-digit animation for the headline balance. Beta (v2
// toggle) — see the `animate` prop, which the caller ties to the *same*
// bumpBalance()/showBalanceBump signal already used for the scale "bump" on
// a confirmed incoming or outgoing payment (see bumpBalance's own comment in
// Dashboard). Deliberately NOT driven by every `text` change — a VTXO
// refresh round or a fiat-rate tick can also change the rendered digits, and
// those should snap silently, not roll.
//
// Only digit characters roll; thousands-separator/currency characters that
// differ just cross-fade. Alignment is right-anchored (pad the shorter
// string on the left) since digits are added/removed from the left as an
// amount grows/shrinks.
// How long RollingDigits will hold the *displayed* value behind the real
// `text` prop, waiting for `animate` to catch up, before giving up and
// snapping silently — see the component's own comment for why a wait is
// needed at all. Picked as a generous multiple of the ~1s gap observed live
// between Dashboard's setBalance() and the bumpBalance() that follows
// wallet.maintenance() settling, not a measured worst case.
const ROLLING_DIGITS_GRACE_MS = 2_000;

// Matches Dashboard.css's font-size transition duration/easing exactly —
// see the roll-vs-scale sync comment on rollStripsRef below for why that
// match has to be exact, not just close.
const ROLL_ANIMATION_MS = 520;
const ROLL_EASING: [number, number, number, number] = [0.22, 1, 0.36, 1];

// Evaluates a CSS cubic-bezier(x1,y1,x2,y2) timing function at progress x
// (0-1), returning the eased y (0-1). Binary-searches the Bezier parameter t
// for the given x (the curve isn't a function of x in closed form), then
// samples y at that t — the standard approach browsers themselves use.
function cubicBezier([x1, y1, x2, y2]: [number, number, number, number]): (x: number) => number {
  const sample = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 20; i++) {
      const guessX = sample(t, x1, x2);
      if (Math.abs(guessX - x) < 1e-4) break;
      if (guessX < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sample(t, y1, y2);
  };
}
const rollEase = cubicBezier(ROLL_EASING);

export function RollingDigits({
  text,
  animate,
  direction,
}: {
  text: string;
  animate: boolean;
  // "up" for an increasing balance (digits scroll upward, like an odometer
  // counting forward — the default look), "down" for a decreasing one
  // (digits scroll downward instead), matching the direction of the actual
  // change rather than always rolling the same way regardless of sign.
  direction: "up" | "down";
}) {
  // `text` updates (Dashboard's setBalance()) land a render or two before
  // `animate` does — bumpBalance() only fires after wallet.maintenance()
  // settles, a real network round-trip — so naively rendering `text`
  // directly makes the number silently snap to its new value first, and the
  // roll (once `animate` finally arrives) replays the same transition a
  // moment later as a redundant-looking echo. `shownText` is what's actually
  // on screen: it lags `text` until either a roll carries it there, or the
  // grace window above elapses with no `animate` signal (a quiet change,
  // e.g. from a VTXO-refresh blip, that was never going to get one).
  const [shownText, setShownText] = useState(text);
  const [prevText, setPrevText] = useState(text);
  const [rolling, setRolling] = useState(false);
  const latestTextRef = useRef(text);
  const rollTimerRef = useRef<number | null>(null);
  const graceTimerRef = useRef<number | null>(null);
  // Populated fresh every render (see below, right before the rolling
  // markup is built) by each .rd-strip's ref callback — what the rAF loop
  // further down actually writes translateY to.
  const rollStripsRef = useRef<HTMLSpanElement[]>([]);
  // Any one live .rd-col, to measure the current (possibly mid-transition)
  // digit-row height from — every digit shares the same height, so one is
  // enough.
  const rollColRef = useRef<HTMLSpanElement | null>(null);
  latestTextRef.current = text;

  // useLayoutEffect, not useEffect: this decides whether to start rolling,
  // and Dashboard.tsx's balanceScaleClass (the 100k/1M font-size step) is
  // derived from the exact same `text`-driving state and therefore updates
  // in the SAME render as this runs. A passive useEffect fires after the
  // browser has already painted that render — showing the old digits at the
  // new (already-scaled) font size for one real frame — and only THEN sets
  // `rolling`, which paints the roll starting a frame late; that one-frame
  // gap between the size change landing and the roll actually starting is
  // exactly what read as a stutter/jerk crossing the 100k/1M threshold.
  // useLayoutEffect runs synchronously before paint, so the size change and
  // the roll's start commit together in one frame instead.
  useLayoutEffect(() => {
    // Deliberately NOT gated on a rising edge of `animate` — Dashboard's own
    // revealedSpendable indirection (see displayBalance's comment) means
    // `animate` routinely goes true a render *before* `text` actually
    // changes, not after, so waiting for the transition false→true would
    // miss it: by the time `text` differs, `animate` has already been true
    // for a render. Checking the live values of both on every run (guarded
    // by `!rolling` so an in-flight roll isn't restarted) handles either
    // ordering.
    if (animate && !rolling && text !== shownText) {
      if (graceTimerRef.current !== null) {
        window.clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      setPrevText(shownText);
      setShownText(text);
      setRolling(true);
      if (rollTimerRef.current !== null) window.clearTimeout(rollTimerRef.current);
      // ROLL_ANIMATION_MS plus a small buffer, so `rolling` never unmounts
      // the animated markup before the rAF-driven roll below actually
      // finishes.
      rollTimerRef.current = window.setTimeout(() => setRolling(false), ROLL_ANIMATION_MS + 55);
      return;
    }
    if (!rolling && text !== shownText && graceTimerRef.current === null) {
      graceTimerRef.current = window.setTimeout(() => {
        graceTimerRef.current = null;
        setShownText(latestTextRef.current);
      }, ROLLING_DIGITS_GRACE_MS);
    }
  }, [text, animate, shownText, rolling]);

  useEffect(() => {
    return () => {
      if (rollTimerRef.current !== null) window.clearTimeout(rollTimerRef.current);
      if (graceTimerRef.current !== null) window.clearTimeout(graceTimerRef.current);
    };
  }, []);

  // Drives each .rd-strip's translateY directly in px, re-measured on every
  // animation frame from a live .rd-col — NOT the CSS keyframe + `-50%`
  // this used to be. A percentage transform and a concurrent font-size
  // transition (Dashboard.css, the 100k/1M scale step) both animate the
  // SAME box height at once, from two independent engines (a
  // compositor-driven transform keyframe vs. a main-thread layout
  // transition) — there's no guarantee they resolve against the same
  // instantaneous height every frame, which read as the roll and the
  // size-shrink drifting apart instead of moving as one motion. Measuring
  // the real, current height every frame and writing the transform
  // ourselves means the roll always matches whatever the font-size
  // transition is actually doing at that instant, by construction — not by
  // hoping two separate animations happen to stay in step.
  rollStripsRef.current = [];
  useLayoutEffect(() => {
    if (!rolling) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const applyFrame = (progress: number) => {
      const col = rollColRef.current;
      if (!col) return;
      const heightPx = col.getBoundingClientRect().height;
      const y = direction === "down" ? -heightPx * (1 - progress) : -heightPx * progress;
      for (const strip of rollStripsRef.current) {
        strip.style.transform = `translateY(${y}px)`;
      }
    };
    if (reduceMotion) {
      applyFrame(1);
      return;
    }
    // Set synchronously (pre-paint, still inside this layout effect) rather
    // than waiting for the first rAF tick — otherwise the very first frame
    // would paint at the default transform:none (i.e. progress 0 on the
    // "up" strip order, but the WRONG end on the "down" one, which starts
    // from the far end) for one frame before the loop corrects it.
    applyFrame(0);
    const startTime = performance.now();
    let rafId: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / ROLL_ANIMATION_MS);
      applyFrame(rollEase(t));
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [rolling, direction]);

  if (!rolling) {
    return <>{shownText}</>;
  }

  // Align digits only — NOT the full formatted string. Thousands
  // separators shift position whenever the digit count crosses a grouping
  // boundary (e.g. "999 999" -> "1 000 000"), so padding/diffing the whole
  // string char-by-char paired the wrong characters up right at that exact
  // boundary (which is also where balanceScaleClass's font-size step
  // lives) and read as the number visibly glitching. Instead, extract just
  // the digits from both strings, align THOSE right-to-left, and walk the
  // target string's own layout (separators, currency symbol, "≈", "sats",
  // decimal point, all rendered statically) consuming one aligned digit per
  // digit character encountered — the non-digit skeleton always matches
  // shownText exactly, with no attempt to cross-fade it against the old
  // string's differently-positioned punctuation.
  const prevDigits = prevText.replace(/[^0-9]/g, "");
  const nextDigits = shownText.replace(/[^0-9]/g, "");
  const digitLen = Math.max(prevDigits.length, nextDigits.length);
  const fromDigits = prevDigits.padStart(digitLen, " ").split("");
  const toDigits = nextDigits.padStart(digitLen, " ").split("");
  let digitCursor = digitLen - nextDigits.length;

  return (
    <span className="rolling-digits">
      {shownText.split("").map((ch, i) => {
        if (!/[0-9]/.test(ch)) {
          return <span key={i}>{ch}</span>;
        }
        const from = fromDigits[digitCursor];
        const to = toDigits[digitCursor];
        digitCursor++;
        if (from === to) return <span key={i}>{to}</span>;
        const fromDigit = <span className="rd-digit">{from === " " ? "" : from}</span>;
        const toDigit = <span className="rd-digit">{to}</span>;
        return (
          <span key={i} className="rd-col" ref={rollColRef}>
            <span
              className="rd-strip"
              ref={(el) => {
                if (el) rollStripsRef.current.push(el);
              }}
            >
              {direction === "down" ? (
                <>
                  {toDigit}
                  {fromDigit}
                </>
              ) : (
                <>
                  {fromDigit}
                  {toDigit}
                </>
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}
