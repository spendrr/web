import { BTC_PATH } from "../BitcoinMark";

export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The home row, the "Ovladač" in Dashboard.css: a bare diagonal arrow beside
// the label, no tile around it. The two mirror each other across
// the bar, pointing away from the scan button at the ends.
export function ReceiveArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 7 7 17" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M15.5 17H7V8.5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SendArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 17 17 7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M8.5 7H17v8.5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// "Comet" direction icons for the history list only — a diagonal arrow with
// a short fading trail suggesting motion, picked over a plain
// vertical-arrow-into-a-tray shape after a round of mockups.
// Trail segments are hand-placed on the exact same diagonal as the main
// stroke (parametrically, not eyeballed) — an earlier eyeballed attempt put
// the receive trail visibly off-axis from the arrow it was supposed to
// extend.
// `g`: the beta's pastel-tile icon (design-v2.css) — a longer arrow with no
// trailing dashes, same diagonal.
export function HistoryReceiveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 7L17 17" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M17 9.5V17H9.5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HistorySendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 17L17 7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M9.5 7H17V14.5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8v4.5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GiftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="3" y="8.5" width="18" height="4" rx="1.2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 8.5v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M12 8.5C10 8.5 7.8 8 7.8 6.2 7.8 4.8 8.8 4 10 4c1.6 0 2 2.4 2 4.5Zm0 0c2 0 4.2-.5 4.2-2.3C16.2 4.8 15.2 4 14 4c-1.6 0-2 2.4-2 4.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The mirror of GiftIcon: a speech bubble (the ask) with a receive arrow
// inside it.
export function RequestIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M20.5 14.5A2.5 2.5 0 0 1 18 17H9.5l-6 4.5V6.5A2.5 2.5 0 0 1 6 4h12a2.5 2.5 0 0 1 2.5 2.5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.5v6.2M9 10.7l3 3 3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

// Tabler's "at" glyph (MIT). Reads as "@handle" at a glance, which is what the
// profile screen it opens is about.
export function AtIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-5.5 8.28"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10.6 3.4h2.8l.5 2.4a6.9 6.9 0 0 1 1.8.75l2.1-1.3 2 2-1.3 2.1c.36.56.62 1.17.75 1.8l2.4.5v2.8l-2.4.5a6.9 6.9 0 0 1-.75 1.8l1.3 2.1-2 2-2.1-1.3a6.9 6.9 0 0 1-1.8.75l-.5 2.4h-2.8l-.5-2.4a6.9 6.9 0 0 1-1.8-.75l-2.1 1.3-2-2 1.3-2.1a6.9 6.9 0 0 1-.75-1.8l-2.4-.5v-2.8l2.4-.5c.13-.63.39-1.24.75-1.8l-1.3-2.1 2-2 2.1 1.3a6.9 6.9 0 0 1 1.8-.75z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {/* The gear outline's own bounding-box center is (12, 13.05), not
          (12, 12) — its teeth aren't quite vertically symmetric — so a
          circle at (12,12) reads as shifted relative to the teeth. */}
      <circle cx="12" cy="13.05" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

// The on-chain (vs. Ark/Lightning) receive tab. Used to be a chain-link
// glyph (two linked ovals), which at this icon size read as a generic "∞"
// rather than anything on-chain/Bitcoin-specific, then a circle with a
// unicode ₿ glyph inside — reported as still not reading as "on-chain"
// specifically, since Ark is also Bitcoin, so the ₿ didn't distinguish the
// two tabs. This renders the same official Bitcoin mark path used as the
// onboarding screen's background decoration (BitcoinMark.tsx), filled
// solid rather than that component's thin outline — at this icon's small
// size a filled mark reads clearly where a stroked one gets lost. Same
// viewBox margin as BitcoinMark for the same reason: the path itself
// slightly overshoots 0..24.
export function OnchainIcon() {
  return (
    <svg viewBox="-2.5 -2.5 29 29" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d={BTC_PATH} />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

// Onchain status tag icons ("chunky card" history row) — potvrzeno/čeká/selhalo.
export function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 7.5V12L15 14.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StatusCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 12.5L10 17L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Beta status ring around the round pastel tile (design-v2.css). It follows
// the tile's silhouette INCLUDING its hard shadow: tile + shadow is two equal
// circles offset diagonally by the shadow, so the ring is the capsule around
// them (two half circles joined by straight sides), RING_GAP clear of both
// everywhere. A plain circle around the pair sat far off the tile on the top
// left and tight on the shadow on the bottom right. Only the dashes run
// (stroke-dashoffset over pathLength 100), the shape never turns.
// Keep TILE / TILE_BORDER / SHADOW in step with design-v2.css.
const HISTORY_TILE = 44;

const HISTORY_TILE_BORDER = 2;

const HISTORY_TILE_SHADOW = 1.75;

const RING_GAP = 2.5;

const RING_STROKE = 2;

export function HistoryIconRing({ tone }: { tone: string }) {
  const pad = RING_GAP + RING_STROKE;
  const box = HISTORY_TILE + HISTORY_TILE_SHADOW + 2 * pad;
  const r = HISTORY_TILE / 2 + RING_GAP + RING_STROKE / 2;
  const c1 = pad + HISTORY_TILE / 2;
  const c2 = c1 + HISTORY_TILE_SHADOW;
  const k = r / Math.SQRT2;
  const f = (n: number) => n.toFixed(3);
  // Clockwise from the top right side: around the shadow circle's bottom
  // right, up the bottom left side, around the tile circle's top left.
  const d =
    `M${f(c1 + k)} ${f(c1 - k)} L${f(c2 + k)} ${f(c2 - k)} ` +
    `A${r} ${r} 0 0 1 ${f(c2 + k)} ${f(c2 + k)} A${r} ${r} 0 0 1 ${f(c2 - k)} ${f(c2 + k)} ` +
    `L${f(c1 - k)} ${f(c1 + k)} ` +
    `A${r} ${r} 0 0 1 ${f(c1 - k)} ${f(c1 - k)} A${r} ${r} 0 0 1 ${f(c1 + k)} ${f(c1 - k)} Z`;
  // An absolute child is placed from the padding box, i.e. inside the tile's
  // outline, hence the extra border.
  const offset = -(pad + HISTORY_TILE_BORDER);
  return (
    <svg
      className={`history-icon-ring-g history-icon-ring-g--${tone}`}
      viewBox={`0 0 ${box} ${box}`}
      style={{ left: offset, top: offset, width: box, height: box }}
      fill="none"
      aria-hidden="true"
    >
      <path d={d} pathLength={100} />
    </svg>
  );
}

// The .history-icon-check-layer overlay used for the pending -> confirmed
// flourish (design-v2.css): drawn with stroke-dasharray/dashoffset rather
// than a plain fade so it visibly "draws in", per explicit design feedback
// — the path length (18, in viewBox units) must match the dasharray value
// hardcoded in design-v2.css's history-icon-check-draw keyframes.
export function ConfirmCheckIcon({ onAnimationEnd }: { onAnimationEnd: () => void }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6 12.5l4 4 8.5-9"
        stroke="currentColor"
        strokeWidth="2.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        onAnimationEnd={onAnimationEnd}
      />
    </svg>
  );
}
