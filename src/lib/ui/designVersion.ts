// Started as an A/B toggle between the current look ("v1") and a refined
// visual pass ("v2", see src/design-v2.css). That comparison is settled —
// every v2 refinement (borders/shadows, toggle animations, header button
// cluster, boolean switch, and the history list's "chunky card" restyle +
// palette + heading) has won and ships unconditionally regardless of this
// flag. The toggle lives on purely as the gate for still-beta features, among
// them "Obnovit všechna VTXO" (Settings → VTXO mince), @names, tap-to-pay and
// the Utility hub's entire swipe entry point (Dashboard.tsx/UtilityHub.tsx —
// converter, map, POS). Check
// getDesignVersion()/useDesignVersion() === "v2" before rendering a
// beta-gated feature.
//
// Stored in localStorage (per-origin, not per-wallet) — a phone reached via
// a LAN-IP dev origin starts with this off regardless of what's toggled on a
// desktop session at a different origin (e.g. localhost), even against the
// same physical wallet vault. That's what made the Utility hub look
// unreachable on mobile once: the swipe gesture is a silent no-op with this
// off, not a rendering bug.
import { useSyncExternalStore } from "react";

export type DesignVersion = "v1" | "v2";

const STORAGE_KEY = "btc-wallet-design-version";
// Components that switch what they *render* (not just CSS) per version —
// e.g. the boolean switch used by Haptics/Notifications/Shake below — can't
// rely on [data-design-version] alone, since a CSS attribute change doesn't
// by itself re-run React render. They listen for this instead.
const CHANGE_EVENT = "design-version-change";

export function getDesignVersion(): DesignVersion {
  return localStorage.getItem(STORAGE_KEY) === "v2" ? "v2" : "v1";
}

export function applyDesignVersion(version: DesignVersion): void {
  const root = document.documentElement;
  if (version === "v2") {
    root.setAttribute("data-design-version", "v2");
  } else {
    root.removeAttribute("data-design-version");
  }
}

export function setDesignVersion(version: DesignVersion): void {
  if (version === "v2") {
    localStorage.setItem(STORAGE_KEY, "v2");
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  applyDesignVersion(version);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onDesignVersionChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

// For components gating a beta feature on this — re-renders immediately if
// the user flips the toggle in Settings while the gated UI is already
// mounted elsewhere, rather than needing a reload to notice.
export function useDesignVersion(): DesignVersion {
  return useSyncExternalStore(onDesignVersionChange, getDesignVersion);
}
