import { useId, useMemo } from "react";

// A vault drawn the way banknotes are engraved: hatching that thickens toward the shaded side, a guilloche
// rosette round the dial, hairline ticks, one accent. Everything is generated from a few numbers, so the line
// work stays regular. Ink is the text colour, so it follows the theme.

const W = 160;

function hatch(spacing: number, from = -W, to = W * 2): string {
  let d = "";
  for (let c = from; c < to; c += spacing) d += `M${c.toFixed(1)} 0L${(c + W).toFixed(1)} ${W}`;
  return d;
}

function vHatch(x0: number, x1: number, y0: number, y1: number, spacing: number): string {
  let d = "";
  for (let x = x0; x <= x1; x += spacing) d += `M${x.toFixed(1)} ${y0}L${x.toFixed(1)} ${y1}`;
  return d;
}

// r = base + amp * sin(k * t + phase), one curve per phase: the classic rosette.
function rosette(cx: number, cy: number, base: number, amp: number, k: number, curves: number): string[] {
  const out: string[] = [];
  for (let j = 0; j < curves; j++) {
    const phase = (j / curves) * Math.PI * 2;
    let d = "";
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * Math.PI * 2;
      const r = base + amp * Math.sin(k * t + phase);
      d += `${i === 0 ? "M" : "L"}${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
    }
    out.push(d + "Z");
  }
  return out;
}

function ticks(cx: number, cy: number, r0: number, long: number, short: number, count: number, every: number): { short: string; long: string } {
  let s = "";
  let l = "";
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const isLong = i % every === 0;
    const r1 = r0 - (isLong ? long : short);
    const seg = `M${(cx + Math.cos(a) * r0).toFixed(2)} ${(cy + Math.sin(a) * r0).toFixed(2)}L${(cx + Math.cos(a) * r1).toFixed(2)} ${(cy + Math.sin(a) * r1).toFixed(2)}`;
    if (isLong) l += seg;
    else s += seg;
  }
  return { short: s, long: l };
}

export function VaultDrawing({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, "");
  const g = useMemo(() => {
    const cx = 80;
    const cy = 76;
    const spokes = [-90, 30, 150].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return { x: cx + Math.cos(a) * 29, y: cy + Math.sin(a) * 29, x0: cx + Math.cos(a) * 6, y0: cy + Math.sin(a) * 6 };
    });
    return {
      cx,
      cy,
      frame: hatch(2.4),
      shade: hatch(1.3),
      hinge: vHatch(9, 13.4, 31, 45, 1.1) + vHatch(9, 13.4, 101, 115, 1.1),
      foot: vHatch(30, 46, 142, 146, 1.2) + vHatch(114, 130, 142, 146, 1.2),
      rosettes: rosette(cx, cy, 33, 4.2, 9, 22),
      dial: ticks(cx, cy, 21, 3.6, 2, 90, 5),
      spokes,
    };
  }, []);

  return (
    <svg className={className} viewBox="0 0 160 152" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs>
        <clipPath id={`${uid}-body`}>
          <rect x="16" y="12" width="128" height="128" rx="10" />
        </clipPath>
        <clipPath id={`${uid}-shade`}>
          <rect x="104" y="12" width="40" height="128" />
          <rect x="16" y="108" width="128" height="32" />
        </clipPath>
        <clipPath id={`${uid}-door`}>
          <circle cx={g.cx} cy={g.cy} r="39" />
        </clipPath>
      </defs>

      {/* feet and hinges sit behind the body */}
      <rect x="28" y="139" width="20" height="8" rx="2" className="vd-fill" strokeWidth="1.2" />
      <rect x="112" y="139" width="20" height="8" rx="2" className="vd-fill" strokeWidth="1.2" />
      <path d={g.foot} strokeWidth="0.45" opacity="0.7" />
      <rect x="8" y="30" width="9" height="16" rx="2.5" className="vd-fill" strokeWidth="1.2" />
      <rect x="8" y="100" width="9" height="16" rx="2.5" className="vd-fill" strokeWidth="1.2" />
      <path d={g.hinge} strokeWidth="0.45" opacity="0.7" />

      {/* body: a hatched frame, thicker toward the shaded right and bottom */}
      <rect x="16" y="12" width="128" height="128" rx="10" className="vd-fill" />
      <g clipPath={`url(#${uid}-body)`}>
        <path d={g.frame} strokeWidth="0.4" opacity="0.55" />
      </g>
      <g clipPath={`url(#${uid}-shade)`}>
        <g clipPath={`url(#${uid}-body)`}>
          <path d={g.shade} strokeWidth="0.45" opacity="0.75" />
        </g>
      </g>
      <rect x="16" y="12" width="128" height="128" rx="10" strokeWidth="1.7" />
      <rect x="25" y="21" width="110" height="110" rx="5" className="vd-fill" strokeWidth="1" />
      <rect x="28" y="24" width="104" height="104" rx="3" strokeWidth="0.5" opacity="0.6" />

      {/* rivets */}
      {[
        [32, 30],
        [128, 30],
        [32, 122],
        [128, 122],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <circle cx={x} cy={y} r="2.2" className="vd-fill" strokeWidth="0.9" />
          <path d={`M${x - 1.2} ${y + 0.6}L${x + 1.2} ${y - 0.6}`} strokeWidth="0.6" />
        </g>
      ))}

      {/* the door: ring, rosette, dial */}
      <circle cx={g.cx} cy={g.cy} r="42" className="vd-fill" strokeWidth="1.5" />
      <circle cx={g.cx} cy={g.cy} r="39" strokeWidth="0.7" />
      <g clipPath={`url(#${uid}-door)`}>
        {g.rosettes.map((d, i) => (
          <path key={i} d={d} strokeWidth="0.32" opacity="0.8" />
        ))}
      </g>
      <circle cx={g.cx} cy={g.cy} r="25" className="vd-fill" strokeWidth="1.3" />
      <circle cx={g.cx} cy={g.cy} r="23.2" strokeWidth="0.5" />
      <path d={g.dial.short} strokeWidth="0.45" />
      <path d={g.dial.long} strokeWidth="0.9" />
      <circle cx={g.cx} cy={g.cy} r="14" strokeWidth="0.6" />

      {/* index mark, the one accent */}
      <path d={`M${g.cx - 3.4} ${g.cy - 49}L${g.cx + 3.4} ${g.cy - 49}L${g.cx} ${g.cy - 42.4}Z`} className="vd-accent" strokeWidth="1" />

      {/* handle */}
      {g.spokes.map((sp, i) => (
        <g key={i}>
          <line x1={sp.x0} y1={sp.y0} x2={sp.x} y2={sp.y} strokeWidth="4.4" />
          <line x1={sp.x0} y1={sp.y0} x2={sp.x} y2={sp.y} strokeWidth="2.2" className="vd-stroke-fill" />
          <circle cx={sp.x} cy={sp.y} r="3.8" className="vd-accent" strokeWidth="1.2" />
        </g>
      ))}
      <circle cx={g.cx} cy={g.cy} r="8" className="vd-fill" strokeWidth="1.5" />
      <circle cx={g.cx} cy={g.cy} r="3.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
