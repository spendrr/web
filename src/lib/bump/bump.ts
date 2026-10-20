// Client for the real, wallet-integrated "tap two phones together to pay".
// worker/bump.ts is the pairing backend.
//
// Passive by design: there is no "Přijmout"/"Zaplatit ťuknutím" button.
// Whoever is paying whom is unknown at the moment of the physical tap —
// every tap just carries the tapper's own Ark address (and a commitment to a
// random nonce, see bumpCommitment), gets paired with the one other tap that
// happened at the same instant, and only *after* both phones show matching
// emoji does a person tap one of two on-screen arrows
// to say which way the money should go. The other phone's arrow then lights
// up on its own (see BumpSession.pollUntilRoleKnown), never requiring that
// person to tap anything.
//
// Silent until paired: every tap-shaped spike the detector sees goes to
// the server as a candidate ("hard", or "soft" when weaker), and nothing
// is shown, buzzed, or paused until one of them comes back paired with
// another phone's. See BumpSession.onCandidate for why.
//
// Bump never carries a payment itself and never calls a wallet.* method on
// its own: once a direction is chosen, the caller (Dashboard.tsx) still
// goes through SendPanel's own classify → send() pipeline — see
// Dashboard.tsx's own comment on how a bump-originated send skips the
// separate confirm-screen step but keeps the password-above-threshold gate
// completely unchanged.
//
// Still gated behind the v2 beta toggle (designVersion.ts) AND its own
// opt-in Settings switch (isBumpPayEnabled) that pre-requests motion
// permission at toggle-on time — passive listening on the home screen has
// no user gesture of its own to request permission from, so it has to
// already be granted before listening ever starts.

import { hapticSuccess } from "../ui/haptics";

export type BumpRole = "send" | "receive";

// The shared payment flow after pairing, mirrored from worker/bump.ts.
export type FlowStage = "choosing" | "entering" | "sending" | "sent" | "received" | "cancelled";

export interface FlowView {
  stage: FlowStage;
  // Only ever set by the sender, once it presses "Zaplatit".
  amountSats?: number;
  // The other phone hasn't been heard from for PEER_LOST_MS.
  peerLost: boolean;
}

// quiet on a notice: it concerns a pairing this phone never showed (a
// faint tap whose emoji weren't verified yet), so the UI drops it silently
// instead of popping up a notice about something nobody saw.
export type BumpOutcome =
  | { kind: "idle" }
  | { kind: "armed" } // listening for a physical tap, nothing shown
  // Paired and verified: emoji to compare, and "Platím" / "Přijímám".
  // quiet: this phone only felt a faint (soft) tap. It might be a stranger's
  // phone that happened to jiggle at the right instant, so the UI offers the
  // pairing as a small dismissible bubble instead of taking over the screen.
  // settling: a late tap could still turn this pairing ambiguous, so the
  // server doesn't accept a direction yet (worker/bump.ts's handleChoose).
  | {
      kind: "paired";
      deltaMs: number;
      partnerCity: string | null;
      emoji: string;
      peerAddress: string;
      quiet: boolean;
      settling: boolean;
    }
  | { kind: "sending"; emoji: string; peerAddress: string; flow: FlowView } // this phone pays
  | { kind: "receiving"; emoji: string; flow: FlowView } // the other phone pays
  | { kind: "cancelled"; quiet?: boolean } // the *other* phone called it off
  | { kind: "ambiguous"; quiet?: boolean }
  // The tap reached the server too late to be matched with anything: the
  // request itself was slower than MAX_ARRIVAL_LAG_MS. Shown rather than
  // swallowed, see sendCandidate.
  | { kind: "slow"; quiet?: boolean }
  // Where it ran out: before the pairing could be verified, before anyone
  // picked a direction, or mid-payment (the pair went idle for minutes).
  | { kind: "expired"; phase: "pairing" | "choosing" | "flow"; quiet?: boolean }
  | { kind: "error"; message: string; quiet?: boolean };

// The set the emoji are drawn from. People compare these by eye (and read
// them out to each other), so every entry is:
// - one code point with default emoji presentation (no variation selector,
//   no ZWJ sequence, no skin tone), so it renders the same everywhere;
// - Emoji 5.0 (2017) or older, so an older Android shows it instead of an
//   empty box (Android 8+ has all of these);
// - easy to name and unlike every other entry: no two of the same colour and
//   shape (no two hearts, fruits of one colour, similar faces, etc.).
// Exactly 64, a power of two (see bumpSasEmoji). Order matters: both phones
// must use the same list in the same order, so changing it is a protocol
// change like the SAS version string below.
export const BUMP_EMOJI = [
  // animals
  "🦊", "🐙", "🐝", "🐧", "🦄", "🐳", "🦖", "🐢", "🦉", "🐸", "🦀", "🐌", "🦋", "🐘", "🦒", "🐼", "🦈", "🦔",
  // food
  "🍄", "🍒", "🍉", "🍩", "🍕", "🍌", "🍍", "🥕", "🌽", "🥥", "🧀", "🍔", "🥨", "🍇",
  // nature
  "🌵", "🔥", "🌙", "🌈", "⭐", "🌻", "🍀", "⚡", "🌊",
  // things
  "🎺", "🚀", "🎲", "🎯", "🎪", "🎧", "🎻", "🐚", "🔑", "🎈", "💎", "🔔", "⚓", "🎸", "💡", "🎩", "👑", "🎁",
  // vehicles
  "🚁", "🚂", "🛸", "🚲", "⛵",
];

// --- Commit-reveal for the emoji ---------------------------------------------
// See worker/bump.ts's bumpCommitment for the why. In short: each candidate
// tap commits to (own address, fresh random nonce); after pairing, each phone
// reveals its nonce only once it already holds the partner's commitment,
// checks the partner's revealed nonce against that commitment, and derives
// the emoji from both. Whoever relays the addresses (the server, or anyone
// who got into the pairing) can no longer choose a value that makes the
// emoji match: its own nonce is fixed before it sees the honest one.
//
// 3 different emoji out of 64 = 64·63·62 ≈ 250 000 combinations (17.9 bits):
// with the commitments, a roughly 1-in-250 000 blind guess per live attempt
// at a real pairing, not a search space someone can grind through in
// advance. Going to 4 (~23.8 bits) is planned for the V1 release; it's this
// one constant, and both phones must run the same value.
export const BUMP_SAS_EMOJI_COUNT = 3;
export const BUMP_NONCE_RE = /^[0-9a-f]{32}$/;
const COMMIT_RE = /^[0-9a-f]{64}$/;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newBumpNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

