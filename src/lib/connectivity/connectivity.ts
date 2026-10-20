// What the app knows about the network. The app used to learn about an
// outage only indirectly, from wallet calls that stopped answering: offline,
// the SDK keeps retrying instead of failing, so a background refresh hung in
// the worker queue until bark.ts's watchdog took the worker (and the session)
// down about a minute later, with no message before it.
//
// Two sources:
//  - navigator.onLine, reliable only when it says false (no network interface
//    at all: Wi-Fi off, airplane mode). Instant, uncapped, for everyone.
//  - an active probe, for everything navigator.onLine calls
//    "online" without it being true: Wi-Fi to a dead router, a hotel portal,
//    no signal. It runs only once something already looks wrong (a failed
//    refresh, a watchdog about to fire), so a healthy session sends nothing.
//    The decision logic is netProbeState.ts; the worker half is
//    netProbeWorker.ts.
import { useSyncExternalStore } from "react";
import {
  INITIAL_MACHINE,
  PROBE_PAUSE_CAP_MS,
  classifyProbe,
  isIdle,
  nextProbeDelay,
  stepProbe,
  watchdogMayPause,
  watchdogPausedByProbe,
  type NetState,
  type ProbeMachine,
  type ProbeOutcome,
} from "./netProbeState";

const CHANGE_EVENT = "spendrr-connectivity-change";

let machine: ProbeMachine = INITIAL_MACHINE;

function navigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function isOffline(): boolean {
  return navigatorOffline() || machine.state === "offline";
}

export function netState(): NetState {
  if (isOffline()) return "offline";
  return machine.state;
}

// Whether bark.ts's worker watchdog should stop counting down. No network
// interface at all pauses it for as long as that lasts; the probe's verdict
// only for PROBE_PAUSE_CAP_MS (see netProbeState.ts).
export function watchdogPaused(): boolean {
  return navigatorOffline() || watchdogPausedByProbe(machine, Date.now());
}

// Fires on every offline/online transition and every probe state change.
export function onConnectivityChange(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

export function useOffline(): boolean {
  return useSyncExternalStore(onConnectivityChange, isOffline, () => false);
}

export function useNetState(): NetState {
  return useSyncExternalStore(onConnectivityChange, netState, () => "online");
}

// --- The probe ---------------------------------------------------------------

// The worker half, registered by bark.ts (which owns the worker) so this
// module needn't import it. null: no worker, or it didn't answer in time.
type WorkerProbe = () => Promise<{ mempool: boolean; ark: boolean } | null>;
let workerProbe: WorkerProbe | null = null;
export function setWorkerNetProbe(fn: WorkerProbe): void {
  workerProbe = fn;
}

const ORIGIN_PROBE_TIMEOUT_MS = 5_000;

// Not AbortSignal.timeout(): missing before Safari 16, and a throw there would
// read as "unreachable" and make the probe call a working network offline.
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// This app's own origin. A static asset, so it is served by Cloudflare's
// asset layer without invoking the Worker, and exists in `npm run dev` too.
// The content type is checked because the SPA fallback answers any unknown
// path with 200 + index.html. spendrr.app is on the HSTS-preloaded .app TLD,
// so a portal cannot answer this in plain HTTP; it fails the TLS handshake.
async function probeOrigin(): Promise<boolean> {
  try {
    const res = await fetch("/favicon.svg", {
      method: "HEAD",
      cache: "no-store",
      signal: timeoutSignal(ORIGIN_PROBE_TIMEOUT_MS),
    });
    return res.ok && (res.headers.get("content-type") ?? "").includes("image/svg");
  } catch {
    return false;
  }
}

let inFlight: Promise<ProbeOutcome> | null = null;
let nextTimer = 0;
let capTimer = 0;
let lastProbeAt = 0;

function snapshot(): string {
  return `${netState()}|${watchdogPaused()}`;
}

function emit(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function schedule(): void {
  window.clearTimeout(nextTimer);
  nextTimer = 0;
  // Hidden tabs have their timers throttled anyway; visibilitychange below
  // probes at once on the way back.
  if (isHidden()) return;
  const delay = nextProbeDelay(machine);
  if (delay === null) return;
  nextTimer = window.setTimeout(() => void probeNow(), delay);
}

// The watchdog pause ends by the clock, not by any probe result, so nothing
// else would tell bark.ts it's over.
function scheduleCapExpiry(): void {
  window.clearTimeout(capTimer);
  capTimer = 0;
  if (machine.troubleSince === null) return;
  const remaining = machine.troubleSince + PROBE_PAUSE_CAP_MS - Date.now();
  if (remaining <= 0) return;
  capTimer = window.setTimeout(emit, remaining + 1);
}

// Runs one probe round now, or joins the one already running.
export function probeNow(): Promise<ProbeOutcome> {
  if (inFlight) return inFlight;
  lastProbeAt = Date.now();
  inFlight = (async () => {
    const [origin, remote] = await Promise.all([
      probeOrigin(),
      workerProbe ? workerProbe().catch(() => null) : Promise.resolve(null),
    ]);
    const outcome = classifyProbe({ origin, mempool: remote?.mempool ?? null, ark: remote?.ark ?? null });
    const before = snapshot();
    machine = stepProbe(machine, outcome, Date.now());
    schedule();
    scheduleCapExpiry();
    if (snapshot() !== before) emit();
    return outcome;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// A failed trigger right after a clean probe is the slow-call case the probe
// already answered; don't re-ask on every failed refresh.
const TROUBLE_PROBE_MIN_INTERVAL_MS = 15_000;

// Called when something network-shaped fails (Dashboard's refresh()). Starts
// probing if nothing is being probed yet; a probe run already in progress
// keeps its own schedule.
export function reportNetworkTrouble(): void {
  if (navigatorOffline() || isHidden()) return;
  if (!isIdle(machine) || inFlight) return;
  if (Date.now() - lastProbeAt < TROUBLE_PROBE_MIN_INTERVAL_MS) return;
  void probeNow();
}

// bark.ts's watchdog asks this synchronously before firing. false resets the
// worker at once: the probe has already had its PROBE_PAUSE_CAP_MS.
export function watchdogShouldConsultProbe(): boolean {
  return machine.troubleSince === null || watchdogMayPause(machine, Date.now());
}

// ...and this when the answer above is true: resolves false when the network
// explains the silence (the watchdog then waits instead of killing the
// session), true when it doesn't. An inconclusive round means the worker did
// not even answer its probe, which is itself the sign of a wedged worker.
export async function confirmWatchdogKill(): Promise<boolean> {
  const outcome = await probeNow();
  if (outcome === "online" || outcome === "inconclusive") return true;
  return !watchdogMayPause(machine, Date.now());
}

if (typeof window !== "undefined") {
  // The browser noticing a network again says nothing about the internet;
  // re-check at once rather than waiting out the backoff.
  window.addEventListener("online", () => {
    if (!isIdle(machine)) void probeNow();
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (isHidden()) {
        window.clearTimeout(nextTimer);
        nextTimer = 0;
      } else if (!isIdle(machine)) {
        void probeNow();
      }
    });
  }
}
