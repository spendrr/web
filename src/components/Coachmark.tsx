import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../lib/i18n";
import "./Coachmark.css";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Spotlight-style coachmark: dims the whole screen except a cutout box
// around `targetRef` (via a box-shadow with an absurdly large spread instead
// of clip-path on an overlay), with a callout bubble anchored below or above
// it. Re-measures on resize/scroll so it stays put if the layout shifts
// (e.g. the balance skeleton resolving to a real number) while it's open.
//
// `visible` drives a CSS transition (opacity/transform only — compositor-only
// properties, same reasoning as the price chart's wipe animation) rather than
// an @keyframes entrance: it flips true one frame after the first real
// measurement, so the highlight/bubble fade and scale in instead of popping
// onto the screen, and flips false on dismiss so they fade back out before
// the component actually unmounts.
export default function Coachmark({
  targetRef,
  text,
  placement = "bottom",
  onDismiss,
  actionLabel,
}: {
  targetRef: RefObject<HTMLElement | null>;
  text: string;
  placement?: "top" | "bottom";
  onDismiss: () => void;
  actionLabel?: string;
}) {
  const t = useT();
  const [rect, setRect] = useState<Rect | null>(null);
  const [visible, setVisible] = useState(false);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const measure = (): Rect | null => {
      const el = targetRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    };
    const sameRect = (a: Rect, b: Rect) =>
      a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

    // The target can still be mid entrance-animation (e.g. ReceivePanel's
    // `.panel-transition` slide-in) the moment this mounts. Measuring right
    // away would lock the highlight onto that in-flux position — and because
    // `.coachmark-highlight` itself transitions top/left/width/height, a
    // later correction doesn't snap into place, it visibly glides there
    // (the "wrong spot, then jumps" symptom). So instead of measuring once
    // and correcting later, poll every frame until the position holds
    // steady for two consecutive frames before ever setting `rect` — that
    // way the very first paint is already the settled position, whatever
    // caused the movement (CSS animation, transition, or layout shift).
    // Capped so a target that never stops moving still resolves to
    // *something* instead of polling forever.
    let rafId: number;
    let last: Rect | null = null;
    let stableFrames = 0;
    let attempts = 0;
    let settled = false;
    const settle = () => {
      const cur = measure();
      attempts++;
      if (!cur) {
        rafId = requestAnimationFrame(settle);
        return;
      }
      stableFrames = last && sameRect(cur, last) ? stableFrames + 1 : 0;
      last = cur;
      if (stableFrames >= 2 || attempts >= 60) {
        settled = true;
        setRect(cur);
        return;
      }
      rafId = requestAnimationFrame(settle);
    };
    rafId = requestAnimationFrame(settle);

    const update = () => {
      if (!settled) return; // `settle` above owns the first measurement
      const cur = measure();
      if (cur) setRect((prev) => (prev && sameRect(prev, cur) ? prev : cur));
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // Content above the target can still arrive after it settled (an exit
    // card, a balance note once the wallet data loads) and shifts it without
    // a resize or scroll event, leaving the highlight on the old spot. Seen
    // on an iPhone: the frame hung ~100pt above the button. A cheap poll
    // catches it; `update` only re-renders when the rect actually moved.
    const pollId = window.setInterval(update, 400);
    return () => {
      window.clearInterval(pollId);
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [targetRef]);

  useEffect(() => {
    if (!rect || visible) return;
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [rect, visible]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    };
  }, []);

  const handleDismiss = () => {
    setVisible(false);
    // Matches the CSS transition duration below — the component keeps
    // rendering (faded out) for this long so the exit actually plays instead
    // of the coachmark just vanishing.
    dismissTimerRef.current = window.setTimeout(onDismiss, 200);
  };

  if (!rect) return null;

  const pad = 8;
  const highlightStyle = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  const bubbleLeft = Math.min(Math.max(rect.left + rect.width / 2, 130), window.innerWidth - 130);
  const bubbleStyle =
    placement === "bottom"
      ? { top: rect.top + rect.height + pad + 12, left: bubbleLeft }
      : { bottom: window.innerHeight - rect.top + pad + 12, left: bubbleLeft };

  return (
    // No onClick here — see Coachmark.css's own comment on .coachmark-overlay
    // for why the whole-screen backdrop must not be a click target. Dismiss
    // is the bubble's explicit button only.
    <div className="coachmark-overlay">
      <div className={`coachmark-highlight${visible ? " is-visible" : ""}`} style={highlightStyle} />
      <div
        className={`coachmark-bubble coachmark-bubble--${placement}${visible ? " is-visible" : ""}`}
        style={bubbleStyle}
      >
        <p>{text}</p>
        <button type="button" onClick={handleDismiss}>
          {actionLabel ?? t("Rozumím")}
        </button>
      </div>
    </div>
  );
}
