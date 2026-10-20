// Durable Object backing the real, wallet-integrated "tap two phones
// together to pay" (src/lib/bump/bump.ts, driven passively from Dashboard.tsx's
// home screen). The class keeps its old BumpLab name only because renaming a
// Durable Object class needs a storage migration; the standalone
// public/bump-lab.html it was named after is gone.
//
// Neither side knows who is paying whom at tap time — passive listening
// means there's no "Přijmout"/"Zaplatit" button to have pre-selected a
// role. Every tap just carries the tapper's own Ark address (plus a
// commitment, see bumpCommitment); pairing matches exactly two taps within
// the window regardless of role (there isn't one yet) and hands each side
// the other's address. Which one actually
// pays is decided *after* pairing, via the two on-screen arrows — see
// handleChoose below — and is a separate, later request precisely because
// the decision comes after a person looks at the emoji and taps an arrow,
// not at tap time.
//
// Silent until paired: the client sends every tap candidate its detector
// sees (see TapKind) and shows nothing until one comes back paired. A
// single phone can't tell a phone-to-phone bump from being put down on a
// table; two phones feeling the same impact within a couple hundred ms
// can. So the pairing itself is the real detector, and a lone false
// positive costs one request instead of an overlay and a deaf phone.

export interface BumpCf {
  colo?: string;
  city?: string;
  country?: string;
}

// How close two taps' networks are, from Cloudflare's view of each request.
//   3 same network (same public IPv4, or same IPv6 /64)
//   2 same city and country (Cloudflare's city, else its colo)
//   1 anything else, including two different countries
//   0 is not a locality any more: pairLevel alone decides who never pairs
//
// "Different country never pairs" used to be rule here, and it was wrong in a
// way that only real use showed (2026-09-20: one phone read as CZ, the other
// as DE, 18 taps in the DE shard, not one pair). These two phones are
// *physically touching*. A country derived from an IP was never evidence of
// that, only a cheap prior, and it is routinely a continent off: iCloud
// Private Relay, a VPN, roaming, or a carrier routing through a foreign
// gateway. Gating a feature whose entire premise is physical contact on a
// guess that can be that wrong is backwards, so the guess no longer gates.
//
// What that costs: two taps with nothing in common match on time alone, so
// the chance an unrelated tap falls in the window grows with global tap rate
// (roughly 2% at 0.1 taps/s worldwide, 17% at 1/s). It costs *annoyance*,
// not safety: a collision is fail-closed (both sides told "ambiguous" and
// asked to tap again, see handleTap) and the commit-reveal emoji are what
// stop a wrong pairing being paid. Buying the headroom back means giving the
// two phones something else to share, which is what a multi-tap rhythm would
// do; it is not something locality can be trusted for.
export type MatchLevel = 0 | 1 | 2 | 3;

export interface Locality {
  cf: BumpCf;
  // Hashed network prefix (see networkPrefix); never the raw IP.
  net?: string;
}

export function matchLevel(a: Locality, b: Locality): MatchLevel {
  if (a.net && b.net && a.net === b.net) return 3;
  const sameCountry = (a.cf.country ?? "") === (b.cf.country ?? "");
  const sameCity = (a.cf.city ?? a.cf.colo ?? "") === (b.cf.city ?? b.cf.colo ?? "");
  return sameCountry && sameCity ? 2 : 1;
}

// Whether two taps' countries disagree, for telemetry only (pairCrossCountry).
// It is no longer a pairing rule, but it is worth knowing how often a real
// pairing depends on the rule being gone.
export function crossCountry(a: Locality, b: Locality): boolean {
  return (a.cf.country ?? "") !== (b.cf.country ?? "");
}

// The part of a client IP that identifies "the same network": a whole IPv4
// address (one NAT = one household or shop), or the /64 prefix of an IPv6
// one (each device on a wifi gets its own address inside the same /64).
// Pure, exported for tests. The worker hashes this before it gets here.
function ipv6Groups(ip: string): string[] {
  const [head, tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0") : [];
  return [...headParts, ...fill, ...tailParts].map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, ""));
}

export function networkPrefix(ip: string): string {
  if (!ip.includes(":")) return ip;
  return ipv6Groups(ip).slice(0, 4).join(":") + "::/64";
}

// The coarser source a *penalty* is charged to (see StrikeLedger): a whole IPv4
// address, or an IPv6 /48. A /64 is what one device's network means, but a
// single subscriber routinely holds a /48 or /56 and can present a fresh /64 on
// every request, so a penalty keyed on the /64 is one the offender simply walks
// away from. Kept apart from networkPrefix on purpose: that one decides who
// counts as "the same network" for pairing and must stay narrow. Pure, exported
// for tests.
export function guardPrefix(ip: string): string {
  if (!ip.includes(":")) return ip;
  return ipv6Groups(ip).slice(0, 3).join(":") + "::/48";
}

// How a tap was produced, which decides what it may pair with:
// - hard: the motion detector is confident (full threshold, tap-shaped).
// - soft: a weaker tap-shaped spike (or one that coincided with a screen
//   touch). Pairs with a hard tap; soft+soft only under the narrow
//   exception in pairLevel (both shape-checked, same network). That's
//   what lets a phone that felt the bump more faintly (softer case, peak
//   falling between two 60Hz samples) still pair when the other phone
//   felt it clearly, without two phones' incidental jiggles pairing.
//
// There used to be two more: "manual" (a since-removed button) and
// "legacy" (a client sending no kind), both with a 900ms human-timing
// window. Nothing in the app sends either any more, and that window was a
// gift to anyone spraying taps on purpose: one request covered well over a
// second of other people's bumps. Both are refused now.
export type TapKind = "hard" | "soft";

function parseKind(value: unknown): TapKind | null {
  return value === "hard" || value === "soft" ? value : null;
}

// Where a paired payment stands, shared by both phones. Only the sender
// ever sets an amount; the receiver only ever confirms arrival. This is
// what lets each phone show live, specific state ("zadává částku",
// "přichází 2 500 sats", "doručeno") instead of guessing from its own
// balance or telling the sender to go check history.
export type FlowStage = "choosing" | "entering" | "sending" | "sent" | "received" | "cancelled";

interface PairFlow {
  senderId?: string;
  stage: FlowStage;
  amountSats?: number;
  cancelledBy?: string;
  // Bumped on every stage change; GET /status?v= long-polls on it.
  version: number;
  createdAt: number;
  lastActivityAt: number;
  doneAt?: number;
}

const MAX_AMOUNT_SATS = 2_100_000_000_000_000;

// Which stage changes are legal, and for whom. Pure, exported for tests.
// Returns the stage to move to, or null if the request is not allowed.
// Asking for the current stage again is allowed (idempotent retries).
export function nextFlowStage(current: FlowStage, actorIsSender: boolean, requested: FlowStage): FlowStage | null {
  if (requested === current) return current;
  switch (requested) {
    case "cancelled":
      // Only before any money can be in flight. Once "sending", the
      // sender's wallet call may already have gone out, so neither side
      // can call it off from here; the receiver just closes its screen.
      return current === "choosing" || current === "entering" ? requested : null;
    case "sending":
      return actorIsSender && current === "entering" ? requested : null;
    case "entering":
      // The sender's wallet call failed outright; back to the amount.
      return actorIsSender && current === "sending" ? requested : null;
    case "sent":
      return actorIsSender && current === "sending" ? requested : null;
    case "received":
      return !actorIsSender && (current === "sending" || current === "sent") ? requested : null;
    default:
      return null;
  }
}

const isDoneStage = (stage: FlowStage): boolean => stage === "received" || stage === "cancelled";

interface PendingTap extends Locality {
  id: string;
  kind: TapKind;
  // SHA-256 commitment to (address, nonce), sent with the tap; the nonce
  // itself only after pairing (handleReveal). See bumpCommitment.
  commit: string;
  nonce?: string;
  // Motion context from the client (src/lib/bump/bump.ts's TapFeatures).
  vertical?: number;
  rested?: boolean;
  noiseBefore?: number;
  // The client's shape check (src/lib/bump/bump.ts's tapShape): present only from
  // builds that drop handling-shaped spikes before sending. Logged, and it
  // gates soft+soft pairing (see pairLevel).
  post?: number;
  spreadMs?: number;
  shaped?: boolean;
  // Paired: the pair's MatchLevel. Ambiguous: the level it collided at.
  // A later tap only disturbs it from at least this close (see handleTap).
  level?: MatchLevel;
  // Last request of any kind carrying this id (see peerSeenAgoMs).
  lastSeenAt?: number;
  // Server-clock time of the *physical* tap: the client's own clock-synced
  // reading when it's plausible, else this DO's arrival time (see
  // resolveTapTime). Matching and the pending lifetime both key off this.
  tapTime: number;
  // How far off tapTime may be in either direction (the client's reported
  // clock-sync error bound, clamped). Widens this tap's match window.
  uncertaintyMs: number;
  // How long after its tap time the request reached this DO. Logged only:
  // it's the data MAX_ARRIVAL_LAG_MS (and with it how long a pairing takes
  // to settle) should be tuned from.
  lagMs?: number;
  address: string;
  cf: BumpCf;
  // Hashed guardPrefix of the request's source; what StrikeLedger charges.
  guard?: string;
  state: "pending" | "paired" | "ambiguous";
  // When the tap stopped being pending. PAIRED_TTL_MS/AMBIGUOUS_TTL_MS
  // count from here, not from tapTime.
  resolvedAt?: number;
  // Set once paired:
  pairId?: string;
  pairedWithId?: string;
  peerAddress?: string;
  deltaMs?: number;
  partnerCf?: BumpCf;
  // Past this, no later tap can still land in this pair's window (see
  // settleAtFor), so the pairing can no longer turn ambiguous.
  settleAt?: number;
}