// Must stay byte-identical to worker/bump.ts's bumpCommitment (a test pins
// the two together). Injective: the address is length-prefixed, the nonce
// has a fixed length.
export async function bumpCommitment(address: string, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(`spendrr-bump-commit-v1:${address.length}:${address}:${nonce}`);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

// Order-independent, so both phones compute the same emoji without either
// one being "first". Draws BUMP_SAS_EMOJI_COUNT *different* emoji: each
// position picks from the ones not used yet, so a row never shows the same
// symbol twice (which read as a glitch, and is easy to miscount). Every
// pick is uniform: a byte is used only if it falls below the largest
// multiple of the number of choices left, otherwise it's skipped, so no
// emoji is ever likelier than another. The byte stream is SHA-256 of the
// input and a counter, extended as needed (almost never past the first
// block). Pure, exported for tests.
export async function bumpSasEmoji(
  a: { address: string; nonce: string },
  b: { address: string; nonce: string },
): Promise<string> {
  const entries = [a, b].map((x) => `${x.address.length}:${x.address}:${x.nonce}`).sort();
  const seed = `spendrr-bump-sas-v2|${entries.join("|")}`;
  const left = [...BUMP_EMOJI];
  const picked: string[] = [];
  let block = 0;
  let bytes = new Uint8Array(0);
  let at = 0;
  while (picked.length < BUMP_SAS_EMOJI_COUNT) {
    if (at >= bytes.length) {
      const data = new TextEncoder().encode(`${seed}|${block++}`);
      bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      at = 0;
    }
    const byte = bytes[at++];
    const n = left.length;
    if (byte >= 256 - (256 % n)) continue;
    picked.push(left.splice(byte % n, 1)[0]);
  }
  return picked.join(" ");
}

const THRESHOLD_STORAGE_KEY = "btc-wallet-bump-threshold";
const DEFAULT_THRESHOLD = 6; // m/s^2 delta above the device's own resting baseline

export function loadBumpThreshold(): number {
  try {
    const v = Number(localStorage.getItem(THRESHOLD_STORAGE_KEY));
    return v > 0 ? v : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

export function saveBumpThreshold(value: number): void {
  try {
    localStorage.setItem(THRESHOLD_STORAGE_KEY, String(value));
  } catch {
    // Best-effort only.
  }
}

// The Settings toggle's own on/off state — separate from the v2 beta
// toggle, since v2 gates whether the *option* is even shown, while this is
// the person's actual opt-in (and the point at which motion permission was
// requested, see requestMotionPermission's call site in Settings.tsx).
const ENABLED_STORAGE_KEY = "btc-wallet-bump-enabled";

// Emergency kill switch from 2026-09-19, re-opened the same day for the
// developer's own continued real-device testing after the first three
// compounding bugs it was flipped for were root-caused and fixed:
// BumpOverlay's restart() leaking the previous session's devicemotion
// listener instead of stopping it (the likely root cause behind the false
// "spouští se to samo" flood, the 429s, and quite possibly the misdirected
// send — a stale leaked session's onOutcome could race the current one);
// a 429 response being silently misread as "expired" instead of a visible
// error; and TOUCH_SUPPRESS_MS added to reject a tap that coincides with
// the phone's own touchscreen input, the most likely source of ordinary
// handling being misread as a bump. Deliberately reads real user opt-in
// again rather than staying forced off — the fixes above are reasoned
// through and unit-testable, but the actual false-positive rate on real
// hardware still needs a real round of testing to trust, and that testing
// is the whole point of turning this back on now. Still explicitly unverified:
// double-send protection, auto-lock mid-flow, and the crowded-room mispairing
// case.
const KILL_SWITCH_DISABLED = false;

// Settings.tsx uses this to hide the toggle row entirely (rather than show
// a switch that looks on but silently does nothing) while the kill switch
// above is active.
export function isBumpPayKillSwitchActive(): boolean {
  return KILL_SWITCH_DISABLED;
}

// Phones and tablets only. A desktop has no motion sensor to bump with, so
// the Settings rows are hidden there and passive listening never starts
// (which would otherwise just keep syncing the clock for nothing). Touch
// plus a coarse primary pointer is the reliable "handheld" signal: a laptop
// with a touchscreen still reports a fine pointer (its trackpad or mouse).
export function isBumpPaySupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      "DeviceMotionEvent" in window &&
      navigator.maxTouchPoints > 0 &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

export function isBumpPayEnabled(): boolean {
  if (KILL_SWITCH_DISABLED || !isBumpPaySupported()) return false;
  try {
    return localStorage.getItem(ENABLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBumpPayEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Best-effort only — worst case the toggle doesn't stick across reloads.
  }
}

export function needsMotionPermissionPrompt(): boolean {
  const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } })
    .DeviceMotionEvent;
  return typeof DME?.requestPermission === "function";
}

// Must be called from inside a real click handler (Settings' toggle) — iOS
// only grants this in direct response to a user gesture. There is no
// equivalent gesture once passive listening is already running on the home
// screen, which is exactly why this has to happen in Settings ahead of
// time rather than lazily the first time a tap would need it.
export async function requestMotionPermission(): Promise<boolean> {
  const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } })
    .DeviceMotionEvent;
  if (typeof DME?.requestPermission !== "function") return true;
  try {
    return (await DME.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

// --- Clock sync -------------------------------------------------------
// worker/bump.ts matches taps on their clock-synced *physical* tap time, so
// this offset is what makes two phones' taps comparable at all: the tap
// is timestamped on this phone's clock and converted to server time here.
//
// Cached at module level rather than re-measured per BumpSession: sessions
// restart after every expired/ambiguous/error outcome, and each sync costs
// five requests out of the same per-IP poll budget. More importantly, the
// old per-session sync ran *before* the motion listener was attached, so
// for the first few round trips after every restart a real tap simply
// wasn't heard. Now the listener is attached first and the sync runs in
// parallel (see BumpSession.start).
export interface ClockSync {
  offsetMs: number; // serverTime ≈ Date.now() + offsetMs
  uncertaintyMs: number; // ± bound: half the best sample's round trip
  measuredAt: number; // Date.now() when measured
}

const CLOCK_SYNC_SAMPLES = 5;
// Stop sampling early once the best round trip is this tight (half of it is
// the uncertainty), after at least CLOCK_SYNC_MIN_SAMPLES: the usual case on a
// warm connection, and well inside worker/bump.ts's MAX_CLOCK_UNCERTAINTY_MS
// (25). Only a slow or jittery network still takes all five.
const CLOCK_SYNC_GOOD_ENOUGH_MS = 15;
const CLOCK_SYNC_MIN_SAMPLES = 2;
// Phone clocks are NTP-disciplined, so drift over this window is a few ms at
// most; the refresh mostly catches an occasional stepped correction.
const CLOCK_SYNC_MAX_AGE_MS = 10 * 60_000;
// If a tap happens while the very first sync is still running, wait for it
// this long (the tap time itself is already captured, so waiting only
// delays the request, it doesn't blur the timestamp). Past this, the tap
// goes out without a client time and the server falls back to arrival time.
const CLOCK_SYNC_TAP_WAIT_MS = 1500;

let cachedClockSync: ClockSync | null = null;
let clockSyncInFlight: Promise<ClockSync | null> | null = null;

// Pure, exported for tests: the NTP-style estimate from one round trip.
// Assumes the server stamped its reply halfway through the round trip; the
// true offset is within ±rtt/2 of this, whatever the actual asymmetry.
export function clockSampleFromRoundTrip(t0: number, t1: number, serverTime: number): { offsetMs: number; rttMs: number } {
  const rttMs = t1 - t0;
  return { offsetMs: serverTime - (t0 + rttMs / 2), rttMs };
}

// performance.now() of the latest same-origin network activity, so warmUp
// can tell a connection that is already awake from one that has gone idle.
// Bump's own requests set it directly (bumpFetch), everything else the app
// fetches from this origin (price, names, backup) through watchSameOriginTraffic.
let lastNetworkAt = -Infinity;
let resourceObserver: PerformanceObserver | null = null;

// Resource Timing sees every fetch without the rest of the app having to
// report it. An observer rather than performance.getEntriesByType: the
// timeline buffer stops recording once full (250 entries by default), and a
// wallet left open for hours gets there. Started once, never stopped: it only
// keeps one number. Without the API warmUp just pings more often.
function watchSameOriginTraffic(): void {
  if (resourceObserver || typeof PerformanceObserver === "undefined") return;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) return;
  try {
    resourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith(`${origin}/`)) continue;
        const end = (entry as PerformanceResourceTiming).responseEnd || entry.startTime + entry.duration;
        if (end > lastNetworkAt) lastNetworkAt = end;
      }
    });
    resourceObserver.observe({ type: "resource" });
  } catch {
    resourceObserver = null;
  }
}

function bumpFetch(input: string, init?: RequestInit): Promise<Response> {
  lastNetworkAt = performance.now();
  return fetch(input, init).finally(() => {
    lastNetworkAt = performance.now();
  });
}

async function measureClockSync(): Promise<ClockSync | null> {
  let best: { offsetMs: number; rttMs: number } | null = null;
  for (let i = 0; i < CLOCK_SYNC_SAMPLES; i++) {
    const t0 = Date.now();
    try {
      const res = await bumpFetch("/api/bump/sync", { cache: "no-store" });
      const t1 = Date.now();
      if (!res.ok) continue;
      const body = (await res.json()) as { serverTime?: number };
      if (typeof body.serverTime !== "number" || !Number.isFinite(body.serverTime)) continue;
      const sample = clockSampleFromRoundTrip(t0, t1, body.serverTime);
      // Minimum round trip wins: the first request of a cold, radio-idle
      // phone is the slow one, and the fastest sample has the tightest bound.
      if (sample.rttMs >= 0 && (!best || sample.rttMs < best.rttMs)) best = sample;
      if (best && i + 1 >= CLOCK_SYNC_MIN_SAMPLES && best.rttMs / 2 <= CLOCK_SYNC_GOOD_ENOUGH_MS) break;
    } catch {
      // A single failed sample is fine — the loop just tries the rest.
    }
  }
  if (!best) return null;
  return { offsetMs: best.offsetMs, uncertaintyMs: Math.ceil(best.rttMs / 2), measuredAt: Date.now() };
}

// Returns a sync no older than CLOCK_SYNC_MAX_AGE_MS, measuring one if
// needed. Concurrent callers share one measurement. A failed measurement
// keeps the previous (stale but almost certainly still accurate) value
// rather than throwing it away.
export function ensureClockSync(): Promise<ClockSync | null> {
  if (cachedClockSync && Date.now() - cachedClockSync.measuredAt < CLOCK_SYNC_MAX_AGE_MS) {
    return Promise.resolve(cachedClockSync);
  }
  if (!clockSyncInFlight) {
    clockSyncInFlight = measureClockSync()
      .then((sync) => {
        if (sync) cachedClockSync = sync;
        return cachedClockSync;
      })
      .finally(() => {
        clockSyncInFlight = null;
      });
  }
  return clockSyncInFlight;
}

// Test-only: module-level cache would otherwise leak between tests.
export function __resetClockSyncForTests(): void {
  cachedClockSync = null;
  clockSyncInFlight = null;
  lastNetworkAt = -Infinity;
  resourceObserver?.disconnect();
  resourceObserver = null;
  warmUpCounts.sent = 0;
  warmUpCounts.skipped = 0;
  warmUpCounts.dropped = 0;
}

async function clockSyncForTap(): Promise<ClockSync | null> {
  if (cachedClockSync) return cachedClockSync;
  const pending = ensureClockSync();
  return Promise.race([pending, sleep(CLOCK_SYNC_TAP_WAIT_MS).then(() => null)]);
}

