// Haptic feedback via the Vibration API. Android Chrome supports it; iOS
// Safari doesn't expose navigator.vibrate at all, so this is silently a
// no-op there — best-effort only, never something a flow depends on.

const STORAGE_KEY = "btc-wallet-haptics";

export function isHapticsSupported(): boolean {
  return typeof navigator !== "undefined" && "vibrate" in navigator;
}

export function isHapticsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setHapticsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}

function vibrate(pattern: number | number[]): void {
  if (!isHapticsEnabled() || !isHapticsSupported()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Best-effort only.
  }
}

// Light tick for small, frequent interactions (tap-to-swap, swipe-to-hide).
export function hapticTap(): void {
  vibrate(10);
}

// A slightly heavier double-pulse for a completed action (send confirmed).
export function hapticSuccess(): void {
  vibrate([15, 40, 15]);
}

// Distinct triple-pulse for an incoming payment — deliberately different
// from hapticSuccess so it doesn't feel like something *you* just did.
export function hapticNotify(): void {
  vibrate([10, 60, 10, 60, 10]);
}

// Short-long-short buzz for a rejected unlock — neither of the patterns
// above, so a wrong password never feels like a success or a payment.
export function hapticError(): void {
  vibrate([30, 50, 70]);
}
