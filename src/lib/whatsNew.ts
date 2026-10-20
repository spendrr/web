// Tracks whether the "what's new" popup (WhatsNewModal) has already been
// shown for the currently running app version.

const STORAGE_KEY = "btc-wallet-last-seen-version";

export function shouldShowWhatsNew(currentVersion: string): boolean {
  const seen = localStorage.getItem(STORAGE_KEY);
  if (seen === null) {
    // Nothing stored yet — either a brand new wallet/browser, or the first
    // load after this feature shipped. Either way there's no previous
    // version to compare against, so silently record the current one
    // instead of greeting a fresh install with "New version!".
    markWhatsNewSeen(currentVersion);
    return false;
  }
  return seen !== currentVersion;
}

export function markWhatsNewSeen(version: string): void {
  localStorage.setItem(STORAGE_KEY, version);
}
