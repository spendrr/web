// Raw sensor recorder for tuning tap-to-pay's detector on real phones
// (Settings → Záznamník ťuknutí, v2 beta only). The detector's thresholds
// (see bump.ts's TapDetector and motion-context constants) were first
// guesses; this captures labelled ground truth so they can be fitted
// offline and then kept as regression fixtures.
//
// A recording is a labelled session ("ťuknutí bočními hranami", "zvednutí
// obou telefonů", …) of up to MAX_SESSION_MS. Both phones record the same
// session at once and are aligned afterwards on clock-synced wall time, so
// every sample and event is stamped on the performance.now() timeline and
// each chunk carries the perf→wall anchor and the server clock offset.
//
// Nothing wallet-related is ever recorded: no address, no balance, no seed.
// Just motion, orientation, touch timing, and what the live detector made
// of it. Uploaded in CHUNK_MS pieces so a crash or a closed tab loses at
// most one chunk, and so each upload stays small.

import { ensureClockSync, loadBumpThreshold, motionSampleTime, TapDetector, type TapFeatures, type TapStrength } from "./bump";

export const RECORDER_GESTURES = [
  { id: "tap-side", label: "Ťuknutí bočními hranami", positive: true },
  { id: "tap-top", label: "Ťuknutí horními hranami", positive: true },
  { id: "tap-soft", label: "Jemné ťuknutí", positive: true },
  { id: "tap-other", label: "Ťuknutí jinak (popiš v poznámce)", positive: true },
  { id: "pickup-both", label: "Zvednutí obou telefonů ze stolu", positive: false },
  { id: "putdown", label: "Položení na stůl", positive: false },
  { id: "table-knock", label: "Ťuknutí o stůl (telefony leží)", positive: false },
  { id: "wave", label: "Mávání telefonem", positive: false },
  { id: "hold-both", label: "Oba telefony v jedné ruce", positive: false },
  { id: "walk", label: "Chůze, kapsa, taška", positive: false },
  { id: "screen", label: "Běžné ovládání displeje", positive: false },
  { id: "other", label: "Jiné (popiš v poznámce)", positive: false },
] as const;

export type GestureId = (typeof RECORDER_GESTURES)[number]["id"];

export const MAX_SESSION_MS = 120_000;
const CHUNK_MS = 10_000;
const UPLOAD_ATTEMPTS = 4;

// --- Per-device identity (random, not derived from anything wallet-related) ---
const DEVICE_ID_KEY = "btc-wallet-bump-rec-device";
const DEVICE_PREFS_KEY = "btc-wallet-bump-rec-prefs";

function randomId(bytes = 8): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function recorderDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[a-f0-9]{16}$/.test(existing)) return existing;
    const id = randomId();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return randomId();
  }
}

export interface RecorderPrefs {
  name: string; // "iPhone 13", whatever tells the two phones apart
  inCase: boolean;
}

export function loadRecorderPrefs(): RecorderPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) ?? "{}") as Partial<RecorderPrefs>;
    return { name: typeof raw.name === "string" ? raw.name : "", inCase: raw.inCase === true };
  } catch {
    return { name: "", inCase: false };
  }
}

export function saveRecorderPrefs(prefs: RecorderPrefs): void {
  try {
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort only.
  }
}

// iOS needs both prompts from inside a click handler. Granting one usually
// grants the other (same "Motion & Orientation Access" setting), but each
// has to be asked for its events to fire.
export async function requestRecorderPermissions(): Promise<{ motion: boolean; orientation: boolean }> {
  type Req = { requestPermission?: () => Promise<string> };
  const ask = async (ctor: Req | undefined): Promise<boolean> => {
    if (typeof ctor?.requestPermission !== "function") return true;
    try {
      return (await ctor.requestPermission()) === "granted";
    } catch {
      return false;
    }
  };
  const w = window as unknown as { DeviceMotionEvent?: Req; DeviceOrientationEvent?: Req };
  const motion = await ask(w.DeviceMotionEvent);
  const orientation = await ask(w.DeviceOrientationEvent);
  return { motion, orientation };
}

// --- Columnar buffers ----------------------------------------------------
// Rounded on the way in: sensors report far more digits than they resolve,
// and JSON size is dominated by them.
const r3 = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const r2 = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

