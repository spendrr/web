// The main thread's view of bark records that did not verify (recordSeal.ts). The worker is the authority: it keeps
// them away from bark and signs them only after the password. This lets the UI show a sheet while any exist.
import { useSyncExternalStore } from "react";
import { getRecordSealStatus, setSealCountListener, type RecordSealStatus } from "./bark";

type Unverified = RecordSealStatus["unverified"];

let unverified: Unverified = [];
let needsPassword = true;
const listeners = new Set<() => void>();

function publish(next: Unverified): void {
  if (next.length === 0 && unverified.length === 0) return;
  unverified = next;
  listeners.forEach((l) => l());
}

// Asks the worker. A failure keeps what was known: nothing is trusted either way until the worker says so.
export async function checkRecordSeal(): Promise<void> {
  try {
    const status = await getRecordSealStatus();
    needsPassword = status.needsPassword;
    publish(status.unverified);
  } catch {
    // keep the last known list
  }
}

export function clearRecordSeal(): void {
  lastSealCount = 0;
  publish([]);
}

// The worker reports its refused-read count with every answer. A change is the only reason to ask for the list again,
// so a normal session adds no request at all.
let lastSealCount = 0;
setSealCountListener((count) => {
  if (count === lastSealCount) return;
  lastSealCount = count;
  if (count > 0) void checkRecordSeal();
});

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useUnverifiedRecords(): Unverified {
  return useSyncExternalStore(subscribe, () => unverified);
}

export function sealNeedsPassword(): boolean {
  return needsPassword;
}
