// Whether the camera is looking at a dark scene, for the QR scanner's torch
// hint (v2): the hint only shows when a flash would actually help. Pure, so
// it is tested without a camera (tests/sceneDarkness.test.ts).
//
// The camera's auto-exposure brightens a dark room a lot before a frame ever
// reaches the page, so a "dark" frame is far from black. These thresholds are
// a first guess, to be tuned on a real phone with the room lights off.
export const DARK_LUMA_ENTER = 45;
export const DARK_LUMA_EXIT = 70;
// A scene has to stay on the other side of the threshold this long before
// the verdict flips, so a hand passing the lens doesn't blink the hint.
export const DARK_HOLD_MS = 1000;

// Mean Rec. 601 luma (0-255) of RGBA pixel data, NaN when there is none.
export function meanLuma(data: ArrayLike<number>): number {
  const pixels = Math.floor(data.length / 4);
  if (pixels === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < pixels * 4; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / pixels;
}

// Feed it (luma, time) samples, it answers whether the scene is dark. Starts
// at "not dark", so nothing shows before there is evidence. Entering needs
// luma under `enter`, leaving needs it over the higher `exit`, each held for
// `holdMs`; anything in between keeps the current verdict.
export function createDarknessTracker({
  enter = DARK_LUMA_ENTER,
  exit = DARK_LUMA_EXIT,
  holdMs = DARK_HOLD_MS,
}: { enter?: number; exit?: number; holdMs?: number } = {}): (luma: number, time: number) => boolean {
  let dark = false;
  let pendingSince: number | null = null;
  return (luma, time) => {
    if (!Number.isFinite(luma)) return dark;
    const wantDark = dark ? luma < exit : luma < enter;
    if (wantDark === dark) {
      pendingSince = null;
      return dark;
    }
    if (pendingSince === null) pendingSince = time;
    if (time - pendingSince >= holdMs) {
      dark = wantDark;
      pendingSince = null;
    }
    return dark;
  };
}
