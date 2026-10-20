// Deterministic abstract avatar for a seed string (in practice an Ark address).
//
// Display only: nothing here is a security control and none of it needs to be
// cryptographic, so a small synchronous hash + PRNG is enough. Same seed in,
// same picture out, on every device, with no upload and no server.
//
// The seed is meant to be the *address*, not the handle. Two handles that
// differ by one character ("pavel" / "pave1") resolve to different addresses
// and therefore to visibly different pictures, which makes the avatar a cheap
// visual checksum next to the confirm screen's text.
//
// THE PICTURE MUST NOT CHANGE for a given address once people rely on it as that
// checksum. Everything below is versioned by SEED_PREFIX: the order of the
// random draws, the palettes, the compositions and their maths all feed the
// result, so changing any of them repaints every existing avatar. A different
// look needs a new prefix, on purpose, and a note in ARCHITECTURE.md.
//
// This is version 3 (versions 1 and 2 were earlier drafts that never shipped in
// this form). Nine compositions, each opaque and crisp on purpose: an earlier
// draft used translucent overlaps, which mixed into muddy colours, and colours
// that sat too close to what was under them. Two guards keep that from coming
// back: `fixContrast` pulls an accent away from the background, and `best` picks
// a colour with enough contrast against the one it is drawn on.
//
// The literal hex values are deliberate (mode-stable): the picture paints its
// own opaque background and must look the same in light and dark.

export const AVATAR_VIEWBOX = 100;

// Feeds the PRNG. See the note above before touching it.
const SEED_PREFIX = "v3|";

export type AvatarShape =
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string; opacity?: number }
  | { kind: "ring"; cx: number; cy: number; r: number; stroke: string; strokeWidth: number; opacity?: number }
  // `rotate` is in degrees around the centre of the picture (50, 50).
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx: number; fill: string; rotate?: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill: string; rotate?: number }
  | { kind: "path"; d: string; fill: string; opacity?: number };

export type AvatarComposition =
  | "orbs"
  | "mosaic"
  | "horizon"
  | "waves"
  | "rings"
  | "blocks"
  | "petals"
  | "split"
  | "planet";

export interface AvatarSpec {
  composition: AvatarComposition;
  background: { from: string; to: string; angle: number };
  shapes: AvatarShape[];
}

// [background, four accents]
export const AVATAR_PALETTES: readonly (readonly [string, string, string, string, string])[] = [
  ["#1F4D3A", "#E9F5D8", "#8FCB5A", "#F2A541", "#D96B3C"],
  ["#2E2A6B", "#EDEBFF", "#9C93F0", "#F5B544", "#F0728E"],
  ["#8A3418", "#FBE7DC", "#F2A07E", "#2E6FB0", "#F5D061"],
  ["#0F3D6B", "#E4F1FC", "#79B4EC", "#F26A8D", "#F5C64B"],
  ["#5E1F3D", "#FBE3EC", "#EE9DB8", "#2FA58A", "#F5B94B"],
  ["#0C5A4B", "#DFF6EE", "#58C4A2", "#F2937A", "#F4D35E"],
  ["#F1E5CE", "#2D4A7A", "#D9573B", "#3E8E6B", "#1E1E1E"],
  ["#DDF2EA", "#1F6E5A", "#F28F6B", "#3C5A9A", "#F2C14E"],
  ["#EAE4FB", "#4B3AA0", "#E86A92", "#2F9C95", "#F2B84B"],
  ["#22252B", "#F2EFE8", "#E85D4A", "#5AA9E6", "#F5C542"],
  ["#D9A21B", "#2A2A2A", "#FFF3D0", "#C9472C", "#3B7F6D"],
  ["#E2664B", "#FFF1E8", "#2B3A67", "#F5C15D", "#4CA487"],
  ["#3B5B92", "#F3F6FB", "#F0B84A", "#E36F6F", "#7BC8A4"],
  ["#5B6B2E", "#F6F1D9", "#D8703A", "#33607A", "#E9C46A"],
];

export const AVATAR_COMPOSITIONS: readonly AvatarComposition[] = [
  "orbs",
  "mosaic",
  "horizon",
  "waves",
  "rings",
  "blocks",
  "petals",
  "split",
  "planet",
];

// ---- randomness ------------------------------------------------------------

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

// mulberry32
export function makeRng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 1831565813) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

