// "Peníze v přání": the gift as a card. One canvas renderer for the sheet, the
// gallery image and the print PDF, so all three show the same thing.
//
// The card is ID-1 sized (85.6 x 54 mm, a bank card) so the printed one fits a
// wallet. It is always dark: an engraved illustration (giftMotifs.ts), the
// amount set in the app's display face.

import { ACCENT, CREAM, INK, type Motif } from "./giftMotifs";

export const CARD_W_MM = 85.6;
export const CARD_H_MM = 54;
// Drawing units: 300 across, the height follows the ID-1 ratio.
export const CARD_W = 300;
export const CARD_H = (CARD_W * CARD_H_MM) / CARD_W_MM;

const DISPLAY = '"Unbounded", "Space Grotesk", sans-serif';
const SANS = '"Space Grotesk", -apple-system, sans-serif';

export { MOTIFS, type Motif, type MotifId } from "./giftMotifs";

export interface CardText {
  occasion: string;
  amount: string;
  unit: string;
  message?: string;
  until: string;
  scan: string;
  details: string[];
  warning: string;
}

export const CARD_FONTS = [`700 34px ${DISPLAY}`, `400 11px ${SANS}`, `500 11px ${SANS}`, `700 11px ${SANS}`];

/** Resolves once the card's faces are usable on a canvas (a canvas never waits for a font itself). */
export function loadCardFonts(): Promise<unknown> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return Promise.all(CARD_FONTS.map((f) => document.fonts.load(f))).catch(() => undefined);
}