// Converts a performance.now()-timeline instant (a DeviceMotionEvent
// timestamp) to this phone's wall clock. performance.now() is what the
// detector measures on; Date.now() is what the offset is relative to.
export function perfToWallMs(perfMs: number, nowPerf: number, nowWall: number): number {
  return nowWall - (nowPerf - perfMs);
}

interface TapResponse {
  id?: string;
  error?: string;
  // Why a tap could not be matched at all, when the server knows: "late"
  // (the request outran MAX_ARRIVAL_LAG_MS) or "skew" (this phone's clock
  // reads ahead of the server's). Absent on a normal unmatched tap.
  reason?: string;
  lagMs?: number;
}
interface StatusResponse {
  state?: "pending" | "paired" | "ambiguous" | "expired";
  deltaMs?: number;
  partnerCf?: { city?: string };
  peerAddress?: string;
  peerCommit?: string;
  peerNonce?: string;
  role?: BumpRole;
  settlesInMs?: number;
  v?: number;
  flow?: { stage: FlowStage; amountSats?: number; cancelledBy?: "me" | "peer" };
  peerSeenAgoMs?: number;
}
interface ChooseResponse {
  role?: BumpRole;
  // settling / unverified: not yet, see worker/bump.ts's handleChoose.
  state?: "ambiguous" | "expired" | "cancelled" | "settling" | "unverified";
  settlesInMs?: number;
  error?: string;
}

// What a tap candidate was, worker/bump.ts's TapKind.
export type TapStrength = "hard" | "soft";

interface TapRequest {
  kind: TapStrength;
  // Server time of the physical tap. A tap is only sent with one: the
  // server can't match a tap without it.
  clientTapTime: number;
  clockUncertaintyMs: number;
  accelPeak: number;
  address: string;
  commit: string;
  // Motion context (see TapFeatures): used for the vertical veto and logged
  // server-side for tuning.
  vertical?: number;
  rested?: boolean;
  noiseBefore?: number;
  // The shape check's measurements (see tapShape): tells the server this
  // candidate already passed it, and logs how close it was.
  post?: number;
  spreadMs?: number;
  // Warm-up pings sent and skipped since the previous tap, for the server's
  // aggregate stats only (see warmUpCounts).
  warmSent?: number;
  warmSkipped?: number;
  spikesDropped?: number;
}

// wait: true makes the server hold the response until the tap is paired,
// ambiguous, or can no longer be matched, so the answer comes back in this
// one request instead of a /status poll loop.
async function postTap(tap: TapRequest, signal: AbortSignal): Promise<TapResponse & StatusResponse> {
  const res = await bumpFetch("/api/bump/tap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...tap, wait: true }),
    signal,
  });
  await throwOnError(res);
  return (await res.json()) as TapResponse & StatusResponse;
}

class BumpRateLimitError extends Error {}

// Both of these used to skip the res.ok check and cast whatever came back
// straight to the expected shape — a 429 body (`{error: "Too many
// requests."}`) has no `.state`/`.role` field, so it read as a
// legitimately-shaped-but-empty response and got silently misinterpreted
// as "the pairing expired" or "nothing happened yet" instead of surfacing
// as the rate-limit error it actually was. Confirmed live as part of the
// same 2026-09-19 incident that motivated TOUCH_SUPPRESS_MS above — a
// storm of false-positive taps burned through the rate limit budget, and
// every poll after that point silently looked like nothing was going on.
async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 429) throw new BumpRateLimitError("Příliš mnoho pokusů, zkus to za chvíli znovu.");
  const body = (await res.json().catch(() => ({}) as { error?: string })) as { error?: string };
  throw new Error(body.error || `bump request failed (${res.status})`);
}

// v: the flow version this phone last saw. The server holds the request
// until the flow moves past it (or ~8s pass), so changes on the other
// phone arrive within one round trip.
async function pollStatus(id: string, v: number, signal: AbortSignal): Promise<StatusResponse> {
  const res = await bumpFetch(`/api/bump/status?id=${encodeURIComponent(id)}&v=${v}`, { cache: "no-store", signal });
  await throwOnError(res);
  return (await res.json()) as StatusResponse;
}

// Moves the shared flow forward. A 409 means the move isn't allowed any
// more (the other phone cancelled first, say); its body carries the
// current status, which is exactly what the caller needs to show.
async function postProgress(id: string, stage: FlowStage, amountSats?: number): Promise<{ ok: boolean; status: StatusResponse }> {
  const res = await bumpFetch("/api/bump/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, stage, amountSats }),
  });
  if (res.status === 409) return { ok: false, status: (await res.json()) as StatusResponse };
  if (res.status === 404) return { ok: false, status: { state: "expired" } };
  await throwOnError(res);
  return { ok: true, status: (await res.json()) as StatusResponse };
}

// Reveals this phone's nonce for a pairing (see bumpCommitment). The answer
// is the pairing's status, which carries the partner's nonce once it has
// revealed too. 404: the pairing is gone.
async function postReveal(id: string, nonce: string): Promise<StatusResponse> {
  const res = await bumpFetch("/api/bump/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, nonce }),
  });
  if (res.status === 404) return { state: "expired" };
  await throwOnError(res);
  return (await res.json()) as StatusResponse;
}

async function postChoice(id: string, choice: BumpRole): Promise<ChooseResponse> {
  const res = await bumpFetch("/api/bump/choose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, choice }),
  });
  // A late tap turned the pairing ambiguous (409), or the record is gone
  // (404): both are pairing outcomes, not errors to show raw.
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as ChooseResponse;
    if (body.state === "settling" || body.state === "unverified") return { state: body.state, settlesInMs: body.settlesInMs };
    return { state: body.state === "cancelled" ? "cancelled" : "ambiguous" };
  }
  if (res.status === 404) return { state: "expired" };
  await throwOnError(res);
  return (await res.json()) as ChooseResponse;
}

// --- Tap-shape classifier ---------------------------------------------
// A raw "delta above baseline" crossing can't tell a real tap apart from
// setting the phone down or picking it up — those cross the same delta,
// just more slowly. The discriminator is shape: a real collision is a
// short, sharp spike that decays back down within ~150ms; handling the
// phone stays elevated longer. Live testing on two different phones motivated
// tracking a per-device rolling baseline in the first
// place (the standalone public/bump-lab.js prototype this was first lifted
// from has since been removed).
const BASELINE_ALPHA = 0.05;
// Lowered (0.4 -> 0.28, SOFT_RATIO 0.5 -> 0.33) once the shape check below
// existed: recorded real taps where one phone peaked at only 2-3 m/s^2 were
// missed outright, and the shape check, not the height, is now what keeps
// handling noise out.
const ARM_RATIO = 0.28;
const MAX_EVENT_MS = 300;
const DECAY_WINDOW_MS = 150;
const TAP_DEBOUNCE_MS = 600;

// A tap-shaped spike this fraction of the threshold or stronger is sent as
// a "soft" candidate: never shown, and it can only pair with the *other*
// phone's hard (or manual) tap, never with another soft one (enforced
// server-side). This is what fixes "only one phone registered it": both
// phones feel the same impact, but a softer case, a heavier phone, or a
// 60Hz sample landing just off the peak can leave one of them under the
// full threshold.
const SOFT_RATIO = 0.33;

// --- Shape check -----------------------------------------------------------
// Fitted on labelled recordings from two real phones (Settings > Záznamník
// ťuknutí, 2026-09-19: 133 confirmed taps of three kinds vs. 141 spikes from
// picking up, putting down, waving, walking and holding both phones in one
// hand). What separates them is not how hard the spike is but what surrounds
// it: a bump is a lone, narrow impulse and the phone is still again right
// after, while handling is a broad swell of motion that keeps going.
//
//   post:     mean |impulse| from 120 to 350ms after the peak. Every real tap
//             was <= 0.91 m/s^2; nearly all other spikes were above it.
//   spreadMs: integral of |impulse| over the peak +-300ms, divided by the
//             peak: the event's effective width. Every real tap <= ~125ms
//             (7.6 samples at 60Hz); nearly all handling far wider.
//
// The limits leave ~50% headroom over the worst recorded tap, because two
// phones in cases held by one person are not every phone. What still gets
// through is the lift-off jolt of a pickup (upward, see VERTICAL_VETO in
// worker/bump.ts) and a phone hitting a table.
//
// Costs POST_WINDOW_END_MS of latency before a candidate leaves the phone;
// matching is on the clock-synced peak time, so it doesn't widen anything.
// It was 600ms at first, which people noticed as lag. Replaying the same
// recordings at 350ms keeps every real tap and lets one more lift-off
// through (+0.88 vertical, exactly the most vertical recorded tap, so no
// veto threshold could tell them apart anyway). Shortening the spread
// window as well let noticeably more through, so it stays at +-300ms.
const POST_WINDOW_START_MS = 120;
const POST_WINDOW_END_MS = 350;
const SPREAD_BEFORE_MS = 300;
const SPREAD_AFTER_MS = 300;
const MAX_POST_MOTION = 1.3;
// ...or this share of the peak, whichever is more. Real use differs from the
// first recordings in one way that mattered: people bump and immediately
// lift the phone to look at it. Recorded "as when paying" (40 taps), two
// clean, hard bumps (~25 m/s^2, 85ms wide) were dropped for 1.5-1.75 m/s^2
// of that follow-through. A hard, narrow impact earns proportionally more
// room after it; waving and walking, the handling this check exists for,
// run at 30-100% of their peak afterwards, and none of the 141 recorded
// handling spikes gets through at 8% that didn't already.
const POST_MOTION_PEAK_SHARE = 0.08;
const MAX_SPREAD_MS = 190;
// Enough history to cover the spread window's lead-in at evaluation time.
const HISTORY_MS = Math.max(POST_WINDOW_END_MS, SPREAD_AFTER_MS) + SPREAD_BEFORE_MS + 200;

