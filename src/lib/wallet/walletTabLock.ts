// One open wallet per browser profile, across every tab and window of this
// origin (including an installed PWA, which on Android shares storage with
// the browser tab).
//
// Everything that keeps the WASM bridge safe (the worker's FIFO queue, the
// delegated-refresh gate and cooldown, the backup CAS, the password-less
// spend budget) is per worker, i.e. per tab. Two tabs unlocked at once meant
// two bark instances with their own daemons writing the same IndexedDB
// (`btc-wallet-mainnet`): both joining rounds, both deriving vtxo key
// indices (the recovery scan's key gap limit), both uploading a cloud backup
// of their own view of the state, each with a fresh spend budget. Nothing
// stopped it; only the backup upload itself had a cross-tab lock.
//
// Web Locks, not a localStorage flag: the browser releases a lock the moment
// its holder goes away (tab closed, crashed, discarded), so there is no
// stale "open elsewhere" state to clean up. Held from prepareSession until
// the session is closed or its worker is reset (bark.ts), which is exactly
// the span a wallet handle can exist in this tab.
//
// No Web Locks (very old browsers only; Safari has them since 15.4) fails
// OPEN: refusing to unlock at all would lock someone out of their own money
// over a missing API, which is worse than the risk this closes.
//
// For everyone since 2026-09-24 (it started behind the v2 toggle). `enabled`
// stays as a seam for tests and for switching it off again without touching
// the call sites.

export const WALLET_TAB_LOCK_NAME = "spendrr-wallet-open";

// Sentinel error message, matched by App.tsx to show the "open in another
// window" sheet instead of an error line.
export const WALLET_OPEN_ELSEWHERE = "WALLET_OPEN_ELSEWHERE";

type Locks = Pick<LockManager, "request" | "query">;

export interface WalletTabLock {
  // Takes the lock if nobody holds it. true when this tab now holds it (or
  // already did), false when another tab does. Never waits for it.
  acquire(): Promise<boolean>;
  // Drops the lock if this tab holds it; a no-op otherwise.
  release(): void;
  // Whether another tab holds the lock right now. A hint for checking before
  // a step that is expensive or destructive (a biometric prompt, overwriting
  // the vault), not a guarantee: only acquire() is atomic.
  heldElsewhere(): Promise<boolean>;
}

export function createWalletTabLock(
  locks: Locks | undefined,
  name = WALLET_TAB_LOCK_NAME,
  enabled: () => boolean = () => true,
): WalletTabLock {
  let releaseHeld: (() => void) | null = null;
  let acquiring: Promise<boolean> | null = null;

  const acquire = (): Promise<boolean> => {
    if (releaseHeld) return Promise.resolve(true);
    if (!locks || !enabled()) return Promise.resolve(true);
    // Two callers racing in the same tab must share one request, or the
    // second would see this tab's own lock and report "open elsewhere".
    if (acquiring) return acquiring;
    acquiring = new Promise<boolean>((resolve) => {
      locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          // The lock is held for as long as this promise is pending.
          return new Promise<void>((done) => {
            releaseHeld = () => {
              releaseHeld = null;
              done();
            };
            resolve(true);
          });
        })
        .catch((e: unknown) => {
          // Same stance as a missing API: never lock the user out.
          console.warn("[walletTabLock] lock request failed, continuing without it", e);
          resolve(true);
        });
    }).finally(() => {
      acquiring = null;
    });
    return acquiring;
  };

  return {
    acquire,
    release() {
      releaseHeld?.();
    },
    async heldElsewhere() {
      if (!locks || releaseHeld || !enabled()) return false;
      try {
        const state = await locks.query();
        return (state.held ?? []).some((l) => l.name === name);
      } catch {
        return false;
      }
    },
  };
}

export const walletTabLock = createWalletTabLock(
  typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined,
  WALLET_TAB_LOCK_NAME,
);
