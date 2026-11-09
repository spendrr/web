// The main thread's view of the spend limits: the last status the wallet worker reported. The worker is the
// authority (it enforces); this only lets the UI ask for a password exactly when the worker will, and show what
// is left of the daily limit. Until the first answer the old fixed rule applies, which is also what the worker
// enforces with nothing stored.
import { useSyncExternalStore } from "react";
import { getSpendLimits } from "./bark";
import { PASSWORD_REQUIRED_THRESHOLD_SATS } from "./walletSession";
import type { SpendLimitsStatus } from "./spendLimits";

let status: SpendLimitsStatus | null = null;
const listeners = new Set<() => void>();

function publish(next: SpendLimitsStatus | null): void {
  status = next;
  listeners.forEach((l) => l());
}

export function setSpendLimitsStatus(next: SpendLimitsStatus): void {
  publish(next);
}

// Forgets everything: a different wallet may open next.
export function clearSpendLimitsStatus(): void {
  publish(null);
}

export function getSpendLimitsStatus(): SpendLimitsStatus | null {
  return status;
}

// Sends at or above this need the password. Read at the moment of use, never cached by a caller.
export function getNoPasswordSats(): number {
  return status?.limits.noPasswordSats ?? PASSWORD_REQUIRED_THRESHOLD_SATS;
}

// Asks the worker. A failure keeps what was known: the worker still enforces, a stale number only means the
// UI may ask for a password it turns out not to need, or the worker refuses once and the sheet asks.
export async function refreshSpendLimits(): Promise<void> {
  try {
    publish(await getSpendLimits());
  } catch {
    // keep the last known status
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSpendLimitsStatus(): SpendLimitsStatus | null {
  return useSyncExternalStore(subscribe, getSpendLimitsStatus);
}