// Matching runs on each tap's own clock-synced *physical* tap time
// (clientTapTime), not on when its request happened to reach this DO. It
// used to be arrival time, which silently folded each phone's network
// latency into the comparison: a passively listening phone's radio is
// usually idle, and waking it plus a cold connection easily costs a second
// or more, so two taps that physically happened together routinely
// "missed" each other. Now latency only has to fit inside
// MAX_ARRIVAL_LAG_MS, and the match window means "how close together the
// two taps actually were".
//
// Base window for two sensor taps. Both phones feel the same physical
// impact, so once tap times are clock-synced they agree to within roughly a
// 60Hz sample on each side plus event-dispatch jitter. The sync's own error
// is added per tap on top (uncertaintyMs). Tight on purpose: this is what
// makes a coincidental unrelated spike (a phone put down elsewhere)
// improbable enough to use the pairing as the detector.
//
// Measured 2026-09-19 on 66 recorded two-phone taps (Settings > Záznamník
// ťuknutí): every one within 35ms, with ~16ms of clock uncertainty per phone
// on top. It was 150-250ms before there was data; with the uncertainty added
// per side the windows below still leave ~3x the worst recorded gap.
// Narrowed 80 -> 40 on 2026-09-20 from production telemetry rather than from
// the two-phones-on-a-table recordings: 24 real pairings that day, every one
// of them within 29ms, against a window that was then 110ms. The sample is
// not censored in a way that could hide a wider tail, because the old window
// would have accepted anything up to 110ms and recorded it in the dt
// histogram; every bucket above 29ms is empty. Keeps ~2.6x over the worst
// pair actually seen. If it is too tight it shows up as `lone` rising while
// `pair` falls, and it is one constant back.
const SENSOR_MATCH_WINDOW_MS = 40;
// Farther apart, less benefit of the doubt: the base sensor window shrinks
// with MatchLevel, and a same-country-only match must be hard on both sides.
const SENSOR_WINDOW_BY_LEVEL: Record<1 | 2 | 3, number> = { 1: 30, 2: 35, 3: SENSOR_MATCH_WINDOW_MS };

// Per-tap clock uncertainty, added on top of the base window for each side.
// The client reports half its best sync round trip; the cap is what bounds
// how much of the timeline one request can claim. It was 300ms, then 150ms,
// both guesses made before there was data: a client that simply *says* it is
// unsure got to cover that much of everyone else's taps per request.
//
// Measured on the 2026-09-19 two-phone recordings (tests/fixtures, the same
// ones tests/bumpReplay.test.ts replays): a real phone reports ~16ms, and
// the two sides' clock-synced tap times agree to within 33ms at the 90th
// percentile. 40ms leaves an honest pair untouched (its window stays base +
// ~32ms, still ~3x the measured p90) while cutting the widest window a
// single request can claim from 380ms to 160ms, and with it PENDING_TTL_MS,
// i.e. how many strangers' taps sit in the table at the same instant.
// Server-side only: the client keeps reporting its real measurement, so this
// needs no client rollout and no mixed-version handling.
// A missing or invalid value gets the cap, never less.
//
// 40 -> 25 on 2026-09-20, same evidence. A session deliberately run on poor
// connections put every tap's claimed uncertainty between 15 and 34ms and not
// one of them reached the 40 cap, because the sync takes the *minimum* of
// five round trips and the best of five is decent even on a bad link. This
// term was half of the whole window (2 x ~25ms out of 110), so it is the half
// worth trimming: the base window alone could never get below it.
const MAX_CLOCK_UNCERTAINTY_MS = 25;

// A reported tap time is trusted only if its request arrived at most this
// long after it, and
// no further "ahead" of this server's clock than the clock sync can be off
// by. A tap outside that can't be matched at all: it used to fall back to
// its arrival time with maximal uncertainty, which no current client needs
// (it only sends a tap once it has a clock sync) and which handed anyone
// the widest window on request. Refusing it is also what makes settleAt a
// hard bound: every tap that could still collide with a pair has a tap time
// no older than MAX_ARRIVAL_LAG_MS by the time it arrives.
//
// This bound is also most of how long a pairing takes to settle (settleAt),
// i.e. how long the "Platím"/"Přijímám" buttons stay disabled. It was 4s,
// a guess meant to cover a cold radio, which kept the buttons locked ~4.6s
// after every tap. Measured live 2026-09-19 (the `lag` field of the pair
// log): ~0.4s, with the client's warm-up ping (BumpSession.warmUp) waking
// the radio while the shape check still holds the candidate. 1.5s keeps
// ~4x headroom over that and unlocks the buttons about when the emoji reel
// finishes. The cost: a request slower than this doesn't pair, the phones
// just tap again. Waiting here is only the second line of defence anyway;
// the commit-reveal emoji (bumpCommitment) are what stop a relayed pairing.
const MAX_ARRIVAL_LAG_MS = 1500;
const MAX_FUTURE_SKEW_MS = MAX_CLOCK_UNCERTAINTY_MS + 50;

// The widest two taps can ever be apart and still match.
const MAX_MATCH_SPAN_MS = SENSOR_MATCH_WINDOW_MS + 2 * MAX_CLOCK_UNCERTAINTY_MS;

// A pending tap has to stay matchable until the slowest possible partner
// request could still arrive: a partner tapped up to MAX_MATCH_SPAN_MS later
// whose request then took up to MAX_ARRIVAL_LAG_MS.
const PENDING_TTL_MS = MAX_MATCH_SPAN_MS + MAX_ARRIVAL_LAG_MS;

// Once resolved (paired or ambiguous), keep the record around long enough
// to survive the emoji-confirm + arrow-decision dwell time — a real person
// looking at the emoji and deciding who pays takes longer than a few
// seconds. Ambiguous is pruned much sooner since there's nothing left to
// look at.
const PAIRED_TTL_MS = 45000;
const AMBIGUOUS_TTL_MS = 5000;

// Once a direction is chosen the pair lives on while either phone is still
// talking to it (typing an amount, a password, the payment itself), with a
// hard cap. After received/cancelled it lingers just long enough for the
// other phone's next poll to see the outcome.
const FLOW_IDLE_TTL_MS = 3 * 60_000;
const FLOW_MAX_TTL_MS = 15 * 60_000;
const FLOW_DONE_TTL_MS = 30_000;

// How long GET /status?v= holds a request open waiting for a change.
const STATUS_WAIT_MAX_MS = 8000;

// Defensive caps — this is reachable at a public URL with only a
// same-origin check in front of it, not real auth. The global one bounds
// memory; the per-network one keeps a single source from filling it (or
// the timeline) on its own. Two real phones sharing one wifi have at most
// MAX_IN_FLIGHT (4) candidates each outstanding (src/lib/bump/bump.ts).
//
// MAX_PENDING was 500 while this was one object for the whole world, and at
// that size it protected the wrong thing. A record is on the order of 1-2 KB
// (two addresses, a commitment, a nonce, some numbers), so 500 of them is
// about 1MB against a Durable Object's 128MB: the cap sat at roughly 1% of
// what it guards, while hitting it answers 503 to *everyone* in the shard.
// That trades a resource which is not scarce for an outage which was cheap
// to cause: at 16 per network, 32 distinct /64s fill the table, and one
// residential IPv6 delegation is a /56, i.e. 256 of them.
//
// 5000 inverts that. It is ~10MB of the 128MB budget, and the real ceiling is not
// memory but the linear scans: prune() runs on every request (including
// every /status long-poll wake) and handleTap adds two or three more, so
// ~5000 iterations is ~0.25ms per request while 50k would start to matter on
// a single-threaded object. Capacity-wise it is 2500 concurrent pairs
// instead of 250, which is far past anything this app will see soon - the
// point is that the cap should never be the thing that breaks first.
//
// Raising MAX_PENDING_PER_NET is the companion question and is deliberately
// NOT answered here: 16 gives two phones on one wifi 2x headroom over their
// MAX_IN_FLIGHT, but a shop with four phones bumping on one network reaches
// it exactly, and nobody knows yet whether that happens in practice. The
// `netCap` counter in BumpDayStats exists to answer it.
//
// The per-network cap alone did not protect MAX_PENDING: a /64 is free to
// rotate, and one residential /56 holds 256 of them, i.e. 4096 records, so two
// such subscribers filled the whole table and every tap anywhere got a 503.
// MAX_PENDING_PER_GUARD caps the source a subscriber cannot rotate out of (a
// whole IPv4, an IPv6 /48, see guardPrefix), so filling the table now takes
// ~80 unrelated sources. 64 is 16 phones with all of their MAX_IN_FLIGHT
// candidates pending behind one address inside the same ~1.6s: far past a
// shop, and a carrier NAT with that many people bumping in the same second is
// not something this feature will see soon (`guardCap` counts it if it does).
// While hot sources are dropped (BUMP_HOT_SOURCES), a source can't even get
// here: HOT_SOURCE_TAPS per SOURCE_RATE_WINDOW_MS is far fewer taps than this.
// This is then the backstop for when the rate meter is full and fails open.
const MAX_PENDING = 5000;
const MAX_PENDING_PER_NET = 16;
export const MAX_PENDING_PER_GUARD = 64;