// One decimal is plenty at avatar sizes and keeps float noise out of the SVG.
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---- colour ----------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return (
    "#" +
    [0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * t).toString(16).padStart(2, "0")).join("")
  );
}

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function shuffle<T>(items: readonly T[], r: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// Pull any accent that sits too close to the background's lightness towards
// black or white, so nothing dissolves into it.
export const MIN_ACCENT_CONTRAST = 0.16;
export function fixContrast(accents: readonly string[], bg: string): string[] {
  const lb = luminance(bg);
  return accents.map((x) =>
    Math.abs(luminance(x) - lb) >= MIN_ACCENT_CONTRAST ? x : mix(x, lb > 0.5 ? "#111111" : "#ffffff", 0.55),
  );
}

// The first candidate with enough lightness contrast against `against`, or the
// one with the most if none reaches `min`. Taking the first (not the best)
// keeps the variety the shuffle produced.
function best(candidates: readonly string[], against: string, min: number): string {
  let pick = candidates[0];
  let pickDelta = -1;
  for (const c of candidates) {
    const d = Math.abs(luminance(c) - luminance(against));
    if (d >= min) return c;
    if (d > pickDelta) {
      pickDelta = d;
      pick = c;
    }
  }
  return pick;
}

// Whether a circle at (px, py) with radius `rad` stays within `limit` of the
// picture's centre, i.e. is not cut off by the round crop.
function inside(px: number, py: number, rad: number, limit: number): boolean {
  return Math.hypot(px - 50, py - 50) + rad <= limit;
}

// ---- shape builders (round once, here) --------------------------------------

const circle = (cx: number, cy: number, r: number, fill: string, opacity?: number): AvatarShape => ({
  kind: "circle",
  cx: round1(cx),
  cy: round1(cy),
  r: round1(r),
  fill,
  ...(opacity !== undefined ? { opacity } : {}),
});

const ring = (cx: number, cy: number, r: number, stroke: string, strokeWidth: number, opacity?: number): AvatarShape => ({
  kind: "ring",
  cx: round1(cx),
  cy: round1(cy),
  r: round1(r),
  stroke,
  strokeWidth: round1(strokeWidth),
  ...(opacity !== undefined ? { opacity } : {}),
});

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  rx = 0,
  rotate?: number,
): AvatarShape => ({
  kind: "rect",
  x: round1(x),
  y: round1(y),
  width: round1(width),
  height: round1(height),
  rx: round1(rx),
  fill,
  ...(rotate !== undefined ? { rotate: round1(rotate) } : {}),
});

const path = (d: string, fill: string, opacity?: number): AvatarShape => ({
  kind: "path",
  d,
  fill,
  ...(opacity !== undefined ? { opacity } : {}),
});

// A quarter disc of radius 50 whose right angle sits at one corner of the 50x50
// tile at (x, y). q: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
function quarter(x: number, y: number, q: number, fill: string): AvatarShape {
  const d = [
    `M${x} ${y}L${x + 50} ${y}A50 50 0 0 1 ${x} ${y + 50}Z`,
    `M${x + 50} ${y}L${x + 50} ${y + 50}A50 50 0 0 1 ${x} ${y}Z`,
    `M${x + 50} ${y + 50}L${x} ${y + 50}A50 50 0 0 1 ${x + 50} ${y}Z`,
    `M${x} ${y + 50}L${x} ${y}A50 50 0 0 1 ${x + 50} ${y + 50}Z`,
  ][q];
  return path(d, fill);
}

// Half of the 50x50 tile at (x, y), cut along a diagonal.
function triangle(x: number, y: number, q: number, fill: string): AvatarShape {
  const p = [
    [x, y, x + 50, y, x, y + 50],
    [x + 50, y, x + 50, y + 50, x, y],
    [x + 50, y + 50, x, y + 50, x + 50, y],
    [x, y + 50, x, y, x + 50, y + 50],
  ][q];
  return path(`M${p[0]} ${p[1]}L${p[2]} ${p[3]}L${p[4]} ${p[5]}Z`, fill);
}

// ---- compositions -----------------------------------------------------------
//
// The order of the r() draws inside each one is part of the picture: keep it.

