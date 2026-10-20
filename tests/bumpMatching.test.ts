// worker/bump.ts matches taps on their clock-synced physical tap time, not
// on when each request reached the Durable Object. These drive the real
// BumpLab class (it has no Cloudflare-specific dependencies) with a faked
// Date.now(), so arrival time and tap time can be set independently.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BumpLab,
  BUMP_MATCHING,
  bumpCommitment,
  bumpRateLimitKey,
  BLOCK_MS,
  crossCountry,
  guardPrefix,
  HOT_SOURCE_TAPS,
  hotSources,
  isHot,
  MAX_PENDING_PER_GUARD,
  SOURCE_RATE_WINDOW_MS,
  SourceRateMeter,
  StrikeLedger,
  STRIKE_LIMIT,
  STRIKE_WINDOW_MS,
  histogramBucket,
  type BumpDayStats,
  matchLevel,
  networkPrefix,
  nextFlowStage,
  pairLevel,
  resolveTapTime,
  verticalVeto,
  type FlowStage,
} from "../worker/bump";

const T0 = 1_800_000_000_000;
const { MAX_CLOCK_UNCERTAINTY_MS, MAX_ARRIVAL_LAG_MS, MAX_FUTURE_SKEW_MS, MAX_MATCH_SPAN_MS, PENDING_TTL_MS, SENSOR_WINDOW_BY_LEVEL } =
  BUMP_MATCHING;
// Taps below carry no Cloudflare location headers, so every pair of them
// is "same city" (both unknown): MatchLevel 2 and its window.
const W = SENSOR_WINDOW_BY_LEVEL[2];

type Status = {
  state: string;
  role?: string;
  peerAddress?: string;
  peerCommit?: string;
  peerNonce?: string;
  settlesInMs?: number;
  deltaMs?: number;
};

function at(ms: number): void {
  vi.setSystemTime(T0 + ms);
}

// A fixed, valid nonce per address, so tests can reveal without tracking it.
function nonceFor(address: string): string {
  let h = 0;
  for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(4);
}

// Synchronous twin of bumpCommitment (pinned to it by a test below), so the
// fake-timer tests never have to await real crypto between steps.
function commitSync(address: string, nonce: string): string {
  return createHash("sha256").update(`spendrr-bump-commit-v1:${address.length}:${address}:${nonce}`).digest("hex");
}

function tapBody(address: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ address, commit: commitSync(address, nonceFor(address)), kind: "hard", ...extra });
}

// Returns the new tap's id, or undefined when the server refused to store it.
async function tap(
  lab: BumpLab,
  arriveAt: number,
  address: string,
  tapAt?: number,
  uncertaintyMs: number | undefined = 0,
): Promise<string> {
  const body = tapBody(address, {
    clientTapTime: tapAt === undefined ? undefined : T0 + tapAt,
    clockUncertaintyMs: tapAt === undefined ? undefined : uncertaintyMs,
  });
  at(arriveAt);
  const res = await lab.fetch(new Request("https://x/api/bump/tap", { method: "POST", body }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function status(lab: BumpLab, id: string, when?: number): Promise<Status> {
  if (when !== undefined) at(when);
  const res = await lab.fetch(new Request(`https://x/api/bump/status?id=${id}`));
  return (await res.json()) as Status;
}

function reveal(lab: BumpLab, id: string, nonce: string): Promise<Response> {
  return lab.fetch(new Request("https://x/api/bump/reveal", { method: "POST", body: JSON.stringify({ id, nonce }) }));
}

// Both phones reveal (by their tap's address), then time moves past the
// point where a direction may be chosen.
async function readyToChoose(lab: BumpLab, ids: [string, string], addresses: [string, string], settleAt: number) {
  for (let i = 0; i < 2; i++) expect((await reveal(lab, ids[i], nonceFor(addresses[i]))).status).toBe(200);
  at(settleAt);
}

async function choose(lab: BumpLab, id: string, choice: "send" | "receive"): Promise<Response> {
  return lab.fetch(new Request("https://x/api/bump/choose", { method: "POST", body: JSON.stringify({ id, choice }) }));
}

// When a pair of taps at tap times t1 < t2 may first be chosen for.
const settleFor = (t2: number) => t2 + MAX_MATCH_SPAN_MS + MAX_ARRIVAL_LAG_MS;

describe("resolveTapTime", () => {
  const now = T0;
  it("trusts a plausible client tap time and clamps its uncertainty", () => {
    expect(resolveTapTime(now - 1200, 20, now)).toEqual({ tapTime: now - 1200, uncertaintyMs: 20 });
    expect(resolveTapTime(now - 10, 99999, now)?.uncertaintyMs).toBe(MAX_CLOCK_UNCERTAINTY_MS);
    // Claiming no (or a nonsensical) uncertainty never buys a narrower
    // window than the cap, nor a wider one.
    expect(resolveTapTime(now - 10, undefined, now)?.uncertaintyMs).toBe(MAX_CLOCK_UNCERTAINTY_MS);
    expect(resolveTapTime(now - 10, -5, now)?.uncertaintyMs).toBe(MAX_CLOCK_UNCERTAINTY_MS);
  });

  it("accepts the exact edges of the allowed range", () => {
    expect(resolveTapTime(now - MAX_ARRIVAL_LAG_MS, 0, now)).not.toBeNull();
    expect(resolveTapTime(now + MAX_FUTURE_SKEW_MS, 0, now)).not.toBeNull();
  });

  it("refuses anything implausible outright (no arrival-time fallback any more)", () => {
    for (const bad of [now - MAX_ARRIVAL_LAG_MS - 1, now + MAX_FUTURE_SKEW_MS + 1, NaN, Infinity, "123", null, undefined, 0]) {
      expect(resolveTapTime(bad, 0, now)).toBeNull();
    }
  });

  it("can't place a tap further in the future than the clock sync can be off", () => {
    expect(MAX_FUTURE_SKEW_MS).toBeLessThanOrEqual(MAX_CLOCK_UNCERTAINTY_MS + 50);
    expect(MAX_CLOCK_UNCERTAINTY_MS).toBeLessThanOrEqual(150);
  });
});

describe("BumpLab pairing on tap time", () => {
  let lab: BumpLab;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lab = new BumpLab(null, null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pairs two simultaneous taps even when one request arrives over a second late (the bug this fixes)", async () => {
    // Arrival times 1.3s apart: the old arrival-time matching (900ms
    // window) left both unpaired.
    const a = await tap(lab, 100, "ark1a", 0);
    const b = await tap(lab, 1400, "ark1b", 20);
    const sa = await status(lab, a);
    const sb = await status(lab, b);
    expect(sa.state).toBe("paired");
    expect(sa.peerAddress).toBe("ark1b");
    expect(sb.peerAddress).toBe("ark1a");
    expect(sb.deltaMs).toBe(20);
    expect(sa.deltaMs).toBe(-20);
  });

  it("does not pair taps that arrive together but physically happened far apart", async () => {
    const a = await tap(lab, 1300, "ark1a", 1000);
    const b = await tap(lab, 1350, "ark1b", 1000 + W + 1);
    expect((await status(lab, a)).state).toBe("pending");
    expect((await status(lab, b)).state).toBe("pending");
  });

  it("widens the window by both taps' clock uncertainty, capped", async () => {
    const a = await tap(lab, 0, "ark1a", 0, MAX_CLOCK_UNCERTAINTY_MS);
    const b = await tap(lab, 1200, "ark1b", W + 2 * MAX_CLOCK_UNCERTAINTY_MS, MAX_CLOCK_UNCERTAINTY_MS);
    expect((await status(lab, b)).state).toBe("paired");

    const lab2 = new BumpLab(null, null);
    const c = await tap(lab2, 10_000, "ark1c", 10_000, 1e9);
    const d = await tap(lab2, 11_000, "ark1d", 10_000 + MAX_MATCH_SPAN_MS + 1, 1e9);
    expect((await status(lab2, c)).state).toBe("pending");
    expect((await status(lab2, d)).state).toBe("pending");
    void a;
  });

  it("keeps a lone tap matchable for a partner at the maximum tolerated lag", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    const b = await tap(lab, W + MAX_ARRIVAL_LAG_MS, "ark1b", W);
    expect((await status(lab, a)).state).toBe("paired");
    expect((await status(lab, b)).state).toBe("paired");
  });

  it("expires a lone tap once no partner could still arrive", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    expect((await status(lab, a, PENDING_TTL_MS)).state).toBe("pending");
    expect((await status(lab, a, PENDING_TTL_MS + 1)).state).toBe("expired");
  });

  it("a tap without a tap time is answered 'expired' and never stored (no arrival-time fallback)", async () => {
    at(0);
    const res = await lab.fetch(new Request("https://x/api/bump/tap", { method: "POST", body: tapBody("ark1a", {}) }));
    expect(await res.json()).toMatchObject({ state: "expired" });
    // Nothing for a partner to pair with.
    const b = await tap(lab, 10, "ark1b", 10);
    expect((await status(lab, b)).state).toBe("pending");
  });

  it("three taps in one window are ambiguous for everyone", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    const b = await tap(lab, 10, "ark1b", 10);
    expect((await status(lab, a)).state).toBe("paired");
    const c = await tap(lab, 20, "ark1c", 20);
    for (const id of [a, b, c]) expect((await status(lab, id)).state).toBe("ambiguous");
  });

  it("a late-arriving third tap poisons an undecided pair, and choose() then reports it", async () => {
    const a = await tap(lab, 50, "ark1a", 0);
    const b = await tap(lab, 60, "ark1b", 10);
    const before = await status(lab, a);
    expect(before.state).toBe("paired");
    expect(before.settlesInMs).toBeGreaterThan(0);

    // Tapped at the same moment, but its request took 1.4s.
    const c = await tap(lab, 1400, "ark1c", 5);
    for (const id of [a, b, c]) expect((await status(lab, id)).state).toBe("ambiguous");

    const res = await choose(lab, a, "send");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "ambiguous" });
  });

  it("a late tap poisons both members of a pair even if it's only in range of one", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    const b = await tap(lab, 10, "ark1b", W);
    // In range of b (diff W), not of a (diff 2W).
    const c = await tap(lab, 1000, "ark1c", 2 * W);
    expect((await status(lab, a)).state).toBe("ambiguous");
    expect((await status(lab, b)).state).toBe("ambiguous");
    expect((await status(lab, c)).state).toBe("ambiguous");
  });

  it("a direction can't be chosen until no late tap can arrive any more (the late tap may be the real partner)", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    const b = await tap(lab, 10, "ark1b", 10);
    for (const [id, addr] of [[a, "ark1a"], [b, "ark1b"]]) expect((await reveal(lab, id, nonceFor(addr))).status).toBe(200);

    at(500);
    const early = await choose(lab, a, "send");
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ state: "settling", settlesInMs: settleFor(10) - 500 });

    // The real partner's request was slow: it still gets to poison the pair.
    const c = await tap(lab, 1400, "ark1c", 5);
    for (const id of [a, b, c]) expect((await status(lab, id)).state).toBe("ambiguous");
  });

  it("once settled and chosen, the pair is decided", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    const b = await tap(lab, 10, "ark1b", 10);
    await readyToChoose(lab, [a, b], ["ark1a", "ark1b"], settleFor(10));
    expect(await (await choose(lab, a, "send")).json()).toEqual({ role: "send" });
    expect((await status(lab, a)).settlesInMs).toBe(0);
    expect((await status(lab, b)).role).toBe("receive");
  });

  it("settlesInMs reaches 0 exactly when no colliding tap can arrive any more", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    await tap(lab, 10, "ark1b", 10);
    const settleAt = 10 + MAX_MATCH_SPAN_MS + MAX_ARRIVAL_LAG_MS;
    expect((await status(lab, a, settleAt - 1)).settlesInMs).toBe(1);
    expect((await status(lab, a, settleAt)).settlesInMs).toBe(0);

    // The latest-possible colliding tap, one ms past the bound: its claimed
    // tap time is too old to be trusted, so it's refused outright.
    const c = await tap(lab, settleAt + 1, "ark1c", 10 + MAX_MATCH_SPAN_MS);
    expect(c).toBeUndefined();
    expect((await status(lab, a)).state).toBe("paired");
  });

  it("the latest colliding tap still inside the bound is caught", async () => {
    const a = await tap(lab, 0, "ark1a", 0, MAX_CLOCK_UNCERTAINTY_MS);
    await tap(lab, 10, "ark1b", 10, MAX_CLOCK_UNCERTAINTY_MS);
    const latest = 10 + W + 2 * MAX_CLOCK_UNCERTAINTY_MS;
    await tap(lab, latest + MAX_ARRIVAL_LAG_MS, "ark1c", latest, MAX_CLOCK_UNCERTAINTY_MS);
    expect((await status(lab, a)).state).toBe("ambiguous");
    expect(latest + MAX_ARRIVAL_LAG_MS).toBeLessThanOrEqual(settleFor(10));
  });

  it("a tap claiming an old tap time can't reach back to a stale pending tap", async () => {
    const a = await tap(lab, 0, "ark1a", 0);
    // Claims the same tap time, but arrives beyond the tolerated lag.
    const b = await tap(lab, MAX_ARRIVAL_LAG_MS + 1, "ark1b", 0);
    expect(b).toBeUndefined();
    expect((await status(lab, a)).state).toBe("pending");
  });
});