export interface TapShape {
  post: number;
  spreadMs: number;
  peak: number;
}

// Pure, exported for tests. `samples` are (time, |impulse|) pairs covering
// at least peakTime - SPREAD_BEFORE_MS .. peakTime + POST_WINDOW_END_MS.
export function tapShape(samples: readonly { t: number; m: number }[], peakTime: number): TapShape {
  let peak = 0;
  let postSum = 0;
  let postN = 0;
  let area = 0;
  let prevT: number | null = null;
  for (const { t, m } of samples) {
    const rel = t - peakTime;
    if (Math.abs(rel) <= 40) peak = Math.max(peak, m);
    if (rel > POST_WINDOW_START_MS && rel <= POST_WINDOW_END_MS) {
      postSum += m;
      postN++;
    }
    if (rel >= -SPREAD_BEFORE_MS && rel <= SPREAD_AFTER_MS) {
      // Sample-rate independent: each sample weighs its own interval
      // (capped, so a gap in the stream doesn't count as one huge sample).
      const dt = prevT === null ? 16.7 : Math.min(Math.max(t - prevT, 1), 50);
      area += m * dt;
    }
    prevT = t;
  }
  return { post: postN ? postSum / postN : 0, spreadMs: peak > 0 ? area / peak : Infinity, peak };
}

export function isTapShaped(shape: TapShape): boolean {
  return shape.post <= Math.max(MAX_POST_MOTION, POST_MOTION_PEAK_SHARE * shape.peak) && shape.spreadMs <= MAX_SPREAD_MS;
}

// The single biggest realistic false-positive source once listening is
// passive (always-on while Home is showing, not just while deliberately
// "armed" for one attempt): the person's own finger tapping their own
// screen — pressing a button, scrolling — produces an accelerometer spike
// with the same short/sharp shape a real two-phone collision has; shape
// alone can't tell them apart. A genuine bump against another phone never
// coincides with touching your own screen at that exact instant, so
// suppressing any classified tap within this window of the phone's own
// touchscreen input removes that entire class without weakening the
// physical detection threshold itself at all. Confirmed live as a real,
// frequent trigger (2026-09-19: passive listening on the home screen
// false-triggered on ordinary use far more than deliberate "armed" testing
// ever had).
//
// Since silent-until-paired, a touch no longer drops the spike, it
// downgrades it to soft: a person holding the phone with a thumb landing
// on the screen at the moment of a real bump still pairs (with the other
// phone's hard tap), while a screen tap on its own can't pair with
// anything but a coincident hard tap elsewhere.
const TOUCH_SUPPRESS_MS = 500;

// See BumpSession.warmUp. Bounded so a burst of handling spikes can't turn
// into a burst of pings.
const WARM_UP_MIN_INTERVAL_MS = 3000;
// A static file, answered by Cloudflare's asset layer without running the
// Worker: same origin, so it wakes the same radio and connection the /tap
// request then uses, at no cost to the Worker's daily request budget. Every
// handling spike (walking, picking the phone up) fires one of these.
const WARM_UP_URL = "/bump-warm.txt";
// Any same-origin request this recent means the radio and the connection are
// still up. Short on purpose: mobile radios drop to idle after ~5-10 s, and a
// skipped ping that was needed costs the next tap a cold start.
const WARM_CONNECTION_MS = 5000;

// Warm-up pings sent and skipped (connection still warm), and spikes the
// shape check threw out as handling, since the last tap that reported them.
// Module level, like the clock sync: sessions restart after every outcome.
// Reported with the next tap, so the server's stats show how much motion the
// detector sees between taps and what it costs (worker/bump.ts's warmSent).
const warmUpCounts = { sent: 0, skipped: 0, dropped: 0 };

function takeWarmUpCounts(): { warmSent?: number; warmSkipped?: number; spikesDropped?: number } {
  const out = {
    warmSent: warmUpCounts.sent || undefined,
    warmSkipped: warmUpCounts.skipped || undefined,
    spikesDropped: warmUpCounts.dropped || undefined,
  };
  warmUpCounts.sent = 0;
  warmUpCounts.skipped = 0;
  warmUpCounts.dropped = 0;
  return out;
}

// --- Motion context ------------------------------------------------------
// Two physical situations produce a perfectly timed, tap-shaped spike on two
// phones at once without them touching: picking both up together, and
// tapping both on a table. Both were reported live. What gives them away:
//
// - Rest before the spike. A phone lying on a table is almost perfectly
//   still and flat right before it's picked up; phones about to bump are
//   held, with a constant small hand tremor. A spike out of rest is sent as
//   soft, and two soft candidates never pair (worker/bump.ts).
// - Direction. A pickup, or a tap on a table, jolts both phones upwards;
//   phones bumping each other are pushed sideways (side edges) or down and
//   away (top edges, "cheers"-style). Each candidate carries the signed
//   vertical share of its impulse and the server refuses a pair where both
//   were almost purely vertical, up or down (worker/bump.ts's verticalVeto).
//
// Both use gravity, taken from accelerationIncludingGravity minus
// acceleration, or a low-pass of the former where acceleration is missing
// (some Android devices). The sign of (impulse · gravity) comes out the same
// whatever axis convention a platform uses, as long as both vectors come
// from the same device, which they do.
const GRAVITY_ALPHA = 0.1;
const NOISE_ALPHA = 0.08;
// Mean |deviation| below which the phone counts as lying still (m/s^2).
// A first guess: hand tremor is typically a few tenths, a phone on a table
// a few hundredths. The server logs this for every candidate so it can be
// tuned from real phones (see worker/bump.ts's logBumpEvent).
const REST_NOISE = 0.12;
// |gravity.z| / |gravity| above which the phone counts as lying flat.
const FLAT_RATIO = 0.9;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const vlen = (v: Vec3): number => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

// Signed share of `impulse` along `gravity`, -1..1. `gravity` here is the
// at-rest reading of accelerationIncludingGravity, which points physically
// *up*, so a positive share means an upward jolt. Pure, exported for tests.
export function verticalShare(impulse: Vec3, gravity: Vec3): number | undefined {
  const li = vlen(impulse);
  const lg = vlen(gravity);
  if (li < 1e-6 || lg < 1e-6) return undefined;
  const dot = (impulse.x * gravity.x + impulse.y * gravity.y + impulse.z * gravity.z) / (li * lg);
  return Math.max(-1, Math.min(1, dot));
}

export interface TapFeatures extends Partial<Omit<TapShape, "peak">> {
  // Signed vertical share of the impulse at its peak (see verticalShare).
  vertical?: number;
  // The phone was lying still and flat right before this spike.
  rested: boolean;
  // Mean hand/sensor noise just before the spike, for tuning REST_NOISE.
  noiseBefore?: number;
}

// When a motion sample was actually taken, on the performance.now()
// timeline. event.timeStamp is that in every current engine, and unlike
// reading performance.now() inside the handler it isn't pushed later by a
// busy main thread (a React render) delaying dispatch. Falls back to "now"
// for an engine that reports 0 or an epoch-based value.
export function motionSampleTime(eventTimeStamp: number, nowPerf: number): number {
  return Number.isFinite(eventTimeStamp) && eventTimeStamp > 0 && eventTimeStamp <= nowPerf && nowPerf - eventTimeStamp < 1000
    ? eventTimeStamp
    : nowPerf;
}

export class TapDetector {
  private baseline: number | null = null;
  private spike: {
    startTime: number;
    peakDelta: number;
    peakTime: number;
    peakImpulse: Vec3 | null;
    peakGravity: Vec3 | null;
    noiseBefore: number | null;
    flatBefore: boolean;
  } | null = null;
  private gravityLP: Vec3 | null = null;
  private noise: number | null = null;
  // Recent |impulse| samples for the shape check, and classified spikes
  // waiting for their post-peak window to fill.
  private history: { t: number; m: number }[] = [];
  private awaiting: { peakMagnitude: number; peakTime: number; strength: TapStrength; features: TapFeatures }[] = [];
  // Not 0: performance.now() starts near 0 at page load. Separate clocks so
  // a soft spike (the hand's approach) can't debounce away the real, hard
  // impact that follows it a few hundred ms later.
  private lastHardAt = -Infinity;
  private lastAnyAt = -Infinity;
  private readonly threshold: number;
  private readonly onTap: (peakMagnitude: number, peakTimePerf: number, strength: TapStrength, features: TapFeatures) => void;
  private readonly isSuppressed: () => boolean;
  private readonly onSpike: () => void;
  private readonly onDropped: () => void;