// Text over the line art: an ink outline first cuts the lines away around the
// letters, so the text reads without a box behind it.
function fillOver(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

// The app mark from public/favicon.svg (dark variant): the S glyph and the
// dot, in that file's 100-unit box.
const MARK_S =
  "M276 -14Q179 -14 117 28Q55 70 42 148L158 178Q165 143 181.5 123Q198 103 222.5 94.5Q247 86 276 86Q320 86 341 101.5Q362 117 362 140Q362 163 342 175.5Q322 188 278 196L250 201Q198 211 155 228.5Q112 246 86 277Q60 308 60 357Q60 431 114 470.5Q168 510 256 510Q339 510 394 473Q449 436 466 376L349 340Q341 378 316.5 394Q292 410 256 410Q220 410 201 397.5Q182 385 182 363Q182 339 202 327.5Q222 316 256 310L284 305Q340 295 385.5 278.5Q431 262 457.5 231.5Q484 201 484 149Q484 71 427.5 28.5Q371 -14 276 -14Z";
const MARK_DOT = "#8b5cf6";
// A shade above the card's ink, so the app-icon tile reads on the dark card.
const MARK_TILE = "#262017";

/** Draws the app icon (rounded tile, S, dot) as a `size`-unit square, top-right corner at (right, top). */
function drawMark(ctx: CanvasRenderingContext2D, right: number, top: number, size: number) {
  const k = size / 100;
  ctx.save();
  ctx.translate(right - size, top);
  ctx.scale(k, k);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.roundRect(0, 0, 100, 100, 22);
  ctx.fillStyle = MARK_TILE;
  ctx.fill();
  ctx.strokeStyle = "rgba(242, 237, 228, 0.18)";
  ctx.lineWidth = 1 / k;
  ctx.stroke();
  ctx.save();
  ctx.translate(17.796, 70.824);
  ctx.scale(0.08397, -0.08397);
  ctx.fillStyle = CREAM;
  ctx.globalAlpha = 1;
  ctx.fill(new Path2D(MARK_S));
  ctx.restore();
  ctx.fillStyle = MARK_DOT;
  ctx.beginPath();
  ctx.arc(69.88, 63.2, 8.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = word;
    if (out.length === maxLines) break;
  }
  if (out.length < maxLines && line) out.push(line);
  else if (line && out.length === maxLines) {
    let last = out[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    out[maxLines - 1] = `${last.trimEnd()}…`;
  }
  // A single word wider than the card still has to fit.
  return out.map((l) => {
    let s = l;
    while (s.length > 1 && ctx.measureText(s).width > width) s = s.slice(0, -2) + "…";
    return s;
  });
}

function ground(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

/** Draws the front in card units; the caller sets the transform (scale) first. */
export function drawFront(ctx: CanvasRenderingContext2D, motif: Motif, text: CardText) {
  ctx.save();
  ground(ctx);
  // Under the illustration, which runs over it at the edges.
  frame(ctx);
  ctx.save();
  motif.draw(ctx);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.fillStyle = CREAM;
  ctx.textBaseline = "alphabetic";

  const pad = 21;
  ctx.textAlign = "left";
  ctx.font = `500 12px ${SANS}`;
  // The right side belongs to the illustration: the mark sits with the text.
  drawMark(ctx, pad + 22, pad - 6, 22);
  fillOver(ctx, text.occasion, pad + 30, pad + 9);

  let size = 34;
  ctx.font = `700 ${size}px ${DISPLAY}`;
  while (size > 20 && ctx.measureText(text.amount).width > 176) {
    size -= 1;
    ctx.font = `700 ${size}px ${DISPLAY}`;
  }
  ctx.textAlign = "left";
  fillOver(ctx, text.amount, pad - 1, 96);
  ctx.globalAlpha = 0.7;
  ctx.font = `500 12px ${SANS}`;
  fillOver(ctx, text.unit, pad, 114);

  ctx.globalAlpha = 0.6;
  ctx.font = `400 10.5px ${SANS}`;
  fillOver(ctx, text.until, pad, 129);
  if (text.message) {
    ctx.globalAlpha = 1;
    ctx.font = `500 11px ${SANS}`;
    const msg = wrap(ctx, text.message, 140, 2);
    msg.forEach((l, i) => fillOver(ctx, l, pad, CARD_H - pad + 2 - (msg.length - 1 - i) * 14));
  }
  ctx.restore();
}

// Guilloche ring, the interwoven pattern printed behind banknote text: the
// same wave run round a circle several times, each pass slightly turned.
function rosette(ctx: CanvasRenderingContext2D, cx: number, cy: number, alpha: number) {
  const base = 27;
  const swing = 10;
  const waves = 18;
  const passes = 6;
  ctx.save();
  ctx.strokeStyle = CREAM;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 0.4;
  for (let j = 0; j < passes; j++) {
    const phase = (j / passes) * ((Math.PI * 2) / waves);
    ctx.beginPath();
    for (let i = 0; i <= 720; i++) {
      const t = (i / 720) * Math.PI * 2;
      const r = base + swing * Math.cos(waves * (t + phase));
      const x = cx + r * Math.cos(t);
      const y = cy + r * Math.sin(t);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// A double rule just inside the edge, like a banknote border.
function frame(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 0.6;
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.roundRect(7, 7, CARD_W - 14, CARD_H - 14, 10);
  ctx.stroke();
  ctx.globalAlpha = 0.1;
  ctx.beginPath();
  ctx.roundRect(9.5, 9.5, CARD_W - 19, CARD_H - 19, 8);
  ctx.stroke();
  ctx.restore();
}

/** Back: the claim QR on a light tile (scanners need dark on light) and what it does. */
export function drawBack(ctx: CanvasRenderingContext2D, qr: CanvasImageSource | null, text: CardText) {
  ctx.save();
  ground(ctx);
  frame(ctx);
  const pad = 22;
  const size = 122;
  const top = (CARD_H - size) / 2;
  const x = pad + size + 18;
  const w = CARD_W - pad - x;
  rosette(ctx, x + w / 2 + 4, CARD_H / 2, 0.16);

  ctx.fillStyle = "#f9f5ec";
  ctx.beginPath();
  ctx.roundRect(pad, top, size, size, 9);
  ctx.fill();
  if (qr) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, pad + 7, top + 7, size - 14, size - 14);
  }

  ctx.fillStyle = CREAM;
  ctx.textAlign = "left";
  ctx.font = `700 14px ${SANS}`;
  const head = wrap(ctx, text.scan, w, 2);
  head.forEach((l, i) => fillOver(ctx, l, x, top + 11 + i * 17));
  // The back's one accent: a short rule under the heading.
  const ruleY = top + 11 + (head.length - 1) * 17 + 9;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(x, ruleY);
  ctx.lineTo(x + 22, ruleY);
  ctx.stroke();

  ctx.font = `400 10px ${SANS}`;
  ctx.globalAlpha = 0.75;
  let y = ruleY + 16;
  for (const d of text.details) {
    for (const l of wrap(ctx, d, w, 2)) {
      fillOver(ctx, l, x, y);
      y += 13;
    }
  }
  ctx.globalAlpha = 1;
  ctx.font = `500 10px ${SANS}`;
  const warn = wrap(ctx, text.warning, w, 2);
  warn.forEach((l, i) => fillOver(ctx, l, x, top + size - 2 - (warn.length - 1 - i) * 13));
  ctx.restore();
}

/** A canvas with one side drawn at `pxPerUnit` device pixels per card unit, corners rounded. */
export function renderSide(
  side: "front" | "back",
  motif: Motif,
  text: CardText,
  qr: CanvasImageSource | null,
  pxPerUnit: number,
  rounded = true,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(CARD_W * pxPerUnit);
  c.height = Math.round(CARD_H * pxPerUnit);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.scale(pxPerUnit, pxPerUnit);
  if (rounded) {
    ctx.beginPath();
    ctx.roundRect(0, 0, CARD_W, CARD_H, 16);
    ctx.clip();
  }
  if (side === "front") drawFront(ctx, motif, text);
  else drawBack(ctx, qr, text);
  return c;
}

/** Gallery image: front above back on the app's dark ground. */
export function renderGalleryImage(motif: Motif, text: CardText, qr: CanvasImageSource | null): HTMLCanvasElement {
  const k = 4;
  const m = 24;
  const gap = 16;
  const c = document.createElement("canvas");
  c.width = (CARD_W + m * 2) * k;
  c.height = (CARD_H * 2 + gap + m * 2) * k;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.fillStyle = "#100e0a";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(renderSide("front", motif, text, qr, k), m * k, m * k);
  ctx.drawImage(renderSide("back", motif, text, qr, k), m * k, (m + CARD_H + gap) * k);
  return c;
}

/** Image for the share sheet: the front only, so the link travels as text beside it. */
export function renderShareImage(motif: Motif, text: CardText): HTMLCanvasElement {
  return renderSide("front", motif, text, null, 4);
}

export const A4_W_MM = 210;
export const A4_H_MM = 297;

/**
 * Print page at `dpi`: back and front side by side, fold line between them.
 * Cut around the outline, fold in half, and the card is two-sided.
 */
export function renderPrintPage(
  motif: Motif,
  text: CardText,
  qr: CanvasImageSource | null,
  hint: string,
  dpi = 300,
): HTMLCanvasElement {
  const pxPerMm = dpi / 25.4;
  const c = document.createElement("canvas");
  c.width = Math.round(A4_W_MM * pxPerMm);
  c.height = Math.round(A4_H_MM * pxPerMm);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);

  const cardPx = CARD_W_MM * pxPerMm;
  const h = CARD_H_MM * pxPerMm;
  const left = (c.width - cardPx * 2) / 2;
  const right = left + cardPx * 2;
  const top = 30 * pxPerMm;
  const bottom = top + h;
  const k = cardPx / CARD_W;
  // Bleed: ink 2 mm past the cut line, so a cut that wanders shows no white edge.
  const bleed = 2 * pxPerMm;
  ctx.fillStyle = INK;
  ctx.fillRect(left - bleed, top - bleed, cardPx * 2 + bleed * 2, h + bleed * 2);
  ctx.drawImage(renderSide("back", motif, text, qr, k, false), left, top);
  ctx.drawImage(renderSide("front", motif, text, qr, k, false), left + cardPx, top);

  // Crop marks at the corners and fold marks at the middle, all outside the bleed.
  const gap = 3 * pxPerMm;
  const len = 5 * pxPerMm;
  ctx.strokeStyle = "#16130d";
  ctx.lineWidth = Math.max(1, pxPerMm * 0.12);
  ctx.beginPath();
  for (const x of [left, right]) {
    for (const [y, dir] of [
      [top, -1],
      [bottom, 1],
    ] as const) {
      ctx.moveTo(x, y + dir * gap);
      ctx.lineTo(x, y + dir * (gap + len));
    }
  }
  for (const y of [top, bottom]) {
    for (const [x, dir] of [
      [left, -1],
      [right, 1],
    ] as const) {
      ctx.moveTo(x + dir * gap, y);
      ctx.lineTo(x + dir * (gap + len), y);
    }
  }
  ctx.stroke();
  const mid = left + cardPx;
  ctx.setLineDash([pxPerMm * 1, pxPerMm * 0.8]);
  ctx.beginPath();
  ctx.moveTo(mid, top - gap);
  ctx.lineTo(mid, top - gap - len);
  ctx.moveTo(mid, bottom + gap);
  ctx.lineTo(mid, bottom + gap + len);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#55503f";
  ctx.font = `400 ${3 * pxPerMm}px ${SANS}`;
  ctx.textAlign = "center";
  ctx.fillText(hint, c.width / 2, bottom + 18 * pxPerMm);
  return c;
}