describe("BumpLab silent-until-paired kinds", () => {
  const { SENSOR_MATCH_WINDOW_MS } = BUMP_MATCHING;
  let lab: BumpLab;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    lab = new BumpLab(null, null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function post(arriveAt: number, address: string, tapAt: number, kind: string | undefined, wait = false): Promise<Response> {
    const body = tapBody(address, { clientTapTime: T0 + tapAt, clockUncertaintyMs: 0, kind, wait });
    at(arriveAt);
    return lab.fetch(new Request("https://x/api/bump/tap", { method: "POST", body }));
  }
  async function send(arriveAt: number, address: string, tapAt: number, kind: string): Promise<string> {
    return ((await (await post(arriveAt, address, tapAt, kind)).json()) as { id: string }).id;
  }

  it("soft pairs with hard, but soft never pairs with soft", async () => {
    const a = await send(0, "ark1a", 0, "soft");
    const b = await send(10, "ark1b", 20, "soft");
    expect((await status(lab, a)).state).toBe("pending");
    expect((await status(lab, b)).state).toBe("pending");

    const lab2 = new BumpLab(null, null);
    lab = lab2;
    const c = await send(1000, "ark1c", 1000, "hard");
    const d = await send(1010, "ark1d", 1020, "soft");
    expect((await status(lab, c)).peerAddress).toBe("ark1d");
    expect((await status(lab, d)).peerAddress).toBe("ark1c");
  });

  it("two sensor taps use the tight window", async () => {
    const a = await send(0, "ark1a", 0, "hard");
    const b = await send(10, "ark1b", SENSOR_MATCH_WINDOW_MS + 1, "hard");
    expect((await status(lab, a)).state).toBe("pending");
    expect((await status(lab, b)).state).toBe("pending");
  });

  it("the old wide-window kinds (manual, none at all) are refused, never stored", async () => {
    await send(0, "ark1a", 0, "hard");
    for (const kind of ["manual", "legacy", undefined]) {
      const res = await post(10, "ark1b", 400, kind);
      expect(res.status).toBe(400);
    }
    expect([...(lab as unknown as { pending: Map<string, unknown> }).pending.values()]).toHaveLength(1);
  });

  it("a tap needs a well-formed commitment", async () => {
    for (const commit of [undefined, "", "abc", "A".repeat(64), "0".repeat(63)]) {
      at(0);
      const res = await lab.fetch(
        new Request("https://x/api/bump/tap", {
          method: "POST",
          body: JSON.stringify({ address: "ark1a", commit, kind: "hard", clientTapTime: T0, clockUncertaintyMs: 0 }),
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("a phone never pairs with its own earlier candidate", async () => {
    const a = await send(0, "ark1a", 0, "hard");
    const b = await send(10, "ark1a", 30, "soft");
    expect((await status(lab, a)).state).toBe("pending");
    expect((await status(lab, b)).state).toBe("pending");
  });

  it("two candidates from the same other phone in range are one partner, not an ambiguity", async () => {
    await send(0, "ark1b", 0, "hard");
    await send(10, "ark1b", 50, "soft");
    const m = await send(20, "ark1a", 40, "hard");
    const s = await status(lab, m);
    expect(s.state).toBe("paired");
    expect(s.peerAddress).toBe("ark1b");
    expect(s.deltaMs).toBe(-10); // the closer one (50) won
  });

  it("pairing discards both phones' other pending candidates so they can't pop up with a stranger later", async () => {
    const stray = await send(1000, "ark1a", 1000, "soft"); // an earlier jiggle of phone A
    await send(2000, "ark1a", 2000, "hard");
    await send(2010, "ark1b", 2020, "hard");
    expect((await status(lab, stray)).state).toBe("expired");
    // A stranger's hard tap matching the discarded stray finds nothing.
    const stranger = await send(2020, "ark1z", 1010, "hard");
    expect((await status(lab, stranger)).state).toBe("pending");
  });

  it("wait: true holds the request until the partner arrives and answers with the pairing", async () => {
    const held = post(0, "ark1a", 0, "hard", true);
    let answered = false;
    void held.then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(answered).toBe(false);
    await send(1500, "ark1b", 30, "soft");
    const body = (await (await held).json()) as Status & { id: string };
    expect(body.state).toBe("paired");
    expect(body.peerAddress).toBe("ark1b");
    expect(typeof body.id).toBe("string");
  });

  it("wait: true answers 'expired' once no partner could still arrive", async () => {
    const held = post(0, "ark1a", 0, "hard", true);
    await vi.advanceTimersByTimeAsync(BUMP_MATCHING.PENDING_TTL_MS + 100);
    expect(((await (await held).json()) as Status).state).toBe("expired");
  });

  it("wait: true answers immediately when the tap resolves on arrival", async () => {
    await send(0, "ark1a", 0, "hard");
    const body = (await (await post(10, "ark1b", 10, "hard", true)).json()) as Status;
    expect(body.state).toBe("paired");
    expect(body.peerAddress).toBe("ark1a");
  });

  it("a held request is answered 'ambiguous' when its pending tap gets caught in a three-way collision", async () => {
    // a and b are too far apart for each other, so both wait; c sits in the
    // window of both.
    const held = post(0, "ark1a", 0, "hard", true);
    await vi.advanceTimersByTimeAsync(0);
    await send(100, "ark1b", 60, "hard");
    await send(110, "ark1c", 30, "hard");
    expect(((await (await held).json()) as Status).state).toBe("ambiguous");
  });
});

describe("nextFlowStage", () => {
  const all: FlowStage[] = ["choosing", "entering", "sending", "sent", "received", "cancelled"];
  it("allows exactly the intended moves", () => {
    const allowed: string[] = [];
    for (const from of all)
      for (const to of all)
        for (const sender of [true, false])
          if (from !== to && nextFlowStage(from, sender, to) !== null) allowed.push(`${from}->${to}:${sender ? "S" : "R"}`);
    expect(allowed.sort()).toEqual(
      [
        "choosing->cancelled:S",
        "choosing->cancelled:R",
        "entering->cancelled:S",
        "entering->cancelled:R",
        "entering->sending:S",
        "sending->entering:S",
        "sending->sent:S",
        "sending->received:R",
        "sent->received:R",
      ].sort(),
    );
  });

  it("repeating the current stage is an idempotent no-op", () => {
    for (const s of all) expect(nextFlowStage(s, true, s)).toBe(s);
  });
});

describe("BumpLab shared payment flow", () => {
  let lab: BumpLab;
  let a: string;
  let b: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    lab = new BumpLab(null, null);
    a = await tap(lab, 0, "ark1a", 0);
    b = await tap(lab, 10, "ark1b", 10);
    await readyToChoose(lab, [a, b], ["ark1a", "ark1b"], settleFor(10));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Full = Status & { v: number; flow?: { stage: string; amountSats?: number; cancelledBy?: string }; peerSeenAgoMs: number };
  const full = async (id: string, v?: number) =>
    (await (await lab.fetch(new Request(`https://x/api/bump/status?id=${id}${v === undefined ? "" : `&v=${v}`}`))).json()) as Full;
  const progress = (id: string, stage: string, amountSats?: number) =>
    lab.fetch(new Request("https://x/api/bump/progress", { method: "POST", body: JSON.stringify({ id, stage, amountSats }) }));

  it("runs choose → amount → sent → received, each side seeing the other's steps", async () => {
    expect((await full(a)).flow?.stage).toBe("choosing");
    await choose(lab, a, "send");
    const r0 = await full(b);
    expect(r0.role).toBe("receive");
    expect(r0.flow).toEqual({ stage: "entering" });

    expect((await progress(b, "sending", 2500)).status).toBe(409); // receiver can't
    expect((await progress(a, "sending")).status).toBe(400); // no amount
    expect((await progress(a, "sending", 2500)).status).toBe(200);
    expect((await full(b)).flow).toEqual({ stage: "sending", amountSats: 2500 });

    expect((await progress(a, "sent")).status).toBe(200);
    expect((await progress(a, "received")).status).toBe(409); // sender can't confirm for the receiver
    expect((await progress(b, "received")).status).toBe(200);
    const s = await full(a);
    expect(s.flow?.stage).toBe("received");
    expect(s.v).toBeGreaterThan(r0.v);
  });

  it("the receiver cancelling blocks the sender from announcing a payment", async () => {
    await choose(lab, a, "send");
    expect((await progress(b, "cancelled")).status).toBe(200);
    const res = await progress(a, "sending", 1000);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Full).flow).toMatchObject({ stage: "cancelled", cancelledBy: "peer" });
  });

  it("'Symboly nesedí' before anyone chose cancels too, and a later choose is refused", async () => {
    expect((await progress(b, "cancelled")).status).toBe(200);
    expect((await full(a)).flow).toMatchObject({ stage: "cancelled", cancelledBy: "peer" });
    expect((await choose(lab, a, "send")).status).toBe(409);
  });

  it("nobody can cancel once money may be in flight", async () => {
    await choose(lab, a, "send");
    await progress(a, "sending", 1000);
    expect((await progress(b, "cancelled")).status).toBe(409);
    expect((await progress(a, "cancelled")).status).toBe(409);
  });

  it("a failed send goes back to entering and can be retried", async () => {
    await choose(lab, a, "send");
    await progress(a, "sending", 1000);
    expect((await progress(a, "entering")).status).toBe(200);
    expect((await full(b)).flow).toMatchObject({ stage: "entering" });
    expect((await progress(a, "sending", 900)).status).toBe(200);
    expect((await full(b)).flow).toMatchObject({ stage: "sending", amountSats: 900 });
  });

  it("status?v= holds until the other phone moves the flow, then answers at once", async () => {
    await choose(lab, a, "send");
    const { v } = await full(b);
    const held = full(b, v);
    let answered = false;
    void held.then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(3000);
    expect(answered).toBe(false);
    // While b holds a long-poll open, a sees it as connected.
    expect((await full(a)).peerSeenAgoMs).toBe(0);
    await progress(a, "sending", 4200);
    const after = await held;
    expect(after.v).toBe(v + 1);
    expect(after.flow).toMatchObject({ stage: "sending", amountSats: 4200 });
  });

  it("status?v= gives up after ~8s with nothing new", async () => {
    await choose(lab, a, "send");
    const { v } = await full(b);
    const held = full(b, v);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await held).v).toBe(v);
  });

  it("reports how long the other phone has been silent", async () => {
    await choose(lab, a, "send");
    at(20_000);
    await full(a);
    at(35_000);
    expect((await full(b)).peerSeenAgoMs).toBe(15_000);
  });

  it("an active pair outlives the choosing TTL, an idle one expires", async () => {
    await choose(lab, a, "send");
    for (let t = 30_000; t <= 150_000; t += 30_000) {
      at(t);
      expect((await full(a)).state).toBe("paired");
    }
    at(150_000 + 3 * 60_000 + 1);
    expect((await full(a)).state).toBe("expired");
  });

  it("without a choice the pair still expires on the choosing TTL", async () => {
    at(46_000);
    expect((await full(a)).state).toBe("expired");
  });
});

describe("network locality", () => {
  it("networkPrefix: whole IPv4, IPv6 /64 however it's written", () => {
    expect(networkPrefix("81.2.69.160")).toBe("81.2.69.160");
    expect(networkPrefix("2a00:1028:8390:6e0a:1c2f:9aa:3b1:77f2")).toBe("2a00:1028:8390:6e0a::/64");
    expect(networkPrefix("2a00:1028:8390:6e0a::1")).toBe("2a00:1028:8390:6e0a::/64");
    expect(networkPrefix("2A00:1028:8390:06E0A:0:0:0:1".replace("06E0A", "6E0A"))).toBe("2a00:1028:8390:6e0a::/64");
    expect(networkPrefix("2a00:0:0:0:ff::")).toBe("2a00:0:0:0::/64");
    expect(networkPrefix("::1")).toBe("0:0:0:0::/64");
  });

  it("matchLevel: network > city > anything else", () => {
    const prg = { country: "CZ", city: "Prague" };
    expect(matchLevel({ cf: prg, net: "x" }, { cf: { country: "CZ", city: "Brno" }, net: "x" })).toBe(3);
    expect(matchLevel({ cf: prg, net: "x" }, { cf: prg, net: "y" })).toBe(2);
    expect(matchLevel({ cf: prg }, { cf: { country: "CZ", city: "Brno" } })).toBe(1);
    // Two countries is level 1, not 0: the phones are touching, and an IP's
    // country is a guess that Private Relay or a carrier gateway routinely
    // gets a continent wrong. Same city name in two countries is level 1 too.
    expect(matchLevel({ cf: prg }, { cf: { country: "PT", city: "Lisbon" } })).toBe(1);
    expect(matchLevel({ cf: prg }, { cf: { country: "SK", city: "Prague" } })).toBe(1);
    // No city from Cloudflare: fall back to comparing colos.
    expect(matchLevel({ cf: { country: "CZ", colo: "PRG" } }, { cf: { country: "CZ", colo: "PRG" } })).toBe(2);
  });

  it("crossCountry flags a pair the old country gate would have refused", () => {
    expect(crossCountry({ cf: { country: "CZ" } }, { cf: { country: "PT" } })).toBe(true);
    expect(crossCountry({ cf: { country: "CZ" } }, { cf: { country: "CZ" } })).toBe(false);
    // Two unknowns compared equal before and still do.
    expect(crossCountry({ cf: {} }, { cf: {} })).toBe(false);
  });

  it("pairLevel: with nothing in common it takes two firm, shape-checked taps and the tightest window", () => {
    const tap = (
      kind: "hard" | "soft",
      address: string,
      tapTime: number,
      city: string,
      country = "CZ",
      shaped = true,
    ) => ({ kind, address, tapTime, uncertaintyMs: 0, cf: { country, city }, shaped });
    // Different countries pair now, on level 1's terms.
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("hard", "b", 10, "Lisbon", "PT"))).toBe(1);
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("hard", "b", 30, "Brno"))).toBe(1);
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("hard", "b", 31, "Brno"))).toBe(0);
    // Level 1 is the weakest evidence there is, so it is held to the
    // strictest terms: firm on both sides, and shape-checked on both.
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("soft", "b", 10, "Brno"))).toBe(0);
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("hard", "b", 10, "Brno", "CZ", false))).toBe(0);
    // A shared city still buys a softer tap and a wider window.
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("soft", "b", 35, "Prague"))).toBe(2);
    expect(pairLevel(tap("hard", "a", 0, "Prague"), tap("soft", "b", 36, "Prague"))).toBe(0);
  });

  it("pairLevel: two faint taps pair only if both passed the shape check, on one network", () => {
    const tap = (address: string, shaped: boolean, net?: string) => ({
      kind: "soft" as const,
      address,
      tapTime: 0,
      uncertaintyMs: 0,
      cf: { country: "CZ", city: "Prague" },
      net,
      shaped,
    });
    expect(pairLevel(tap("a", true, "home"), tap("b", true, "home"))).toBe(3);
    expect(pairLevel(tap("a", true, "home"), tap("b", false, "home"))).toBe(0); // an older client
    expect(pairLevel(tap("a", true, "home"), tap("b", true, "cafe"))).toBe(0); // same city only
  });
});

