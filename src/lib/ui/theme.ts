export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "btc-wallet-theme";

// Must match index.html's static <meta name="theme-color"> values (those
// only cover the instant-first-paint case, before this module runs).
const DARK_THEME_COLOR = "#100e0a";
const LIGHT_THEME_COLOR = "#f2ede4";

const darkMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function resolvedTheme(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? (darkMediaQuery.matches ? "dark" : "light") : pref;
}

// An installed PWA's status bar color follows the *live* theme-color meta
// tag, not just the manifest's static theme_color (that one only matters
// for the splash screen / before this runs). Android then picks status-bar
// icon contrast for that color — if this never tracks the actual on-screen
// theme (e.g. stays on index.html's static media-query tags while the user
// has an explicit in-app override, or the system theme flips while the app
// is open), the icons can end up invisible against the real background.
function syncThemeColorMeta(pref: ThemePreference): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute("content", resolvedTheme(pref) === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
}

export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
  syncThemeColorMeta(pref);
}

export function setThemePreference(pref: ThemePreference): void {
  if (pref === "system") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, pref);
  }
  applyTheme(pref);
}

// Keeps the status bar in sync if the OS theme flips while the app is open
// and the user hasn't overridden it in Settings.
darkMediaQuery.addEventListener("change", () => {
  if (getThemePreference() === "system") syncThemeColorMeta("system");
});
