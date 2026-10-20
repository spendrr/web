// Pure state machine of the status Worker (status/worker.ts), tested in
// tests/statusLogic.test.ts. No I/O here: probe results and the app's signed
// report come in, the public snapshot goes out.
//
// The public snapshot carries only enums, numbers and timestamps, never text:
// spendrr.app/status renders it on a domain users trust, and this Worker runs
// on a separate Cloudflare account. Whoever took that account over could make
// the page show a wrong status, but never a message ("move your funds to ...").

import type { StatusReport } from "./report.ts";

export const COMPONENTS = ["ark", "chain", "lnaddr", "push", "spendrr"] as const;
export type ComponentId = (typeof COMPONENTS)[number];
// "unknown" only until a component is first observed: no data is shown as no
// data, never as a green "ok".
export type Status = "ok" | "degraded" | "down" | "unknown";
type Observed = Exclude<Status, "unknown">;

// A change between observed states is confirmed only after this many
// observations in a row, so one failed request (ark.second.tech flips between
// 500 and 502) is not an incident.
export const CONFIRM_AFTER = 2;
// The Spendrr probe runs every SPENDRR_EVERY_MIN minutes: those requests count
// against the app account's daily limit.
export const SPENDRR_EVERY_MIN = 5;
// The app sends its report every 5 minutes (worker/statusReport.ts). Missing
// for longer than this means its cron stopped, and with it every push.
export const REPORT_STALE_MS = 12 * 60 * 1000;
// Rounds run every round_interval (3600 s on mainnet). A next-round time this
// far in the past means they stopped: payments still work, refresh does not.
export const ROUNDS_STALLED_MS = 10 * 60 * 1000;
// The primary chain source this many blocks behind the fallback is stale.
export const CHAIN_LAG_BLOCKS = 3;
export const HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_INCIDENTS = 500;

export interface ProbeResults {
  // GetArkInfo answered; nextRoundAt null when NextRoundTime did not.
  ark: { up: boolean; nextRoundAt: number | null };
  chainPrimary: number | null; // tip height, null when it failed
  chainFallback: number | null;
  // Absent on the minutes the Spendrr probe does not run.
  spendrr?: { up: boolean; lnaddrOk: boolean };
  // False while no report key is configured (status/reportKey.ts): then a
  // missing report says nothing about the app.
  reportsExpected: boolean;
}

export interface ComponentState {
  status: Status;
  since: number;
  // Observations that differ from `status`, fewer than CONFIRM_AFTER in a row.
  // `status` is the latest of them; `mixed` when they were not all the same.
  pending: { status: Observed; since: number; count: number; mixed?: boolean } | null;
}

export interface Incident {
  c: ComponentId;
  s: "degraded" | "down";
  from: number;
  to: number | null;
}

export interface StoredReport {
  report: StatusReport;
  receivedAt: number;
}

export interface State {
  v: 2;
  createdAt: number;
  checkedAt: number;
  lastSpendrr: { up: boolean; lnaddrOk: boolean } | null;
  // Last NextRoundTime the Ark server gave (absent in state saved before it was kept).
  nextRoundAt?: number | null;
  report: StoredReport | null;
  // The report already counted as an observation, so one report is one.
  reportSeenAt: number;
  components: Record<ComponentId, ComponentState>;
  incidents: Incident[];
}

// An incident from before the checks ran (or that they missed), written into
// code by hand from logs and manual checks (status/recorded.ts). `r` lets the
// page say so.
export type RecordedIncident = Incident & { to: number; r: true };

export interface PublicSnapshot {
  v: 2;
  checkedAt: number;
  dataFrom: number;
  // Per component, an earlier start of known history than dataFrom, from
  // logs entered by hand (status/recorded.ts). Missing: dataFrom.
  knownFrom: Partial<Record<ComponentId, number>>;
  components: Record<ComponentId, { status: Status; since: number }>;
  incidents: (Incident | RecordedIncident)[];
  // Unix ms of the next Ark round, null when the server did not say.
  nextRoundAt: number | null;
}

function arkStatus(ark: ProbeResults["ark"], now: number): Observed {
  if (!ark.up) return "down";
  return ark.nextRoundAt !== null && now - ark.nextRoundAt > ROUNDS_STALLED_MS ? "degraded" : "ok";
}

function chainStatus(primary: number | null, fallback: number | null): Observed {
  if (primary === null) return fallback === null ? "down" : "degraded";
  return fallback !== null && fallback - primary >= CHAIN_LAG_BLOCKS ? "degraded" : "ok";
}

