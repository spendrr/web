// A damped sine sampled finely enough that linear interpolation between
// samples reads as one smooth motion rather than discrete jumps.
export const UNLOCK_SHAKE: Keyframe[] = Array.from({ length: 25 }, (_, i) => {
  const p = i / 24;
  return { transform: `translateX(${(Math.sin(p * Math.PI * 4) * 6 * (1 - p)).toFixed(2)}px)` };
});
