// The profile avatar as a PNG, for link previews (spendrr.app/@name).
//
// Chat apps and social networks that unfurl a link do not render SVG, which is
// what the in-app avatar is (src/components/Avatar.tsx). So the Worker draws
// the very same spec (src/lib/names/avatar.ts's avatarSpec) itself: a small software
// rasteriser for the handful of primitives the spec uses, and a PNG encoder on
// top of the platform's own deflate. No dependency, no WASM.
//
// It must look like the SVG, since the avatar is a visual checksum of the
// address: same shapes, same colours, same sRGB compositing. Anti-aliasing is
// the only thing allowed to differ. Circles, rings, ellipses and rounded
// rectangles get analytic coverage from a signed distance; paths are flattened
// and filled with a supersampled scanline (nonzero rule, as SVG).
//
// Cheap on purpose: the free plan gives an invocation ~10ms of CPU, and a cache
// miss renders once per address (the image is immutable for an address, see
// handleAvatarPng in index.ts).

import { AVATAR_VIEWBOX, avatarSpec, type AvatarShape } from "../src/lib/names/avatar";

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Canvas {
  size: number;
  /** RGB, 0..255, row-major. */
  px: Float32Array;
  /** Viewbox units to pixels, and where the viewbox's origin sits. */
  scale: number;
  offset: number;
}

function blend(c: Canvas, i: number, color: Rgb, a: number): void {
  if (a <= 0) return;
  const k = i * 3;
  const p = c.px;
  p[k] += (color[0] - p[k]) * a;
  p[k + 1] += (color[1] - p[k + 1]) * a;
  p[k + 2] += (color[2] - p[k + 2]) * a;
}

// Rotation of `rotate(deg 50 50)`, as a function mapping a point in picture
// space back into the shape's own (unrotated) space.
function unrotate(deg: number | undefined): (x: number, y: number) => [number, number] {
  if (!deg) return (x, y) => [x, y];
  const a = (-deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return (x, y) => {
    const dx = x - 50;
    const dy = y - 50;
    return [50 + dx * cos - dy * sin, 50 + dx * sin + dy * cos];
  };
}

function rotatePoint(x: number, y: number, deg: number | undefined): [number, number] {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180;
  const dx = x - 50;
  const dy = y - 50;
  return [50 + dx * Math.cos(a) - dy * Math.sin(a), 50 + dx * Math.sin(a) + dy * Math.cos(a)];
}

// Paints a shape given its signed distance (viewbox units, negative inside),
// over the pixels of a bounding circle around (cx, cy) with radius `reach`.
function paintSdf(
  c: Canvas,
  cx: number,
  cy: number,
  reach: number,
  color: Rgb,
  opacity: number,
  sdf: (x: number, y: number) => number,
): void {
  const { size, scale, offset } = c;
  const x0 = Math.max(0, Math.floor(offset + (cx - reach) * scale) - 1);
  const x1 = Math.min(size - 1, Math.ceil(offset + (cx + reach) * scale) + 1);
  const y0 = Math.max(0, Math.floor(offset + (cy - reach) * scale) - 1);
  const y1 = Math.min(size - 1, Math.ceil(offset + (cy + reach) * scale) + 1);
  for (let py = y0; py <= y1; py++) {
    const vy = (py + 0.5 - offset) / scale;
    for (let px = x0; px <= x1; px++) {
      const vx = (px + 0.5 - offset) / scale;
      const d = sdf(vx, vy) * scale;
      if (d >= 0.5) continue;
      blend(c, py * size + px, color, (d <= -0.5 ? 1 : 0.5 - d) * opacity);
    }
  }
}

// ---- paths ------------------------------------------------------------------

type Point = [number, number];

// Parses the path grammar avatar.ts emits (absolute M L H V C S A Z, numbers
// separated by spaces or glued to the command letter) into closed polygons.
export function flattenPath(d: string): Point[][] {
  const tokens = d.match(/[MLHVCSAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const polys: Point[][] = [];
  let poly: Point[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let prevCmd = "";
  let i = 0;
  let cmd = "";
  const num = () => parseFloat(tokens[i++]);
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const steps = 16;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      poly.push([
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey,
      ]);
    }
    lastCtrlX = x2;
    lastCtrlY = y2;
    x = ex;
    y = ey;
  };
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    switch (cmd) {
      case "M":
        if (poly.length > 2) polys.push(poly);
        x = startX = num();
        y = startY = num();
        poly = [[x, y]];
        cmd = "L"; // implicit lineto after the first pair
        break;
      case "L":
        x = num();
        y = num();
        poly.push([x, y]);
        break;
      case "H":
        x = num();
        poly.push([x, y]);
        break;
      case "V":
        y = num();
        poly.push([x, y]);
        break;
      case "C": {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), ex = num(), ey = num();
        cubic(x1, y1, x2, y2, ex, ey);
        break;
      }
      case "S": {
        const reflect = prevCmd === "C" || prevCmd === "S";
        const x1 = reflect ? 2 * x - lastCtrlX : x;
        const y1 = reflect ? 2 * y - lastCtrlY : y;
        const x2 = num(), y2 = num(), ex = num(), ey = num();
        cubic(x1, y1, x2, y2, ex, ey);
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), ex = num(), ey = num();
        for (const p of arcPoints(x, y, rx, ry, rot, large !== 0, sweep !== 0, ex, ey)) poly.push(p);
        x = ex;
        y = ey;
        break;
      }
      case "Z":
        x = startX;
        y = startY;
        if (poly.length > 2) polys.push(poly);
        poly = [];
        break;
      default:
        i++; // unknown token: skip rather than loop forever
    }
    prevCmd = cmd;
  }
  if (poly.length > 2) polys.push(poly);
  return polys;
}

