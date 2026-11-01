import { useLayoutEffect, useRef } from "react";

// A quill writing on a scroll, once, above the seed words ("write it down on paper"). Same grey as the password mark
// so the two screens read as one family. The three lines are drawn left to right with the nib riding the very curve
// being drawn (the ink and the nib share one progress, so they cannot drift apart); the pace is uneven like a hand
// (a push per word, softer at the ends), the quill tilts a little with the stroke, lifts in an arc between lines and
// then rests. Reduced motion shows the finished drawing.
//
// The scroll is Lucide's "scroll" (ISC, https://lucide.dev), drawn on its 24 grid scaled to the 256 box, with the curl and
// the roll made about a quarter smaller; the quill is Phosphor's thin "feather" (MIT, (c) Phosphor Icons, https://phosphoricons.com), drawn with its nib at the group's
// origin. LINES are [y, length]; each is one continuous low wave, a half period every 15 units.
const FEATHER =
  "M236,80A60,60,0,0,0,133.59,37.56L63.52,106.83A11.9,11.9,0,0,0,60,115.31v75L29.17,221.17a4,4,0,0,0,5.66,5.66L65.66,196h75a12,12,0,0,0,8.48-3.51l0,0L218,122.83h0l.4-.4A59.63,59.63,0,0,0,236,80ZM139.23,43.23A52,52,0,0,1,213.5,116H145.66l41.17-41.17a4,4,0,1,0-5.66-5.66L116,134.34V66.19ZM68,115.31a4,4,0,0,1,1.16-2.81L108,74.1v68.24l-40,40Zm75.51,71.52a4,4,0,0,1-2.82,1.17h-67l64-64h68Z";
// The feather's outline alone (its first subpath), filled with the surface and a margin: where the quill crosses the
// paper's edge the line breaks cleanly around it instead of running through the feather.
const FEATHER_OUTLINE =
  "M236,80A60,60,0,0,0,133.59,37.56L63.52,106.83A11.9,11.9,0,0,0,60,115.31v75L29.17,221.17a4,4,0,0,0,5.66,5.66L65.66,196h75a12,12,0,0,0,8.48-3.51l0,0L218,122.83h0l.4-.4A59.63,59.63,0,0,0,236,80Z";
const LINES: [number, number][] = [[72, 90], [106, 75], [140, 45]];
const X0 = 84;
const WRITE_SPEED = 120; // units of curve per second
const START_DELAY = 0.25; // lets the sheet finish rising first
const ARRIVE = 0.4;
const LIFT = 0.4;
const SETTLE = 0.45;
const WORDS = 3; // pushes per line