function newMotion() {
  return {
    t: [] as number[], // event.timeStamp (perf ms), what the detector uses
    lag: [] as number[], // performance.now() at dispatch minus t: main-thread delay
    iv: [] as (number | null)[], // event.interval (ms)
    ax: [] as (number | null)[], // acceleration (gravity removed), m/s²; null where the device lacks it
    ay: [] as (number | null)[],
    az: [] as (number | null)[],
    gx: [] as (number | null)[], // accelerationIncludingGravity, m/s²
    gy: [] as (number | null)[],
    gz: [] as (number | null)[],
    ra: [] as (number | null)[], // rotationRate alpha/beta/gamma, deg/s
    rb: [] as (number | null)[],
    rg: [] as (number | null)[],
  };
}

function newOrientation() {
  return {
    t: [] as number[],
    abs: [] as number[], // 1 = earth-referenced (deviceorientationabsolute or absolute:true)
    al: [] as (number | null)[], // alpha/beta/gamma, degrees
    be: [] as (number | null)[],
    ga: [] as (number | null)[],
    hd: [] as (number | null)[], // iOS webkitCompassHeading, degrees from magnetic north
    ha: [] as (number | null)[], // iOS webkitCompassAccuracy, ± degrees (-1 = uncalibrated)
  };
}

export interface DetectorHit {
  t: number; // peak time, perf ms
  peak: number;
  strength: TapStrength;
  vertical?: number;
  rested: boolean;
  noiseBefore?: number;
}

interface Chunk {
  motion: ReturnType<typeof newMotion>;
  orient: ReturnType<typeof newOrientation>;
  touches: { t: number; type: string; n: number }[];
  hits: DetectorHit[];
  events: { t: number; type: string; detail?: string }[];
  startPerf: number;
}

function newChunk(startPerf: number): Chunk {
  return { motion: newMotion(), orient: newOrientation(), touches: [], hits: [], events: [], startPerf };
}

// --- Device description -----------------------------------------------------
async function describeDevice(): Promise<Record<string, unknown>> {
  const nav = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
      mobile?: boolean;
      getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
    };
    deviceMemory?: number;
  };
  let uaData: Record<string, unknown> | null = null;
  try {
    // Android Chrome reports the actual phone model here; the UA string
    // itself has been frozen to "K" for a while.
    uaData = (await nav.userAgentData?.getHighEntropyValues?.(["model", "platformVersion", "fullVersionList"])) ?? null;
  } catch {
    uaData = null;
  }
  return {
    ua: navigator.userAgent,
    uaData,
    platform: nav.userAgentData?.platform ?? navigator.platform,
    screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
    touchPoints: navigator.maxTouchPoints,
    cores: navigator.hardwareConcurrency,
    memory: nav.deviceMemory ?? null,
    standalone: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
  };
}

// --- Session ---------------------------------------------------------------
export interface RecorderStats {
  elapsedMs: number;
  samples: number;
  sampleHz: number; // over the last second
  orientSamples: number;
  hard: number;
  soft: number;
  lastHit: DetectorHit | null;
  level: number; // |linear acceleration| of the latest sample, for a live meter
  chunksSent: number;
  chunksPending: number;
  uploadError: string | null;
  hasLinear: boolean | null;
  hasRotation: boolean | null;
  hasOrientation: boolean;
  hasCompass: boolean;
}

export interface RecorderSessionInfo {
  gesture: GestureId;
  note: string;
  prefs: RecorderPrefs;
}

