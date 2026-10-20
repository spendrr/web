// Geometry and motion for the scanner's lock-on (motion design): the corner
// brackets jump from the guide frame onto a detected QR code and then keep
// following it until the result is handed over. Pure, tested in
// tests/qrLock.test.ts; QrScanner.tsx only feeds it corners and draws the box.

export type Point = { x: number; y: number };
// The bracket square: centre, side and rotation in degrees.
export type LockBox = { cx: number; cy: number; side: number; angle: number };

// Maps a point in the video's own pixels to the element showing it with
// `object-fit: cover` (scaled to fill, centred, overflow cropped).
export function coverMapper(videoW: number, videoH: number, elW: number, elH: number): (p: Point) => Point {
  const k = Math.max(elW / videoW, elH / videoH);
  const ox = (elW - videoW * k) / 2;
  const oy = (elH - videoH * k) / 2;
  return (p) => ({ x: p.x * k + ox, y: p.y * k + oy });
}

// The part of the video an `object-fit: cover` element actually shows, in the
// video's own pixels: the whole frame minus what the element crops off.
export function coverVisibleRect(
  videoW: number,
  videoH: number,
  elW: number,
  elH: number,
): { x: number; y: number; w: number; h: number } {
  const k = Math.max(elW / videoW, elH / videoH);
  const w = Math.min(videoW, elW / k);
  const h = Math.min(videoH, elH / k);
  return { x: (videoW - w) / 2, y: (videoH - h) / 2, w, h };
}

// The bracket square around a code from its corners (top-left, top-right,
// bottom-right, bottom-left, as jsQR reports them): centre of the four,
// side from the top and bottom edges plus `pad`, angle of the top edge.
// null for anything degenerate.
export function boxFromCorners(corners: Point[], pad: number): LockBox | null {
  if (corners.length < 4) return null;
  const [tl, tr, br, bl] = corners;
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;
  const side = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2 + pad;
  const angle = foldQuarterTurn((Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI);
  if (![cx, cy, side, angle].every(Number.isFinite) || side <= pad) return null;
  return { cx, cy, side, angle };
}

// The four brackets look the same after every quarter turn, so an angle is
// only meaningful mod 90: folded into [-45, 45), a code held sideways or
// upside down doesn't spin the brackets.
export function foldQuarterTurn(angle: number): number {
  return ((((angle + 45) % 90) + 90) % 90) - 45;
}

// The equivalent of `angle` (mod 90) closest to `from`, so a retarget across
// the ±45 seam turns the short way instead of spinning back.
export function nearestQuarterTurn(angle: number, from: number): number {
  return from + foldQuarterTurn(angle - from);
}

const KEYS = ["cx", "cy", "side", "angle"] as const;
const ZERO: LockBox = { cx: 0, cy: 0, side: 0, angle: 0 };

// Slightly underdamped (damping ratio ~0.62): lands in ~0.4 s with a small
// overshoot, the feel of the old one-shot EASE.spring snap, but it can be
// retargeted mid-flight without a jump because position and velocity carry.
export const LOCK_SPRING = { stiffness: 260, damping: 20 };
// Integration substep; keeps the spring stable however long a frame took.
const MAX_SUBSTEP_S = 1 / 120;

// `targetVel` is how fast the target itself moves. Damping acts on the
// difference, so a target moving at a steady speed is followed without the
// (damping / stiffness) × speed lag a spring has towards a moving point.
export function createLockSpring(
  start: LockBox,
  { stiffness, damping } = LOCK_SPRING,
): { step: (target: LockBox, dtSeconds: number, targetVel?: LockBox) => LockBox } {
  const pos: LockBox = { ...start };
  const vel: LockBox = { ...ZERO };
  return {
    step(target, dtSeconds, targetVel = ZERO) {
      const goal = { ...target, angle: nearestQuarterTurn(target.angle, pos.angle) };
      let left = Math.min(Math.max(dtSeconds, 0), 0.25);
      while (left > 0) {
        const h = Math.min(left, MAX_SUBSTEP_S);
        for (const k of KEYS) {
          vel[k] += (stiffness * (goal[k] - pos[k]) - damping * (vel[k] - targetVel[k])) * h;
          pos[k] += vel[k] * h;
        }
        left -= h;
      }
      return { ...pos };
    },
  };
}

// Where the code is now, from where it was last seen. Sightings are tens of
// milliseconds apart and already that old when they arrive, so the last box
// is carried forward along the code's recent velocity (smoothed against
// jsQR's corner jitter), at most `maxAheadS` past the last sighting; after
// that the code counts as standing still.
export function createBoxPredictor(
  maxAheadS = 0.15,
  smoothing = 0.5,
): {
  see: (box: LockBox, timeS: number) => void;
  predict: (timeS: number) => { box: LockBox; vel: LockBox } | null;
} {
  let last: { box: LockBox; t: number } | null = null;
  let vel: LockBox = { ...ZERO };
  return {
    see(box, timeS) {
      const seen = last ? { ...box, angle: nearestQuarterTurn(box.angle, last.box.angle) } : box;
      if (last && timeS > last.t) {
        const dt = timeS - last.t;
        for (const k of KEYS) vel[k] += smoothing * ((seen[k] - last.box[k]) / dt - vel[k]);
      }
      last = { box: seen, t: timeS };
    },
    predict(timeS) {
      if (!last) return null;
      const since = Math.max(timeS - last.t, 0);
      if (since > maxAheadS) {
        const box = { ...last.box };
        for (const k of KEYS) box[k] += vel[k] * maxAheadS;
        return { box, vel: { ...ZERO } };
      }
      const box = { ...last.box };
      for (const k of KEYS) box[k] += vel[k] * since;
      return { box, vel: { ...vel } };
    },
  };
}
