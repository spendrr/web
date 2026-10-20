// Persisted state for the beta "Obnovit všechna VTXO" (consolidate) feature
// in Settings.tsx's VtxoList. wallet.refreshVtxosDelegated() only registers
// the VTXOs for the next round — it doesn't wait for that round (a fixed
// hourly interval on ark.second.tech, confirmed live via
// arkInfo().roundIntervalSecs) to actually complete, and Settings unmounts
// entirely whenever the user closes it. So there's no persistent background
// watcher tracking this the way Dashboard.tsx tracks an exit; completion is
// instead re-checked fresh (via wallet.pendingRoundStates()) every time this
// screen is opened while a registration is outstanding.
export interface PendingVtxoRefresh {
  roundId: number;
  vtxoIds: string[];
  startedAt: number;
}

const KEY = "btc-wallet-pending-vtxo-refresh";

export function getPendingVtxoRefresh(): PendingVtxoRefresh | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingVtxoRefresh;
    return typeof parsed?.roundId === "number" && Array.isArray(parsed.vtxoIds) ? parsed : null;
  } catch {
    return null;
  }
}

export function setPendingVtxoRefresh(record: PendingVtxoRefresh): void {
  localStorage.setItem(KEY, JSON.stringify(record));
}

export function clearPendingVtxoRefresh(): void {
  localStorage.removeItem(KEY);
}
