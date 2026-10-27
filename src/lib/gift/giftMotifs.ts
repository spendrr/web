// The card illustrations, drawn the way a banknote is engraved: fine cream
// lines on ink, shapes filled with ink so what lies in front hides what lies
// behind, shading by hatching, one accent element per motif.
//
// Everything is in card units (300 across, see giftCard.ts) and deterministic,
// so the sheet, the gallery image and the PDF show the same drawing.

type Ctx = CanvasRenderingContext2D;

export const INK = "#16130d";
export const CREAM = "#f2ede4";
export const ACCENT = "#e89540";

const TAU = Math.PI * 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rad = (deg: number) => (deg * Math.PI) / 180;

function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pen(ctx: Ctx, width: number, alpha = 1, color = CREAM) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function seg(ctx: Ctx, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function solid(ctx: Ctx, p: Path2D, edge = CREAM, width = 0.8) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.fill(p);
  pen(ctx, width, 1, edge);
  ctx.stroke(p);
}

/** Parallel lines at `angle` across a box, clipped to `clip`; `skip` leaves a highlight. */
function hatch(
  ctx: Ctx,
  clip: Path2D,
  box: [number, number, number, number],
  angle: number,
  gap: number,
  width: number,
  alpha: number,
  color = CREAM,
  skip?: (x: number, y: number) => boolean,
) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = Math.hypot(x1 - x0, y1 - y0) / 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  ctx.save();
  ctx.clip(clip);
  pen(ctx, width, alpha, color);
  for (let o = -r; o <= r; o += gap) {
    const px = cx - dy * o;
    const py = cy + dx * o;
    if (!skip) {
      seg(ctx, px - dx * r, py - dy * r, px + dx * r, py + dy * r);
      continue;
    }
    // Broken where the highlight is: short runs, so the gap reads as light.
    let on = false;
    ctx.beginPath();
    for (let s = -r; s <= r; s += 1.5) {
      const x = px + dx * s;
      const y = py + dy * s;
      const lit = skip(x, y);
      if (!lit && !on) ctx.moveTo(x, y);
      if (!lit) ctx.lineTo(x, y);
      on = !lit;
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Almond (leaf, petal) along +x from the origin. */
function almond(len: number, wid: number): Path2D {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.bezierCurveTo(len * 0.25, -wid, len * 0.68, -wid * 0.92, len, 0);
  p.bezierCurveTo(len * 0.68, wid * 0.92, len * 0.25, wid, 0, 0);
  p.closePath();
  return p;
}

function leaf(ctx: Ctx, x: number, y: number, ang: number, len: number, wid: number, veins = 4, edge = CREAM) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const p = almond(len, wid);
  solid(ctx, p, edge, 0.75);
  pen(ctx, 0.5, 0.85, edge);
  seg(ctx, 0, 0, len * 0.9, 0);
  // Veins: full on the lit side, faint on the shaded one.
  for (let i = 1; i <= veins; i++) {
    const t = i / (veins + 1);
    const vx = len * t;
    const half = wid * 0.72 * Math.sin(Math.PI * Math.min(1, t * 1.1));
    pen(ctx, 0.45, 0.7, edge);
    seg(ctx, vx, 0, vx + half * 0.9, -half * 0.85);
    pen(ctx, 0.45, 0.3, edge);
    seg(ctx, vx, 0, vx + half * 0.9, half * 0.85);
  }
  ctx.restore();
}

/** A flight feather along +x: blunt tip, shaft, barbs engraved on both vanes. */
function feather(ctx: Ctx, x: number, y: number, ang: number, len: number, wid: number, edge = CREAM) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const p = new Path2D();
  p.moveTo(0, -wid * 0.32);
  p.bezierCurveTo(len * 0.4, -wid * 0.55, len * 0.8, -wid * 0.55, len * 0.97, -wid * 0.18);
  p.quadraticCurveTo(len * 1.01, wid * 0.12, len * 0.86, wid * 0.42);
  p.bezierCurveTo(len * 0.6, wid * 0.58, len * 0.3, wid * 0.5, 0, wid * 0.32);
  p.closePath();
  solid(ctx, p, edge, 0.75);
  ctx.save();
  ctx.clip(p);
  for (let s = 3; s < len * 0.95; s += 2.1) {
    pen(ctx, 0.4, 0.6, edge);
    seg(ctx, s, -wid * 0.04, s + 3.2, -wid * 0.6);
    pen(ctx, 0.4, 0.28, edge);
    seg(ctx, s, wid * 0.04, s + 3.2, wid * 0.6);
  }
  ctx.restore();
  pen(ctx, 0.6, 0.95, edge);
  seg(ctx, 0, 0, len * 0.9, -wid * 0.04);
  ctx.restore();
}