// Fail closed: no ranking between would-be partners any more. Every
// ranking signal (same network, hard vs. soft) is something a third party
// can have or claim, so a ranked pick could hand the payer a stranger's
// address while the real partner was merely told "ambiguous".
describe("BumpLab fails closed under load", () => {
  let lab: BumpLab;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    lab = new BumpLab(null, null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function send(
    arriveAt: number,
    address: string,
    tapAt: number,
    kind: "hard" | "soft",
    where: { net?: string; city?: string; country?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "X-Bump-Country": where.country ?? "CZ", "X-Bump-City": where.city ?? "Prague" };
    if (where.net) headers["X-Bump-Net"] = where.net;
    // Every real candidate carries the client's shape measurements, and
    // level 1 (nothing in common but the clock) now insists on them.
    const body = tapBody(address, { clientTapTime: T0 + tapAt, clockUncertaintyMs: 0, kind, post: 0.2, spreadMs: 90 });
    at(arriveAt);
    return lab.fetch(new Request("https://x/api/bump/tap", { method: "POST", headers, body }));
  }
  const idOf = async (res: Promise<Response>): Promise<string> => ((await (await res).json()) as { id: string }).id;

  it("a same-network tap arriving late no longer takes over a stranger's pairing: all ambiguous", async () => {
    const alice = await idOf(send(0, "ark1alice", 0, "hard", { net: "home" }));
    const stranger = await idOf(send(10, "ark1stranger", 30, "hard", { net: "elsewhere" }));
    expect((await status(lab, alice)).peerAddress).toBe("ark1stranger");
    const bob = await idOf(send(900, "ark1bob", 20, "soft", { net: "home" }));
    for (const id of [alice, stranger, bob]) expect((await status(lab, id)).state).toBe("ambiguous");
  });

  it("a stranger on the payer's own network can't outrank the real partner either (café wifi, carrier NAT)", async () => {
    const alice = await idOf(send(0, "ark1alice", 0, "hard", { net: "cafe" }));
    const bob = await idOf(send(10, "ark1bob", 20, "hard", { net: "mobile" }));
    expect((await status(lab, alice)).peerAddress).toBe("ark1bob");
    const mallory = await idOf(send(1500, "ark1mallory", 10, "hard", { net: "cafe" }));
    for (const id of [alice, bob, mallory]) expect((await status(lab, id)).state).toBe("ambiguous");
  });

  it("a farther tap arriving late still poisons an undecided pair", async () => {
    const alice = await idOf(send(0, "ark1alice", 0, "hard", { net: "home" }));
    await send(10, "ark1bob", 20, "soft", { net: "home" });
    const stranger = await idOf(send(900, "ark1stranger", 30, "hard", { net: "elsewhere" }));
    expect((await status(lab, alice)).state).toBe("ambiguous");
    expect((await status(lab, stranger)).state).toBe("ambiguous");
  });

  it("two pending candidates are ambiguous, however much closer one of them is", async () => {
    const near = await idOf(send(0, "ark1near", 0, "soft", { net: "home" }));
    const far = await idOf(send(5, "ark1far", 10, "soft", { net: "elsewhere" }));
    const me = await idOf(send(20, "ark1me", 15, "hard", { net: "home" }));
    for (const id of [near, far, me]) expect((await status(lab, id)).state).toBe("ambiguous");
  });

  // The case this whole rule was removed for: one phone read as CZ, the other
  // as DE, physically touching, and before 2026-09-20 they never paired.
  it("taps in different countries pair", async () => {
    const a = await idOf(send(0, "ark1a", 0, "hard", { country: "CZ" }));
    const b = await idOf(send(10, "ark1b", 5, "hard", { country: "DE", city: "Berlin" }));
    expect((await status(lab, a)).state).toBe("paired");
    expect((await status(lab, b)).peerAddress).toBe("ark1a");
  });

  it("taps elsewhere in the city outside the window don't disturb a pair", async () => {
    const a = await idOf(send(1000, "ark1a", 1000, "hard", { net: "shop" }));
    const b = await idOf(send(1010, "ark1b", 1012, "hard", { net: "shop" }));
    // Tapped 700ms+ earlier, arriving just after: in the city, not in range.
    for (let i = 0; i < 10; i++) await send(1020 + i, `ark1noise${i}`, i * 30, i % 2 ? "hard" : "soft", { net: `n${i}` });
    expect((await status(lab, a)).peerAddress).toBe("ark1b");
    expect((await status(lab, b)).peerAddress).toBe("ark1a");
  });

  it("one network can't hold more than its share of pending taps", async () => {
    const { MAX_PENDING_PER_NET } = BUMP_MATCHING;
    // Spaced wider than the window so none of them pair with each other, and
    // close enough together that the whole spray is still inside
    // PENDING_TTL_MS when the last one lands (that TTL shrinks with the
    // window, so a wider spacing would see the first taps pruned instead).
    for (let i = 0; i < MAX_PENDING_PER_NET; i++) {
      const res = await send(i * 60, `ark1spray${i}`, i * 60, "hard", { net: "spray" });
      expect(((await res.json()) as Status).state).toBeUndefined(); // stored, pending
    }
    const t = MAX_PENDING_PER_NET * 60;
    expect((await send(t, "ark1spray-more", t, "hard", { net: "spray" })).status).toBe(429);
    // Someone else is unaffected.
    const other = await send(t + 1, "ark1other", t + 1, "hard", { net: "home" });
    expect(other.status).toBe(200);
    expect(((await other.json()) as { id?: string }).id).toBeDefined();
  });

  it("a phone in an undecided pairing: its stray candidate neither poisons it nor pairs with anyone", async () => {
    const a = await idOf(send(0, "ark1a", 0, "hard"));
    await send(10, "ark1b", 10, "hard");
    const stray = await (await send(20, "ark1b", 40, "soft")).json();
    expect(stray).toMatchObject({ state: "expired" });
    expect((await status(lab, a)).peerAddress).toBe("ark1b");
    const stranger = await idOf(send(2000, "ark1z", 2000, "hard"));
    expect((await status(lab, stranger)).state).toBe("pending");
  });

  it("after 'Symboly nesedí' the phone may bump again right away", async () => {
    const a = await idOf(send(0, "ark1a", 0, "hard"));
    await send(10, "ark1b", 10, "hard");
    await lab.fetch(new Request("https://x/api/bump/progress", { method: "POST", body: JSON.stringify({ id: a, stage: "cancelled" }) }));
    const again = await idOf(send(2000, "ark1a", 2000, "hard"));
    await send(2010, "ark1c", 2010, "hard");
    expect((await status(lab, again)).peerAddress).toBe("ark1c");
  });
});

describe("commit-reveal (the emoji can't be steered by whoever relays the addresses)", () => {
  let lab: BumpLab;
  let a: string;
  let b: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lab = new BumpLab(null, null);
    a = await tap(lab, 0, "ark1a", 0);
    b = await tap(lab, 10, "ark1b", 10);
  });
  afterEach(() => vi.useRealTimers());

  it("the test's synchronous commitment is byte-identical to the worker's", async () => {
    for (const [addr, nonce] of [["ark1a", "0".repeat(32)], ["ark1ščř😀", "0123456789abcdef".repeat(2)]]) {
      expect(await bumpCommitment(addr, nonce)).toBe(commitSync(addr, nonce));
    }
  });

  it("each phone gets the partner's commitment at once, its nonce only after revealing its own", async () => {
    const sa = await status(lab, a);
    expect(sa.peerCommit).toBe(commitSync("ark1b", nonceFor("ark1b")));
    expect(sa.peerNonce).toBeUndefined();

    // b reveals first: a still doesn't see b's nonce until a has revealed.
    expect((await reveal(lab, b, nonceFor("ark1b"))).status).toBe(200);
    expect((await status(lab, a)).peerNonce).toBeUndefined();
    expect((await status(lab, b)).peerNonce).toBeUndefined();

    const res = await reveal(lab, a, nonceFor("ark1a"));
    expect(((await res.json()) as Status).peerNonce).toBe(nonceFor("ark1b"));
    expect((await status(lab, b)).peerNonce).toBe(nonceFor("ark1a"));
  });

  it("a nonce that doesn't open the commitment is refused, and a revealed nonce can't be swapped", async () => {
    expect((await reveal(lab, a, "f".repeat(32))).status).toBe(400);
    expect((await reveal(lab, a, "xyz")).status).toBe(400);
    expect((await reveal(lab, a, nonceFor("ark1a"))).status).toBe(200);
    expect((await reveal(lab, a, nonceFor("ark1a"))).status).toBe(200); // idempotent retry
    expect((await reveal(lab, a, "e".repeat(32))).status).toBe(409);
  });

  it("no direction before both phones revealed, even once settled", async () => {
    at(settleFor(10));
    await reveal(lab, a, nonceFor("ark1a"));
    const res = await choose(lab, a, "send");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "unverified" });
    await reveal(lab, b, nonceFor("ark1b"));
    expect((await choose(lab, a, "send")).status).toBe(200);
  });

  it("a long-poll that reaches the server after the partner's reveal answers at once (not after ~8s)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    at(20);
    const { v } = (await (await lab.fetch(new Request(`https://x/api/bump/status?id=${b}`))).json()) as { v: number };
    await reveal(lab, b, nonceFor("ark1b"));
    await reveal(lab, a, nonceFor("ark1a"));
    // b's next long-poll still carries the version it saw before either
    // reveal, and arrives only now (its request was on the wire).
    const held = lab.fetch(new Request(`https://x/api/bump/status?id=${b}&v=${v}`));
    let answered = false;
    void held.then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(answered).toBe(true);
    expect(((await (await held).json()) as Status).peerNonce).toBe(nonceFor("ark1a"));
  });

  it("revealing for a tap that isn't paired is refused", async () => {
    const lone = await tap(lab, 20_000, "ark1c", 20_000);
    expect((await reveal(lab, lone, nonceFor("ark1c"))).status).toBe(404);
  });
});