// A large disc with a second one overlapping its edge, a small satellite, and a
// ring concentric with the first. Everything opaque, nothing cut off.
function orbs(r: Rng, c: string[], bg: string): AvatarShape[] {
  const cx = 44 + r() * 12;
  const cy = 44 + r() * 12;
  const R = 25 + r() * 6;
  const a = r() * 6.283;
  const rest = c.slice(1).concat([bg]);
  const shapes: AvatarShape[] = [circle(cx, cy, R, c[0])];

  const c2 = best(rest, c[0], 0.22);
  const r2 = R * (0.6 + r() * 0.18);
  let dist = R * (0.8 + r() * 0.2);
  let px: number;
  let py: number;
  let k = 0;
  do {
    px = cx + Math.cos(a) * dist;
    py = cy + Math.sin(a) * dist;
    dist *= 0.92;
    k++;
  } while (!inside(px, py, r2, 47) && k < 12);
  shapes.push(circle(px, py, r2, c2));

  const c3 = best(
    rest.filter((x) => x !== c2),
    bg,
    0.22,
  );
  const r3 = 5 + r() * 4;
  const b = a + 3.1 + r() * 1.2;
  let dd = R + r3 + 3;
  let qx = cx + Math.cos(b) * dd;
  let qy = cy + Math.sin(b) * dd;
  let g = 0;
  while (!inside(qx, qy, r3, 46) && g < 12) {
    dd *= 0.94;
    qx = cx + Math.cos(b) * dd;
    qy = cy + Math.sin(b) * dd;
    g++;
  }
  shapes.push(circle(qx, qy, r3, c3));
  shapes.push(ring(cx, cy, R + 9 + r() * 3, best(c.slice(1), bg, 0.25), 1.8));
  return shapes;
}

// Four tiles in the manner of the Bauhaus, every motif in a colour that stands
// out from its own tile.
function mosaic(r: Rng, c: string[], bg: string): AvatarShape[] {
  const shapes: AvatarShape[] = [];
  const tiles = [
    [0, 0],
    [50, 0],
    [0, 50],
    [50, 50],
  ];
  const o = Math.floor(r() * 4);
  const all = c.concat([bg]);
  for (let i = 0; i < 4; i++) {
    const [x, y] = tiles[i];
    const b = c[(i + o) % 4];
    shapes.push(rect(x, y, 50, 50, b));
    const g = best(
      shuffle(
        all.filter((z) => z !== b),
        r,
      ),
      b,
      0.28,
    );
    const k = r();
    if (k < 0.45) shapes.push(quarter(x, y, Math.floor(r() * 4), g));
    else if (k < 0.7) shapes.push(circle(x + 25, y + 25, 16, g));
    else if (k < 0.85) shapes.push(triangle(x, y, Math.floor(r() * 4), g));
    else shapes.push(rect(x + 12, y + 12, 26, 26, g, r() < 0.5 ? 13 : 3));
  }
  return shapes;
}

// A sun on a horizon, with striped reflection below it.
function horizon(r: Rng, c: string[]): AvatarShape[] {
  const hy = 52 + r() * 10;
  const rad = 22 + r() * 8;
  const cx = 38 + r() * 24;
  const shapes: AvatarShape[] = [circle(cx, hy, rad, c[0]), rect(-5, hy, 110, 100, c[3])];
  shapes.push(path(`M${round1(cx - rad)} ${round1(hy)}A${round1(rad)} ${round1(rad)} 0 0 0 ${round1(cx + rad)} ${round1(hy)}Z`, c[0], 0.55));
  for (let i = 0; i < 4; i++) shapes.push(rect(-5, hy + 7 + i * 9, 110, 5 - i * 0.8, c[1]));
  shapes.push(circle(14 + r() * 10, 20 + r() * 12, 4 + r() * 3, c[2]));
  return shapes;
}

function waves(r: Rng, c: string[]): AvatarShape[] {
  const shapes: AvatarShape[] = [];
  const a = 8 + r() * 8;
  for (let i = 0; i < 3; i++) {
    const y = 42 + i * 17 + r() * 4;
    shapes.push(
      path(
        `M-5 ${round1(y)} C 20 ${round1(y - a)} 30 ${round1(y + a)} 52 ${round1(y)} S 85 ${round1(y - a)} 105 ${round1(y)} V105 H-5Z`,
        c[i],
      ),
    );
  }
  shapes.push(circle(60 + r() * 20, 22 + r() * 10, 10 + r() * 5, c[3]));
  return shapes;
}

function rings(r: Rng, c: string[]): AvatarShape[] {
  const x = 38 + r() * 24;
  const y = 38 + r() * 24;
  let rad = 64;
  const shapes: AvatarShape[] = [];
  for (let i = 0; i < 4; i++) {
    shapes.push(circle(x, y, rad, c[i % 4]));
    rad -= 13 + r() * 6;
  }
  shapes.push(ring(x, y, rad + 40, mix(c[0], "#ffffff", 0.5), 1, 0.5));
  return shapes;
}

