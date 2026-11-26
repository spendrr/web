// Avatar engine v4 ("friends"): a small character drawn from a seed, flat and
// opaque. Six families (astronaut, octopus, angler fish, planet, cactus, robot); the
// seed picks the family and then every part of it (colours, eyes, mouth,
// accessories), so two addresses nearly always look different at a glance and
// a person is easy to remember.
//
// Same contract as avatar.ts: display only, deterministic, no upload and no
// server. The output is a list of AvatarShape (circle, ring, rect, ellipse,
// path with M/L/Z only), so Avatar.tsx and worker/avatarPng.ts draw it with
// the primitives they already have. Strokes (smiles, the lure's stalk) are
// built as filled polygons here for that reason; rotated ellipses are polygons
// too, because the spec's `rotate` turns around the picture's centre.
//
// THE PICTURE MUST NOT CHANGE for a given seed once people recognise it: the
// order of the random draws, the palettes and the geometry all feed the result
// (SEED_PREFIX versions them). A different look needs a new prefix and a note
// in ARCHITECTURE.md. tests/avatarFriends.test.ts pins the family and a few
// colours of fixed seeds.

import { makeRng } from "./avatar";
import type { AvatarShape } from "./avatar";

export const FRIENDS_SEED_PREFIX = "v4|";

export type AvatarFamily = "astronaut" | "octopus" | "angler" | "planet" | "cactus" | "robot" | "ghost";
export const AVATAR_FAMILIES: readonly AvatarFamily[] = ["astronaut", "octopus", "angler", "planet", "cactus", "robot", "ghost"];

export interface FriendSpec {
  family: AvatarFamily;
  // The colour the picture is mostly made of; names are tied to it (friendName.ts).
  main: string;
  background: { from: string; to: string; angle: number };
  shapes: AvatarShape[];
}

type Rng = () => number;
type Pt = [number, number];

const INK = "#1b1a2e";
const PASTEL = ["#ffd9c2", "#bfe8d2", "#bbd2ff", "#f9b8cf", "#d3c4ff", "#ffe08a", "#f2ede4", "#9ed986", "#ffb88a", "#a8e6f0"];
const BODY = ["#e89540", "#2f6fe0", "#e5484d", "#1a8f5e", "#8b5cf6", "#f5c542", "#f472b6", "#2bb3c0", "#ff7a45", "#5b6cff"];
const DEEP = ["#0b1530", "#0e2a47", "#15103a", "#082b2b"];
const SPACE = ["#14173a", "#1d1240", "#0e2a47"];

const pick = <T>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)];
const round1 = (n: number) => Math.round(n * 10) / 10;

function channel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}
const toHex = (v: number[]) => "#" + v.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const dk = (hex: string, k = 0.72) => toHex([0, 1, 2].map((i) => channel(hex, i) * k));
const lt = (hex: string, k = 0.35) => toHex([0, 1, 2].map((i) => channel(hex, i) + (255 - channel(hex, i)) * k));

// A picture must not vanish into its own background (pale pink on pale pink).
// When the body is too close to the background colour, the background becomes
// the dark or the cream one, whichever the body stands out from. It takes no
// random draw, so the rest of the picture is unchanged.
function safeBg(bg: string, body: string): string {
  const d = Math.hypot(channel(bg, 0) - channel(body, 0), channel(bg, 1) - channel(body, 1), channel(bg, 2) - channel(body, 2));
  if (d >= 90) return bg;
  const lum = 0.299 * channel(body, 0) + 0.587 * channel(body, 1) + 0.114 * channel(body, 2);
  return lum > 150 ? "#14173a" : "#f2ede4";
}

// ---- drawing context ---------------------------------------------------------