describe("vertical veto (pickups and table taps)", () => {
  it("only two almost purely vertical jolts are vetoed, in either direction", () => {
    expect(verticalVeto({ vertical: 0.93 }, { vertical: 0.99 })).toBe(true); // both lifted
    expect(verticalVeto({ vertical: -0.98 }, { vertical: -1 })).toBe(true); // both put down
    expect(verticalVeto({ vertical: -0.98 }, { vertical: 0.95 })).toBe(true); // one put down next to the other
    expect(verticalVeto({ vertical: 0.88 }, { vertical: 0.88 })).toBe(false); // the most vertical recorded real tap
    expect(verticalVeto({ vertical: -0.68 }, { vertical: -0.7 })).toBe(false); // top edges, as recorded
    expect(verticalVeto({ vertical: 0.95 }, { vertical: 0.2 })).toBe(false);
    expect(verticalVeto({ vertical: 0.95 }, {})).toBe(false); // an older client sends none
  });

  it("the server leaves a simultaneous double pickup unpaired but pairs a top-edge bump", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const lab = new BumpLab(null, null);
      const post = async (address: string, tapAt: number, vertical: number) => {
        vi.setSystemTime(T0 + tapAt + 20);
        const res = await lab.fetch(
          new Request("https://x/api/bump/tap", {
            method: "POST",
            headers: { "X-Bump-Net": "home" },
            body: tapBody(address, { clientTapTime: T0 + tapAt, clockUncertaintyMs: 0, vertical }),
          }),
        );
        return ((await res.json()) as { id: string }).id;
      };
      const a = await post("ark1a", 0, 0.97);
      await post("ark1b", 15, 0.93);
      expect((await status(lab, a)).state).toBe("pending");

      const c = await post("ark1c", 20_000, -0.68);
      await post("ark1d", 20_010, -0.5);
      expect((await status(lab, c)).state).toBe("paired");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a decided pair survives a restart (deploy, eviction)", () => {
  // In-memory stand-in for Durable Object storage, shared between two
  // BumpLab instances the way one object's storage outlives its restarts.
  function fakeState(store: Map<string, unknown>) {
    return {
      storage: {
        get: async <T>(k: string) => store.get(k) as T | undefined,
        put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
        delete: async (k: string) => store.delete(k),
        list: async <T>({ prefix }: { prefix: string }) =>
          new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
      },
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    };
  }
  // Only the pair records. The object also persists its aggregate telemetry
  // under a key of its own (worker/bump.ts's STATS_KEY), which has nothing to
  // do with how long a pair is kept.
  const pairCount = (store: Map<string, unknown>) => [...store.keys()].filter((k) => k.startsWith("pair:")).length;
  const progress = (lab: BumpLab, id: string, stage: FlowStage, amountSats?: number) =>
    lab.fetch(new Request("https://x/api/bump/progress", { method: "POST", body: JSON.stringify({ id, stage, amountSats }) }));
  const flowOf = async (lab: BumpLab, id: string) =>
    (await status(lab, id)) as Status & { flow?: { stage: string; amountSats?: number } };

  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("mid-payment: both phones carry on against the restarted object", async () => {
    const store = new Map<string, unknown>();
    const before = new BumpLab(fakeState(store), null);
    const a = await tap(before, 0, "ark1a", 0);
    const b = await tap(before, 20, "ark1b", 10);
    await readyToChoose(before, [a, b], ["ark1a", "ark1b"], settleFor(10));
    expect(pairCount(store)).toBe(0); // undecided pairs stay in memory only
    await choose(before, a, "send");
    await progress(before, a, "sending", 5000);

    at(settleFor(10) + 1000);
    const after = new BumpLab(fakeState(store), null);
    const sa = await flowOf(after, a);
    const sb = await flowOf(after, b);
    expect(sa).toMatchObject({ state: "paired", role: "send", flow: { stage: "sending", amountSats: 5000 } });
    expect(sb).toMatchObject({ state: "paired", role: "receive", peerAddress: "ark1a", flow: { stage: "sending" } });

    expect((await progress(after, a, "sent")).status).toBe(200);
    expect((await progress(after, b, "received")).status).toBe(200);
    expect((await flowOf(after, a)).flow?.stage).toBe("received");
  });

  it("forgets a pair once it's over, and never restores one past its lifetime", async () => {
    const store = new Map<string, unknown>();
    const lab = new BumpLab(fakeState(store), null);
    const a = await tap(lab, 0, "ark1a", 0);
    const b = await tap(lab, 20, "ark1b", 10);
    await readyToChoose(lab, [a, b], ["ark1a", "ark1b"], settleFor(10));
    await choose(lab, a, "send");
    expect(pairCount(store)).toBe(1);
    await status(lab, a, 16 * 60_000); // past FLOW_MAX_TTL_MS: pruned
    expect(pairCount(store)).toBe(0);

    const stale = new Map<string, unknown>();
    const lab2 = new BumpLab(fakeState(stale), null);
    const c = await tap(lab2, 20 * 60_000, "ark1c", 20 * 60_000);
    const d = await tap(lab2, 20 * 60_000 + 20, "ark1d", 20 * 60_000 + 10);
    await readyToChoose(lab2, [c, d], ["ark1c", "ark1d"], settleFor(20 * 60_000 + 10));
    await choose(lab2, c, "receive");
    at(40 * 60_000);
    const restarted = new BumpLab(fakeState(stale), null);
    expect((await status(restarted, c)).state).toBe("expired");
    expect(pairCount(stale)).toBe(0);
  });
});

describe("rate limit key", () => {
  it("uses an IPv4 address whole: one NAT is one source", () => {
    expect(bumpRateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  });

  it("collapses IPv6 to its /64, so one subscriber cannot rotate out of its bucket", () => {
    const a = bumpRateLimitKey("2001:db8:abcd:1234:1::1");
    const b = bumpRateLimitKey("2001:db8:abcd:1234:ffff:ffff:ffff:ffff");
    expect(a).toBe(b);
    // A different /64 of the same allocation is still a different bucket:
    // this narrows the bypass by 2^64, it does not close it (see the
    // per-network pending cap for the rest).
    expect(bumpRateLimitKey("2001:db8:abcd:9999::1")).not.toBe(a);
  });
});

describe("histogramBucket", () => {
  it("keeps everything out of range in the last bucket rather than losing it", () => {
    expect(histogramBucket(0, 10, 5)).toBe(0);
    expect(histogramBucket(25, 10, 5)).toBe(2);
    expect(histogramBucket(10_000, 10, 5)).toBe(4);
    expect(histogramBucket(-1, 10, 5)).toBe(0);
    expect(histogramBucket(NaN, 10, 5)).toBe(0);
  });
});

describe("telemetry", () => {
  const stats = async (lab: BumpLab): Promise<{ days: BumpDayStats[] }> =>
    (await (await lab.fetch(new Request("https://x/api/bump/stats"))).json()) as { days: BumpDayStats[] };

  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("counts a pair, its closeness, and the taps that never matched", async () => {
    const lab = new BumpLab(null, null);
    const a = await tap(lab, 0, "ark1a", 0);
    await tap(lab, 20, "ark1b", 10);
    expect((await status(lab, a)).state).toBe("paired");
    // A tap with nobody near it, pruned once it can no longer match.
    await tap(lab, 30_000, "ark1c", 30_000);
    await status(lab, a, 60_000);

    const [day] = (await stats(lab)).days;
    expect(day.tapHard).toBe(3);
    expect(day.pair).toBe(1);
    expect(day.lone).toBe(1);
    expect(day.ambiguous).toBe(0);
    // 10ms apart, so the 10-19ms bucket; same-city, since the taps carry no
    // Cloudflare location headers.
    expect(day.dt[1]).toBe(1);
    expect(day.pairByLevel[2]).toBe(1);
  });

  it("adds up the warm-up pings phones report with their taps, even a tap refused as late", async () => {
    const lab = new BumpLab(null, null);
    at(5000);
    const send = (extra: Record<string, unknown>) =>
      lab.fetch(new Request("https://x/api/bump/tap", { method: "POST", body: tapBody("ark1w", extra) }));
    await send({ clientTapTime: T0 + 5000, clockUncertaintyMs: 0, warmSent: 3, warmSkipped: 2, spikesDropped: 7 });
    // Too old to match, still counted; junk values count as nothing.
    await send({ clientTapTime: T0, clockUncertaintyMs: 0, warmSent: 1.7, warmSkipped: -4 });
    await send({ clientTapTime: T0 + 5000, clockUncertaintyMs: 0, warmSent: "9" });

    const [day] = (await stats(lab)).days;
    expect(day.warmSent).toBe(4);
    expect(day.warmSkipped).toBe(2);
    expect(day.spikesDropped).toBe(7);
  });

  it("counts a tap refused for arriving too late, and tells the client why", async () => {
    const lab = new BumpLab(null, null);
    at(5000);
    const res = await lab.fetch(
      new Request("https://x/api/bump/tap", {
        method: "POST",
        body: tapBody("ark1a", { clientTapTime: T0 + 5000 - (MAX_ARRIVAL_LAG_MS + 500), clockUncertaintyMs: 0 }),
      }),
    );
    expect(await res.json()).toMatchObject({ state: "expired", reason: "late" });
    expect((await stats(lab)).days[0].late).toBe(1);
  });

  // A record written by a different version of this file: two bucket counts
  // it doesn't recognise, a counter it does, and one field of the wrong type
  // entirely. Restoring this as-is used to mean `s.dt[i]++` writing NaN past
  // the end of a short array, and a missing array throwing inside stat() —
  // which handleTap calls for every tap, so the shard would have answered 500
  // to every tap, restart after restart.
  it("survives a stats record written by another version of this code", async () => {
    const store = new Map<string, unknown>();
    const state = {
      storage: {
        get: async <T,>(k: string) => store.get(k) as T | undefined,
        put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
        delete: async (k: string) => store.delete(k),
        list: async <T,>({ prefix }: { prefix: string }) =>
          new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, v as T])),
      },
      blockConcurrencyWhile: <T,>(fn: () => Promise<T>) => fn(),
    };
    const today = new Date(T0).toISOString().slice(0, 10);
    store.set("stats", [{ day: today, pair: 5, dt: [0, 7], lone: "nonsense" }, { day: "not-a-day" }, null, 42]);

    const lab = new BumpLab(state, null);
    const a = await tap(lab, 0, "ark1a", 0);
    await tap(lab, 20, "ark1b", 10);
    expect((await status(lab, a)).state).toBe("paired");

    const days = (await stats(lab)).days;
    expect(days).toHaveLength(1); // the junk entries are dropped, not restored
    const [day] = days;
    expect(day.pair).toBe(6); // 5 restored + the one just made
    expect(day.dt[1]).toBe(8); // 7 restored + this pair, 10ms apart
    expect(day.lone).toBe(0); // a value of the wrong type reads as zero
    // Every bucket is a real number at this version's length: no NaN, no hole.
    for (const bucket of [day.dt, day.lag, day.unc, day.pairByLevel, day.srcRate]) {
      expect(bucket.every((n) => typeof n === "number" && Number.isFinite(n))).toBe(true);
    }
    expect(day.dt.length).toBeGreaterThan(2);
  });

  // `unc` is recorded after resolveTapTime clamps it, so on a poor connection
  // every tap saturates its last bucket and the cap can no longer be judged
  // from the data. uncRaw keeps the claim as the client made it.
  it("keeps the claimed clock uncertainty as claimed, not as clamped", async () => {
    const lab = new BumpLab(null, null);
    at(0);
    for (const claimed of [12, 250]) {
      await lab.fetch(
        new Request("https://x/api/bump/tap", {
          method: "POST",
          body: tapBody(`ark1u${claimed}`, { clientTapTime: T0, clockUncertaintyMs: claimed }),
        }),
      );
    }
    const day = (await stats(lab)).days[0];
    // Clamped to MAX_CLOCK_UNCERTAINTY_MS (25), i.e. the 25-29ms bucket.
    expect(day.unc[5]).toBe(1); // the 250ms one, clamped
    expect(day.unc[2]).toBe(1); // the 12ms one
    // Raw, 20ms buckets: 12ms in the first, 250ms in the 240-259 bucket.
    expect(day.uncRaw[0]).toBe(1);
    expect(day.uncRaw[12]).toBe(1);
  });

  it("records nothing that identifies a phone", async () => {
    const lab = new BumpLab(null, null);
    await tap(lab, 0, "ark1a", 0);
    await tap(lab, 20, "ark1b", 10);
    const raw = await (await lab.fetch(new Request("https://x/api/bump/stats"))).text();
    for (const secret of ["ark1a", "ark1b", commitSync("ark1a", nonceFor("ark1a"))]) {
      expect(raw).not.toContain(secret);
    }
  });
});

