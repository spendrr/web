// A worker script that "failed to load" while the device is online is almost
// always a tab that outlived a deploy: its HTML points at hashed chunk names
// the new build no longer has (the asset layer answers them with the SPA
// fallback, which is not JavaScript). Lazy `import()`s already reload for
// this (main.tsx, vite:preloadError); a Worker construction has no such hook.
// Reloading costs nothing here: the script never ran, so no wallet is open.
const RELOADED_KEY = "btc-wallet-preload-reloaded";

export async function isStaleBuild(): Promise<boolean> {
  try {
    const res = await fetch("/build-info.json", { cache: "no-store" });
    if (!res.ok) return false;
    const info = (await res.json()) as { version?: unknown };
    return typeof info.version === "string" && info.version !== __APP_VERSION__;
  } catch {
    return false;
  }
}

// One reload per page life (the flag main.tsx shares clears itself 5 s after a
// clean mount, so a later deploy gets its own). False: already tried.
export function reloadOnceForNewBuild(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === "1") return false;
    sessionStorage.setItem(RELOADED_KEY, "1");
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
