import { useState } from "react";

const PW_ASTERISKS = [
  "M5.9,25.03L4.27,24.14l2.04-3.5h-4V18.82h4L4.27,15.36L5.9,14.45l1.96,3.43l1.96-3.43l1.62,0.91L9.41,18.82h4v1.83h-4l2.02,3.5L9.82,25.03L7.86,21.58L5.9,25.03Z",
  "M22.04,25.03l-1.63-0.97l2.04-3.48h-4V18.74h4l-2.04-3.46l1.63-0.89L24,17.8l1.96-3.41l1.63,0.89l-2.04,3.46h4v1.85h-4l2.04,3.48l-1.63,0.97L24,21.58l-1.96,3.45Z",
  "M38.18,25.03l-1.62-0.97l2.02-3.48h-4V18.74h4l-2.02-3.46l1.62-0.89l1.96,3.41l1.96-3.41l1.63,0.89L41.7,18.74h4v1.85h-4l2.04,3.48L42.1,25.03l-1.96-3.45l-1.96,3.45Z"
];

// Three asterisks over a field's baseline, grey like the rest of the screen. They turn green with the password's
// strength (all three exactly when it passes the gate), the baseline turns red on a wrong confirmation or a failed
// attempt, and `done` plays one pass left to right. No ring: only the sheets' mark entrance (sheet/PaySheet.css)
// is reused; the canvas is cropped to the drawing.
export function PasswordMark({
  level,
  bad,
  done,
  markRef,
}: {
  level: number;
  bad: boolean;
  done: boolean;
  markRef: React.RefObject<HTMLDivElement | null>;
}) {
  // The level the mark came from, so a jump of several asterisks (a pasted password) lights them in turn rather
  // than all at once; a single step starts at once.
  const [shown, setShown] = useState(level);
  const [from, setFrom] = useState(level);
  if (level !== shown) {
    setFrom(shown);
    setShown(level);
  }
  return (
    <div
      ref={markRef}
      className={`sht-mark pw-mark${level > 2 ? " is-strong" : ""}${bad ? " is-bad" : ""}${done ? " is-done" : ""}`}
      aria-hidden="true"
    >
      <svg viewBox="1 13 46 20">
        {PW_ASTERISKS.map((d, k) => (
          <path
            key={k}
            className={`pw-ast${level > k ? " on" : ""}`}
            style={{ ["--k" as string]: k, ["--d" as string]: `${Math.max(0, k - from) * 110}ms` }}
            d={d}
          />
        ))}
        <rect className="pw-line" x="2.3" y="31" width="43.4" height="1.85" rx="0.925" />
      </svg>
    </div>
  );
}