// A low wave (peak 4.5 units, a half period per 15) from x0 for len units: one quadratic, then reflected ones.
function wave(x0: number, y: number, len: number) {
  return `M${x0} ${y}q7.5 -9 15 0${"t15 0".repeat(len / 15 - 1)}`;
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
const smoother = (u: number) => u * u * u * (u * (6 * u - 15) + 10);
// Progress along a line: a gentle push per word on top of a soft start and stop. Both parts are monotone (the push
// never takes the speed below about 0.7 of the average), so the nib never runs backwards and never seems to stutter.
const pace = (u: number) => {
  const k = 2 * Math.PI * WORDS;
  const pushes = u - (0.3 * Math.sin(k * u)) / k;
  return 0.5 * pushes + 0.5 * smoother(u);
};

export function QuillMark() {
  const lineRefs = useRef<(SVGPathElement | null)[]>([]);
  const quillRef = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    const quill = quillRef.current;
    const paths = lineRefs.current;
    if (!quill || paths.length !== LINES.length || paths.some((p) => !p)) return;
    const lines = paths as SVGPathElement[];
    const lens = lines.map((p) => p.getTotalLength());
    const at = (i: number, p: number) => lines[i].getPointAtLength(p * lens[i]);
    // The segments say where the nib is and how the quill should lean; the lean is eased towards that each frame so it
    // follows the stroke instead of jumping with its slope.
    let rot = 0;
    let shownOpacity = -1;
    const pose = { x: 0, y: 0, rot: 0, opacity: 0 };
    const place = (x: number, y: number, rotTarget: number, opacity: number) => {
      pose.x = x;
      pose.y = y;
      pose.rot = rotTarget;
      pose.opacity = opacity;
    };
    const paint = (dt: number) => {
      rot += (pose.rot - rot) * (1 - Math.exp(-dt * 9));
      quill.setAttribute("transform", `translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${rot.toFixed(2)})`);
      if (pose.opacity !== shownOpacity) {
        shownOpacity = pose.opacity;
        quill.style.opacity = String(pose.opacity);
      }
    };
    const ink = (i: number, p: number) => {
      lines[i].style.strokeDashoffset = String(1 - p);
      // A fully undrawn dash still paints its round cap as a dot.
      lines[i].style.opacity = p > 0.002 ? "1" : "0";
    };
    const end = at(LINES.length - 1, 1);
    const rest = { x: end.x + 22, y: end.y - 6 };

    const finish = () => {
      lines.forEach((_, i) => ink(i, 1));
      place(rest.x, rest.y, 0, 1);
      rot = 0;
      paint(1);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }

    // One list of segments played in order; each gets u in 0..1.
    type Seg = { dur: number; run: (u: number) => void };
    const segs: Seg[] = [{ dur: START_DELAY, run: () => {} }];
    const start0 = at(0, 0);
    const from = { x: start0.x - 12, y: start0.y + 20 };
    segs.push({
      dur: ARRIVE,
      run: (u) => {
        const e = easeOut(u);
        place(from.x + (start0.x - from.x) * e, from.y + (start0.y - from.y) * e, 0, u);
      },
    });
    LINES.forEach((_, i) => {
      segs.push({
        dur: lens[i] / WRITE_SPEED,
        run: (u) => {
          const p = pace(u);
          ink(i, p);
          const a = at(i, p);
          const b = at(i, Math.min(1, p + 0.02));
          // A fraction of the stroke's own slope plus a slow sway: the hand turns a little as it writes, it does not shake.
          const slope = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
          place(a.x, a.y, slope * 0.12 + 1.5 * Math.sin(2 * Math.PI * WORDS * p), 1);
        },
      });
      if (i < LINES.length - 1) {
        const p0 = at(i, 1);
        const p1 = at(i + 1, 0);
        // Swings below the lines, where the page is empty: an arc above would sweep over the line just written.
        const c = { x: (p0.x + p1.x) / 2, y: Math.max(p0.y, p1.y) + 22 };
        segs.push({
          dur: LIFT,
          run: (u) => {
            const e = easeInOut(u);
            const m = 1 - e;
            place(
              m * m * p0.x + 2 * m * e * c.x + e * e * p1.x,
              m * m * p0.y + 2 * m * e * c.y + e * e * p1.y,
              0,
              1,
            );
          },
        });
      }
    });
    segs.push({
      dur: SETTLE,
      run: (u) => {
        const e = easeOut(u);
        place(end.x + (rest.x - end.x) * e, end.y + (rest.y - end.y) * e, 0, 1);
      },
    });

    lines.forEach((_, i) => ink(i, 0));
    place(from.x, from.y, 0, 0);
    paint(1);

    let raf = 0;
    let t0: number | null = null;
    let prev = 0;
    let settled = 0;
    const total = segs.reduce((n, s) => n + s.dur, 0);
    const frame = (now: number) => {
      t0 ??= now;
      const t = (now - t0) / 1000;
      const dt = Math.min(0.05, t - prev);
      prev = t;
      if (t >= total) {
        finish();
        return;
      }
      let acc = 0;
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        if (t < acc + s.dur) {
          // A late frame can jump over whole segments; give each one its final state first, so a skipped line
          // is still drawn.
          for (; settled < k; settled++) segs[settled].run(1);
          s.run((t - acc) / s.dur);
          paint(dt);
          break;
        }
        acc += s.dur;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="sht-mark qm-mark" aria-hidden="true">
      <svg viewBox="0 0 256 256">
        <g className="qm-scroll" transform="scale(10.667)">
          <path d="M19 17.5V5a2 2 0 0 0-2-2H4.5" />
          <path d="M7.5 20.5H19.5a1.5 1.5 0 0 0 1.5-1.5v-.5a1 1 0 0 0-1-1H10a1 1 0 0 0-1 1v.5a1.5 1.5 0 1 1-3 0V4.5a1.5 1.5 0 1 0-3 0V7a1 1 0 0 0 1 1h2" />
        </g>
        {LINES.map(([y, len], i) => (
          <path
            key={i}
            ref={(el) => {
              lineRefs.current[i] = el;
            }}
            className="qm-dash"
            pathLength="1"
            d={wave(X0, y, len)}
          />
        ))}
        <g ref={quillRef} transform={`translate(${X0 + 45 + 22} ${140 - 6})`}>
          <g transform="rotate(24) scale(.34) translate(-31 -224)">
            <path className="qm-under" d={FEATHER_OUTLINE} />
            <path className="qm-feather" d={FEATHER} />
          </g>
        </g>
      </svg>
    </div>
  );
}
