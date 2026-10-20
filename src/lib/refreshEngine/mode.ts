// Which VTXO refresh path runs: the engine, for everyone (V1 since 2026-10-17;
// beta since 2026-09-26). No user switch (dropped 2026-09-28 with the user).
// "off" stays as the one-line way back: return it below and every session
// opens on the SDK path again (daemon + scheduleMaintenanceDelegated).
//
// - "off":  the SDK path.
// - "live": the engine refreshes; the SDK daemon is off (runDaemon: false,
//           decided at open, so a change needs a relock) and
//           maintenanceDelegated() is no longer called.
// ("dry-run" stays a tick mode in engine.ts for its tests, no session runs it.)
export type RefreshEngineMode = "off" | "dry-run" | "live";

export function getRefreshEngineMode(): RefreshEngineMode {
  return "live";
}

// The mode the CURRENT session was opened with. Only "live" differs in what
// the open does (no daemon), so the running session keeps this until relock
// even if the beta toggle changes meanwhile: an engine going live next to a
// running daemon would put the same coins in two participations (a tab open
// across the update keeps the SDK path until its next unlock).
let sessionMode: RefreshEngineMode = "off";
export function beginSessionEngineMode(): RefreshEngineMode {
  sessionMode = getRefreshEngineMode();
  return sessionMode;
}
export function sessionEngineMode(): RefreshEngineMode {
  return sessionMode;
}

// What refresh() actually does right now: the session's mode.
export function effectiveEngineMode(): RefreshEngineMode {
  return sessionMode;
}

export function needsRelockForMode(): boolean {
  return (sessionMode === "live") !== (getRefreshEngineMode() === "live");
}
