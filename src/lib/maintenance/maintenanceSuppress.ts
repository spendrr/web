// Emergency escape hatch, added live 2026-09-15 against a real Ark-server
// stall: wallet.maintenance() (Dashboard.tsx's refresh()) is sync() plus
// round-participation upkeep plus, only when a VTXO is actually due for
// refresh, an indefinite wait on the server's round-event stream to join
// the next round — see bark's own lib.rs (maintenance()/maintenance_refresh())
// for the exact breakdown. That wait is what was observed hanging for
// minutes at a time when the server-side round coordinator wedges, and
// because the worker only runs one wallet.* call at a time, every other
// call (Odeslat, VTXO mince) queues up behind it regardless of the 60s
// ceiling maintenanceWithDeadline() (bark.ts) now caps a single attempt at.
//
// sync() alone (called unconditionally either way, never suppressed here)
// already covers the bulk of what a live refresh needs — claiming incoming
// Lightning receives, pending rounds/sends/boards/offboards, force-exit
// detection — so suppressing just the maintenance() call trades away
// automatic VTXO-refresh (and its round-triggered mailbox catch-up) for a
// queue that isn't held hostage by a stalled server. Not a fund-safety
// issue on its own: an unrefreshed VTXO doesn't lose funds, it only loses
// the unilateral-exit guarantee until it's refreshed (confirmed with the
// Ark server's developers).
// Deliberately a manual, sticky toggle (not auto-detected) — flip it back
// off once the underlying stall clears.
const STORAGE_KEY = "btc-wallet-suppress-maintenance";

export function isMaintenanceSuppressed(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setMaintenanceSuppressed(suppressed: boolean): void {
  if (suppressed) {
    localStorage.setItem(STORAGE_KEY, "1");
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}