class Canvas {
  shapes: AvatarShape[] = [];
  private mirror: boolean;
  constructor(mirror = false) {
    this.mirror = mirror;
  }
  private x(v: number) {
    return this.mirror ? 100 - v : v;
  }
  rect(x: number, y: number, w: number, h: number, fill: string, rx = 0) {
    this.shapes.push({
      kind: "rect",
      x: round1(this.mirror ? 100 - x - w : x),
      y: round1(y),
      width: round1(w),
      height: round1(h),
      rx: round1(rx),
      fill,
    });
  }
  circle(cx: number, cy: number, r: number, fill: string, opacity?: number) {
    this.shapes.push({
      kind: "circle",
      cx: round1(this.x(cx)),
      cy: round1(cy),
      r: round1(r),
      fill,
      ...(opacity !== undefined ? { opacity } : {}),
    });
  }
  poly(pts: Pt[], fill: string) {
    const d = "M" + pts.map(([px, py]) => `${round1(this.x(px))} ${round1(py)}`).join("L") + "Z";
    this.shapes.push({ kind: "path", d, fill });
  }
  // `rot` in degrees around the ellipse's own centre.
  ellipse(cx: number, cy: number, rx: number, ry: number, fill: string, rot = 0) {
    if (rot === 0 && !this.mirror) {
      this.shapes.push({ kind: "ellipse", cx: round1(cx), cy: round1(cy), rx: round1(rx), ry: round1(ry), fill });
      return;
    }
    this.poly(ellipsePts(cx, cy, rx, ry, rot), fill);
  }
  // A line of constant width with round ends, as filled shapes.
  line(pts: Pt[], w: number, fill: string) {
    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * (w / 2);
      const ny = (dx / len) * (w / 2);
      left.push([pts[i][0] + nx, pts[i][1] + ny]);
      right.push([pts[i][0] - nx, pts[i][1] - ny]);
    }
    this.poly(left.concat(right.reverse()), fill);
    this.circle(pts[0][0], pts[0][1], w / 2, fill);
    this.circle(pts[pts.length - 1][0], pts[pts.length - 1][1], w / 2, fill);
  }
  eye(x: number, y: number, rad: number, dx = 0, dy = 0, white = "#ffffff") {
    this.circle(x, y, rad, white);
    this.circle(x + dx, y + dy, rad * 0.52, INK);
    this.circle(x + dx + rad * 0.18, y + dy - rad * 0.2, rad * 0.16, "#ffffff");
  }
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, rotDeg: number, n = 28): Pt[] {
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const ex = Math.cos(t) * rx;
    const ey = Math.sin(t) * ry;
    out.push([cx + ex * c - ey * s, cy + ex * s + ey * c]);
  }
  return out;
}

// Points of a quadratic curve p0 -> p2 bent towards p1.
function quad(p0: Pt, p1: Pt, p2: Pt, n = 8): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

const smile = (cv: Canvas, cx: number, cy: number, half: number, drop: number, w = 2.4) =>
  cv.line(quad([cx - half, cy], [cx, cy + drop * 2], [cx + half, cy]), w, INK);

// ---- families ------------------------------------------------------------------
//
// The order of the r() draws inside each one is part of the picture: keep it.

function astronaut(r: Rng): { bg: string; cv: Canvas; main: string } {
  const cv = new Canvas();
  const space = r() < 0.45;
  const bg = space ? pick(r, SPACE) : pick(r, PASTEL);
  if (space) for (let i = 0; i < 9; i++) cv.circle(6 + r() * 88, 6 + r() * 70, 0.7 + r() * 1, "#ffffff");
  const suit = pick(r, ["#f4f1ea", "#f4f1ea", "#e89540", "#2f6fe0", "#e5484d", "#f5c542", "#1a8f5e"]);
  const acc = pick(r, BODY.filter((c) => c !== suit));
  cv.rect(20, 76, 60, 40, suit === "#f4f1ea" ? "#dad6cc" : dk(suit, 0.82), 18);
  cv.rect(44, 80, 12, 10, acc, 2);
  if (r() < 0.5) {
    cv.rect(47.5, 16, 5, 12, dk(suit, 0.7), 2);
    cv.circle(50, 15, 3.8, acc);
  }
  cv.rect(17, 40, 6, 16, acc, 3);
  cv.rect(77, 40, 6, 16, acc, 3);
  cv.circle(50, 50, 32, suit);
  const vt = Math.floor(r() * 3);
  const vc = pick(r, ["#1b2347", "#0f2a3f", "#2a1740"]);
  if (vt === 0) cv.ellipse(50, 50, 23, 19, vc);
  else if (vt === 1) cv.rect(26, 36, 48, 28, vc, 14);
  else cv.rect(27, 33, 46, 34, vc, 17);
  const rf = Math.floor(r() * 4);
  if (rf === 0) {
    cv.circle(40, 52, 7, pick(r, ["#ffc933", "#ff8a5b"]));
    cv.circle(62, 44, 2.2, "#ffffff");
  } else if (rf === 1) {
    cv.circle(58, 50, 8, acc);
    cv.ellipse(58, 50, 13, 2.6, lt(acc, 0.5), -18);
  } else if (rf === 2) {
    for (let i = 0; i < 5; i++) cv.circle(32 + r() * 36, 40 + r() * 20, 1 + r() * 1.2, "#ffffff");
  } else {
    cv.rect(32, 53, 36, 3, pick(r, ["#6fe3ff", "#ff7ad9"]), 1.5);
    cv.rect(38, 59, 24, 2.4, "#7cffb2", 1.2);
  }
  // Highlight on the glass.
  cv.line(quad([33, 44], [36, 38], [44, 36]), 2.6, "#cfd4e6");
  return { bg: safeBg(bg, suit), cv, main: suit === "#f4f1ea" ? acc : suit };
}

