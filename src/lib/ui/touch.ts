// A phone or tablet as the primary input. Where a field would open the keyboard the moment its screen appears and
// cover the screen, it waits for a tap there; on a desktop the cursor goes straight in.
export const COARSE_POINTER = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