export const BUMP_MATCHING = {
  SENSOR_MATCH_WINDOW_MS,
  SENSOR_WINDOW_BY_LEVEL,
  MAX_CLOCK_UNCERTAINTY_MS,
  MAX_ARRIVAL_LAG_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_MATCH_SPAN_MS,
  PENDING_TTL_MS,
  MAX_PENDING_PER_NET,
} as const;

// The server-clock tap time a tap is matched on, from the client's own
// clock-synced reading, or null when that reading is missing or
// implausible (such a tap can never be matched). Pure, exported for tests.
export function resolveTapTime(
  clientTapTime: unknown,
  clientUncertaintyMs: unknown,
  serverNow: number,
): { tapTime: number; uncertaintyMs: number } | null {
  if (
    typeof clientTapTime !== "number" ||
    !Number.isFinite(clientTapTime) ||
    clientTapTime < serverNow - MAX_ARRIVAL_LAG_MS ||
    clientTapTime > serverNow + MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  const uncertaintyMs =
    typeof clientUncertaintyMs === "number" && Number.isFinite(clientUncertaintyMs) && clientUncertaintyMs >= 0
      ? Math.min(clientUncertaintyMs, MAX_CLOCK_UNCERTAINTY_MS)
      : MAX_CLOCK_UNCERTAINTY_MS;
  return { tapTime: clientTapTime, uncertaintyMs };
}

// --- Commit-reveal for the emoji -------------------------------------------
// The emoji both people compare used to be a hash of the two addresses
// alone, and the addresses come from this server. So whoever controls it
// (or a compromised Worker) could hand the payer an address of its own,
// ground until the emoji matched the real pair's (3 emoji = 15 bits, a few
// ms of work), and the comparison would pass.
//
// Now each tap carries a commitment to (address, random nonce), and the
// nonce is revealed only after pairing, once the phone already holds its
// partner's commitment. The emoji are derived from both nonces. Whoever
// sits in the middle has to fix its own nonce (via the commitment) before
// it learns the honest phone's, so it can no longer steer the emoji: it
// gets one blind guess per attempt at the emoji code. The same
// scheme as Bluetooth's numeric comparison and ZRTP.
//
// The phones check all of this themselves (src/lib/bump/bump.ts); the check here
// only turns away garbage early. Both encodings are injective: the address
// is length-prefixed and the nonce has a fixed length.
export const BUMP_NONCE_RE = /^[0-9a-f]{32}$/;
const COMMIT_RE = /^[0-9a-f]{64}$/;

export async function bumpCommitment(address: string, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(`spendrr-bump-commit-v1:${address.length}:${address}:${nonce}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Spray defence -----------------------------------------------------------
// Fail-closed pairing (handleTap) means ANY third tap inside the window makes
// everyone involved ambiguous, and that is deliberate: it is what stops a
// stranger from being paired with a payer whose real partner is also tapping.
// The price is that someone who simply sprays taps turns every real pairing
// they land on into "tap again", and the server cannot tell a spray tap from
// an innocent one by looking at the tap. Pairing therefore stays exactly as
// strict as it is; what is added is a penalty on SOURCES.
//
// A source is judged by how often it taps, never by where its taps land.
// Covering the timeline takes a tap every ~140ms (one tap covers its whole
// window on both sides, see pairLevel), i.e. ~70 per SOURCE_RATE_WINDOW_MS; an
// honest phone sends a handful of candidates per bump.
//
// It used to be by position: the two closest taps of an ambiguous cluster
// were taken to be the honest pair and every other source was struck. But
// position is exactly what a sprayer chooses. Two taps of its own 1ms apart
// made IT the "honest pair" and the real one the outsiders, so a single source
// got honest phones blocked (after STRIKE_LIMIT retaps, which is what a person
// told "tap again" does) without ever being charged itself. Reproduced in
// tests/bumpMatching.test.ts.
//
// The rate is used twice:
//   - Strikes (always, unless BUMP_STRIKES_OFF): every source in an ambiguous
//     cluster that is hot at that moment takes a strike, and STRIKE_LIMIT
//     strikes inside STRIKE_WINDOW_MS block it for BLOCK_MS. A source that is
//     not hot is never struck, wherever its taps land.
//   - Dropping (only with BUMP_HOT_SOURCES = "enforce"): a hot source's taps
//     are not stored at all, so they can neither pair nor poison anyone.
//     Until then this only counts (`hot` in BumpDayStats): HOT_SOURCE_TAPS is
//     a first guess the `srcRate` histogram has to confirm, and a carrier NAT
//     puts many phones behind one IPv4 that then share one budget.
// What neither does: stop a source that stays under the rate. That bounds how
// much of the timeline one source can cover (~2 taps/s x 140-160ms, about a
// third of it), it does not remove it; more takes more IPv4 addresses or /48s,
// and each of them has to stay under the rate too.
//
// Keyed on guardPrefix (a whole IPv4 / an IPv6 /48), because a /64 is free to
// rotate. What it does NOT do: stop an attacker with a large pool of unrelated
// addresses. The residual is inherent to fail-closed matching.
export const STRIKE_LIMIT = 5;
export const STRIKE_WINDOW_MS = 2 * 60_000;
export const BLOCK_MS = 5 * 60_000;
// Bounds memory against a caller who rotates sources, for both StrikeLedger and
// SourceRateMeter. Past it, new sources are simply not tracked (fail open: an
// untracked source can be neither struck, blocked nor found hot), never evicted
// from a block early. MAX_PENDING_PER_GUARD does not depend on either and still
// holds.
const LEDGER_MAX_SOURCES = 20_000;

// A source that has sent more than HOT_SOURCE_TAPS taps inside
// SOURCE_RATE_WINDOW_MS is hot. What one honest phone can send at most, from
// src/lib/bump/bump.ts's own caps: hard candidates at least TAP_DEBOUNCE_MS (600ms)
// apart, soft ones SOFT_MIN_INTERVAL_MS (1.5s), no more than MAX_IN_FLIGHT (4)
// at once, each held ~1.6s. That is ~23 in 10s for a phone being jolted
// nonstop, a false-positive storm rather than a bump; a real bump attempt is
// one to four, a few attempts a minute. Two phones on one wifi share the
// budget. A first guess: the `srcRate` histogram (the source's count at each
// of its taps) is what should set it before dropping is switched on.
export const SOURCE_RATE_WINDOW_MS = 10_000;
export const HOT_SOURCE_TAPS = 20;
// Per source, only as many timestamps as it takes to tell hot from not (and
// fill the histogram's last bucket); the count saturates there.
const RATE_HISTORY_MAX = HOT_SOURCE_TAPS * 2;

export function isHot(recentTaps: number): boolean {
  return recentTaps > HOT_SOURCE_TAPS;
}

export class StrikeLedger {
  private readonly sources = new Map<string, { strikes: number[]; blockedUntil: number }>();

  blocked(key: string, now: number): boolean {
    const s = this.sources.get(key);
    return s !== undefined && s.blockedUntil > now;
  }

  // Returns true when this strike is the one that blocks the source.
  strike(key: string, now: number): boolean {
    let s = this.sources.get(key);
    if (!s) {
      if (this.sources.size >= LEDGER_MAX_SOURCES) return false;
      s = { strikes: [], blockedUntil: 0 };
      this.sources.set(key, s);
    }
    if (s.blockedUntil > now) return false;
    s.strikes = s.strikes.filter((t) => t > now - STRIKE_WINDOW_MS);
    s.strikes.push(now);
    if (s.strikes.length < STRIKE_LIMIT) return false;
    s.strikes = [];
    s.blockedUntil = now + BLOCK_MS;
    return true;
  }

  prune(now: number): void {
    for (const [key, s] of this.sources) {
      if (s.blockedUntil > now) continue;
      if (!s.strikes.some((t) => t > now - STRIKE_WINDOW_MS)) this.sources.delete(key);
    }
  }

  get size(): number {
    return this.sources.size;
  }
}

// Taps per source inside SOURCE_RATE_WINDOW_MS, by arrival time at this object
// (the server's clock, not the tap time a client claims). In memory only, like
// StrikeLedger.
export class SourceRateMeter {
  private readonly sources = new Map<string, number[]>();

  // Counts one tap and returns the source's count inside the window, this tap
  // included (saturating at RATE_HISTORY_MAX). 0 for a source that can't be
  // tracked any more (see LEDGER_MAX_SOURCES).
  record(key: string, now: number): number {
    let times = this.sources.get(key);
    if (!times) {
      if (this.sources.size >= LEDGER_MAX_SOURCES) return 0;
      times = [];
      this.sources.set(key, times);
    }
    trimOlderThan(times, now - SOURCE_RATE_WINDOW_MS);
    times.push(now);
    if (times.length > RATE_HISTORY_MAX) times.shift();
    return times.length;
  }

  count(key: string, now: number): number {
    const times = this.sources.get(key);
    if (!times) return 0;
    trimOlderThan(times, now - SOURCE_RATE_WINDOW_MS);
    return times.length;
  }

  prune(now: number): void {
    for (const [key, times] of this.sources) {
      trimOlderThan(times, now - SOURCE_RATE_WINDOW_MS);
      if (times.length === 0) this.sources.delete(key);
    }
  }

  get size(): number {
    return this.sources.size;
  }
}

// `times` is ascending (arrival order).
function trimOlderThan(times: number[], cutoff: number): void {
  let drop = 0;
  while (drop < times.length && times[drop] <= cutoff) drop++;
  if (drop > 0) times.splice(0, drop);
}

// The sources to charge for an ambiguous cluster: the ones that are hot right
// now, one entry per source, wherever in the cluster their taps are. Pure,
// exported for tests.
export function hotSources(cluster: readonly { guard?: string }[], recentTaps: (guard: string) => number): string[] {
  const out = new Set<string>();
  for (const { guard } of cluster) {
    if (guard !== undefined && !out.has(guard) && isHot(recentTaps(guard))) out.add(guard);
  }
  return [...out];
}

interface MatchableTap extends Locality {
  kind: TapKind;
  address: string;
  tapTime: number;
  uncertaintyMs: number;
  vertical?: number;
  shaped?: boolean;
}

// Some handling produces a sharp, lone, tap-shaped jolt that the client's
// shape check can't reject, and it is always almost purely vertical:
// picking a phone up (the lift-off snap, straight up), putting it down or
// dropping it on a table (straight down), and a phone lying on the table
// under either of those (straight up). A real bump is mostly horizontal:
// phones meet edge to edge, held roughly level. So a pair where *both*
// impulses are almost purely vertical, in either direction, is not a bump.
//
// Fitted on recordings from two real phones (2026-09-19): real taps (side
// edges, top edges, gentle) never exceeded |0.88|; pickups that got past
// the shape check were +0.93..+1.00 and every put-down -0.98..-1.00. The
// cost: a top-edge "cheers" tap with both phones held upright would read as
// vertical too. None of the recorded top-edge taps came close (|v| <= 0.68).
//
// `vertical` is the impulse's signed share along the device's at-rest
// accelerationIncludingGravity reading (src/lib/bump/bump.ts's verticalShare),
// so positive means physically upward on every platform: the sign is
// relative to a vector from the same sensor, whatever the axis convention.
// Pure, exported for tests.
const VERTICAL_VETO = 0.9;
export function verticalVeto(a: { vertical?: number }, b: { vertical?: number }): boolean {
  if (a.vertical === undefined || b.vertical === undefined) return false;
  return Math.abs(a.vertical) >= VERTICAL_VETO && Math.abs(b.vertical) >= VERTICAL_VETO;
}

export function pairLevel(a: MatchableTap, b: MatchableTap, ignoreVeto = false): MatchLevel {
  if (a.address === b.address) return 0;
  if (!ignoreVeto && verticalVeto(a, b)) return 0;
  const level = matchLevel(a, b);
  // Two faint taps pair only when both phones passed the shape check and
  // sit on the same network. Recorded: 5 of 73 real taps were faint on both
  // phones (2-5 m/s^2), and the shape check is what makes two faint,
  // tap-shaped, same-instant spikes on one wifi a bump rather than noise.
  if (a.kind === "soft" && b.kind === "soft" && !(a.shaped && b.shaped && level === 3)) return 0;
  if (level === 0) return 0;
  // Level 1 now means "nothing in common but the clock", so it is held to the
  // strictest terms: a firm tap on both phones, both past the shape check,
  // and the tightest window (SENSOR_WINDOW_BY_LEVEL). This is what partly
  // replaces the country gate removed above.
  if (level === 1 && (a.kind !== "hard" || b.kind !== "hard" || !a.shaped || !b.shaped)) return 0;
  const base = SENSOR_WINDOW_BY_LEVEL[level];
  return Math.abs(a.tapTime - b.tapTime) <= base + a.uncertaintyMs + b.uncertaintyMs ? level : 0;
}

// A third tap can only ever collide with this pair if it is within
// MAX_MATCH_SPAN_MS of one of the two tap times and reaches this DO no more
// than MAX_ARRIVAL_LAG_MS after its own tap time (resolveTapTime refuses
// anything later). Past this instant no such tap can exist any more, which
// is why a direction can only be chosen from then on (handleChoose).
function settleAtFor(a: PendingTap, b: PendingTap): number {
  return Math.max(a.tapTime, b.tapTime) + MAX_MATCH_SPAN_MS + MAX_ARRIVAL_LAG_MS;
}

// One JSON line per pairing decision, for `wrangler tail` while tuning the
// detector on real phones: timing, closeness, kinds and motion context.
// Never addresses, ids or network keys.
function logBumpEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ bump: event }));
}

const motionOf = (t: PendingTap) => ({
  kind: t.kind,
  v: t.vertical,
  rest: t.rested,
  noise: t.noiseBefore,
  post: t.post,
  spread: t.spreadMs,
  unc: t.uncertaintyMs,
  lag: t.lagMs,
});

function parseNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, 10_000) : undefined;
}

function parseUnit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The slice of Durable Object storage this uses (typed by hand, like
// mailboxWatcher.ts, since this project has no workers-types dependency).
interface BumpStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
interface BumpState {
  storage: BumpStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

// A decided pair as stored: the flow plus both taps, everything needed to
// answer /status, /progress and /choose for either phone again.
interface StoredPair {
  flow: PairFlow;
  taps: PendingTap[];
}
const PAIR_KEY_PREFIX = "pair:";

// --- Telemetry --------------------------------------------------------------
// Aggregates only: no address, no id, no network key, no per-tap row with a
// timestamp (the same rule logBumpEvent already follows, for the same reason
// - a per-tap log could be correlated back against the pair log, an
// aggregate cannot). Nothing new is asked of the client either; every number
// below is something this object already receives in order to match taps at
// all, and used to throw away the moment the request ended.
//
// What it answers: how many taps end paired vs. ambiguous vs. alone, how
// close real pairs actually are, and how much of the arrival-lag and
// clock-uncertainty budget real phones really use. That last one is what any
// further tightening of SENSOR_WINDOW_BY_LEVEL has to be argued from,
// instead of from one afternoon with two phones on one table.
//
// Kept per UTC day, today and yesterday, and written at the end of whichever
// request touched them (see flushStats). Read back through the token-gated
// /api/bump/stats.
const STATS_KEY = "stats";
const STATS_DAYS = 2;
const DT_BUCKET_MS = 10;
const DT_BUCKETS = 21; // 0..200ms+, wider than any pair can be
const LAG_BUCKET_MS = 100;
const LAG_BUCKETS = 16; // 0..1500ms+, i.e. MAX_ARRIVAL_LAG_MS
const UNC_BUCKET_MS = 5;
// Deliberately still 9 buckets although MAX_CLOCK_UNCERTAINTY_MS is now 25,
// so the top ones simply stop filling: reshaping a histogram mid-day would
// throw away what is already in it (reviveDayStats truncates on purpose), and
// uncRaw below is the one to read for what clients actually claim.
const UNC_BUCKETS = 9;
// The same number *before* resolveTapTime clamps it. `unc` above can only
// ever say "at or above the cap", which is useless for deciding whether the
// cap itself is right: a phone claiming 45ms and one claiming 400ms land in
// the same bucket. This one keeps the claim as made, so a session on a poor
// connection can actually answer that question.
const UNC_RAW_BUCKET_MS = 20;
const UNC_RAW_BUCKETS = 16; // 0..300ms+
// The tapping source's own count inside SOURCE_RATE_WINDOW_MS at each tap, that
// tap included: the evidence HOT_SOURCE_TAPS has to be set from. Sampled per
// tap, so it reads directly as "what share of taps a given threshold would
// drop". Taps only, no source key, like everything else here.
const SRC_RATE_BUCKET = 2;
const SRC_RATE_BUCKETS = 21; // 0..40+, i.e. RATE_HISTORY_MAX

// Pure, exported for tests. Everything out of range lands in the last
// bucket, so a histogram never silently loses a sample.
export function histogramBucket(value: number, width: number, count: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(count - 1, Math.floor(value / width));
}

export interface BumpDayStats {
  day: string; // UTC, YYYY-MM-DD
  tapHard: number;
  tapSoft: number;
  // Refused before ever being stored: tap time too old (the network was too
  // slow), too far in the future (a skewed clock), the per-network cap, the
  // global cap, or the phone already sat in an undecided pairing.
  late: number;
  skew: number;
  netCap: number;
  // Taps refused because their source is blocked (StrikeLedger), and strikes
  // handed out to sources that were hot inside an ambiguous cluster.
  blocked: number;
  struck: number;
  // Taps from a hot source (dropped only while BUMP_HOT_SOURCES is "enforce",
  // counted either way), and taps refused by MAX_PENDING_PER_GUARD.
  hot: number;
  guardCap: number;
  busy: number;
  inPairing: number;
  // Warm-up pings the phones report with their next tap: sent to the static
  // warm-up file, or skipped because the connection was still warm
  // (src/lib/bump/bump.ts's warmUp). Shows how much network the motion
  // detector causes between taps.
  warmSent: number;
  warmSkipped: number;
  // Tap-like spikes the phone's shape check threw out as handling, reported
  // the same way: what the detector sees but never sends.
  spikesDropped: number;
  pair: number;
  pairByLevel: number[]; // indexed by MatchLevel
  // Pairs whose two phones were placed in different countries. Never a rule
  // (see matchLevel), only the measure of how much the removed country gate
  // was costing: on the phones that motivated removing it, this should be
  // most of them.
  pairCrossCountry: number;
  ambiguous: number;
  veto: number;
  lone: number; // pending, never matched, pruned
  dt: number[]; // |deltaMs| of real pairs
  lag: number[]; // tap time -> arrival at this object
  unc: number[]; // clock uncertainty the client claimed, after the cap
  uncRaw: number[]; // ...and as claimed, before MAX_CLOCK_UNCERTAINTY_MS
  srcRate: number[]; // the source's taps inside SOURCE_RATE_WINDOW_MS, per tap
}

// Scalar counters, listed so a restored record can be copied field by field
// rather than trusted wholesale (see reviveDayStats).
const DAY_STAT_COUNTERS = [
  "tapHard",
  "tapSoft",
  "late",
  "skew",
  "netCap",
  "blocked",
  "struck",
  "hot",
  "guardCap",
  "busy",
  "inPairing",
  "warmSent",
  "warmSkipped",
  "spikesDropped",
  "pair",
  "pairCrossCountry",
  "ambiguous",
  "veto",
  "lone",
] as const;

function emptyDayStats(day: string): BumpDayStats {
  return {
    day,
    tapHard: 0,
    tapSoft: 0,
    late: 0,
    skew: 0,
    netCap: 0,
    blocked: 0,
    struck: 0,
    hot: 0,
    guardCap: 0,
    busy: 0,
    inPairing: 0,
    warmSent: 0,
    warmSkipped: 0,
    spikesDropped: 0,
    pair: 0,
    pairByLevel: [0, 0, 0, 0],
    pairCrossCountry: 0,
    ambiguous: 0,
    veto: 0,
    lone: 0,
    dt: new Array(DT_BUCKETS).fill(0),
    lag: new Array(LAG_BUCKETS).fill(0),
    unc: new Array(UNC_BUCKETS).fill(0),
    uncRaw: new Array(UNC_RAW_BUCKETS).fill(0),
    srcRate: new Array(SRC_RATE_BUCKETS).fill(0),
  };
}

// Rebuilds a stored day on top of a fresh, correctly shaped record, copying
// only fields this version knows and only where they are finite numbers.
// Restoring a stored record as-is would mean a record written by a *different*
// version of this file gets incremented later on, and the bucket counts above
// exist precisely to be retuned:
//   - a stored array shorter than its constant makes `s.dt[i]++` write NaN at
//     an index past its end, silently corrupting the histogram it is being
//     collected to inform;
//   - a counter added after that record was written makes `s.newOne++` NaN,
//     and a new *array* field makes `s.newOnes[i]++` throw outright - inside
//     stat(), which handleTap calls for every accepted tap, so the shard would
//     answer 500 to every tap, and keep doing so across restarts because the
//     offending record is read back from storage each time.
// A stored array longer than its constant (a bucket count reduced) keeps its
// leading buckets and drops the tail, which is the only sane merge.
// Returns null for anything that isn't recognisably one day's record.
function reviveDayStats(raw: unknown): BumpDayStats | null {
  if (!raw || typeof raw !== "object") return null;
  const stored = raw as Record<string, unknown>;
  if (typeof stored.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stored.day)) return null;
  const out = emptyDayStats(stored.day);
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  for (const key of DAY_STAT_COUNTERS) out[key] = count(stored[key]);
  const copyInto = (target: number[], v: unknown): void => {
    if (!Array.isArray(v)) return;
    for (let i = 0; i < Math.min(target.length, v.length); i++) target[i] = count(v[i]);
  };
  copyInto(out.pairByLevel, stored.pairByLevel);
  copyInto(out.dt, stored.dt);
  copyInto(out.lag, stored.lag);
  copyInto(out.unc, stored.unc);
  copyInto(out.uncRaw, stored.uncRaw);
  copyInto(out.srcRate, stored.srcRate);
  return out;
}

// What a per-source rate limit is keyed on. An IPv4 address is one NAT, i.e.
// one household or shop, and is used whole. An IPv6 *address* is not a
// source at all: a single subscriber is handed a /56 or /48, so the same
// phone can present a fresh address on every request and a limiter keyed on
// the full address never fires. networkPrefix collapses it to the /64, which
// is what one device's network means and what the pairing code already
// treats as "the same network". Pure, exported for tests.
export function bumpRateLimitKey(ip: string): string {
  return ip === "unknown" ? ip : networkPrefix(ip);
}

export class BumpLab {
  private pending = new Map<string, PendingTap>();
  // pairId -> the shared payment flow. The first /choose call for a pair
  // locks in who sends; later calls (from either side) just read it back,
  // which is what lets the *other* phone switch on its own without that
  // person ever clicking anything themselves.
  private pairs = new Map<string, PairFlow>();
  // Held /status long-polls per tap id, so the *other* phone can tell
  // "still connected, just waiting" from "gone" (see peerSeenAgoMs).
  private activeWaits = new Map<string, number>();
  // Held-open /tap requests (wait: true) waiting for their tap to leave
  // "pending". One request per candidate instead of a /status poll loop,
  // which matters now that every candidate is sent, not just the one tap
  // the old UI reacted to.
  private waiters = new Map<string, Set<() => void>>();
  // See StrikeLedger. In memory only: a restart forgives everyone, which is fine.
  private readonly ledger = new StrikeLedger();
  private readonly strikesOff: boolean;
  // See SourceRateMeter. Same lifetime as the ledger.
  private readonly rates = new SourceRateMeter();
  private readonly dropHotSources: boolean;

  // Everything above is in memory, which a deploy or an eviction wipes.
  // For taps and undecided pairs that's fine (they live seconds; people just
  // tap again). Once someone picked "Platím" it isn't: money may be about to
  // move, or already moving, and losing the pair there used to show both
  // phones "Platba vypršela" in the middle of a real payment. So a decided
  // pair is written to durable storage on every change and read back when
  // the object starts. Unit tests pass no state and run in memory only.
  private readonly storage: BumpStorage | null;
  // Every request waits for this, so none can see (or write over) a half
  // restored state, on top of blockConcurrencyWhile doing the same.
  private readonly ready: Promise<void>;
  // Aggregate telemetry, see BumpDayStats.
  private stats = new Map<string, BumpDayStats>();
  private statsDirty = false;

  constructor(state: BumpState | null, env: { BUMP_STRIKES_OFF?: string; BUMP_HOT_SOURCES?: string } | null) {
    // Escape hatch if the penalty ever misfires: `wrangler secret put BUMP_STRIKES_OFF` = "1".
    this.strikesOff = env?.BUMP_STRIKES_OFF === "1";
    // Counting only until someone decides otherwise; see the spray defence notes.
    this.dropHotSources = env?.BUMP_HOT_SOURCES === "enforce";
    this.storage = state?.storage ?? null;
    this.ready = state ? state.blockConcurrencyWhile(() => this.restore()).catch(() => {}) : Promise.resolve();
  }

  private async restore(): Promise<void> {
    if (!this.storage) return;
    const stored = await this.storage.list<StoredPair>({ prefix: PAIR_KEY_PREFIX });
    const now = Date.now();
    for (const [key, { flow, taps }] of stored) {
      const pairId = key.slice(PAIR_KEY_PREFIX.length);
      // Past its lifetime while nothing was running: drop it for good.
      const dead = isDoneStage(flow.stage)
        ? now - (flow.doneAt ?? now) > FLOW_DONE_TTL_MS
        : now - flow.createdAt > FLOW_MAX_TTL_MS;
      if (dead || taps.length !== 2) {
        void this.storage.delete(key);
        continue;
      }
      // The restart itself isn't the phones going quiet.
      this.pairs.set(pairId, { ...flow, lastActivityAt: Math.max(flow.lastActivityAt, now) });
      for (const tap of taps) this.pending.set(tap.id, tap);
    }
    try {
      const days = await this.storage.get<unknown>(STATS_KEY);
      if (Array.isArray(days)) {
        for (const stored of days) {
          const day = reviveDayStats(stored);
          if (day) this.stats.set(day.day, day);
        }
        // stat() trims on a day change; this bounds what a stored value can
        // put in memory in the first place.
        for (const old of [...this.stats.keys()].sort().slice(0, -STATS_DAYS)) this.stats.delete(old);
      }
    } catch {
      // Telemetry is never worth failing a restore over.
    }
  }

  // Best-effort: a failed write only means this pair wouldn't survive a
  // restart, the same as before persistence existed. Durable Object output
  // gates hold the response until the write has landed.
  private persist(pairId: string): void {
    if (!this.storage) return;
    const flow = this.pairs.get(pairId);
    if (!flow?.senderId) return;
    const taps = [...this.pending.values()].filter((t) => t.pairId === pairId);
    if (taps.length !== 2) return;
    void this.storage.put(PAIR_KEY_PREFIX + pairId, { flow, taps } satisfies StoredPair).catch(() => {});
  }

  private forget(pairId: string): void {
    if (this.storage) void this.storage.delete(PAIR_KEY_PREFIX + pairId).catch(() => {});
  }

  // Counts one aggregate event. Never called with anything derived from an
  // address, an id or a network key.
  private stat(fn: (s: BumpDayStats) => void): void {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let today = this.stats.get(day);
    if (!today) {
      today = emptyDayStats(day);
      this.stats.set(day, today);
      for (const old of [...this.stats.keys()].sort().slice(0, -STATS_DAYS)) this.stats.delete(old);
    }
    fn(today);
    this.statsDirty = true;
  }

  // Written at the end of whichever request touched the counters, not on a
  // timer. A shard is idle most of the time, so the object is evicted between
  // taps and anything not yet on disk is simply gone. Throttling writes to
  // one per 10s (the first version of this) lost exactly the events worth
  // counting, confirmed against a local wrangler runtime on 2026-09-20: the
  // *second* tap of a pairing always lands inside the window the first one
  // just opened, so `pair` and its `dt` sample were the counts most certain
  // to vanish, and a later read showed the totals going *backwards*. At most
  // one write per request, and the Durable Object output gate holds the
  // response until it has landed.
  private flushStats(): void {
    if (!this.storage || !this.statsDirty) return;
    this.statsDirty = false;
    void this.storage.put(STATS_KEY, [...this.stats.values()]).catch(() => {});
  }

  private handleStats(): Response {
    return jsonResponse({
      now: Date.now(),
      bucketMs: { dt: DT_BUCKET_MS, lag: LAG_BUCKET_MS, unc: UNC_BUCKET_MS, uncRaw: UNC_RAW_BUCKET_MS },
      bucketTaps: { srcRate: SRC_RATE_BUCKET },
      sources: {
        hotSourceTaps: HOT_SOURCE_TAPS,
        windowMs: SOURCE_RATE_WINDOW_MS,
        dropHot: this.dropHotSources,
        maxPendingPerGuard: MAX_PENDING_PER_GUARD,
        tracked: this.rates.size,
      },
      pending: this.pending.size,
      pairs: this.pairs.size,
      days: [...this.stats.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    try {
      return await this.route(request);
    } finally {
      this.flushStats();
    }
  }

  private async route(request: Request): Promise<Response> {
    this.prune();
    const url = new URL(request.url);
    // Token-checked in worker/index.ts, which is the realm that holds the
    // secret; by here it is already authorised.
    if (request.method === "GET" && url.pathname === "/api/bump/stats") {
      return this.handleStats();
    }
    if (request.method === "POST" && url.pathname === "/api/bump/tap") {
      return this.handleTap(request);
    }
    if (request.method === "GET" && url.pathname === "/api/bump/status") {
      return this.handleStatus(url);
    }
    if (request.method === "POST" && url.pathname === "/api/bump/choose") {
      return this.handleChoose(request);
    }
    if (request.method === "POST" && url.pathname === "/api/bump/progress") {
      return this.handleProgress(request);
    }
    if (request.method === "POST" && url.pathname === "/api/bump/reveal") {
      return this.handleReveal(request);
    }
    return jsonResponse({ error: "Not found" }, 404);
  }

  private notify(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const wake of set) wake();
  }

  private remove(id: string): void {
    const tap = this.pending.get(id);
    if (!tap) return;
    if (tap.pairId && this.pairs.delete(tap.pairId)) this.forget(tap.pairId);
    this.pending.delete(id);
    this.notify(id);
    if (tap.pairedWithId) this.notify(tap.pairedWithId);
  }

  // Any request carrying a paired tap's id keeps its pair alive.
  private touch(tap: PendingTap, now: number): void {
    tap.lastSeenAt = now;
    const flow = tap.pairId ? this.pairs.get(tap.pairId) : undefined;
    if (flow) flow.lastActivityAt = now;
  }

  private bumpFlow(tap: PendingTap, flow: PairFlow): void {
    flow.version++;
    if (tap.pairId) this.persist(tap.pairId);
    this.notify(tap.id);
    if (tap.pairedWithId) this.notify(tap.pairedWithId);
  }

  private pairExpired(tap: PendingTap, now: number): boolean {
    const flow = tap.pairId ? this.pairs.get(tap.pairId) : undefined;
    if (!flow || !flow.senderId) return now - (tap.resolvedAt ?? tap.tapTime) > PAIRED_TTL_MS;
    if (isDoneStage(flow.stage)) return now - (flow.doneAt ?? now) > FLOW_DONE_TTL_MS;
    return now - flow.lastActivityAt > FLOW_IDLE_TTL_MS || now - flow.createdAt > FLOW_MAX_TTL_MS;
  }

  private prune(): void {
    const now = Date.now();
    this.ledger.prune(now);
    this.rates.prune(now);
    for (const [id, tap] of this.pending) {
      const expired =
        tap.state === "pending"
          ? now - tap.tapTime > PENDING_TTL_MS
          : tap.state === "ambiguous"
            ? now - (tap.resolvedAt ?? tap.tapTime) > AMBIGUOUS_TTL_MS
            : this.pairExpired(tap, now);
      if (expired) {
        if (tap.state === "pending") {
          logBumpEvent({ ev: "lone", ...motionOf(tap) });
          this.stat((s) => s.lone++);
        }
        this.remove(id);
      }
    }
  }

  private isDecided(tap: PendingTap): boolean {
    return tap.pairId !== undefined && this.pairs.get(tap.pairId)?.senderId !== undefined;
  }

  private markAmbiguous(tap: PendingTap, now: number, level: MatchLevel): void {
    if (tap.state === "ambiguous") return;
    if (tap.pairId) this.pairs.delete(tap.pairId);
    tap.level = level;
    tap.state = "ambiguous";
    tap.resolvedAt = now;
    tap.pairId = undefined;
    tap.pairedWithId = undefined;
    tap.peerAddress = undefined;
    tap.settleAt = undefined;
    this.notify(tap.id);
  }

  // Resolves once `id` stops being pending, or at the latest when it can no
  // longer be matched (PENDING_TTL_MS after its tap time).
  private waitWhilePending(id: string): Promise<void> {
    const tap = this.pending.get(id);
    if (!tap || tap.state !== "pending") return Promise.resolve();
    const untilExpiry = Math.max(0, tap.tapTime + PENDING_TTL_MS - Date.now()) + 20;
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(untilExpiry, PENDING_TTL_MS + MAX_FUTURE_SKEW_MS + 20));
      set.add(done);
    });
  }

  private async handleTap(request: Request): Promise<Response> {
    if (this.pending.size >= MAX_PENDING) {
      this.stat((s) => s.busy++);
      return jsonResponse({ error: "Busy, try again shortly." }, 503);
    }

    const guard = request.headers.get("X-Bump-Guard") ?? undefined;
    if (guard !== undefined && !this.strikesOff && this.ledger.blocked(guard, Date.now())) {
      this.stat((s) => s.blocked++);
      return jsonResponse({ error: "Too many requests." }, 429);
    }

    let body: {
      address?: unknown;
      commit?: unknown;
      clientTapTime?: unknown;
      clockUncertaintyMs?: unknown;
      kind?: unknown;
      wait?: unknown;
      vertical?: unknown;
      rested?: unknown;
      noiseBefore?: unknown;
      post?: unknown;
      spreadMs?: unknown;
      warmSent?: unknown;
      warmSkipped?: unknown;
      spikesDropped?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid body." }, 400);
    }

    if (typeof body.address !== "string" || body.address.length === 0 || body.address.length > 200) {
      return jsonResponse({ error: "address is required (max 200 chars)." }, 400);
    }
    const address = body.address;
    if (typeof body.commit !== "string" || !COMMIT_RE.test(body.commit)) {
      return jsonResponse({ error: "commit is required (64 lowercase hex chars)." }, 400);
    }
    const commit = body.commit;
    const kind = parseKind(body.kind);
    if (kind === null) return jsonResponse({ error: "kind must be 'hard' or 'soft'." }, 400);

    // Telemetry only, counted for every well-formed tap whatever happens to
    // it below: the client hands these over once and does not resend them.
    const warmSent = Math.floor(parseNonNegative(body.warmSent) ?? 0);
    const warmSkipped = Math.floor(parseNonNegative(body.warmSkipped) ?? 0);
    const spikesDropped = Math.floor(parseNonNegative(body.spikesDropped) ?? 0);
    if (warmSent > 0 || warmSkipped > 0 || spikesDropped > 0) {
      this.stat((s) => {
        s.warmSent += warmSent;
        s.warmSkipped += warmSkipped;
        s.spikesDropped += spikesDropped;
      });
    }

    const cf: BumpCf = {
      colo: request.headers.get("X-Bump-Colo") ?? undefined,
      city: request.headers.get("X-Bump-City") ?? undefined,
      country: request.headers.get("X-Bump-Country") ?? undefined,
    };
    const net = request.headers.get("X-Bump-Net") ?? undefined;

    const serverTime = Date.now();
    const time = resolveTapTime(body.clientTapTime, body.clockUncertaintyMs, serverTime);
    // No usable tap time: it can't match anything, so it is never stored.
    // It used to be answered exactly like a tap nobody else made, which left
    // the single commonest network failure invisible: on a slow connection
    // every tap vanished without a word and the phone simply looked broken.
    // The reason is named now, so the client can say the network was too
    // slow instead of nothing at all (src/lib/bump/bump.ts's sendCandidate). Only
    // a tap whose time was usable but stale says "late": a missing or
    // nonsensical value is a client bug, not something to blame the network
    // for, and stays silent as before.
    if (!time) {
      const claimed =
        typeof body.clientTapTime === "number" && Number.isFinite(body.clientTapTime) ? body.clientTapTime : null;
      const reason = claimed === null ? undefined : claimed < serverTime ? "late" : "skew";
      this.stat((s) => {
        if (reason === "late") s.late++;
        else if (reason === "skew") s.skew++;
      });
      return jsonResponse({
        state: "expired",
        reason,
        lagMs: claimed === null ? undefined : Math.round(serverTime - claimed),
        serverTime,
      });
    }

    // Counted before any of the refusals below, so a source that keeps being
    // refused stays hot for as long as it keeps sending.
    if (guard !== undefined) {
      const recent = this.rates.record(guard, serverTime);
      const hot = isHot(recent);
      this.stat((s) => {
        if (recent > 0) s.srcRate[histogramBucket(recent, SRC_RATE_BUCKET, SRC_RATE_BUCKETS)]++;
        if (hot) s.hot++;
      });
      if (hot && this.dropHotSources) return jsonResponse({ error: "Too many requests." }, 429);
    }

    if (net !== undefined) {
      let fromNet = 0;
      for (const t of this.pending.values()) if (t.state === "pending" && t.net === net) fromNet++;
      if (fromNet >= MAX_PENDING_PER_NET) {
        this.stat((s) => s.netCap++);
        return jsonResponse({ error: "Too many requests." }, 429);
      }
    }
    if (guard !== undefined) {
      let fromGuard = 0;
      for (const t of this.pending.values()) if (t.state === "pending" && t.guard === guard) fromGuard++;
      if (fromGuard >= MAX_PENDING_PER_GUARD) {
        this.stat((s) => s.guardCap++);
        return jsonResponse({ error: "Too many requests." }, 429);
      }
    }

    // A phone in a pairing nobody has chosen a direction for yet (its
    // session stops listening at that point, but a candidate can still be
    // on the wire) is not a third party to that pairing, and must not pair
    // with anyone else either. Once the pairing is decided, cancelled or
    // gone, the phone is free again: it may well be about to bump someone
    // else.
    for (const t of this.pending.values()) {
      if (t.state !== "paired" || t.address !== address) continue;
      const flow = t.pairId ? this.pairs.get(t.pairId) : undefined;
      if (flow && !flow.senderId && flow.stage !== "cancelled") {
        this.stat((s) => s.inPairing++);
        return jsonResponse({ state: "expired", serverTime });
      }
    }

    const id = crypto.randomUUID();
    const me: PendingTap = {
      id,
      kind,
      commit,
      tapTime: time.tapTime,
      uncertaintyMs: time.uncertaintyMs,
      lagMs: Math.round(serverTime - time.tapTime),
      address,
      cf,
      net,
      guard,
      state: "pending",
      vertical: parseUnit(body.vertical),
      rested: typeof body.rested === "boolean" ? body.rested : undefined,
      noiseBefore:
        typeof body.noiseBefore === "number" && Number.isFinite(body.noiseBefore)
          ? Math.min(Math.max(body.noiseBefore, 0), 100)
          : undefined,
      post: parseNonNegative(body.post),
      spreadMs: parseNonNegative(body.spreadMs),
    };
    me.shaped = me.post !== undefined && me.spreadMs !== undefined;
    const claimedUnc =
      typeof body.clockUncertaintyMs === "number" && Number.isFinite(body.clockUncertaintyMs) && body.clockUncertaintyMs >= 0
        ? body.clockUncertaintyMs
        : undefined;
    this.stat((s) => {
      if (kind === "hard") s.tapHard++;
      else s.tapSoft++;
      s.lag[histogramBucket(me.lagMs ?? 0, LAG_BUCKET_MS, LAG_BUCKETS)]++;
      s.unc[histogramBucket(time.uncertaintyMs, UNC_BUCKET_MS, UNC_BUCKETS)]++;
      if (typeof claimedUnc === "number") {
        s.uncRaw[histogramBucket(claimedUnc, UNC_RAW_BUCKET_MS, UNC_RAW_BUCKETS)]++;
      }
    });

    // Fail closed: a tap pairs only if exactly one other phone could be its
    // partner and it doesn't land on anyone else's undecided pairing.
    // Anything more and everyone involved is told "ambiguous" and retaps.
    //
    // This used to rank candidates (same network over same city, hard over
    // soft) and let a closer late tap take a pairing over. Every one of
    // those signals is something a third party can simply have or claim:
    // "hard" is a field in the request, and "same network" is anyone on the
    // same café wifi or behind the same carrier NAT. So ranking let a
    // stranger outrank the real partner, who was then told "ambiguous"
    // while the payer saw a perfectly normal pairing, with the stranger's
    // address. A coincidence now costs one retap instead.
    //
    // A pairing whose direction has been chosen is out of reach by
    // construction: choosing waits for settleAt (handleChoose), after which
    // no tap in range of it can arrive any more.
    const byAddress = new Map<string, { tap: PendingTap; level: MatchLevel }>();
    const collisions: { tap: PendingTap; level: MatchLevel }[] = [];
    for (const tap of this.pending.values()) {
      const level = pairLevel(tap, me);
      if (level === 0) {
        if (pairLevel(tap, me, true) !== 0) {
          logBumpEvent({ ev: "veto", dt: me.tapTime - tap.tapTime, a: motionOf(tap), b: motionOf(me) });
          this.stat((s) => s.veto++);
        }
        continue;
      }
      if (tap.state === "pending") {
        // At most one candidate per phone (its hard tap and a soft one can
        // both be in range); the one closest in time is the likelier match.
        const prev = byAddress.get(tap.address);
        if (!prev || Math.abs(tap.tapTime - me.tapTime) < Math.abs(prev.tap.tapTime - me.tapTime)) {
          byAddress.set(tap.address, { tap, level });
        }
      } else if (tap.state === "ambiguous" || !this.isDecided(tap)) {
        collisions.push({ tap, level });
      }
    }
    const candidates = [...byAddress.values()];

    if (candidates.length === 1 && collisions.length === 0) {
      const { tap: partner, level } = candidates[0];
      const pairId = crypto.randomUUID();
      this.pairs.set(pairId, { stage: "choosing", version: 1, createdAt: serverTime, lastActivityAt: serverTime });
      const deltaMs = me.tapTime - partner.tapTime;
      const settleAt = settleAtFor(partner, me);
      partner.state = "paired";
      partner.level = level;
      partner.resolvedAt = serverTime;
      partner.pairId = pairId;
      partner.pairedWithId = id;
      partner.peerAddress = address;
      partner.deltaMs = -deltaMs;
      partner.partnerCf = cf;
      partner.settleAt = settleAt;
      this.pending.set(id, {
        ...me,
        state: "paired",
        level,
        resolvedAt: serverTime,
        pairId,
        pairedWithId: partner.id,
        peerAddress: partner.address,
        deltaMs,
        partnerCf: partner.cf,
        settleAt,
      });
      // Both phones are now committed to this pair. Their other
      // still-pending candidates must not go on to pair with a stranger
      // and pop an emoji screen up on a phone that isn't part of this.
      for (const tap of [...this.pending.values()]) {
        if (tap.state === "pending" && (tap.address === address || tap.address === partner.address)) this.remove(tap.id);
      }
      this.notify(partner.id);
      logBumpEvent({ ev: "pair", dt: deltaMs, level, a: motionOf(partner), b: motionOf(me) });
      const crossed = crossCountry(partner, me);
      this.stat((s) => {
        s.pair++;
        s.pairByLevel[level]++;
        if (crossed) s.pairCrossCountry++;
        s.dt[histogramBucket(Math.abs(deltaMs), DT_BUCKET_MS, DT_BUCKETS)]++;
      });
    } else if (candidates.length > 0 || collisions.length > 0) {
      // A poisoned pair takes both of its members down, even if only one
      // was in range.
      const level = Math.max(...candidates.map((c) => c.level), ...collisions.map((c) => c.level)) as MatchLevel;
      const affected = [...candidates.map((c) => c.tap), ...collisions.map((c) => c.tap)];
      for (const tap of [...affected]) {
        const other = tap.state === "paired" && tap.pairedWithId ? this.pending.get(tap.pairedWithId) : undefined;
        if (other) affected.push(other);
      }
      for (const tap of affected) this.markAmbiguous(tap, serverTime, level);
      this.pending.set(id, { ...me, state: "ambiguous", level, resolvedAt: serverTime });
      if (!this.strikesOff) {
        for (const key of hotSources([...affected, me], (g) => this.rates.count(g, serverTime))) {
          this.stat((s) => s.struck++);
          if (this.ledger.strike(key, serverTime)) logBumpEvent({ ev: "block", forMs: BLOCK_MS });
        }
      }
      logBumpEvent({ ev: "ambiguous", level, taps: affected.length + 1 });
      this.stat((s) => s.ambiguous++);
    } else {
      this.pending.set(id, me);
    }

    if (body.wait !== true) return jsonResponse({ id, serverTime });
    await this.waitWhilePending(id);
    this.prune();
    return jsonResponse({ id, serverTime, ...this.statusFor(id) });
  }

  // POST /reveal {id, nonce}: the second half of the commit-reveal (see
  // bumpCommitment). Accepted only for a paired tap, only if it matches the
  // commitment its tap carried, and only once. Wakes the other phone's
  // long-poll, whose status then carries this nonce as its peerNonce.
  private async handleReveal(request: Request): Promise<Response> {
    let body: { id?: unknown; nonce?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid body." }, 400);
    }
    if (typeof body.id !== "string" || typeof body.nonce !== "string" || !BUMP_NONCE_RE.test(body.nonce)) {
      return jsonResponse({ error: "id and nonce (32 lowercase hex chars) are required." }, 400);
    }
    const tap = this.pending.get(body.id);
    if (!tap || tap.state !== "paired") {
      return jsonResponse({ error: "Unknown or unpaired id.", state: tap?.state ?? "expired" }, 404);
    }
    this.touch(tap, Date.now());
    if (tap.nonce !== undefined) {
      return tap.nonce === body.nonce
        ? jsonResponse(this.statusFor(tap.id))
        : jsonResponse({ error: "Already revealed." }, 409);
    }
    if ((await bumpCommitment(tap.address, body.nonce)) !== tap.commit) {
      return jsonResponse({ error: "Nonce does not match the commitment." }, 400);
    }
    // The await above yields: the tap may have been resolved or pruned since.
    if (this.pending.get(tap.id) !== tap || tap.state !== "paired") {
      return jsonResponse({ error: "Unknown or unpaired id.", state: tap.state }, 404);
    }
    tap.nonce = body.nonce;
    // A version bump, not just a wake-up: the other phone's long-poll may
    // still be on the wire, carrying the version it saw before this reveal.
    // Waking only the polls already held here left that late one waiting
    // out the full STATUS_WAIT_MAX_MS for a change that had already
    // happened, so that phone showed nothing for ~8s (and could time out
    // its verification altogether). Live, 2026-09-19.
    const flow = tap.pairId ? this.pairs.get(tap.pairId) : undefined;
    if (flow) this.bumpFlow(tap, flow);
    return jsonResponse(this.statusFor(tap.id));
  }

  // GET /status?id=…&v=N holds the request (up to STATUS_WAIT_MAX_MS) while
  // the pair's flow is still at version N, so a stage change on one phone
  // reaches the other within one round trip instead of a poll interval.
  private async handleStatus(url: URL): Promise<Response> {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id." }, 400);
    const tap = this.pending.get(id);
    if (tap) this.touch(tap, Date.now());
    const known = Number(url.searchParams.get("v"));
    const flow = tap?.pairId ? this.pairs.get(tap.pairId) : undefined;
    if (tap && flow && Number.isInteger(known) && known === flow.version) {
      this.activeWaits.set(id, (this.activeWaits.get(id) ?? 0) + 1);
      try {
        await this.waitForChange(id, STATUS_WAIT_MAX_MS);
      } finally {
        const left = (this.activeWaits.get(id) ?? 1) - 1;
        if (left > 0) this.activeWaits.set(id, left);
        else this.activeWaits.delete(id);
      }
      this.prune();
      const after = this.pending.get(id);
      if (after) this.touch(after, Date.now());
    }
    return jsonResponse(this.statusFor(id));
  }

  private waitForChange(id: string, maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, maxMs);
      set.add(done);
    });
  }

  private statusFor(id: string): Record<string, unknown> {
    const tap = this.pending.get(id);
    if (!tap) return { state: "expired" };
    if (tap.state === "pending") return { state: "pending" };
    if (tap.state === "ambiguous") return { state: "ambiguous" };

    const now = Date.now();
    const flow = tap.pairId ? this.pairs.get(tap.pairId) : undefined;
    const senderId = flow?.senderId;
    const settlesInMs = senderId ? 0 : Math.max(0, (tap.settleAt ?? 0) - now);
    const peer = tap.pairedWithId ? this.pending.get(tap.pairedWithId) : undefined;
    const peerSeenAgoMs =
      peer && (this.activeWaits.get(peer.id) ?? 0) > 0 ? 0 : Math.max(0, now - (peer?.lastSeenAt ?? tap.resolvedAt ?? now));
    return {
      state: "paired",
      deltaMs: tap.deltaMs,
      partnerCf: tap.partnerCf,
      peerAddress: tap.peerAddress,
      // Commit-reveal (see bumpCommitment): the partner's commitment always,
      // its nonce only once this phone has revealed its own, so neither side
      // ever sees the other's nonce before being bound to its own.
      peerCommit: peer?.commit,
      peerNonce: tap.nonce !== undefined ? peer?.nonce : undefined,
      role: senderId ? (senderId === id ? "send" : "receive") : undefined,
      // Until this reaches 0 a late tap can still turn the pairing
      // ambiguous (see handleTap), and handleChoose refuses a direction.
      settlesInMs,
      v: flow?.version ?? 0,
      flow: flow
        ? {
            stage: flow.stage,
            amountSats: flow.amountSats,
            cancelledBy: flow.cancelledBy ? (flow.cancelledBy === id ? "me" : "peer") : undefined,
          }
        : undefined,
      // How long since the other phone last talked to this pair (0 while
      // it has a long-poll open). Lets a phone waiting on the other one
      // say "druhý telefon neodpovídá" instead of waiting forever.
      peerSeenAgoMs,
    };
  }

  // POST /progress {id, stage, amountSats?}: one phone moving the shared
  // flow forward (see nextFlowStage for who may do what).
  private async handleProgress(request: Request): Promise<Response> {
    let body: { id?: unknown; stage?: unknown; amountSats?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid body." }, 400);
    }
    if (typeof body.id !== "string" || typeof body.stage !== "string") {
      return jsonResponse({ error: "id and stage are required." }, 400);
    }
    const tap = this.pending.get(body.id);
    const flow = tap?.pairId ? this.pairs.get(tap.pairId) : undefined;
    const requested = body.stage as FlowStage;
    // Cancelling is the one move allowed before anyone picked a direction
    // ("Emoji nesedí"), so the other phone learns about it too.
    if (!tap || tap.state !== "paired" || !flow || (!flow.senderId && requested !== "cancelled")) {
      return jsonResponse({ error: "Unknown or undecided pairing.", state: tap?.state ?? "expired" }, 404);
    }
    this.touch(tap, Date.now());
    if (requested === "sending") {
      const amount = body.amountSats;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_SATS) {
        return jsonResponse({ error: "amountSats must be a positive integer." }, 400);
      }
    }
    const next = nextFlowStage(flow.stage, flow.senderId === tap.id, requested);
    if (next === null) return jsonResponse({ error: "Not allowed now.", ...this.statusFor(tap.id) }, 409);
    if (next !== flow.stage) {
      flow.stage = next;
      if (next === "sending") flow.amountSats = body.amountSats as number;
      if (next === "cancelled") flow.cancelledBy = tap.id;
      if (isDoneStage(next)) flow.doneAt = Date.now();
      this.bumpFlow(tap, flow);
    }
    return jsonResponse(this.statusFor(tap.id));
  }

  // Records which side of an already-paired tap ends up sending. Only the
  // *first* call for a given pair has any effect — see this class's own
  // `pairs` field comment for why that's what lets the other phone switch
  // on its own. Choosing also moves the flow from "choosing" to "entering".
  private async handleChoose(request: Request): Promise<Response> {
    let body: { id?: unknown; choice?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid body." }, 400);
    }
    if (typeof body.id !== "string" || (body.choice !== "send" && body.choice !== "receive")) {
      return jsonResponse({ error: "id and choice ('send'|'receive') are required." }, 400);
    }
    const tap = this.pending.get(body.id);
    if (tap?.state === "ambiguous") {
      return jsonResponse({ error: "Pairing became ambiguous.", state: "ambiguous" }, 409);
    }
    if (!tap || tap.state !== "paired" || !tap.pairId || !tap.pairedWithId) {
      return jsonResponse({ error: "Unknown or unpaired id." }, 404);
    }
    const flow = this.pairs.get(tap.pairId);
    if (!flow) return jsonResponse({ error: "Unknown or unpaired id." }, 404);
    this.touch(tap, Date.now());
    if (flow.stage === "cancelled") return jsonResponse({ error: "Cancelled.", state: "cancelled" }, 409);
    if (!flow.senderId) {
      // Not before both phones revealed their nonces (without them there is
      // no emoji to have compared), and not before settleAt: until then a
      // late tap can still turn this pairing ambiguous, and that late tap
      // may well be the real partner. Choosing used to be possible at once
      // and locked the pair, so a quick "Platím" on a pairing with a
      // stranger simply ignored the real partner's slower request.
      const peer = this.pending.get(tap.pairedWithId);
      if (tap.nonce === undefined || peer?.nonce === undefined) {
        return jsonResponse({ error: "Not verified yet.", state: "unverified" }, 409);
      }
      const settlesInMs = Math.max(0, (tap.settleAt ?? 0) - Date.now());
      if (settlesInMs > 0) return jsonResponse({ error: "Still settling.", state: "settling", settlesInMs }, 409);
      flow.senderId = body.choice === "send" ? tap.id : tap.pairedWithId;
      flow.stage = "entering";
      this.bumpFlow(tap, flow);
    }
    return jsonResponse({ role: flow.senderId === tap.id ? "send" : "receive" });
  }
}