function octopus(r: Rng): { bg: string; cv: Canvas; main: string } {
  const cv = new Canvas();
  const bg = pick(r, ["#14173a", "#0e2a47", "#bfe8d2", "#bbd2ff", "#ffd9c2", "#d3c4ff"]);
  const b = pick(r, ["#f472b6", "#8b5cf6", "#ff7a45", "#2bb3c0", "#e5484d", "#5b6cff", "#f5c542"]);
  const n = 4 + Math.floor(r() * 2);
  const cy = 52;
  for (let i = 0; i < n; i++) {
    const x0 = 50 + (i - (n - 1) / 2) * (46 / (n - 1));
    const ph = r() * 6;
    for (let k = 0; k < 12; k++) {
      const t = k / 11;
      const x = x0 + Math.sin(ph + t * 5) * (4 + 6 * t) + (x0 - 50) * t * 0.2;
      cv.circle(x, cy + 14 + t * 34, 6.5 * (1 - t * 0.65), dk(b, 0.88));
    }
  }
  cv.ellipse(50, cy - 2, 27, 26, b);
  const sp = Math.floor(r() * 3);
  if (sp === 0) for (let i = 0; i < 4; i++) cv.circle(36 + r() * 28, 26 + r() * 12, 2 + r() * 2, lt(b, 0.4));
  else if (sp === 1) cv.ellipse(50, 34, 14, 5, lt(b, 0.4));
  const et = Math.floor(r() * 2);
  if (et === 0) {
    cv.eye(40, 52, 6.5);
    cv.eye(60, 52, 6.5);
  } else cv.eye(50, 50, 10);
  smile(cv, 50, et ? 64 : 61, 5, 1.6);
  if (r() < 0.5) {
    cv.circle(31, 60, 3.4, "#ff9db0");
    cv.circle(69, 60, 3.4, "#ff9db0");
  }
  return { bg: safeBg(bg, b), cv, main: b };
}