  // onSpike fires as soon as a spike is classified, before the shape check
  // has decided: BumpSession uses it to wake the network early. onDropped
  // fires for each of those the shape check then rejects.
  constructor(
    threshold: number,
    onTap: (peakMagnitude: number, peakTimePerf: number, strength: TapStrength, features: TapFeatures) => void,
    isSuppressed: () => boolean = () => false,
    onSpike: () => void = () => {},
    onDropped: () => void = () => {},
  ) {
    this.threshold = threshold;
    this.onTap = onTap;
    this.isSuppressed = isSuppressed;
    this.onSpike = onSpike;
    this.onDropped = onDropped;
  }

  handle = (event: DeviceMotionEvent): void => {
    const a = event.acceleration && event.acceleration.x !== null ? event.acceleration : event.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
    if (this.baseline === null) this.baseline = mag;
    const delta = mag - this.baseline;
    const armLevel = this.threshold * ARM_RATIO;
    const now = motionSampleTime(event.timeStamp, performance.now());
    const { gravity, impulse } = this.motionVectors(event);
    this.history.push({ t: now, m: impulse ? vlen(impulse) : Math.abs(delta) });
    while (this.history.length && now - this.history[0].t > HISTORY_MS) this.history.shift();
    this.releaseAwaiting(now);

    if (this.spike === null && Math.abs(delta) < armLevel) {
      this.baseline = this.baseline * (1 - BASELINE_ALPHA) + mag * BASELINE_ALPHA;
      this.noise = this.noise === null ? Math.abs(delta) : this.noise * (1 - NOISE_ALPHA) + Math.abs(delta) * NOISE_ALPHA;
    }

    if (this.spike === null) {
      if (delta >= armLevel) {
        this.spike = {
          startTime: now,
          peakDelta: delta,
          peakTime: now,
          peakImpulse: impulse,
          peakGravity: gravity,
          noiseBefore: this.noise,
          flatBefore: gravity !== null && Math.abs(gravity.z) / Math.max(vlen(gravity), 1e-6) > FLAT_RATIO,
        };
      }
      return;
    }

    if (delta > this.spike.peakDelta) {
      this.spike.peakDelta = delta;
      this.spike.peakTime = now;
      this.spike.peakImpulse = impulse;
      this.spike.peakGravity = gravity ?? this.spike.peakGravity;
    }
    const sinceStart = now - this.spike.startTime;
    const sincePeak = now - this.spike.peakTime;
    if (delta < armLevel) {
      const fastEnough = sincePeak <= DECAY_WINDOW_MS && sinceStart <= MAX_EVENT_MS;
      if (fastEnough && this.spike.peakDelta >= this.threshold * SOFT_RATIO) {
        const rested = this.spike.noiseBefore !== null && this.spike.noiseBefore < REST_NOISE && this.spike.flatBefore;
        const features: TapFeatures = {
          rested,
          noiseBefore: this.spike.noiseBefore ?? undefined,
          vertical:
            this.spike.peakImpulse && this.spike.peakGravity
              ? verticalShare(this.spike.peakImpulse, this.spike.peakGravity)
              : undefined,
        };
        const strength: TapStrength =
          this.spike.peakDelta >= this.threshold && !this.isSuppressed() && !rested ? "hard" : "soft";
        // The peak, not this decay sample, is the moment of impact: both
        // phones peak at the same physical instant, but how long each
        // takes to decay back under armLevel differs per device and
        // sample rate (up to DECAY_WINDOW_MS).
        this.awaiting.push({
          peakMagnitude: this.baseline + this.spike.peakDelta,
          peakTime: this.spike.peakTime,
          strength,
          features,
        });
        this.onSpike();
      }
      this.spike = null;
    } else if (sinceStart > MAX_EVENT_MS) {
      this.spike = null; // sustained motion (a lift, a walk) — not a discrete tap
    }
  };

  // Decides each classified spike once its post-peak window has passed: the
  // shape check first, then the debounce, so a rejected swell of handling
  // can't debounce away a real tap right after it.
  private releaseAwaiting(now: number): void {
    while (this.awaiting.length && now - this.awaiting[0].peakTime >= POST_WINDOW_END_MS) {
      const c = this.awaiting.shift()!;
      const shape = tapShape(this.history, c.peakTime);
      if (!isTapShaped(shape)) {
        this.onDropped();
        continue;
      }
      const lastRelevant = c.strength === "hard" ? this.lastHardAt : this.lastAnyAt;
      if (c.peakTime - lastRelevant <= TAP_DEBOUNCE_MS) continue;
      this.lastAnyAt = c.peakTime;
      if (c.strength === "hard") this.lastHardAt = c.peakTime;
      this.onTap(c.peakMagnitude, c.peakTime, c.strength, { ...c.features, post: shape.post, spreadMs: shape.spreadMs });
    }
  }

  // Gravity and the gravity-free impulse for one sample, or nulls when the
  // device doesn't give enough to tell them apart.
  private motionVectors(event: DeviceMotionEvent): { gravity: Vec3 | null; impulse: Vec3 | null } {
    const toVec = (a: DeviceMotionEventAcceleration | null): Vec3 | null =>
      a && a.x !== null && a.y !== null && a.z !== null ? { x: a.x, y: a.y, z: a.z } : null;
    const incl = toVec(event.accelerationIncludingGravity);
    const lin = toVec(event.acceleration);
    if (incl && lin) return { gravity: { x: incl.x - lin.x, y: incl.y - lin.y, z: incl.z - lin.z }, impulse: lin };
    if (!incl) return { gravity: null, impulse: lin };
    // No separate linear acceleration: estimate gravity as a slow low-pass
    // of the total, frozen while a spike is in progress so the spike itself
    // doesn't leak into it.
    if (this.gravityLP === null) this.gravityLP = { ...incl };
    else if (this.spike === null) {
      const g = this.gravityLP;
      this.gravityLP = {
        x: g.x + (incl.x - g.x) * GRAVITY_ALPHA,
        y: g.y + (incl.y - g.y) * GRAVITY_ALPHA,
        z: g.z + (incl.z - g.z) * GRAVITY_ALPHA,
      };
    }
    const g = this.gravityLP;
    return { gravity: { ...g }, impulse: { x: incl.x - g.x, y: incl.y - g.y, z: incl.z - g.z } };
  }
}

// --- Pairing orchestration ----------------------------------------------
export class BumpSession {
  private readonly myAddress: string;
  private readonly onOutcome: (outcome: BumpOutcome) => void;
  private detector: TapDetector | null = null;
  private cancelled = false;
  private myId: string | null = null;
  private lastTouchAt = 0;
  private readonly onTouch = (): void => {
    this.lastTouchAt = performance.now();
  };
  // Home can sit armed in a backgrounded tab for hours. Coming back to the
  // foreground is the moment a tap is most likely and the moment the cached
  // offset is most likely stale, and the sync costs nothing when it is still
  // fresh (ensureClockSync no-ops inside CLOCK_SYNC_MAX_AGE_MS). Without it
  // the first tap after a long sleep waits on a cold sync, and past
  // CLOCK_SYNC_TAP_WAIT_MS goes out with no time at all, which the server
  // cannot match.
  // `document` is guarded the same way bark.ts guards it: this module is
  // unit-tested in a plain Node realm that has a stand-in `window` but no
  // document at all.
  private readonly onVisible = (): void => {
    if (typeof document === "undefined" || document.visibilityState === "visible") void ensureClockSync();
  };
  // After pairing. The partner's address and commitment are fixed by the
  // first paired answer; any later answer naming a different one fails the
  // pairing (see applyStatus), so what the emoji were verified against is
  // exactly what gets paid.
  private peerAddress = "";
  private peerCommit = "";
  private myNonce = "";
  private pairInfo: { deltaMs: number; partnerCity: string | null } = { deltaMs: 0, partnerCity: null };
  // Paired through a faint (soft) tap: see BumpOutcome's `quiet`.
  private quietPair = false;
  // The partner's nonce checked against its commitment and the emoji
  // derived; only then is anything shown, and only then may a direction be
  // picked.
  private verified = false;
  private verifying = false;
  // "paired" was emitted at least once (the person has seen this pairing).
  private shown = false;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  // performance.now() from which the server accepts a direction (see
  // settling in BumpOutcome); Infinity until the server said.
  private settleDeadline = Infinity;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private emittedSettling: boolean | null = null;
  // performance.now() of the first time the emoji question was emitted, and
  // the timer that lets a held peer-chosen "send" role through (see
  // BUMP_MIN_QUESTION_MS).
  private shownAt = -Infinity;
  private roleTimer: ReturnType<typeof setTimeout> | null = null;
  private choosing = false;
  // Which side this phone is on (once either phone picked), the emoji both
  // show, and the long-poll loop following the shared flow.
  private role: BumpRole | null = null;
  private emoji = "";
  private lastStatus: StatusResponse | null = null;
  private lastEmitted = "";
  private readonly followCtrl = new AbortController();
  private clockResyncTimer: ReturnType<typeof setInterval> | null = null;
  // Silent-until-paired bookkeeping (see sendCandidate). `settled` flips
  // once this session is committed to one result (paired, or a hard tap
  // that came back ambiguous); from then on it ignores every other
  // candidate's answer.
  private settled = false;
  private readonly inFlight = new Set<AbortController>();
  private lastSoftSentAt = -Infinity;
  private backoffUntil = -Infinity;
  private rateLimitStrikes = 0;