function quadAt(p0: number[], c: number[], p1: number[], t: number): [number, number] {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

function quadTangent(p0: number[], c: number[], p1: number[], t: number): number {
  const dx = 2 * (1 - t) * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]);
  const dy = 2 * (1 - t) * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1]);
  return Math.atan2(dy, dx);
}

// ---------------------------------------------------------------------------
// Eagle: wings raised, head in profile, a sun behind it.

function eagleWing(ctx: Ctx) {
  const S = [5, -6];
  const C = [30, -6];
  const W = [44, -42];
  const n = 12;
  // Flight feathers, outermost first so the inner ones lie over them.
  for (let i = n - 1; i >= 0; i--) {
    const k = i / (n - 1);
    const [x, y] = quadAt(S, C, W, lerp(0.18, 1, k));
    const ang = rad(lerp(22, -80, Math.pow(k, 0.85)));
    const len = lerp(30, 60, Math.pow(k, 0.7)) * (i === n - 1 ? 0.9 : 1);
    feather(ctx, x, y, ang, len, lerp(7, 8.5, k));
  }
  // Coverts: two rows of short feathers over the feather roots.
  for (let i = 0; i <= 9; i++) {
    const t = lerp(0.08, 0.98, i / 9);
    const [x, y] = quadAt(S, C, W, t);
    const ang = rad(lerp(25, -70, Math.pow(t, 0.85)));
    feather(ctx, x, y, ang, lerp(15, 19, t), 7);
  }
  for (let i = 0; i <= 8; i++) {
    const t = lerp(0.04, 0.9, i / 8);
    const [x, y] = quadAt(S, C, W, t);
    const ang = rad(lerp(30, -60, t));
    feather(ctx, x - 1, y + 1, ang, 10, 6.5);
  }
  // Leading edge of the wing.
  pen(ctx, 1.4, 1);
  ctx.beginPath();
  ctx.moveTo(S[0], S[1]);
  ctx.quadraticCurveTo(C[0], C[1] - 3, W[0], W[1]);
  ctx.stroke();
}