function angler(r: Rng): { bg: string; cv: Canvas; main: string } {
  const bg = pick(r, DEEP);
  const b = pick(r, ["#e5484d", "#f472b6", "#8b5cf6", "#ff7a45", "#2bb3c0", "#5b6cff", "#f5c542"]);
  const glow = pick(r, ["#fff36b", "#7cffb2", "#6fe3ff", "#ff7ad9"]);
  const stars: Pt[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < 7; i++) {
    stars.push([5 + r() * 90, 5 + r() * 90]);
    sizes.push(0.6 + r() * 1.2);
  }
  const lx = 22 + r() * 8;
  const ly = 16 + r() * 8;
  const k = 3 + Math.floor(r() * 3);
  const ey = Math.floor(r() * 2);
  const spots = r() < 0.6;
  const spotPts: Pt[] = [];
  const spotR: number[] = [];
  if (spots)
    for (let i = 0; i < 4; i++) {
      spotPts.push([54 + r() * 18, 52 + r() * 14]);
      spotR.push(1.5 + r());
    }
  const cv = new Canvas(r() < 0.5);
  stars.forEach((p, i) => cv.circle(p[0], p[1], sizes[i], "#ffffff", 0.5));
  cv.poly([[70, 60], [92, 44], [92, 76]], dk(b, 0.8));
  cv.ellipse(46, 62, 31, 25, b);
  cv.ellipse(46, 70, 24, 13, lt(b, 0.4));
  cv.poly([[44, 38], [52, 30], [58, 40]], dk(b, 0.75));
  cv.line(quad([46, 40], [40, 22], [lx + 8, ly + 4], 10), 2.2, dk(b, 0.7));
  cv.circle(lx + 8, ly + 4, 9, glow, 0.25);
  cv.circle(lx + 8, ly + 4, 5.6, glow);
  cv.line(quad([20, 64], [34, 76], [56, 68], 10), 2.4, INK);
  for (let i = 0; i < k; i++) {
    const x = 24 + i * (26 / k);
    cv.poly([[x, 66 + i * 0.6], [x + 3, 66 + i * 0.6], [x + 1.5, 71]], "#ffffff");
  }
  if (ey === 0) cv.eye(36, 52, 7.5);
  else {
    cv.eye(34, 52, 5.6);
    cv.eye(48, 50, 5);
  }
  cv.ellipse(66, 56, 9, 4, dk(b, 0.8), -15);
  spotPts.forEach((p, i) => cv.circle(p[0], p[1], spotR[i], lt(b, 0.4)));
  return { bg, cv, main: b };
}

function planet(r: Rng): { bg: string; cv: Canvas; main: string } {
  const cv = new Canvas();
  const space = r() < 0.6;
  let bg = space ? pick(r, SPACE) : pick(r, PASTEL);
  if (space) for (let i = 0; i < 10; i++) cv.circle(6 + r() * 88, 6 + r() * 88, 0.6 + r() * 1, "#ffffff");
  const b = pick(r, BODY);
  bg = safeBg(bg, b);
  const band = dk(b, 0.82);
  const band2 = lt(b, 0.3);
  const rad = 24 + r() * 5;
  const cx = 50;
  const cy = 50;
  const tilt = Math.floor(r() * 5) * 12 - 24;
  const ring = r() < 0.7;
  const rc = pick(r, ["#f5c542", "#f2ede4", "#ff9dd1", "#6fe3ff"]);
  if (ring) {
    cv.poly(ellipsePts(50, 50, rad + 17, 6.4, tilt, 40), rc);
    cv.poly(ellipsePts(50, 50, rad + 10, 3.6, tilt, 40), bg);
  }
  cv.circle(cx, cy, rad, b);
  const nb = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nb; i++) {
    const y1 = cy - rad + rad * (0.35 + i * 0.55) + r() * 3;
    const y2 = Math.min(y1 + 4 + r() * 4, cy + rad - 1);
    const a1 = Math.acos((y1 - cy) / rad);
    const a2 = Math.acos((y2 - cy) / rad);
    const ps: Pt[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = a1 + ((a2 - a1) * k) / 10;
      ps.push([cx + Math.sin(a) * rad, cy + Math.cos(a) * rad]);
    }
    for (let k = 10; k >= 0; k--) {
      const a = a1 + ((a2 - a1) * k) / 10;
      ps.push([cx - Math.sin(a) * rad, cy + Math.cos(a) * rad]);
    }
    cv.poly(ps, i % 2 ? band2 : band);
  }
  if (r() < 0.5) {
    cv.circle(cx - 9, cy - 14, 3, dk(b, 0.7));
    cv.circle(cx + 14, cy + 13, 2.2, dk(b, 0.7));
  }
  if (ring) {
    // The front half of the ring (below the planet's centre line), tilted.
    const a = (tilt * Math.PI) / 180;
    const rot = (p: Pt): Pt => [50 + (p[0] - 50) * Math.cos(a) - (p[1] - 50) * Math.sin(a), 50 + (p[0] - 50) * Math.sin(a) + (p[1] - 50) * Math.cos(a)];
    const front: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = Math.PI * (1 - i / 20);
      front.push(rot([50 + Math.cos(t) * (rad + 17), 50 + Math.sin(t) * 6.4]));
    }
    for (let i = 0; i <= 20; i++) {
      const t = Math.PI * (i / 20);
      front.push(rot([50 + Math.cos(t) * (rad + 10), 50 + Math.sin(t) * 3.6]));
    }
    cv.poly(front, rc);
  }
  cv.eye(cx - 8, cy + 1, 4.8);
  cv.eye(cx + 8, cy + 1, 4.8);
  smile(cv, cx, cy + 10, 4, 1);
  if (r() < 0.6) {
    const a = r() * 6.28;
    cv.circle(50 + Math.cos(a) * 40, 50 + Math.sin(a) * 40 * 0.9, 4.5 + r() * 2, pick(r, ["#f2ede4", "#c6cbe8", "#ffc933"]));
  }
  return { bg, cv, main: b };
}

