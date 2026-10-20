import { useEffect, useState } from "react";

// Whether Pokladna (PosPanel.tsx) spreads into its two-column layout:
// landscape tablet or desktop. Height as well as width: a landscape phone is
// 850-930px wide but only ~400px tall, and two columns there would leave the
// keypad no room.
const WIDE_QUERY = "(min-width: 900px) and (min-height: 560px)";

export function usePosWideLayout(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}