describe("spray defence: hot sources that keep poisoning pairings get blocked, honest ones never", () => {
  it("guardPrefix: whole IPv4, IPv6 /48 however it's written (a rotated /64 is the same source)", () => {
    expect(guardPrefix("203.0.113.9")).toBe("203.0.113.9");
    expect(guardPrefix("2001:db8:abcd:1::1")).toBe("2001:db8:abcd::/48");
    expect(guardPrefix("2001:0db8:abcd:ffff:1:2:3:4")).toBe("2001:db8:abcd::/48");
    expect(guardPrefix("2001:db8:abcd:1::1")).toBe(guardPrefix("2001:db8:abcd:9999::7"));
    expect(guardPrefix("2001:db8:abcd:1::1")).not.toBe(guardPrefix("2001:db8:abce:1::1"));
    // networkPrefix (pairing locality) is unchanged and stays a /64.
    expect(networkPrefix("2001:db8:abcd:1::1")).toBe("2001:db8:abcd:1::/64");
  });

  it("hotSources: every hot source in the cluster, once, wherever its taps are", () => {
    const rate: Record<string, number> = { hot: HOT_SOURCE_TAPS + 1, calm: 3, edge: HOT_SOURCE_TAPS };
    const recent = (g: string) => rate[g] ?? 0;
    expect(hotSources([{ guard: "calm" }, { guard: "hot" }, { guard: "hot" }, { guard: "edge" }, {}], recent)).toEqual([
      "hot",
    ]);
    // Exactly at the threshold is not hot; nothing hot, nobody charged.
    expect(hotSources([{ guard: "calm" }, { guard: "edge" }], recent)).toEqual([]);
  });

  it("SourceRateMeter: counts a source's taps inside the window, forgets them after it, saturates", () => {
    const m = new SourceRateMeter();
    for (let i = 1; i <= HOT_SOURCE_TAPS; i++) expect(m.record("x", i * 10)).toBe(i);
    expect(isHot(m.count("x", HOT_SOURCE_TAPS * 10))).toBe(false);
    expect(isHot(m.record("x", 1000))).toBe(true);
    // Each source has its own count.
    expect(m.record("y", 1000)).toBe(1);
    // Taps age out of the window one by one.
    expect(m.count("x", 10 + SOURCE_RATE_WINDOW_MS)).toBe(HOT_SOURCE_TAPS);
    expect(isHot(m.count("x", 10 + SOURCE_RATE_WINDOW_MS))).toBe(false);
    // A flood stays hot without its history growing with it.
    for (let i = 0; i < 1000; i++) m.record("z", 5000 + i);
    expect(isHot(m.count("z", 6000))).toBe(true);
    expect(m.count("z", 6000)).toBeLessThanOrEqual(HOT_SOURCE_TAPS * 2);
    // Idle sources are dropped.
    m.prune(6000 + SOURCE_RATE_WINDOW_MS);
    expect(m.size).toBe(0);
  });

  it("StrikeLedger: blocks at the limit inside the window, forgives outside it, unblocks after BLOCK_MS", () => {
    const l = new StrikeLedger();
    for (let i = 0; i < STRIKE_LIMIT - 1; i++) expect(l.strike("x", i)).toBe(false);
    expect(l.blocked("x", 100)).toBe(false);
    expect(l.strike("x", 100)).toBe(true);
    expect(l.blocked("x", 101)).toBe(true);
    expect(l.blocked("x", 100 + BLOCK_MS - 1)).toBe(true);
    expect(l.blocked("x", 100 + BLOCK_MS)).toBe(false);
    // Slow strikes never add up.
    const slow = new StrikeLedger();
    for (let i = 0; i < 50; i++) expect(slow.strike("y", i * (STRIKE_WINDOW_MS / 2))).toBe(false);
    expect(slow.blocked("y", 50 * (STRIKE_WINDOW_MS / 2))).toBe(false);
    // Idle sources are dropped, blocked ones kept.
    l.prune(100 + STRIKE_WINDOW_MS + 1);
    expect(l.size).toBe(1);
    l.prune(100 + BLOCK_MS + STRIKE_WINDOW_MS + 1);
    expect(l.size).toBe(0);
  });

  describe("in BumpLab", () => {
    let lab: BumpLab;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      lab = new BumpLab(null, null);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const post = (arriveAt: number, address: string, tapAt: number, guard: string | undefined, lab2: BumpLab = lab) => {
      const headers: Record<string, string> = { "X-Bump-Country": "CZ", "X-Bump-City": "Prague" };
      if (guard) headers["X-Bump-Guard"] = guard;
      at(arriveAt);
      return lab2.fetch(
        new Request("https://x/api/bump/tap", {
          method: "POST",
          headers,
          body: tapBody(address, { clientTapTime: T0 + tapAt, clockUncertaintyMs: 0, post: 0.2, spreadMs: 90 }),
        }),
      );
    };
    // Two honest phones 20ms apart, and a spray tap 30ms after the second.
    async function poisonedBump(base: number, sprayGuard: string, lab2: BumpLab = lab): Promise<string[]> {
      const a = ((await (await post(base, `ark1a${base}`, base, "ga", lab2)).json()) as { id: string }).id;
      const b = ((await (await post(base + 20, `ark1b${base}`, base + 20, "gb", lab2)).json()) as { id: string }).id;
      const s = ((await (await post(base + 50, `ark1s${base}`, base + 50, sprayGuard, lab2)).json()) as { id: string }).id;
      return [a, b, s];
    }
    // Makes `guard` hot by `until`: HOT_SOURCE_TAPS + 1 taps spaced wider than
    // any window (they pair with nothing), all of them pruned again by `until`
    // so they can't collide with whatever the test does next.
    async function heat(guard: string, until: number, lab2: BumpLab = lab): Promise<void> {
      const first = until - 2000 - (HOT_SOURCE_TAPS + 1) * 100;
      for (let i = 0; i <= HOT_SOURCE_TAPS; i++) {
        const t = first + i * 100;
        await post(t, `ark1heat-${guard}-${until}-${i}`, t, guard, lab2);
      }
    }

    it("pairing is exactly as strict as before: the spray tap still makes everyone ambiguous", async () => {
      const ids = await poisonedBump(0, "spray");
      for (const id of ids) expect((await status(lab, id)).state).toBe("ambiguous");
    });

    it("a hot source that keeps poisoning pairings is refused after STRIKE_LIMIT, honest ones never are", async () => {
      const start = 10_000;
      for (let i = 0; i < STRIKE_LIMIT; i++) {
        const base = start + i * 5000;
        await heat("spray", base);
        await poisonedBump(base, "spray");
      }
      const t = start + STRIKE_LIMIT * 5000;
      const blocked = await post(t, "ark1s", t, "spray");
      expect(blocked.status).toBe(429);
      // The honest pair (poisoned every time) is not blocked, and now pairs.
      const a = ((await (await post(t + 1, "ark1a-now", t + 1, "ga")).json()) as { id: string }).id;
      await post(t + 21, "ark1b-now", t + 21, "gb");
      expect((await status(lab, a)).state).toBe("paired");
      // A blocked source is let back in after BLOCK_MS.
      const later = t + BLOCK_MS + 10;
      expect((await post(later, "ark1s", later, "spray")).status).toBe(200);
    });

    it("a source that isn't hot is never struck, wherever its taps land", async () => {
      for (let i = 0; i < STRIKE_LIMIT + 2; i++) await poisonedBump(i * 5000, "spray");
      const t = (STRIKE_LIMIT + 2) * 5000;
      for (const guard of ["spray", "ga", "gb"]) expect((await post(t, `ark1${guard}-now`, t, guard)).status).toBe(200);
    });

    // The attribution this replaced took the two closest taps of an ambiguous
    // cluster to be the honest pair and struck everyone else. Two taps of the
    // attacker's own, 1ms apart, were then "the honest pair", and the real
    // pair beside them got blocked after STRIKE_LIMIT retaps while the
    // attacker was never charged.
    async function framingBump(base: number, attacker: string): Promise<void> {
      await post(base, `ark1x${base}`, base, attacker);
      await post(base + 1, `ark1y${base}`, base + 1, attacker);
      await post(base + 20, `ark1a${base}`, base + 20, "ga");
      await post(base + 35, `ark1b${base}`, base + 35, "gb");
    }

    it("a sprayer can't get the honest pair blocked by putting its own two taps closest", async () => {
      for (let i = 0; i < STRIKE_LIMIT + 2; i++) await framingBump(i * 5000, "attacker");
      const t = (STRIKE_LIMIT + 2) * 5000;
      expect((await post(t, "ark1a-now", t, "ga")).status).toBe(200);
      expect((await post(t + 1000, "ark1b-now", t + 1000, "gb")).status).toBe(200);
    });

    it("...and when that sprayer is hot, it is the one blocked", async () => {
      const start = 10_000;
      for (let i = 0; i < STRIKE_LIMIT + 2; i++) {
        const base = start + i * 5000;
        await heat("attacker", base);
        await framingBump(base, "attacker");
      }
      const t = start + (STRIKE_LIMIT + 2) * 5000;
      expect((await post(t, "ark1z", t, "attacker")).status).toBe(429);
      expect((await post(t + 1000, "ark1a-now", t + 1000, "ga")).status).toBe(200);
      expect((await post(t + 2000, "ark1b-now", t + 2000, "gb")).status).toBe(200);
    });

    it("taps without a source are never tracked or blocked", async () => {
      for (let i = 0; i < STRIKE_LIMIT + 2; i++) await poisonedBump(i * 5000, "");
      const t = (STRIKE_LIMIT + 2) * 5000;
      expect((await post(t, "ark1s", t, undefined)).status).toBe(200);
    });

    it("BUMP_STRIKES_OFF switches the penalty off", async () => {
      const off = new BumpLab(null, { BUMP_STRIKES_OFF: "1" });
      const start = 10_000;
      for (let i = 0; i < STRIKE_LIMIT + 2; i++) {
        const base = start + i * 5000;
        await heat("spray", base, off);
        await poisonedBump(base, "spray", off);
      }
      const t = start + (STRIKE_LIMIT + 2) * 5000;
      expect((await post(t, "ark1s", t, "spray", off)).status).toBe(200);
    });
  });
});