function cactus(r: Rng): { bg: string; cv: Canvas; main: string } {
  const cv = new Canvas();
  let bg = pick(r, PASTEL);
  const gr = pick(r, ["#1a8f5e", "#2bb3c0", "#5b9e3a", "#3b8f7a", "#6c6cf0"]);
  const pot = pick(r, ["#e89540", "#e5484d", "#f2ede4", "#8b5cf6", "#2f6fe0"]);
  bg = safeBg(safeBg(bg, gr), pot);
  cv.ellipse(50, 92, 36, 8, dk(bg, 0.92));
  const bw = 19 + r() * 4;
  const arms = Math.floor(r() * 3);
  if (arms !== 1) {
    cv.rect(50 - bw - 14, 50, bw * 0.6, 8, gr, 4);
    cv.rect(50 - bw - 14, 34, 8, 24, gr, 4);
  }
  if (arms !== 0) {
    cv.rect(50 + bw - 1, 42, 15, 8, gr, 4);
    cv.rect(50 + bw + 7, 26, 8, 24, gr, 4);
  }
  cv.rect(50 - bw, 16, 2 * bw, 66, gr, bw);
  cv.rect(48.8, 22, 2.4, 52, lt(gr, 0.25), 1.2);
  cv.rect(50 - bw * 0.55, 26, 2, 44, lt(gr, 0.18), 1);
  cv.rect(50 + bw * 0.55 - 2, 26, 2, 44, lt(gr, 0.18), 1);
  const fl = pick(r, ["#ff5a8a", "#ffd93d", "#ffffff", "#ff8a5b"]);
  if (r() < 0.8) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * 6.283;
      cv.circle(50 + Math.cos(a) * 4.4, 15 + Math.sin(a) * 4.4, 3.2, fl);
    }
    cv.circle(50, 15, 2.6, "#ffd93d");
  }
  cv.eye(43, 44, 4.6);
  cv.eye(57, 44, 4.6);
  smile(cv, 50, 52, 4, 1, 2);
  if (r() < 0.5) {
    cv.circle(38, 52, 2.6, "#ff9db0");
    cv.circle(62, 52, 2.6, "#ff9db0");
  }
  for (let i = 0; i < 4; i++) cv.circle(50 - bw + 4 + r() * (2 * bw - 8), 24 + r() * 48, 0.9, "#ffffff");
  cv.poly([[30, 78], [70, 78], [64, 96], [36, 96]], pot);
  cv.rect(28, 74, 44, 8, dk(pot, 0.85), 3);
  return { bg, cv, main: gr };
}