// SVG's endpoint arc parametrisation (SVG 1.1 appendix F.6), flattened.
function arcPoints(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Point[] {
  if (rx === 0 || ry === 0) return [[x2, y2]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * yp) / ry;
  const cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(Math.abs(dt) / (Math.PI / 32)));
  const out: Point[] = [];
  for (let s = 1; s <= steps; s++) {
    const t = t1 + (dt * s) / steps;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  out[out.length - 1] = [x2, y2];
  return out;
}

const SUBROWS = 5;

function paintPolygons(c: Canvas, polys: Point[][], color: Rgb, opacity: number): void {
  const { size, scale, offset } = c;
  const edges: { x0: number; y0: number; x1: number; y1: number; dir: number }[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const ax = offset + a[0] * scale, ay = offset + a[1] * scale;
      const bx = offset + b[0] * scale, by = offset + b[1] * scale;
      if (ay === by) continue;
      edges.push(ay < by ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1 } : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1 });
      minY = Math.min(minY, ay, by);
      maxY = Math.max(maxY, ay, by);
    }
  }
  if (edges.length === 0) return;
  const row = new Float32Array(size + 1);
  const hits: { x: number; dir: number }[] = [];
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(size - 1, Math.ceil(maxY));
  for (let py = yStart; py <= yEnd; py++) {
    row.fill(0);
    let touched = false;
    for (let s = 0; s < SUBROWS; s++) {
      const sy = py + (s + 0.5) / SUBROWS;
      hits.length = 0;
      for (const e of edges) {
        if (sy < e.y0 || sy >= e.y1) continue;
        hits.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
      }
      if (hits.length < 2) continue;
      hits.sort((p, q) => p.x - q.x);
      let winding = 0;
      for (let h = 0; h < hits.length - 1; h++) {
        winding += hits[h].dir;
        if (winding === 0) continue;
        const xa = Math.max(0, hits[h].x);
        const xb = Math.min(size, hits[h + 1].x);
        if (xb <= xa) continue;
        touched = true;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        if (ia === ib) {
          row[ia] += xb - xa;
        } else {
          row[ia] += ia + 1 - xa;
          for (let k = ia + 1; k < ib; k++) row[k] += 1;
          if (ib < size) row[ib] += xb - ib;
        }
      }
    }
    if (!touched) continue;
    for (let px = 0; px < size; px++) {
      const a = row[px] / SUBROWS;
      if (a > 0) blend(c, py * size + px, color, Math.min(1, a) * opacity);
    }
  }
}

// ---- shapes -----------------------------------------------------------------