  constructor(myAddress: string, onOutcome: (outcome: BumpOutcome) => void) {
    this.myAddress = myAddress;
    this.onOutcome = onOutcome;
  }

  async start(): Promise<void> {
    this.cancelled = false;
    this.onOutcome({ kind: "armed" });
    // Listening starts immediately; the clock sync runs alongside it (see
    // ensureClockSync) instead of gating it, and a tap that lands before it
    // finishes waits for it in sendCandidate.
    const threshold = loadBumpThreshold();
    this.detector = new TapDetector(
      threshold,
      (peakMagnitude, peakTimePerf, strength, features) =>
        this.onCandidate(peakMagnitude, peakTimePerf, strength, features),
      () => performance.now() - this.lastTouchAt < TOUCH_SUPPRESS_MS,
      () => this.warmUp(),
      () => warmUpCounts.dropped++,
    );
    window.addEventListener("devicemotion", this.detector.handle);
    // See TOUCH_SUPPRESS_MS's own comment above.
    window.addEventListener("touchstart", this.onTouch, { passive: true });
    window.addEventListener("pointerdown", this.onTouch, { passive: true });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    // Home can sit armed for hours; keep the offset fresh so a tap never
    // has to wait on a sync. ensureClockSync no-ops while it's still fresh.
    // Only while visible: a hidden page can't be bumped, and onVisible
    // resyncs on the way back anyway.
    this.clockResyncTimer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void ensureClockSync();
    }, CLOCK_SYNC_MAX_AGE_MS);
    watchSameOriginTraffic();
    await ensureClockSync();
  }

  // A phone listening passively on Home has usually been idle for a while:
  // its radio is asleep and the connection may be gone, and waking both can
  // cost far more than the request itself. The shape check holds a candidate
  // back for POST_WINDOW_END_MS anyway, so a cheap ping fired the moment a
  // spike is classified wakes everything in parallel with that wait, and the
  // real /tap request then goes out on a warm connection.
  private lastWarmUpAt = -Infinity;
  private warmUp(): void {
    const now = performance.now();
    if (now - this.lastWarmUpAt < WARM_UP_MIN_INTERVAL_MS || now < this.backoffUntil) return;
    this.lastWarmUpAt = now;
    if (now - lastNetworkAt < WARM_CONNECTION_MS) {
      warmUpCounts.skipped++;
      return;
    }
    warmUpCounts.sent++;
    lastNetworkAt = now;
    void fetch(WARM_UP_URL, { cache: "no-store" }).catch(() => {});
  }

  private clearClockResync(): void {
    if (this.clockResyncTimer !== null) clearInterval(this.clockResyncTimer);
    this.clockResyncTimer = null;
  }

  private stopListening(): void {
    this.clearClockResync();
    if (this.detector) window.removeEventListener("devicemotion", this.detector.handle);
    this.detector = null;
    window.removeEventListener("touchstart", this.onTouch);
    window.removeEventListener("pointerdown", this.onTouch);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
  }

  private abortInFlight(): void {
    for (const ctrl of this.inFlight) ctrl.abort();
    this.inFlight.clear();
  }

  private clearPairTimers(): void {
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.roleTimer !== null) clearTimeout(this.roleTimer);
    this.revealTimer = null;
    this.settleTimer = null;
    this.roleTimer = null;
  }

  stop(): void {
    this.cancelled = true;
    this.stopListening();
    this.abortInFlight();
    this.clearPairTimers();
    this.followCtrl.abort();
  }

  private isDone(): boolean {
    return this.cancelled || this.settled;
  }

  // "Platím" / "Přijímám" on the paired screen. Picking also stands in for
  // "the emoji match" — there's no separate confirm step any more. The
  // server keeps the first pick for a pair, so it's safe even if both
  // people tap at once; the other phone follows via the long-poll. Only
  // once verified: before that there are no emoji to have compared. The
  // UI keeps the buttons disabled while settling; should the server still
  // say "not yet" (its clock, a slow first answer), this waits it out.
  async choose(choice: BumpRole): Promise<void> {
    if (!this.myId || this.role || this.cancelled || !this.verified || this.choosing) return;
    this.choosing = true;
    try {
      for (let attempt = 0; attempt < CHOOSE_MAX_ATTEMPTS; attempt++) {
        const result = await postChoice(this.myId, choice);
        if (this.cancelled || this.role) return;
        if (result.state === "settling" || result.state === "unverified") {
          await sleep(Math.min(Math.max(result.settlesInMs ?? 300, 100), 2000) + 50);
          if (this.cancelled || this.role) return;
          continue;
        }
        if (result.state === "cancelled") {
          this.finish({ kind: "cancelled" });
          return;
        }
        if (result.state === "ambiguous" || result.state === "expired") {
          this.finish(result.state === "expired" ? { kind: "expired", phase: "choosing" } : { kind: "ambiguous" });
          return;
        }
        if (result.role) {
          this.role = result.role;
          this.emitFlow({ stage: "entering" });
        }
        return;
      }
    } catch (e) {
      if (!this.cancelled) this.finish({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.choosing = false;
    }
  }

  // Sender, right before the wallet call: tells the receiver the amount.
  // Must succeed before any money moves — a refusal means the receiver
  // cancelled in the meantime (or the pair expired), and paying anyway
  // would send money to someone who already walked away. Returns whether
  // it's OK to pay.
  async announceSending(amountSats: number): Promise<boolean> {
    if (!this.myId || this.role !== "send" || this.cancelled) return false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { ok, status } = await postProgress(this.myId, "sending", amountSats);
        this.applyStatus(status);
        return ok;
      } catch (e) {
        lastError = e;
        if (e instanceof BumpRateLimitError) break;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // Sender, after the wallet call: "sent" on success, back to "entering" on
  // an outright failure (so the receiver shows "zadává částku" again
  // instead of "přichází" forever). Best-effort: the payment itself already
  // happened or didn't; this only updates the other screen.
  reportSendResult(ok: boolean): void {
    if (!this.myId || this.role !== "send" || this.cancelled) return;
    void postProgress(this.myId, ok ? "sent" : "entering")
      .then(({ status }) => this.applyStatus(status))
      .catch(() => {});
  }

  // Receiver, once the payment shows up in its own history: tells the sender
  // it arrived (the sender's "Doručeno ✅"). Best-effort, retried a couple
  // of times since the sender is waiting on exactly this.
  async confirmReceived(): Promise<void> {
    if (!this.myId || this.role !== "receive" || this.cancelled) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { status } = await postProgress(this.myId, "received");
        this.applyStatus(status);
        return;
      } catch {
        await sleep(600 * (attempt + 1));
      }
    }
  }

  // Sender: "sending" was accepted, but this screen no longer belongs to that
  // pairing (it was closed or replaced while the announcement was in flight),
  // so the payment will not be made after all. Puts the receiver back on
  // "zadává částku" instead of leaving it on "Přichází" for money that never
  // comes. Unlike reportSendResult this deliberately works on a stopped
  // session: stopping is exactly the situation it exists for.
  abandonSending(): void {
    if (!this.myId || this.role !== "send") return;
    void postProgress(this.myId, "entering").catch(() => {});
  }

  // Stopped, or ended on a terminal outcome: nothing this session reports
  // any more reaches the screen, so nothing may act on its behalf either.
  get closed(): boolean {
    return this.cancelled;
  }

  // Either side backing out: tells the other phone (best-effort) so it
  // doesn't sit on "zadává částku" forever, then stops this session.
  cancel(): void {
    if (this.myId && !this.cancelled) void postProgress(this.myId, "cancelled").catch(() => {});
    this.stop();
  }

  // Every tap the detector sees, hard or soft, goes to the server
  // silently: no overlay, no haptic, and listening never pauses. A single
  // phone can't tell a bump from being put on a table; two phones feeling
  // the same impact within a couple hundred ms can, so nothing is shown
  // until the server pairs a candidate. This replaced "react to the first
  // tap": that showed every false positive as an overlay and then left the
  // phone deaf for the whole pairing wait plus the restart delay (~11s),
  // which is exactly when the *real* tap tended to come and go unnoticed.
  //
  // Budget: each candidate is one held-open request (see postTap), so
  // soft ones are capped to SOFT_MIN_INTERVAL_MS apart and the total in
  // flight to MAX_IN_FLIGHT; a 429 backs off for rateLimitBackoffMs(), which
  // doubles per consecutive 429 rather than muting the phone for a flat 30s.
  private onCandidate(
    peakMagnitude: number,
    tapTimePerf: number,
    strength: TapStrength,
    features: TapFeatures = { rested: false },
  ): void {
    if (this.isDone()) return;
    const now = performance.now();
    if (now < this.backoffUntil || this.inFlight.size >= MAX_IN_FLIGHT) return;
    if (strength === "soft") {
      if (now - this.lastSoftSentAt < SOFT_MIN_INTERVAL_MS) return;
      this.lastSoftSentAt = now;
    }
    void this.sendCandidate(strength, peakMagnitude, tapTimePerf, features);
  }

  private async sendCandidate(
    kind: TapStrength,
    peakMagnitude: number,
    tapTimePerf: number,
    features: TapFeatures,
  ): Promise<void> {
    // Captured before anything async: this is the physical moment the
    // server matches on, however long the request below takes to leave.
    const tapWallMs = perfToWallMs(tapTimePerf, performance.now(), Date.now());
    const ctrl = new AbortController();
    this.inFlight.add(ctrl);
    // Backstop only: the server answers on its own once no partner can
    // arrive any more (worker/bump.ts's PENDING_TTL_MS, ~1.9s after the
    // tap); this has to outlast that plus the request's own latency.
    const deadline = setTimeout(() => ctrl.abort(), CANDIDATE_DEADLINE_MS);
    try {
      const sync = await clockSyncForTap();
      if (this.isDone()) return;
      // Without a clock sync there is no tap time the server could match
      // on, and it refuses such a tap. Not worth a request.
      if (!sync) return;
      // A fresh nonce per candidate: it is revealed only for the one
      // candidate that pairs, and never reused for another pairing.
      const nonce = newBumpNonce();
      const commit = await bumpCommitment(this.myAddress, nonce);
      if (this.isDone()) return;
      const result = await postTap(
        {
          kind,
          clientTapTime: Math.round(tapWallMs + sync.offsetMs),
          clockUncertaintyMs: sync.uncertaintyMs,
          accelPeak: peakMagnitude,
          address: this.myAddress,
          commit,
          vertical: features.vertical === undefined ? undefined : Math.round(features.vertical * 100) / 100,
          rested: features.rested,
          noiseBefore: features.noiseBefore === undefined ? undefined : Math.round(features.noiseBefore * 1000) / 1000,
          post: features.post === undefined ? undefined : Math.round(features.post * 1000) / 1000,
          spreadMs: features.spreadMs === undefined ? undefined : Math.round(features.spreadMs * 10) / 10,
          ...takeWarmUpCounts(),
        },
        ctrl.signal,
      );
      if (this.isDone()) return;
      this.rateLimitStrikes = 0;
      if (result.state === "paired" && result.id) {
        this.onPaired(result.id, result, kind === "soft", nonce);
        return;
      }
      // The tap arrived, but too late to be matched against anything
      // (worker/bump.ts's resolveTapTime). This used to be indistinguishable
      // from "nobody else tapped", so on a slow connection every tap vanished
      // without a word and the phone simply looked broken. Only a hard tap
      // says so: a faint one is too weak a signal to interrupt anyone with,
      // exactly as with ambiguous below.
      //
      // Only when this is the last candidate on the wire (inFlight holds this
      // one's own controller, so 1 means "no siblings"). The ambiguous branch
      // below can settle and abort regardless, because ambiguity poisons
      // every tap near it; a late tap was never stored server-side at all, so
      // a sibling may still be perfectly matchable - and giving up here would
      // abort a held request the server had already paired, leaving the other
      // phone alone on a verified emoji screen. Staying quiet costs nothing:
      // whichever candidate is last to come back reports it.
      if (result.state === "expired" && result.reason === "late" && kind === "hard" && this.inFlight.size <= 1) {
        this.settled = true;
        this.stopListening();
        this.abortInFlight();
        this.onOutcome({ kind: "slow" });
        return;
      }
      // A soft candidate is too weak a signal to bother anyone with; a hard
      // one that collided with a third tap is worth a retap hint.
      if (result.state === "ambiguous" && kind === "hard") {
        this.settled = true;
        this.stopListening();
        this.abortInFlight();
        this.onOutcome({ kind: "ambiguous" });
      }
    } catch (e) {
      if (this.isDone()) return;
      if (e instanceof BumpRateLimitError) {
        this.rateLimitStrikes++;
        this.backoffUntil = performance.now() + rateLimitBackoffMs(this.rateLimitStrikes);
      }
    } finally {
      clearTimeout(deadline);
      this.inFlight.delete(ctrl);
    }
  }

  // Paired, not yet verified: nothing is shown until the partner's nonce
  // checks out against its commitment (see verifyPeer).
  private onPaired(id: string, data: StatusResponse, quiet: boolean, nonce: string): void {
    this.settled = true;
    this.myId = id;
    this.myNonce = nonce;
    this.quietPair = quiet;
    // Committed to this pair: stop listening and drop the other candidates
    // (the server has already discarded their pending records).
    this.stopListening();
    this.abortInFlight();
    if (!data.peerAddress || typeof data.peerCommit !== "string" || !COMMIT_RE.test(data.peerCommit)) {
      this.failPairing({ kind: "error", message: "Ověření spojení selhalo. Ťukněte telefony o sebe znovu." });
      return;
    }
    this.peerAddress = data.peerAddress;
    this.peerCommit = data.peerCommit;
    this.pairInfo = { deltaMs: data.deltaMs ?? 0, partnerCity: data.partnerCf?.city ?? null };
    if (data.settlesInMs !== undefined) this.noteSettle(data.settlesInMs);
    this.revealTimer = setTimeout(
      () => this.failPairing({ kind: "expired", phase: "pairing" }),
      REVEAL_TIMEOUT_MS,
    );
    void this.follow(id);
    void this.reveal(id, nonce);
  }

  // Our own nonce, now that we hold the partner's commitment. The answer
  // may already carry the partner's nonce; otherwise the follow loop's
  // long-poll wakes up once it arrives.
  private async reveal(id: string, nonce: string): Promise<void> {
    for (let attempt = 0; attempt < 3 && !this.cancelled; attempt++) {
      try {
        this.applyStatus(await postReveal(id, nonce));
        return;
      } catch {
        await sleep(400 * (attempt + 1));
      }
    }
    // Never got through: the reveal timeout ends the pairing.
  }

  private async verifyPeer(peerNonce: string): Promise<void> {
    if (this.verified || this.verifying || this.cancelled) return;
    this.verifying = true;
    const mismatch = (): void =>
      this.failPairing({ kind: "error", message: "Ověření spojení selhalo. Ťukněte telefony o sebe znovu." });
    if (!BUMP_NONCE_RE.test(peerNonce) || (await bumpCommitment(this.peerAddress, peerNonce)) !== this.peerCommit) {
      if (!this.cancelled) mismatch();
      return;
    }
    const emoji = await bumpSasEmoji(
      { address: this.myAddress, nonce: this.myNonce },
      { address: this.peerAddress, nonce: peerNonce },
    );
    if (this.cancelled) return;
    this.emoji = emoji;
    this.verified = true;
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    // The first feedback this phone gives at all for a sensor tap: it only
    // ever buzzes for a tap another phone felt too, and never for a faint
    // one (see `quiet`), which may not have been a tap at all.
    if (!this.quietPair) hapticSuccess();
    this.emitPaired();
    // The other phone may have picked a direction while this one was still
    // verifying.
    const role = this.lastStatus?.role;
    if (role) this.adoptPeerRole(role);
  }

  // The direction the *other* phone picked. Becoming the payer waits until the
  // emoji question has been on screen for BUMP_MIN_QUESTION_MS.
  private adoptPeerRole(role: BumpRole): void {
    if (this.role || this.cancelled) return;
    if (role === "send") {
      const wait = this.shownAt + BUMP_MIN_QUESTION_MS - performance.now();
      if (wait > 0) {
        if (this.roleTimer === null) {
          this.roleTimer = setTimeout(() => {
            this.roleTimer = null;
            const held = this.lastStatus?.role;
            if (held) this.adoptPeerRole(held);
          }, wait + 20);
        }
        return;
      }
    }
    this.role = role;
    this.emitFlow();
  }

  // Ends a pairing that was never (or not yet) a verified, visible one: the
  // other phone is told (best-effort), and a faint pairing nobody saw ends
  // silently.
  private failPairing(outcome: Extract<BumpOutcome, { kind: "expired" | "error" }>): void {
    if (this.cancelled) return;
    if (this.myId) void postProgress(this.myId, "cancelled").catch(() => {});
    this.finish({ ...outcome, quiet: this.silentNotice() });
  }

  // A notice about a pairing this phone never showed, reached through a
  // faint tap, is dropped by the UI (see BumpOutcome's quiet).
  private silentNotice(): boolean {
    return !this.shown && this.quietPair;
  }

  private noteSettle(settlesInMs: number): void {
    // The answer is at least a network delay old, so this deadline is never
    // earlier than the server's own; the earliest estimate is the best one.
    this.settleDeadline = Math.min(this.settleDeadline, performance.now() + Math.max(0, settlesInMs));
    if (this.shown && !this.role) this.emitPaired();
  }

  private emitPaired(): void {
    if (this.cancelled || !this.verified || this.role) return;
    const remaining = this.settleDeadline - performance.now();
    const settling = remaining > 0;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = settling && Number.isFinite(remaining) ? setTimeout(() => this.emitPaired(), remaining + 20) : null;
    // Re-emitted only when "settling" actually flips: every emit is a
    // fresh "paired" to the UI.
    if (this.shown && this.emittedSettling === settling) return;
    if (!this.shown) this.shownAt = performance.now();
    this.shown = true;
    this.emittedSettling = settling;
    this.onOutcome({
      kind: "paired",
      quiet: this.quietPair,
      deltaMs: this.pairInfo.deltaMs,
      partnerCity: this.pairInfo.partnerCity,
      emoji: this.emoji,
      peerAddress: this.peerAddress,
      settling,
    });
  }

  // Terminal outcome for this session: nothing after it may overwrite it.
  private finish(outcome: BumpOutcome): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.clearPairTimers();
    this.followCtrl.abort();
    this.onOutcome(outcome);
  }

  private emitFlow(overrides: Partial<NonNullable<StatusResponse["flow"]>> = {}): void {
    if (!this.role || this.cancelled) return;
    const flow = { stage: "entering" as FlowStage, ...this.lastStatus?.flow, ...overrides };
    const peerLost = (this.lastStatus?.peerSeenAgoMs ?? 0) > PEER_LOST_MS;
    const view: FlowView = { stage: flow.stage, amountSats: flow.amountSats, peerLost };
    const outcome: BumpOutcome =
      this.role === "send"
        ? { kind: "sending", emoji: this.emoji, peerAddress: this.peerAddress, flow: view }
        : { kind: "receiving", emoji: this.emoji, flow: view };
    // Long-polls return every few seconds with nothing new; only hand the
    // UI an actual change.
    const key = JSON.stringify(outcome);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.onOutcome(outcome);
  }

  private applyStatus(data: StatusResponse): void {
    if (this.cancelled) return;
    const quiet = this.silentNotice();
    if (data.state === "ambiguous") {
      // Only possible before anyone picked a direction (see worker/bump.ts).
      this.finish({ kind: "ambiguous", quiet });
      return;
    }
    if (data.state !== "paired") {
      this.finish({ kind: "expired", phase: this.role ? "flow" : this.shown ? "choosing" : "pairing", quiet });
      return;
    }
    // The partner is whoever the first paired answer named. A later answer
    // naming anyone else means the relay changed its story: fail closed.
    if (
      (data.peerAddress !== undefined && data.peerAddress !== this.peerAddress) ||
      (data.peerCommit !== undefined && data.peerCommit !== this.peerCommit)
    ) {
      this.failPairing({ kind: "error", message: "Ověření spojení selhalo. Ťukněte telefony o sebe znovu." });
      return;
    }
    // Keep the newest flow version only: a slow response to an older
    // request must not roll the screen back.
    if (this.lastStatus?.v !== undefined && data.v !== undefined && data.v < this.lastStatus.v) return;
    this.lastStatus = data;
    if (data.flow?.stage === "cancelled") {
      if (data.flow.cancelledBy === "peer") this.finish({ kind: "cancelled", quiet });
      return;
    }
    if (!this.verified) {
      if (data.peerNonce !== undefined) void this.verifyPeer(data.peerNonce);
      return;
    }
    if (data.settlesInMs !== undefined && !this.role) this.noteSettle(data.settlesInMs);
    if (!this.role && data.role) {
      this.adoptPeerRole(data.role);
      return;
    }
    this.emitFlow();
  }

  // One long-poll loop per pairing, for its whole life: picks up the
  // partner's nonce, the other phone's choice, its amount, "sent",
  // "received", a cancel, a late tap making the pair ambiguous, and whether
  // the other phone is still there.
  private async follow(id: string): Promise<void> {
    let failures = 0;
    while (!this.cancelled) {
      let data: StatusResponse;
      try {
        data = await pollStatus(id, this.lastStatus?.v ?? -1, this.followCtrl.signal);
        failures = 0;
      } catch (e) {
        if (this.cancelled) return;
        failures++;
        if (failures >= FOLLOW_MAX_FAILURES) {
          this.failPairing({ kind: "error", message: "Spojení s druhým telefonem se přerušilo." });
          return;
        }
        await sleep(e instanceof BumpRateLimitError ? 5000 : Math.min(400 * 2 ** failures, 4000));
        continue;
      }
      this.applyStatus(data);
      if (this.lastStatus?.flow?.stage === "received") return;
      // An older server without long-poll support answers at once; don't spin.
      if (data.v === undefined) await sleep(700);
    }
  }
}