describe("hot sources and the per-source pending cap", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  const stats = async (lab: BumpLab): Promise<{ days: BumpDayStats[]; sources: { dropHot: boolean } }> =>
    (await (await lab.fetch(new Request("https://x/api/bump/stats"))).json()) as {
      days: BumpDayStats[];
      sources: { dropHot: boolean };
    };

  function send(
    lab: BumpLab,
    arriveAt: number,
    address: string,
    guard: string,
    opts: { net?: string; kind?: "hard" | "soft" } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "X-Bump-Country": "CZ", "X-Bump-City": "Prague", "X-Bump-Guard": guard };
    if (opts.net) headers["X-Bump-Net"] = opts.net;
    at(arriveAt);
    return lab.fetch(
      new Request("https://x/api/bump/tap", {
        method: "POST",
        headers,
        body: tapBody(address, {
          clientTapTime: T0 + arriveAt,
          clockUncertaintyMs: 0,
          kind: opts.kind ?? "hard",
          post: 0.2,
          spreadMs: 90,
        }),
      }),
    );
  }
  const idOf = async (res: Promise<Response>): Promise<string> => ((await (await res).json()) as { id: string }).id;

  // HOT_SOURCE_TAPS + 1 taps from `guard`, spaced wider than any window and
  // pruned again by `until`.
  async function heat(lab: BumpLab, guard: string, until: number): Promise<void> {
    const first = until - 2000 - (HOT_SOURCE_TAPS + 1) * 100;
    for (let i = 0; i <= HOT_SOURCE_TAPS; i++) await send(lab, first + i * 100, `ark1heat${i}`, guard);
  }

  it("by default a hot source is only counted: it still pairs", async () => {
    const lab = new BumpLab(null, null);
    await heat(lab, "g-hot-source", 10_000);
    const a = await idOf(send(lab, 10_000, "ark1a", "g-hot-source"));
    await send(lab, 10_020, "ark1b", "gb");
    expect((await status(lab, a)).state).toBe("paired");

    const body = await stats(lab);
    expect(body.sources.dropHot).toBe(false);
    const [day] = body.days;
    // The (HOT_SOURCE_TAPS + 1)th tap inside the window and the one after it.
    expect(day.hot).toBe(2);
    // Every tap that carried a source is in the histogram, at its own count.
    expect(day.srcRate.reduce((sum, n) => sum + n, 0)).toBe(HOT_SOURCE_TAPS + 3);
    expect(day.srcRate[0]).toBe(2); // the first heat tap, and gb's only one
    // Counts, never the source itself.
    expect(JSON.stringify(body)).not.toContain("g-hot-source");
  });

  it("with BUMP_HOT_SOURCES=enforce a hot source's taps are refused, can't poison a pair, and it is let back in once it slows down", async () => {
    const lab = new BumpLab(null, { BUMP_HOT_SOURCES: "enforce" });
    const base = 10_000;
    await heat(lab, "spray", base);
    const a = await idOf(send(lab, base, "ark1a", "ga"));
    await send(lab, base + 20, "ark1b", "gb");
    // Lands right between them: stored, it would have made both ambiguous.
    expect((await send(lab, base + 30, "ark1s", "spray")).status).toBe(429);
    expect((await status(lab, a)).state).toBe("paired");
    expect((await stats(lab)).sources.dropHot).toBe(true);

    const later = base + SOURCE_RATE_WINDOW_MS + 10;
    expect((await send(lab, later, "ark1s-again", "spray")).status).toBe(200);
  });

  it("one source can't hold more than MAX_PENDING_PER_GUARD pending taps, however many /64s it rotates through", async () => {
    const lab = new BumpLab(null, null);
    // Soft taps from different networks never pair with each other (soft+soft
    // needs one network), so every one of these stays pending, and none of
    // their networks gets anywhere near MAX_PENDING_PER_NET.
    for (let i = 0; i < MAX_PENDING_PER_GUARD; i++) {
      const res = await send(lab, i * 20, `ark1r${i}`, "g56", { net: `net${i}`, kind: "soft" });
      expect(res.status).toBe(200);
    }
    const t = MAX_PENDING_PER_GUARD * 20;
    expect((await send(lab, t, "ark1r-more", "g56", { net: "net-new", kind: "soft" })).status).toBe(429);
    // Another source is unaffected.
    const other = await send(lab, t + 1, "ark1other", "g-other", { net: "net-other", kind: "soft" });
    expect(other.status).toBe(200);
    expect(((await other.json()) as { id?: string }).id).toBeDefined();
    expect((await stats(lab)).days[0].guardCap).toBe(1);
  });
});