function paintShape(c: Canvas, shape: AvatarShape): void {
  switch (shape.kind) {
    case "circle": {
      const { cx, cy, r } = shape;
      paintSdf(c, cx, cy, r, rgb(shape.fill), shape.opacity ?? 1, (x, y) => Math.hypot(x - cx, y - cy) - r);
      return;
    }
    case "ring": {
      const { cx, cy, r, strokeWidth } = shape;
      const half = strokeWidth / 2;
      paintSdf(c, cx, cy, r + half, rgb(shape.stroke), shape.opacity ?? 1, (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - half);
      return;
    }
    case "ellipse": {
      const { cx, cy, rx, ry } = shape;
      const back = unrotate(shape.rotate);
      const [ccx, ccy] = rotatePoint(cx, cy, shape.rotate);
      paintSdf(c, ccx, ccy, Math.max(rx, ry), rgb(shape.fill), 1, (x, y) => {
        const [lx, ly] = back(x, y);
        const dx = lx - cx;
        const dy = ly - cy;
        const k = Math.hypot(dx / rx, dy / ry);
        if (k === 0) return -Math.min(rx, ry);
        const grad = Math.hypot(dx / (rx * rx), dy / (ry * ry)) / k;
        return (k - 1) / grad;
      });
      return;
    }
    case "rect": {
      const { x, y, width, height } = shape;
      const hx = width / 2;
      const hy = height / 2;
      const mx = x + hx;
      const my = y + hy;
      const r = Math.min(shape.rx, hx, hy);
      const back = unrotate(shape.rotate);
      const [ccx, ccy] = rotatePoint(mx, my, shape.rotate);
      paintSdf(c, ccx, ccy, Math.hypot(hx, hy), rgb(shape.fill), 1, (px, py) => {
        const [lx, ly] = back(px, py);
        const qx = Math.abs(lx - mx) - (hx - r);
        const qy = Math.abs(ly - my) - (hy - r);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      });
      return;
    }
    case "path":
      paintPolygons(c, flattenPath(shape.d), rgb(shape.fill), shape.opacity ?? 1);
      return;
  }
}

/**
 * The avatar for `seed`, drawn as the app shows it (a round crop), centred on a
 * square of `outer` with `pad` pixels of margin. Returns packed RGB.
 */
export function renderAvatarRgb(seed: string, size: number, pad: number, outer: string): Uint8Array {
  const spec = avatarSpec(seed);
  const inner = size - 2 * pad;
  const c: Canvas = { size, px: new Float32Array(size * size * 3), scale: inner / AVATAR_VIEWBOX, offset: pad };

  // Background gradient (objectBoundingBox, rotated about its centre), only
  // over the inner square: everything outside it is masked away below.
  const from = rgb(spec.background.from);
  const to = rgb(spec.background.to);
  const a = (spec.background.angle * Math.PI) / 180;
  const ga = Math.cos(a);
  const gb = Math.sin(a);
  for (let py = pad; py < size - pad; py++) {
    const by = (py + 0.5 - pad) / inner - 0.5;
    for (let px = pad; px < size - pad; px++) {
      const bx = (px + 0.5 - pad) / inner - 0.5;
      const t = clamp01(bx * ga + by * gb + 0.5);
      const k = (py * size + px) * 3;
      c.px[k] = from[0] + (to[0] - from[0]) * t;
      c.px[k + 1] = from[1] + (to[1] - from[1]) * t;
      c.px[k + 2] = from[2] + (to[2] - from[2]) * t;
    }
  }
  for (const shape of spec.shapes) paintShape(c, shape);

  // Round crop onto the outer colour.
  const out = new Uint8Array(size * size * 3);
  const bg = rgb(outer);
  const centre = size / 2;
  const radius = inner / 2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const d = Math.hypot(px + 0.5 - centre, py + 0.5 - centre) - radius;
      const m = d <= -0.5 ? 1 : d >= 0.5 ? 0 : 0.5 - d;
      const k = (py * size + px) * 3;
      for (let ch = 0; ch < 3; ch++) out[k + ch] = Math.round(bg[ch] + (c.px[k + ch] - bg[ch]) * m);
    }
  }
  return out;
}

// ---- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    t[n] = v >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" is the zlib container (RFC 1950), which is what IDAT holds.
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(rgbData: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  // Filter "Sub" per row: the avatar is flat colour, so horizontal deltas are
  // mostly zero and deflate squeezes them well.
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) {
      const v = rgbData[y * stride + x];
      const left = x >= 3 ? rgbData[y * stride + x - 3] : 0;
      raw[o + 1 + x] = (v - left) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const AVATAR_PNG_SIZE = 256;
// The app's light background (src/index.css --bg), so the preview reads as
// the same round picture the app shows rather than a square of shapes.
const AVATAR_PNG_OUTER = "#f2ede4";

export async function avatarPng(address: string): Promise<Uint8Array> {
  const size = AVATAR_PNG_SIZE;
  return encodePng(renderAvatarRgb(address, size, Math.round(size * 0.08), AVATAR_PNG_OUTER), size, size);
}

// An Ark address as the registry stores it: bech32 charset, "ark1" prefix.
// Anything else is refused before any drawing happens.
export function isAvatarAddress(value: string): boolean {
  return /^ark1[02-9ac-hj-np-z]{20,200}$/.test(value);
}
