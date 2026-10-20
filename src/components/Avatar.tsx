import { useId, useMemo } from "react";
import { AVATAR_VIEWBOX, avatarSpec, type AvatarShape } from "../lib/names/avatar";

// Abstract avatar drawn from a seed (see lib/avatar.ts). Purely decorative, so
// it is hidden from assistive tech: whatever it sits next to (a @handle, an
// address) is what carries the meaning.
//
// No <clipPath>: the outer <svg> already clips to its own viewport and the round
// shape comes from border-radius. The one id it does need is for the background
// gradient, made unique per instance so several avatars can share a page.

function renderShape(shape: AvatarShape, i: number) {
  switch (shape.kind) {
    case "circle":
      return <circle key={i} cx={shape.cx} cy={shape.cy} r={shape.r} fill={shape.fill} opacity={shape.opacity} />;
    case "ring":
      return (
        <circle
          key={i}
          cx={shape.cx}
          cy={shape.cy}
          r={shape.r}
          fill="none"
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
        />
      );
    case "rect":
      return (
        <rect
          key={i}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          fill={shape.fill}
          transform={shape.rotate !== undefined ? `rotate(${shape.rotate} 50 50)` : undefined}
        />
      );
    case "ellipse":
      return (
        <ellipse
          key={i}
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          fill={shape.fill}
          transform={shape.rotate !== undefined ? `rotate(${shape.rotate} 50 50)` : undefined}
        />
      );
    case "path":
      return <path key={i} d={shape.d} fill={shape.fill} opacity={shape.opacity} />;
  }
}

export default function Avatar({
  seed,
  size = 48,
  className,
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const spec = useMemo(() => avatarSpec(seed), [seed]);
  // useId() returns something like ":r3:"; colons are legal in an id but awkward
  // inside url(#...), so they are dropped.
  const gradientId = `av${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${AVATAR_VIEWBOX} ${AVATAR_VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      style={{ borderRadius: "50%", flexShrink: 0, display: "block" }}
    >
      <defs>
        <linearGradient id={gradientId} gradientTransform={`rotate(${spec.background.angle} .5 .5)`}>
          <stop offset="0" stopColor={spec.background.from} />
          <stop offset="1" stopColor={spec.background.to} />
        </linearGradient>
      </defs>
      <rect width={AVATAR_VIEWBOX} height={AVATAR_VIEWBOX} fill={`url(#${gradientId})`} />
      {spec.shapes.map(renderShape)}
    </svg>
  );
}