// --- Receiver: spotting the payment ---------------------------------------
// The slice of the SDK's Movement this reads (structural, so tests don't
// need the SDK).
export interface ArrivalMovement {
  id: number;
  status: string;
  subsystemKind: string;
  effectiveBalanceSats: number;
}

// Moves that raise the balance without being anyone's payment to us. A
// finished VTXO refresh is the one that matters: funds locked in a round go
// back to spendable when it completes, which used to read as the bump
// payment arriving (spendable went up by enough) and told the sender
// "Doručeno" for money that may never have been sent.
const NON_PAYMENT_KINDS: ReadonlySet<string> = new Set([
  "round",
  "refresh",
  "board",
  "offboard",
  "exit",
  "send",
  "send_onchain",
  "lightning_send",
]);

// A received arkoor payment arrives whole, but accept a hair less in case a
// fee ever lands on the receiving side; never more (a larger, unrelated
// payment is not this one).
const ARRIVAL_TOLERANCE = 0.02;

// Highest movement id in `movements`, or -1 for an empty history. The
// baseline new movements are compared against. Pure, exported for tests.
export function maxMovementId(movements: readonly { id: number }[]): number {
  let max = -1;
  for (const m of movements) if (m.id > max) max = m.id;
  return max;
}

// The movement that is this bump's payment: newer than the baseline taken
// before the sender could have paid, incoming, not a refresh or other
// internal move, and for the amount the sender announced. Not assumed
// sorted (the SDK's history order isn't guaranteed); the oldest match wins.
// Pure, exported for tests.
export function findBumpArrival<M extends ArrivalMovement>(
  movements: readonly M[],
  baselineMaxId: number,
  expectedSats: number | undefined,
): M | null {
  let found: M | null = null;
  for (const m of movements) {
    if (m.id <= baselineMaxId || m.status === "failed" || NON_PAYMENT_KINDS.has(m.subsystemKind)) continue;
    const got = m.effectiveBalanceSats;
    if (!(got > 0)) continue;
    if (expectedSats !== undefined && (got > expectedSats || got < Math.floor(expectedSats * (1 - ARRIVAL_TOLERANCE)))) {
      continue;
    }
    if (!found || m.id < found.id) found = m;
  }
  return found;
}

