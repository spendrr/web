// Hidden toggle for the ambient background glow (index.css, on #root) —
// triple-click "Verze" in Nastavení → O peněžence to flip it. Exists so
// there's always a guaranteed way back to the plain flat background if the
// glow ever needs to go, without needing a code change/redeploy.

const STORAGE_KEY = "btc-wallet-bg-glow";

export function getBgGlowEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "off";
}

export function applyBgGlow(enabled: boolean): void {
  document.documentElement.toggleAttribute("data-bg-glow-off", !enabled);
}

export function setBgGlowEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, "off");
  }
  applyBgGlow(enabled);
}
