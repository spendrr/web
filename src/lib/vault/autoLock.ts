// User-controlled override for App.tsx's inactivity auto-lock. Defaults to
// enabled (real funds sit behind the unlock screen) — this exists because the
// criticalOpRef/isEditingField deferrals in App.tsx only cover specific known
// operations, and a long, multi-step flow with a lot of reading/waiting in
// between can still hit the 5-minute idle window with nothing there to defer
// it. A manual override is the user's own call, not something a specific
// screen should decide for them.
const KEY = "btc-wallet-autolock-enabled";

export function isAutoLockEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoLockEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // Ignored — worst case the setting doesn't persist across reloads.
  }
}