function drawEagle(ctx: Ctx) {
  ctx.save();
  ctx.translate(250, 108);
  ctx.scale(1.12, 1.12);

  // Sun behind the head: the accent, mostly hidden by the bird.
  pen(ctx, 1.2, 1, ACCENT);
  ctx.beginPath();
  ctx.arc(0, -36, 27, 0, TAU);
  ctx.stroke();
  pen(ctx, 0.5, 0.55, ACCENT);
  ctx.beginPath();
  ctx.arc(0, -36, 23.5, 0, TAU);
  ctx.stroke();

  // Tail fan, the outer feathers first.
  for (const o of [-3, 3, -2, 2, -1, 1, 0]) {
    feather(ctx, 0, 22, rad(90 + o * 9), 32 - Math.abs(o) * 0.8, 8);
  }

  ctx.save();
  eagleWing(ctx);
  ctx.restore();
  ctx.save();
  ctx.scale(-1, 1);
  eagleWing(ctx);
  ctx.restore();

  // Talons drawn up under the body.
  for (const side of [-1, 1]) {
    pen(ctx, 1, 1);
    const fx = side * 6;
    seg(ctx, side * 4, 22, fx, 31);
    for (const c of [-1, 0, 1]) {
      ctx.beginPath();
      ctx.moveTo(fx, 31);
      ctx.quadraticCurveTo(fx + c * 3 + side, 34, fx + c * 3.6, 36.5);
      ctx.stroke();
    }
  }

  // Body, shaded by contour lines that follow its curve.
  const body = new Path2D();
  body.moveTo(0, -27);
  body.bezierCurveTo(13, -24, 14, 6, 6, 27);
  body.lineTo(-6, 27);
  body.bezierCurveTo(-14, 6, -13, -24, 0, -27);
  body.closePath();
  solid(ctx, body, CREAM, 0.9);
  ctx.save();
  ctx.clip(body);
  for (let f = -1; f <= 1.001; f += 0.2) {
    pen(ctx, 0.5, 0.35 + 0.45 * Math.max(0, f));
    ctx.beginPath();
    ctx.moveTo(f * 3, -26);
    ctx.bezierCurveTo(f * 13, -16, f * 14, 8, f * 5, 27);
    ctx.stroke();
  }
  // Breast feathers: short chevrons across the contours.
  for (let y = -12; y < 24; y += 5) {
    for (let x = -8; x <= 8; x += 4) {
      pen(ctx, 0.45, 0.5);
      ctx.beginPath();
      ctx.moveTo(x - 1.6, y);
      ctx.lineTo(x, y + 2);
      ctx.lineTo(x + 1.6, y);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Head in profile, facing left, hooked beak in the accent.
  const head = new Path2D();
  head.moveTo(6, -24);
  head.bezierCurveTo(10, -32, 7, -43, -1, -43);
  head.bezierCurveTo(-8, -43, -10, -38, -10, -35);
  head.bezierCurveTo(-8, -30, -7, -27, -6, -24);
  head.closePath();
  solid(ctx, head, CREAM, 0.9);
  ctx.save();
  ctx.clip(head);
  for (let i = 0; i < 7; i++) {
    pen(ctx, 0.45, 0.5);
    seg(ctx, -2 + i * 2, -44, 2 + i * 2.4, -24);
  }
  ctx.restore();
  const beak = new Path2D();
  beak.moveTo(-9, -38.5);
  beak.bezierCurveTo(-14, -40, -19, -38, -19.5, -33.5);
  beak.bezierCurveTo(-19.6, -31.5, -18.5, -30.5, -17.6, -31.2);
  beak.bezierCurveTo(-17, -33.5, -15, -34.5, -9.5, -33);
  beak.closePath();
  ctx.globalAlpha = 1;
  ctx.fillStyle = ACCENT;
  ctx.fill(beak);
  // Eye and brow.
  ctx.fillStyle = CREAM;
  ctx.beginPath();
  ctx.arc(-4.6, -37.6, 1.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(-4.9, -37.6, 0.7, 0, TAU);
  ctx.fill();
  pen(ctx, 0.8, 1);
  seg(ctx, -8.5, -39.8, -1.5, -40.6);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Balloons on curled strings.

function drawBalloons(ctx: Ctx) {
  const knotTo = [246, 214];
  // Back to front: later balloons cover earlier ones.
  const balloons = [
    { x: 283, y: 46, rx: 17, ry: 21, rot: 0.2, accent: false },
    { x: 222, y: 40, rx: 16, ry: 20, rot: -0.2, accent: false },
    { x: 274, y: 98, rx: 19, ry: 23, rot: 0.1, accent: false },
    { x: 226, y: 96, rx: 18, ry: 22, rot: -0.12, accent: false },
    { x: 252, y: 64, rx: 22, ry: 27, rot: 0.02, accent: true },
  ];
  // Strings first: they run behind every balloon.
  for (const [i, b] of balloons.entries()) {
    const kx = b.x + Math.sin(b.rot) * -b.ry;
    const ky = b.y + Math.cos(b.rot) * b.ry + 3;
    pen(ctx, 0.6, 0.75);
    ctx.beginPath();
    ctx.moveTo(kx, ky);
    const sway = i % 2 ? 9 : -9;
    ctx.bezierCurveTo(kx + sway, ky + 25, knotTo[0] - sway, knotTo[1] - 45, knotTo[0], knotTo[1]);
    ctx.stroke();
  }
  for (const b of balloons) {
    const edge = b.accent ? ACCENT : CREAM;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    const p = new Path2D();
    // Egg shape: fuller at the top.
    p.moveTo(0, -b.ry);
    p.bezierCurveTo(b.rx * 1.1, -b.ry, b.rx * 1.05, b.ry * 0.45, 0, b.ry);
    p.bezierCurveTo(-b.rx * 1.05, b.ry * 0.45, -b.rx * 1.1, -b.ry, 0, -b.ry);
    p.closePath();
    solid(ctx, p, edge, 0.9);
    const hx = -b.rx * 0.38;
    const hy = -b.ry * 0.42;
    hatch(ctx, p, [-b.rx, -b.ry, b.rx, b.ry], rad(-28), 1.9, 0.45, 0.6, edge, (x, y) =>
      Math.hypot((x - hx) / b.rx, (y - hy) / b.ry) < 0.34,
    );
    // Shade line along the lower right rim.
    ctx.save();
    ctx.clip(p);
    pen(ctx, 0.5, 0.5, edge);
    ctx.beginPath();
    ctx.ellipse(-b.rx * 0.1, -b.ry * 0.05, b.rx * 0.82, b.ry * 0.86, 0, rad(-20), rad(110));
    ctx.stroke();
    ctx.restore();
    // Knot.
    const k = new Path2D();
    k.moveTo(-2.2, b.ry + 3.2);
    k.lineTo(0, b.ry - 0.5);
    k.lineTo(2.2, b.ry + 3.2);
    k.closePath();
    solid(ctx, k, edge, 0.7);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Spruce branch with a bauble, a few snowflakes.

function needles(ctx: Ctx, P0: number[], C: number[], P1: number[], maxLen: number, R: () => number) {
  const steps = Math.round(Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) / 2.1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = quadAt(P0, C, P1, t);
    const a = quadTangent(P0, C, P1, t);
    const len = maxLen * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08))) * (0.85 + R() * 0.3);
    for (const side of [-1, 1]) {
      const na = a + side * rad(48 + R() * 12);
      pen(ctx, 0.65, side < 0 ? 0.9 : 0.55);
      seg(ctx, x, y, x + Math.cos(na) * len, y + Math.sin(na) * len);
    }
  }
  pen(ctx, 1.1, 1);
  ctx.beginPath();
  ctx.moveTo(P0[0], P0[1]);
  ctx.quadraticCurveTo(C[0], C[1], P1[0], P1[1]);
  ctx.stroke();
}

function snowflake(ctx: Ctx, x: number, y: number, r: number, alpha: number) {
  pen(ctx, 0.55, alpha);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    seg(ctx, x, y, x + c * r, y + s * r);
    for (const f of [0.5, 0.75]) {
      const bx = x + c * r * f;
      const by = y + s * r * f;
      const b = r * 0.28 * (f === 0.5 ? 1 : 0.7);
      seg(ctx, bx, by, bx + Math.cos(a + 0.8) * b, by + Math.sin(a + 0.8) * b);
      seg(ctx, bx, by, bx + Math.cos(a - 0.8) * b, by + Math.sin(a - 0.8) * b);
    }
  }
}

function cone(ctx: Ctx, x: number, y: number, ang: number, len: number, wid: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  pen(ctx, 0.8, 1);
  seg(ctx, -5, 0, 0, 0);
  const p = almond(len, wid);
  solid(ctx, p, CREAM, 0.8);
  ctx.save();
  ctx.clip(p);
  // Scales in a lattice, each an arc opening towards the stem.
  for (let row = 0, sx = 2; sx < len + 4; sx += 3.6, row++) {
    for (let sy = -wid + (row % 2) * 2.2; sy <= wid; sy += 4.4) {
      pen(ctx, 0.5, sy < 0 ? 0.85 : 0.45);
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6, rad(-70), rad(70));
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.restore();
}

function drawSpruce(ctx: Ctx) {
  const R = rng(11);
  const P0 = [342, 2];
  const C = [262, 30];
  const P1 = [204, 126];
  // Side twigs leave the main stem forwards, drawn first so the stem lies over them.
  const twigs: [number, number, number][] = [
    [0.12, -1, 52],
    [0.22, 1, 50],
    [0.36, -1, 44],
    [0.46, 1, 40],
    [0.6, -1, 34],
    [0.72, 1, 28],
    [0.84, -1, 20],
  ];
  for (const [t, side, len] of twigs) {
    const [x, y] = quadAt(P0, C, P1, t);
    const a = quadTangent(P0, C, P1, t) + side * rad(40);
    const end = [x + Math.cos(a) * len, y + Math.sin(a) * len];
    const ctl = [x + Math.cos(a - side * 0.3) * len * 0.55, y + Math.sin(a - side * 0.3) * len * 0.55];
    needles(ctx, [x, y], ctl, end, 10, R);
  }
  needles(ctx, P0, C, P1, 13, R);

  // A cone hanging from an upper twig.
  const [cx, cy] = quadAt(P0, C, P1, 0.36);
  cone(ctx, cx - 4, cy + 8, rad(100), 24, 7.5);

  // Bauble, the accent, hanging from the main stem.
  const [hx, hy] = quadAt(P0, C, P1, 0.52);
  const bx = hx + 6;
  const by = hy + 46;
  pen(ctx, 0.6, 0.9, ACCENT);
  seg(ctx, hx, hy, bx, by - 15);
  const cap = new Path2D();
  cap.rect(bx - 3.5, by - 17, 7, 4.5);
  solid(ctx, cap, ACCENT, 0.8);
  const ball = new Path2D();
  ball.arc(bx, by, 13.5, 0, TAU);
  solid(ctx, ball, ACCENT, 1);
  ctx.save();
  ctx.clip(ball);
  for (let i = -3; i <= 3; i++) {
    pen(ctx, 0.5, 0.75, ACCENT);
    ctx.beginPath();
    ctx.ellipse(bx, by + i * 3.8, 13.5 * Math.sqrt(Math.max(0, 1 - Math.pow(i / 3.6, 2))), 1.7, 0, 0, Math.PI);
    ctx.stroke();
  }
  ctx.restore();
  hatch(ctx, ball, [bx - 14, by - 14, bx + 14, by + 14], rad(60), 1.8, 0.4, 0.45, ACCENT, (x, y) =>
    Math.hypot(x - (bx - 5), y - (by - 5)) < 4.8 || Math.hypot(x - bx, y - by) < 7,
  );

  snowflake(ctx, 196, 26, 6, 0.7);
  snowflake(ctx, 232, 12, 4, 0.5);
  snowflake(ctx, 290, 168, 5.5, 0.55);
  snowflake(ctx, 228, 172, 3.5, 0.45);
}

// ---------------------------------------------------------------------------
// Laurel wreath tied with a bow, two rings inside.

function drawLaurel(ctx: Ctx) {
  // The whole wreath on the card: leaves reach about 11 past the radius.
  const cx = 238;
  const cy = 94;
  const r = 43;
  const R = rng(5);
  for (const side of [-1, 1]) {
    // From the bow at the bottom up and around to the top, on one side.
    const from = 96;
    const to = 262;
    const steps = 15;
    const stem = new Path2D();
    for (let i = 0; i <= steps; i++) {
      const deg = lerp(from, to, i / steps);
      const a = side > 0 ? rad(deg) : rad(180 - deg);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) stem.moveTo(x, y);
      else stem.lineTo(x, y);
    }
    pen(ctx, 1, 1);
    ctx.stroke(stem);
    for (let i = 0; i < steps; i++) {
      const k = (i + 0.5) / steps;
      const deg = lerp(from, to, k);
      const a = side > 0 ? rad(deg) : rad(180 - deg);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      // Tangent pointing along the growth direction.
      const tang = a + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
      const size = lerp(1, 0.62, k);
      leaf(ctx, x, y, tang - side * rad(40 + R() * 8), 17 * size, 5.2 * size, 3);
      leaf(ctx, x, y, tang + side * rad(34 + R() * 8), 15 * size, 4.8 * size, 3);
    }
    // Berries.
    for (let i = 2; i < steps; i += 4) {
      const deg = lerp(from, to, i / steps);
      const a = side > 0 ? rad(deg) : rad(180 - deg);
      const p = new Path2D();
      p.arc(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6), 2, 0, TAU);
      solid(ctx, p, CREAM, 0.7);
    }
  }

  // Two linked rings, engraved as double lines.
  for (const x of [cx - 10, cx + 10]) {
    pen(ctx, 1.4, 1);
    ctx.beginPath();
    ctx.arc(x, cy, 14, 0, TAU);
    ctx.stroke();
    pen(ctx, 0.5, 0.65);
    ctx.beginPath();
    ctx.arc(x, cy, 11, 0, TAU);
    ctx.stroke();
  }

  // Bow at the bottom, the accent.
  const by = cy + r + 2;
  const bow = new Path2D();
  bow.moveTo(cx, by);
  bow.bezierCurveTo(cx - 14, by - 11, cx - 19, by + 5, cx, by);
  bow.moveTo(cx, by);
  bow.bezierCurveTo(cx + 14, by - 11, cx + 19, by + 5, cx, by);
  bow.moveTo(cx - 1, by);
  bow.bezierCurveTo(cx - 6, by + 9, cx - 9, by + 15, cx - 13, by + 20);
  bow.moveTo(cx + 1, by);
  bow.bezierCurveTo(cx + 6, by + 9, cx + 9, by + 15, cx + 13, by + 20);
  pen(ctx, 1.2, 1, ACCENT);
  ctx.stroke(bow);
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(cx, by, 2.2, 0, TAU);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Sunflower: two layers of petals, a seed head in the accent.

function drawSunflower(ctx: Ctx) {
  // Set towards the right, cropped at the frame's inner rule (giftCard.ts
  // draws the rules 7 and 9.5 in from the edge) so no petal crosses it.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(9.5, 9.5, 300 - 19, (300 * 54) / 85.6 - 19, 8);
  ctx.clip();
  ctx.translate(256, 96);
  ctx.scale(0.86, 0.86);
  const cx = 0;
  const cy = 0;
  const disk = 29;
  const R = rng(9);
  for (const [layer, count, len, wid, rot] of [
    [0, 21, 44, 8.5, 0.5],
    [1, 21, 40, 8, 0],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const a = ((i + rot) / count) * TAU + R() * 0.05;
      const l = len * (0.9 + R() * 0.18);
      ctx.save();
      ctx.translate(cx + Math.cos(a) * (disk - 4), cy + Math.sin(a) * (disk - 4));
      ctx.rotate(a);
      const p = almond(l, wid);
      solid(ctx, p, CREAM, 0.75);
      // Lengthwise veins.
      ctx.save();
      ctx.clip(p);
      for (const v of [-0.45, -0.15, 0.15, 0.45]) {
        pen(ctx, 0.45, layer === 0 ? 0.3 : 0.55 - Math.abs(v) * 0.3);
        ctx.beginPath();
        ctx.moveTo(2, 0);
        ctx.quadraticCurveTo(l * 0.5, v * wid * 1.5, l * 0.96, v * wid * 0.2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }
  }
  const head = new Path2D();
  head.arc(cx, cy, disk, 0, TAU);
  solid(ctx, head, CREAM, 1);
  // Seeds on the golden angle.
  const n = 340;
  const golden = Math.PI * (3 - Math.sqrt(5));
  ctx.fillStyle = ACCENT;
  for (let k = 1; k < n; k++) {
    const t = Math.sqrt(k / n);
    const rr = (disk - 2.5) * t;
    const a = k * golden;
    ctx.globalAlpha = 0.45 + 0.55 * t;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.35 + 0.75 * t, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

export type MotifId = "eagle" | "balloons" | "spruce" | "laurel" | "sunflower";

export interface Motif {
  id: MotifId;
  /** Czech, used as the t() key by the caller. */
  name: string;
  occasion: string;
  draw: (ctx: Ctx) => void;
}

export const MOTIFS: Motif[] = [
  { id: "eagle", name: "Orel", occasion: "Dárek", draw: drawEagle },
  { id: "balloons", name: "Balónky", occasion: "Všechno nejlepší", draw: drawBalloons },
  { id: "spruce", name: "Smrk", occasion: "Veselé Vánoce", draw: drawSpruce },
  { id: "laurel", name: "Vavřín", occasion: "Novomanželům", draw: drawLaurel },
  { id: "sunflower", name: "Slunečnice", occasion: "Děkuju", draw: drawSunflower },
];