function robot(r: Rng): { bg: string; cv: Canvas; main: string } {
  const cv = new Canvas();
  const bg = pick(r, PASTEL);
  const b = pick(r, BODY);
  const g = pick(r, ["#fff36b", "#7cffb2", "#6fe3ff", "#ff7ad9", "#ffffff", "#ffb347"]);
  const vis = pick(r, [INK, "#0f2a3f", "#2a1740"]);
  const hw = 52 + r() * 12;
  const hh = 44 + r() * 10;
  const x = 50 - hw / 2;
  const y = 30 + r() * 4;
  cv.rect(18, y + hh + 4, 64, 36, dk(b, 0.8), 16);
  const an = Math.floor(r() * 5);
  if (an === 1) {
    cv.rect(48.6, y - 12, 2.8, 14, dk(b, 0.6));
    cv.circle(50, y - 13, 4.5, g);
  } else if (an === 2) {
    cv.rect(x + 8, y - 8, 3, 10, dk(b, 0.6));
    cv.circle(x + 9.5, y - 9, 3.5, g);
    cv.rect(x + hw - 11, y - 8, 3, 10, dk(b, 0.6));
    cv.circle(x + hw - 9.5, y - 9, 3.5, g);
  } else if (an === 3) {
    cv.poly([[x + 6, y + 2], [x + 14, y - 12], [x + 22, y + 2]], dk(b, 0.7));
    cv.poly([[x + hw - 22, y + 2], [x + hw - 14, y - 12], [x + hw - 6, y + 2]], dk(b, 0.7));
  } else if (an === 4) {
    cv.rect(46, y - 8, 8, 10, dk(b, 0.6), 2);
  }
  const ears = Math.floor(r() * 3);
  if (ears === 1) {
    cv.rect(x - 5, y + hh * 0.3, 7, hh * 0.4, dk(b, 0.7), 3);
    cv.rect(x + hw - 2, y + hh * 0.3, 7, hh * 0.4, dk(b, 0.7), 3);
  } else if (ears === 2) {
    cv.circle(x - 1, y + hh / 2, 6, dk(b, 0.7));
    cv.circle(x + hw + 1, y + hh / 2, 6, dk(b, 0.7));
  }
  cv.rect(x, y, hw, hh, b, pick(r, [hw * 0.22, hw * 0.34, hh * 0.5]));
  const vx = x + 6;
  const vy = y + 7;
  const vw = hw - 12;
  const vh = hh * 0.46;
  const vs = Math.floor(r() * 3);
  cv.rect(vx, vy, vw, vh, vis, vs === 0 ? 4 : vs === 1 ? vh / 2 : 8);
  const ec = vy + vh / 2;
  const et = Math.floor(r() * 6);
  if (et === 0) {
    cv.circle(50 - vw * 0.22, ec, 4.2, g);
    cv.circle(50 + vw * 0.22, ec, 4.2, g);
  } else if (et === 1) {
    cv.rect(50 - vw * 0.22 - 3.6, ec - 3.6, 7.2, 7.2, g, 1.5);
    cv.rect(50 + vw * 0.22 - 3.6, ec - 3.6, 7.2, 7.2, g, 1.5);
  } else if (et === 2) {
    cv.circle(50, ec, Math.min(vh * 0.36, 7), g);
    cv.circle(50, ec, 2.6, vis);
  } else if (et === 3) {
    cv.rect(50 - vw * 0.34, ec - 1.8, vw * 0.68, 3.6, g, 1.8);
  } else if (et === 4) {
    cv.rect(50 - vw * 0.28 - 2, ec - 5, 4, 10, g, 2);
    cv.rect(50 + vw * 0.28 - 2, ec - 5, 4, 10, g, 2);
  } else {
    cv.ellipse(50 - vw * 0.22, ec, 5, 3.2, g);
    cv.ellipse(50 + vw * 0.22, ec, 5, 3.2, g);
  }
  const my = y + hh * 0.72;
  const mt = Math.floor(r() * 5);
  if (mt === 0) for (let i = 0; i < 3; i++) cv.rect(50 - 8 + i * 6, my - 3, 3, 6.5, vis, 1);
  else if (mt === 1) cv.line(quad([44, my - 1], [50, my + 11], [56, my - 1]), 2.6, vis);
  else if (mt === 2) cv.rect(43, my - 1.3, 14, 2.8, vis, 1.4);
  else if (mt === 3) {
    cv.rect(42, my - 3, 16, 6, vis, 3);
    cv.rect(49.2, my - 3, 1.6, 6, b);
  } else cv.circle(50, my, 3.2, vis);
  if (r() < 0.5) {
    cv.circle(x + 5, y + hh - 5, 1.7, dk(b, 0.6));
    cv.circle(x + hw - 5, y + hh - 5, 1.7, dk(b, 0.6));
  }
  return { bg: safeBg(bg, b), cv, main: b };
}