function blocks(r: Rng, c: string[]): AvatarShape[] {
  return [
    rect(8 + r() * 18, 12 + r() * 16, 46 + r() * 12, 46 + r() * 12, c[0], 10 + r() * 10, Math.floor(r() * 50) - 25),
    rect(30 + r() * 18, 32 + r() * 16, 40 + r() * 12, 40 + r() * 12, c[1], 8 + r() * 14, Math.floor(r() * 70) - 35),
    circle(58 + r() * 18, 26 + r() * 18, 12 + r() * 8, c[2]),
    circle(24 + r() * 18, 68 + r() * 12, 6 + r() * 5, c[3]),
  ];
}

// A flower: opaque petals in two contrasting colours around a centre, all inside
// the crop.
function petals(r: Rng, c: string[], bg: string): AvatarShape[] {
  const k = 5 + Math.floor(r() * 3);
  const rx = 9 + r() * 2.5;
  const ry = 17 + r() * 3;
  const off = r() * 360;
  const d = ry + 5;
  const a = c[0];
  const b = best(c.slice(1), a, 0.22);
  const shapes: AvatarShape[] = [];
  for (let i = 0; i < k; i++) {
    shapes.push({
      kind: "ellipse",
      cx: 50,
      cy: round1(50 - d),
      rx: round1(rx),
      ry: round1(ry),
      fill: i % 2 ? b : a,
      rotate: round1(off + (i * 360) / k),
    });
  }
  const cc = best(
    c
      .slice(1)
      .concat([bg])
      .filter((x) => x !== a && x !== b),
    a,
    0.2,
  );
  shapes.push(circle(50, 50, 8 + r() * 3, cc));
  shapes.push(circle(50, 50, 3, best([bg, a, b], cc, 0.3)));
  return shapes;
}

function split(r: Rng, c: string[]): AvatarShape[] {
  const rot = Math.floor(r() * 180);
  const shapes: AvatarShape[] = [rect(-60, 50, 220, 140, c[0], 0, rot)];
  const cx = 38 + r() * 24;
  const cy = 38 + r() * 24;
  shapes.push(circle(cx, cy, 22 + r() * 8, c[1]));
  shapes.push(ring(cx, cy, 32 + r() * 5, c[2], 2.2));
  shapes.push(
    circle(cx + (r() < 0.5 ? -1 : 1) * (34 + r() * 4), cy + (r() < 0.5 ? -1 : 1) * (20 + r() * 10), 5 + r() * 3, c[3]),
  );
  return shapes;
}

function planet(r: Rng, c: string[], bg: string): AvatarShape[] {
  const dot = mix(bg, luminance(bg) > 0.6 ? "#000000" : "#ffffff", 0.3);
  const shapes: AvatarShape[] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) shapes.push(circle(10 + i * 20, 10 + j * 20, 1.1, dot, 0.7));
  const cx = 44 + r() * 12;
  const cy = 44 + r() * 12;
  const rad = 22 + r() * 6;
  shapes.push(circle(cx, cy, rad, c[0]));
  const R = rad + 12 + r() * 6;
  shapes.push(ring(cx, cy, R, c[1], 1.6));
  const a = r() * 6.28;
  shapes.push(circle(cx + R * Math.cos(a), cy + R * Math.sin(a), 5 + r() * 3, c[2]));
  shapes.push(circle(cx - rad * 0.3, cy - rad * 0.3, rad * 0.35, c[3], 0.55));
  return shapes;
}

const COMPOSE: Record<AvatarComposition, (r: Rng, c: string[], bg: string) => AvatarShape[]> = {
  orbs,
  mosaic,
  horizon,
  waves,
  rings,
  blocks,
  petals,
  split,
  planet,
};

export function avatarSpec(seed: string): AvatarSpec {
  const r = makeRng(SEED_PREFIX + seed);
  const palette = AVATAR_PALETTES[Math.floor(r() * AVATAR_PALETTES.length)];
  const bg = palette[0];
  const accents = fixContrast(shuffle(palette.slice(1), r), bg);
  const angle = Math.floor(r() * 360);
  const towards = luminance(bg) > 0.6 ? "#000000" : "#ffffff";
  const composition = AVATAR_COMPOSITIONS[Math.floor(r() * AVATAR_COMPOSITIONS.length)];
  // Decided BEFORE the composition draws anything, exactly as in the draft the
  // pictures were approved from; the ring itself goes on top at the end.
  const hasEdgeRing = r() < 0.4;
  const shapes = COMPOSE[composition](r, accents, bg);
  if (hasEdgeRing) shapes.push(ring(50, 50, 45.5, mix(bg, towards, 0.28), 1.2, 0.9));
  return {
    composition,
    background: { from: bg, to: mix(bg, towards, 0.14), angle },
    shapes,
  };
}