// What each component looks like this round; a component missing from the
// result was not observed this round. Parts that come from the 5-minute
// sources (the Spendrr probe, the app's report) count only on the round that
// brought them: reusing them every minute would count one failure five times.
export function observe(r: ProbeResults, prev: State | null, now: number): Partial<Record<ComponentId, Observed>> {
  const ark = arkStatus(r.ark, now);
  const seen: Partial<Record<ComponentId, Observed>> = { ark, chain: chainStatus(r.chainPrimary, r.chainFallback) };

  const stored = prev?.report ?? null;
  const reportFresh = stored !== null && now - stored.receivedAt <= REPORT_STALE_MS;
  const newReport = reportFresh && stored.receivedAt > (prev?.reportSeenAt ?? 0);
  const report = reportFresh ? stored.report : null;
  // Since the first report ever, a silence is news: the app's cron stopped.
  const reportMissing =
    r.reportsExpected && !reportFresh && (stored !== null || (prev !== null && now - prev.createdAt > REPORT_STALE_MS));

  // Payment notifications: sent by the app's cron, faster with the relay.
  if (reportMissing) seen.push = "down";
  else if (newReport && report) seen.push = !report.pushConfigured ? "down" : report.relay ? "ok" : "degraded";

  // Spendrr server: the page and Worker answer (probe), names and backups work (report).
  if (r.spendrr) {
    seen.spendrr = !r.spendrr.up ? "down" : report && (!report.names || !report.backups) ? "degraded" : "ok";
  }

  // Lightning address: needs Ark (barkd makes invoices there), the node, no
  // kill switch, and real invoices not failing.
  const spendrr = r.spendrr ?? prev?.lastSpendrr ?? null;
  const lnBad =
    (spendrr !== null && (!spendrr.up || !spendrr.lnaddrOk)) ||
    (report !== null && (!report.lnNode || report.lnRefusing || report.lnInvoicesFailing));
  if (ark === "down") seen.lnaddr = "down";
  else if (r.spendrr || newReport) seen.lnaddr = lnBad ? "down" : "ok";
  else if (!lnBad && (prev?.components.lnaddr.status ?? "unknown") !== "unknown") seen.lnaddr = "ok";

  return seen;
}

export function initialState(now: number): State {
  const components = {} as Record<ComponentId, ComponentState>;
  for (const c of COMPONENTS) components[c] = { status: "unknown", since: now, pending: null };
  return { v: 2, createdAt: now, checkedAt: now, lastSpendrr: null, report: null, reportSeenAt: 0, components, incidents: [] };
}

function moveTo(state: State, c: ComponentId, status: Observed, at: number): void {
  const comp = state.components[c];
  const open = state.incidents.find((i) => i.c === c && i.to === null);
  if (open) open.to = at;
  if (status !== "ok") state.incidents.push({ c, s: status, from: at, to: null });
  comp.status = status;
  comp.since = at;
  comp.pending = null;
}

export function applyProbes(prev: State | null, r: ProbeResults, now: number): State {
  const seen = observe(r, prev, now);
  const state = prev ? structuredClone(prev) : initialState(now);
  if (r.spendrr) state.lastSpendrr = r.spendrr;
  if (state.report && state.report.receivedAt > state.reportSeenAt) state.reportSeenAt = state.report.receivedAt;
  state.checkedAt = now;
  state.nextRoundAt = r.ark.up ? r.ark.nextRoundAt : null;

  for (const c of COMPONENTS) {
    const comp = state.components[c];
    const status = seen[c];
    if (status === undefined) continue;
    // The first observation is not a change: there was nothing to confirm against.
    if (comp.status === "unknown") {
      moveTo(state, c, status, now);
      continue;
    }
    if (status === comp.status) {
      comp.pending = null;
      continue;
    }
    // Every observation that differs from the current status counts, whichever
    // it is: counting only repeats of one status kept a component that flaps
    // between degraded and ok after an outage at down for good.
    if (comp.pending) {
      comp.pending.count++;
      if (comp.pending.status !== status) comp.pending.mixed = true;
      comp.pending.status = status;
    } else comp.pending = { status, since: now, count: 1 };
    if (comp.pending.count < CONFIRM_AFTER) continue;
    // Confirmed: the change happened at the first observation, not now. Down
    // only after down every time (the Lightning address follows each down Ark
    // observation, so it is confirmed down with it); a mixed run that ends down
    // is degraded, and that last down already counts towards down.
    const downAfterMixed = status === "down" && comp.pending.mixed === true;
    const target: Observed = downAfterMixed ? "degraded" : status;
    if (target === comp.status) comp.pending = null;
    else moveTo(state, c, target, comp.pending.since);
    if (downAfterMixed) comp.pending = { status: "down", since: now, count: 1 };
  }

  state.incidents = state.incidents.filter((i) => i.to === null || i.to >= now - HISTORY_MS).slice(-MAX_INCIDENTS);
  return state;
}

// A verified report from the app (status/report.ts checked the signature).
// Older or same-time reports are ignored, so a replay changes nothing.
export function acceptReport(prev: State | null, report: StatusReport, now: number): State {
  const state = prev ? structuredClone(prev) : initialState(now);
  if (state.report && report.at <= state.report.report.at) return state;
  state.report = { report, receivedAt: now };
  return state;
}

export function toPublic(
  state: State,
  recorded: readonly RecordedIncident[] = [],
  knownFrom: Partial<Record<ComponentId, number>> = {},
): PublicSnapshot {
  const components = {} as PublicSnapshot["components"];
  for (const c of COMPONENTS) components[c] = { status: state.components[c].status, since: state.components[c].since };
  return {
    v: 2,
    checkedAt: state.checkedAt,
    dataFrom: state.createdAt,
    knownFrom: Object.fromEntries(Object.entries(knownFrom).filter(([, t]) => t < state.createdAt)),
    components,
    incidents: [
      ...recorded.filter((i) => i.to >= state.checkedAt - HISTORY_MS).map((i) => ({ c: i.c, s: i.s, from: i.from, to: i.to, r: true as const })),
      ...state.incidents.map((i) => ({ c: i.c, s: i.s, from: i.from, to: i.to })),
    ],
    nextRoundAt: state.nextRoundAt ?? null,
  };
}