function ghost(r: Rng): { bg: string; cv: Canvas; main: string } {
  const cv = new Canvas();
  const dark = r() < 0.5;
  const bg = dark ? pick(r, ["#1d1240", "#14173a", "#2b2f5c"]) : pick(r, PASTEL);
  // Tinted sheet, so the colour of the picture (and of the name) is readable.
  const tint = pick(r, BODY);
  const b = lt(tint, dark ? 0.72 : 0.2);
  const w = 26;
  const top = 20;
  const body: Pt[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI + (i / 16) * Math.PI;
    body.push([50 + Math.cos(a) * w, top + w + Math.sin(a) * w]);
  }
  body.push([50 + w, 90]);
  body.push(...quad([50 + w, 90], [50 + w * 0.67, 82], [50 + w * 0.33, 90]).slice(1));
  body.push(...quad([50 + w * 0.33, 90], [50, 98], [50 - w * 0.33, 90]).slice(1));
  body.push(...quad([50 - w * 0.33, 90], [50 - w * 0.67, 82], [50 - w, 90]).slice(1));
  cv.poly(body, b);
  const acc = pick(r, BODY);
  const hat = Math.floor(r() * 5);
  if (hat === 1) {
    const cap: Pt[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI + (i / 16) * Math.PI;
      cap.push([50 + Math.cos(a) * w * 0.8, 34 + Math.sin(a) * w * 0.8]);
    }
    cv.poly(cap, acc);
    cv.rect(50 - w * 0.9, 32, w * 1.8, 5, dk(acc, 0.8), 2.5);
    cv.circle(50, 16, 3.6, "#ffffff");
  } else if (hat === 2) {
    cv.poly([[50 - w * 0.6, 28], [50 - w * 0.6, 16], [50 - w * 0.2, 22], [50, 12], [50 + w * 0.2, 22], [50 + w * 0.6, 16], [50 + w * 0.6, 28]], "#ffc933");
  } else if (hat === 3) {
    cv.rect(50 - w * 0.7, 20, w * 1.4, 10, acc, 3);
    cv.rect(50 - w * 0.95, 28, w * 1.9, 4, dk(acc, 0.8), 2);
  }
  const glasses = r() < 0.5;
  const ey = glasses ? 50 : 48;
  if (glasses) {
    cv.circle(40, ey, 8, INK);
    cv.circle(40, ey, 6, b);
    cv.circle(60, ey, 8, INK);
    cv.circle(60, ey, 6, b);
    cv.rect(47, ey - 1, 6, 2, INK);
    cv.circle(40, ey, 3, INK);
    cv.circle(60, ey, 3, INK);
  } else {
    cv.ellipse(41, ey, 3.8, 5.6, INK);
    cv.ellipse(59, ey, 3.8, 5.6, INK);
  }
  const mt = Math.floor(r() * 3);
  if (mt === 0) cv.ellipse(50, 64, 3.6, 4.6, INK);
  else if (mt === 1) smile(cv, 50, 62, 6, 3, 2.2);
  else cv.rect(45, 62, 10, 3, INK, 1.5);
  if (r() < 0.55) {
    cv.circle(33, 60, 3, "#ff9db0");
    cv.circle(67, 60, 3, "#ff9db0");
  }
  if (r() < 0.4) cv.rect(50 - w, 70, 2 * w, 6, acc, 3);
  return { bg: safeBg(bg, b), cv, main: tint };
}

const FAMILY: Record<AvatarFamily, (r: Rng) => { bg: string; cv: Canvas; main: string }> = {
  astronaut,
  octopus,
  angler,
  planet,
  cactus,
  robot,
  ghost,
};

export function friendSpec(seed: string): FriendSpec {
  const r = makeRng(FRIENDS_SEED_PREFIX + seed);
  const family = AVATAR_FAMILIES[Math.floor(r() * AVATAR_FAMILIES.length)];
  const { bg, cv, main } = FAMILY[family](r);
  return { family, main, background: { from: bg, to: bg, angle: 0 }, shapes: cv.shapes };
}
