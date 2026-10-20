// Keeps the browser from throwing this origin's storage away, which is where
// the only copy of the vault lives. Two different ways it can happen:
//
// - Every browser: without navigator.storage.persist() the origin is
//   "best-effort" and the first thing evicted when the device runs short of
//   space. Chrome grants persist() silently by its own heuristics (installed,
//   bookmarked, notification permission, engagement) and says no otherwise;
//   Firefox asks the user with a prompt, which is why the unforced call below
//   is throttled.
// - iOS Safari on top: ITP deletes all script-writable storage (localStorage
//   AND IndexedDB) of a site the user has not interacted with for 7 days of
//   Safari use. persist() does not exempt a browser tab from that; WebKit
//   grants it mainly to Home Screen web apps, and those have their own day
//   counter, so the fix there is installing the app, not an API call.
//
// A Home Screen web app on iOS also has storage SEPARATE from Safari's: it
// starts empty and the wallet has to be restored in it from the seed phrase.
// That is why InstallAppSheet says so, and why the recommendation matters most
// before a wallet exists at all (onboarding).
//
// Nothing here can make a wallet safe without its seed phrase (the cloud
// backup's keys are derived from the seed too); it only narrows how often the
// seed is needed.

export type StorageProtection = "persisted" | "best-effort" | "unsupported";

const LAST_REQUEST_KEY = "btc-wallet-persist-requested-at";
const REQUEST_THROTTLE_MS = 24 * 60 * 60 * 1000;

export async function getStorageProtection(): Promise<StorageProtection> {
  try {
    if (!navigator.storage?.persisted) return "unsupported";
    return (await navigator.storage.persisted()) ? "persisted" : "best-effort";
  } catch {
    return "unsupported";
  }
}

// `force` skips the once-a-day throttle: for wallet creation/import and the
// Settings button, where a Firefox prompt is expected. The per-unlock call
// leaves it off so a user who dismissed that prompt is not asked on every
// unlock. Never throws.
export async function requestPersistentStorage({ force = false } = {}): Promise<StorageProtection> {
  try {
    if (!navigator.storage?.persist || !navigator.storage.persisted) return "unsupported";
    if (await navigator.storage.persisted()) return "persisted";
    if (!force) {
      const last = Number(localStorage.getItem(LAST_REQUEST_KEY));
      if (Number.isFinite(last) && Date.now() - last < REQUEST_THROTTLE_MS) return "best-effort";
    }
    try {
      localStorage.setItem(LAST_REQUEST_KEY, String(Date.now()));
    } catch {
      // storage unavailable: just not throttled
    }
    return (await navigator.storage.persist()) ? "persisted" : "best-effort";
  } catch {
    return "unsupported";
  }
}

// iPadOS 13+ reports itself as a Mac; told apart by its touch screen.
export function isIpad(): boolean {
  const ua = navigator.userAgent;
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// iPhone, iPod and iPad. Every browser on iOS is WebKit, so this is the ITP
// question, not a Safari one.
export function isIosDevice(): boolean {
  return /iPhone|iPod/.test(navigator.userAgent) || isIpad();
}

export function isStandalone(): boolean {
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// The case InstallAppSheet exists for: an iOS browser tab, where ITP applies.
export function isIosBrowserTab(): boolean {
  return isIosDevice() && !isStandalone();
}

// --- When the Dashboard shows the sheet by itself -------------------------
// "Rozumím" snoozes it for a week (the length of the ITP window: someone who
// opens the wallet more often than that is not the one at risk anyway), and
// "Nepřipomínat" for good. Settings always has it either way.

const HINT_KEY = "btc-wallet-install-hint";
const HINT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function readHint(): { snoozedUntil?: number; never?: boolean } {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as { snoozedUntil?: number; never?: boolean }) : {};
  } catch {
    return {};
  }
}

function writeHint(value: { snoozedUntil?: number; never?: boolean }): void {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(value));
  } catch {
    // storage unavailable: the sheet may just show again next time
  }
}

export function shouldAutoShowInstallHint(): boolean {
  if (!isIosBrowserTab()) return false;
  const { snoozedUntil, never } = readHint();
  if (never) return false;
  return typeof snoozedUntil !== "number" || Date.now() >= snoozedUntil;
}

export function snoozeInstallHint(): void {
  writeHint({ snoozedUntil: Date.now() + HINT_SNOOZE_MS });
}

export function neverShowInstallHint(): void {
  writeHint({ never: true });
}