export class BumpRecorder {
  readonly sessionId = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomId(4)}`;
  private readonly deviceId = recorderDeviceId();
  private readonly info: RecorderSessionInfo;
  private readonly onStats: (s: RecorderStats) => void;
  private chunk: Chunk;
  private chunkIndex = 0;
  private readonly startPerf: number;
  private readonly startWall: number;
  private detector: TapDetector | null = null;
  private threshold = loadBumpThreshold();
  private lastTouchAt = -Infinity;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private device: Record<string, unknown> | null = null;
  private stopped = false;
  private readonly uploads: Promise<void>[] = [];
  private readonly recentSampleTimes: number[] = [];
  private readonly stats: RecorderStats = {
    elapsedMs: 0,
    samples: 0,
    sampleHz: 0,
    orientSamples: 0,
    hard: 0,
    soft: 0,
    lastHit: null,
    level: 0,
    chunksSent: 0,
    chunksPending: 0,
    uploadError: null,
    hasLinear: null,
    hasRotation: null,
    hasOrientation: false,
    hasCompass: false,
  };
  private readonly onAutoStop: () => void;

  constructor(info: RecorderSessionInfo, onStats: (s: RecorderStats) => void, onAutoStop: () => void) {
    this.info = info;
    this.onStats = onStats;
    this.onAutoStop = onAutoStop;
    this.startPerf = performance.now();
    this.startWall = Date.now();
    this.chunk = newChunk(this.startPerf);
  }

  async start(): Promise<void> {
    this.device = await describeDevice();
    // The same detector the home screen runs, on the same events, so every
    // recording also says what the live app would have made of it.
    this.detector = new TapDetector(
      this.threshold,
      (peak, peakTime, strength, features) => this.onHit(peak, peakTime, strength, features),
      () => performance.now() - this.lastTouchAt < 500,
    );
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrientation);
    window.addEventListener("deviceorientationabsolute", this.onOrientationAbsolute as EventListener);
    window.addEventListener("touchstart", this.onTouch, { passive: true, capture: true });
    window.addEventListener("touchend", this.onTouch, { passive: true, capture: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.flushTimer = setInterval(() => this.flush(false), CHUNK_MS);
    this.statsTimer = setInterval(() => this.emitStats(), 100);
    this.stopTimer = setTimeout(() => {
      void this.stop().then(this.onAutoStop);
    }, MAX_SESSION_MS);
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      this.wakeLock = (await wl?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null; // Only keeps the screen on; recording works without it.
    }
    this.event("start");
    // Refresh the server clock offset up front so the first chunk carries it.
    void ensureClockSync();
  }

  // Resolves once every chunk (including the last) has been uploaded or has
  // run out of retries.
  async stop(count?: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.event("stop");
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrientation);
    window.removeEventListener("deviceorientationabsolute", this.onOrientationAbsolute as EventListener);
    window.removeEventListener("touchstart", this.onTouch, { capture: true });
    window.removeEventListener("touchend", this.onTouch, { capture: true });
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.flush(true, count);
    try {
      await this.wakeLock?.release();
    } catch {
      // Already released by the browser.
    }
    await Promise.allSettled(this.uploads);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.emitStats();
  }

  // The person's own count of how many times they actually did the gesture:
  // the ground truth the detector's hit count is compared against.
  async saveCount(count: number): Promise<boolean> {
    return this.upload({ kind: "meta", sessionId: this.sessionId, deviceId: this.deviceId, count }, "meta");
  }

  private readonly onMotion = (e: DeviceMotionEvent): void => {
    const nowPerf = performance.now();
    const t = motionSampleTime(e.timeStamp, nowPerf);
    const m = this.chunk.motion;
    m.t.push(Math.round(t * 100) / 100);
    m.lag.push(Math.round((nowPerf - t) * 10) / 10);
    m.iv.push(r2(e.interval));
    const a = e.acceleration;
    const g = e.accelerationIncludingGravity;
    const rr = e.rotationRate;
    m.ax.push(r3(a?.x));
    m.ay.push(r3(a?.y));
    m.az.push(r3(a?.z));
    m.gx.push(r3(g?.x));
    m.gy.push(r3(g?.y));
    m.gz.push(r3(g?.z));
    m.ra.push(r2(rr?.alpha));
    m.rb.push(r2(rr?.beta));
    m.rg.push(r2(rr?.gamma));
    // "Ever seen", not "first sample": some browsers fire one empty event
    // (all nulls) before the real stream starts.
    if (this.stats.hasLinear !== true) this.stats.hasLinear = a !== null && a.x !== null;
    if (this.stats.hasRotation !== true) this.stats.hasRotation = rr !== null && rr.alpha !== null;
    this.stats.samples++;
    this.stats.level = a && a.x !== null ? Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) : 0;
    this.recentSampleTimes.push(t);
    while (this.recentSampleTimes.length && t - this.recentSampleTimes[0] > 1000) this.recentSampleTimes.shift();
    this.detector?.handle(e);
  };

  private pushOrientation(e: DeviceOrientationEvent, absolute: boolean): void {
    const o = this.chunk.orient;
    const ios = e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
    o.t.push(Math.round(motionSampleTime(e.timeStamp, performance.now()) * 100) / 100);
    o.abs.push(absolute || e.absolute ? 1 : 0);
    o.al.push(r2(e.alpha));
    o.be.push(r2(e.beta));
    o.ga.push(r2(e.gamma));
    o.hd.push(r2(ios.webkitCompassHeading));
    o.ha.push(r2(ios.webkitCompassAccuracy));
    this.stats.orientSamples++;
    if (e.alpha !== null || e.beta !== null) this.stats.hasOrientation = true;
    if (((absolute || e.absolute) && e.alpha !== null) || typeof ios.webkitCompassHeading === "number") this.stats.hasCompass = true;
  }

  private readonly onOrientation = (e: DeviceOrientationEvent): void => this.pushOrientation(e, false);
  private readonly onOrientationAbsolute = (e: DeviceOrientationEvent): void => this.pushOrientation(e, true);

  private readonly onTouch = (e: TouchEvent): void => {
    this.lastTouchAt = performance.now();
    this.chunk.touches.push({ t: Math.round(motionSampleTime(e.timeStamp, performance.now()) * 100) / 100, type: e.type, n: e.touches.length });
  };

  private readonly onVisibility = (): void => this.event("visibility", document.visibilityState);

  private event(type: string, detail?: string): void {
    this.chunk.events.push({ t: Math.round(performance.now() * 100) / 100, type, detail });
  }

  private onHit(peak: number, t: number, strength: TapStrength, features: TapFeatures): void {
    const hit: DetectorHit = {
      t: Math.round(t * 100) / 100,
      peak: Math.round(peak * 1000) / 1000,
      strength,
      vertical: features.vertical === undefined ? undefined : Math.round(features.vertical * 1000) / 1000,
      rested: features.rested,
      noiseBefore: features.noiseBefore === undefined ? undefined : Math.round(features.noiseBefore * 1000) / 1000,
    };
    this.chunk.hits.push(hit);
    if (strength === "hard") this.stats.hard++;
    else this.stats.soft++;
    this.stats.lastHit = hit;
  }

  private emitStats(): void {
    this.stats.elapsedMs = Math.min(performance.now() - this.startPerf, MAX_SESSION_MS);
    const times = this.recentSampleTimes;
    this.stats.sampleHz = times.length > 1 ? Math.round(((times.length - 1) * 1000) / (times[times.length - 1] - times[0])) : 0;
    this.onStats({ ...this.stats });
  }

  private flush(final: boolean, count?: number): void {
    const chunk = this.chunk;
    const index = this.chunkIndex++;
    this.chunk = newChunk(performance.now());
    const nowPerf = performance.now();
    const nowWall = Date.now();
    const payload = {
      kind: "chunk",
      v: 1,
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      chunk: index,
      final,
      count: count ?? null,
      gesture: this.info.gesture,
      note: this.info.note,
      deviceName: this.info.prefs.name,
      inCase: this.info.prefs.inCase,
      device: index === 0 || final ? this.device : undefined,
      threshold: this.threshold,
      // perf ↔ wall anchor taken at flush time, plus the absolute origin, so
      // every perf timestamp above converts to this phone's wall clock and,
      // with `clock`, to server time (the timeline both phones share).
      anchor: { perf: Math.round(nowPerf * 100) / 100, wall: nowWall, timeOrigin: performance.timeOrigin },
      session: { startPerf: Math.round(this.startPerf * 100) / 100, startWall: this.startWall },
      chunkStartPerf: Math.round(chunk.startPerf * 100) / 100,
      clock: null as null | { offsetMs: number; uncertaintyMs: number; measuredAt: number },
      motion: chunk.motion,
      orient: chunk.orient,
      touches: chunk.touches,
      hits: chunk.hits,
      events: chunk.events,
    };
    this.stats.chunksPending++;
    const job = ensureClockSync()
      .then((clock) => {
        payload.clock = clock;
        return this.upload(payload, String(index));
      })
      .then((ok) => {
        this.stats.chunksPending--;
        if (ok) this.stats.chunksSent++;
      });
    this.uploads.push(job);
  }

  private async upload(payload: unknown, label: string): Promise<boolean> {
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
      try {
        const res = await fetch("/api/bump/lab/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: body.length < 60_000,
        });
        if (res.ok) {
          this.stats.uploadError = null;
          return true;
        }
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        this.stats.uploadError = `${label}: ${err.error ?? res.status}`;
        if (res.status === 400 || res.status === 403 || res.status === 413) return false;
      } catch (e) {
        this.stats.uploadError = `${label}: ${e instanceof Error ? e.message : String(e)}`;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    return false;
  }
}