// How long the other phone may go unheard (no request, no open long-poll)
// before this one says it's gone. Long-polls return every ~8s, so this is
// comfortably more than one missed cycle.
const PEER_LOST_MS = 15_000;
const FOLLOW_MAX_FAILURES = 6;

// How long a pairing may take to verify (both nonces revealed, the
// partner's checked) before it's given up on: a couple of round trips on a
// live connection, so this only ever fires on a dead one. Longer than one
// long-poll cycle (STATUS_WAIT_MAX_MS, 8s) on purpose, so a single missed
// wake-up can never on its own end a pairing.
const REVEAL_TIMEOUT_MS = 15_000;
// choose() retries while the server still says "not yet".
const CHOOSE_MAX_ATTEMPTS = 4;

// How long the emoji question stays on screen, at the very least, before the
// *other* phone's choice may turn this one into the payer. The direction is
// decided by whoever picks first, so an honest receiver's "Přijímám" (or an
// automated peer, which picks the moment the server allows it, ~1.9s after
// the tap) used to swap this screen for the amount entry before the person
// could have compared anything. Only the payer's side is held: being made the
// receiver risks nothing. A person who presses a button here is not held
// either, that press is the answer to the question.
export const BUMP_MIN_QUESTION_MS = 3000;

const SOFT_MIN_INTERVAL_MS = 1500;
const MAX_IN_FLIGHT = 4;
const CANDIDATE_DEADLINE_MS = 9000;

// A 429 used to mute this phone for a flat 30s. That is the right answer for
// something hammering the endpoint and the wrong one for a person who tripped
// the limit once: they tap, nothing happens, and nothing keeps happening for
// half a minute (seen live on 2026-09-19, when a burst of false-positive taps
// burned the budget and every tap after it was silently dead). Doubling from
// 2s reaches the same 30s for anything that keeps tripping it, while one
// unlucky limit now costs a single retap.
const RATE_LIMIT_BACKOFF_BASE_MS = 2000;
const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;

// Pure, exported for tests. `strikes` counts consecutive 429s, 1 for the
// first; any answer that isn't a 429 resets it.
export function rateLimitBackoffMs(strikes: number): number {
  if (strikes <= 0) return 0;
  return Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (strikes - 1), RATE_LIMIT_BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
