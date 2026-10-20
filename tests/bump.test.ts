// Regression coverage for the 2026-09-19 incident: BumpOverlay's restart()
// used to create a fresh BumpSession without ever calling stop() on the
// previous one, leaking its devicemotion (and touchstart/pointerdown)
// listeners forever. Every leaked session could independently fire its own
// tap → network cycle and race to overwrite the current one's outcome —
// the working theory behind the false-positive request floods, the
// emoji-confirm button appearing to do nothing, and (most seriously) a real
// send reading a stale peerAddress from an abandoned session rather than
// the one actually on screen. This test exercises BumpSession's own
// start()/stop() directly (not BumpOverlay's React state), against a fake
// `window` that counts add/remove calls, so a regression here fails even
// without a real browser or a real accelerometer.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  BUMP_EMOJI,
  BUMP_SAS_EMOJI_COUNT,
  BUMP_MIN_QUESTION_MS,
  BumpSession,
  TapDetector,
  __resetClockSyncForTests,
  ensureClockSync,
  bumpCommitment,
  bumpSasEmoji,
  clockSampleFromRoundTrip,
  newBumpNonce,
  findBumpArrival,
  maxMovementId,
  motionSampleTime,
  perfToWallMs,
  verticalShare,
  rateLimitBackoffMs,
} from "../src/lib/bump/bump";
import type { BumpOutcome } from "../src/lib/bump/bump";
import { BumpLab, BUMP_MATCHING, bumpCommitment as workerBumpCommitment } from "../worker/bump";

// Bare EventTarget-based fake — real enough for addEventListener/
// removeEventListener bookkeeping, which is all BumpSession's leak touches.
function makeFakeWindow() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(fn);
    },
    countFor(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
    totalCount(): number {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

describe("BumpSession start()/stop() listener lifecycle", () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;
  let originalWindow: unknown;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetClockSyncForTests();
    fakeWindow = makeFakeWindow();
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window: unknown }).window = fakeWindow;
    originalFetch = globalThis.fetch;
    // start() awaits syncClockOffsetMs(), which fires 5 quick GETs against
    // /api/bump/sync — stub them out so start() resolves immediately
    // without a real network.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 }));
  });

  afterEach(() => {
    (globalThis as { window: unknown }).window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  it("stop() removes every listener start() added", async () => {
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    expect(fakeWindow.countFor("devicemotion")).toBe(1);
    expect(fakeWindow.countFor("touchstart")).toBe(1);
    expect(fakeWindow.countFor("pointerdown")).toBe(1);

    session.stop();
    expect(fakeWindow.totalCount()).toBe(0);
  });

  it("restart-style start()+stop() cycling never accumulates listeners (the actual bug)", async () => {
    // Mirrors BumpOverlay.tsx's restart(): stop the outgoing session, then
    // start a fresh one — repeated the way the ambiguous/expired/error
    // auto-retry effect does under a false-positive storm.
    let current: BumpSession | null = null;
    for (let i = 0; i < 25; i++) {
      current?.stop();
      current = new BumpSession("ark1test", () => {});
      await current.start();
    }
    // However many cycles ran, exactly one session's worth of listeners
    // should be live at the end — never a number that grows with the
    // cycle count.
    expect(fakeWindow.countFor("devicemotion")).toBe(1);
    expect(fakeWindow.totalCount()).toBe(3);
  });

  it("the pre-fix pattern (new session without stopping the old one) really did leak — sanity check", async () => {
    // Proves the fake harness itself actually distinguishes leaking from
    // not leaking, by deliberately reproducing the old buggy call pattern.
    let last: BumpSession | null = null;
    for (let i = 0; i < 5; i++) {
      // No stop() here on purpose.
      last = new BumpSession("ark1test", () => {});
      await last.start();
    }
    expect(fakeWindow.countFor("devicemotion")).toBe(5);
    expect(fakeWindow.totalCount()).toBe(15);
  });

  it("a lone sensor candidate is silent and listening never pauses (the old 'deaf for ~11s after a false positive' bug)", async () => {
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    (session as unknown as { onCandidate: (p: number, t: number, s: string) => void }).onCandidate(12, performance.now(), "hard");
    // Mid-flight and after the (unpaired) answer alike: nothing shown, and
    // the motion listener is still attached for the next, real tap.
    expect(fakeWindow.countFor("devicemotion")).toBe(1);
    await vi.waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).includes("/api/bump/tap"))).toBe(true));
    await new Promise((r) => setTimeout(r, 10));
    expect(outcomes).toEqual(["armed"]);
    expect(fakeWindow.countFor("devicemotion")).toBe(1);
    session.stop();
  });
});

describe("BumpSession silent-until-paired", () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;
  let originalWindow: unknown;
  let originalFetch: typeof fetch;
  let tapBodies: Record<string, unknown>[];
  let revealBodies: Record<string, unknown>[];
  let progressBodies: Record<string, unknown>[];
  // What the server answers each /tap with, in order; the last one repeats.
  let tapAnswers: { status?: number; body: Record<string, unknown> }[];
  // The fake partner: a real commitment to its address and nonce, which the
  // fake server hands out like the real one (nonce only after our reveal).
  const PEER = "ark1peer";
  const PEER_NONCE = "ab".repeat(16);
  let peer: { address: string; commit: string; nonce: string };
  // Overrides for what the fake server claims in later answers.
  let statusOverride: Record<string, unknown>;
  let revealed: boolean;

  const pairedStatus = () => ({
    state: "paired",
    peerAddress: peer.address,
    peerCommit: peer.commit,
    peerNonce: revealed ? peer.nonce : undefined,
    settlesInMs: 0,
    ...statusOverride,
  });

  beforeEach(async () => {
    __resetClockSyncForTests();
    fakeWindow = makeFakeWindow();
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window: unknown }).window = fakeWindow;
    originalFetch = globalThis.fetch;
    tapBodies = [];
    revealBodies = [];
    progressBodies = [];
    statusOverride = {};
    revealed = false;
    peer = { address: PEER, commit: await bumpCommitment(PEER, PEER_NONCE), nonce: PEER_NONCE };
    tapAnswers = [{ body: { id: "t", state: "expired" } }];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bump/tap")) {
        tapBodies.push(JSON.parse(String(init?.body)));
        const answer = tapAnswers.length > 1 ? tapAnswers.shift()! : tapAnswers[0];
        const body = answer.body.state === "paired" ? { peerAddress: peer.address, peerCommit: peer.commit, ...answer.body } : answer.body;
        return new Response(JSON.stringify(body), { status: answer.status ?? 200 });
      }
      if (url.includes("/api/bump/reveal")) {
        revealBodies.push(JSON.parse(String(init?.body)));
        revealed = true;
        return new Response(JSON.stringify(pairedStatus()));
      }
      if (url.includes("/api/bump/progress")) {
        progressBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(pairedStatus()));
      }
      // No `v`: the session then paces its follow loop instead of spinning.
      if (url.includes("/api/bump/status")) return new Response(JSON.stringify(pairedStatus()));
      return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    (globalThis as { window: unknown }).window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  type Candidate = (peak: number, time: number, strength: "hard" | "soft") => void;
  const candidate = (session: BumpSession): Candidate =>
    (session as unknown as { onCandidate: Candidate }).onCandidate.bind(session);
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("shows the emoji only once paired and verified, then stops listening so later motion can't disturb the flow", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired", settlesInMs: 0 } }];
    const seen: BumpOutcome[] = [];
    const session = new BumpSession("ark1test", (o) => seen.push(o));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(seen.map((o) => o.kind)).toContain("paired"));
    expect(seen.map((o) => o.kind)).toEqual(["armed", "paired"]);
    expect(fakeWindow.totalCount()).toBe(0);
    expect(tapBodies[0]).toMatchObject({ kind: "hard", wait: true, address: "ark1test", commit: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // The revealed nonce opens the commitment the tap carried, and the emoji
    // are derived from both phones' nonces.
    const myNonce = revealBodies[0].nonce as string;
    expect(await bumpCommitment("ark1test", myNonce)).toBe(tapBodies[0].commit);
    const paired = seen[1] as Extract<BumpOutcome, { kind: "paired" }>;
    expect(paired.emoji).toBe(await bumpSasEmoji({ address: "ark1test", nonce: myNonce }, { address: PEER, nonce: PEER_NONCE }));
    expect(paired).toMatchObject({ peerAddress: PEER, settling: false });

    candidate(session)(12, performance.now(), "hard");
    await settle();
    expect(tapBodies).toHaveLength(1);
    session.stop();
  });

  it("every candidate commits to a fresh nonce", async () => {
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 700)); // past the hard-tap debounce
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(2));
    expect(tapBodies[0].commit).not.toBe(tapBodies[1].commit);
    session.stop();
  });

  it("never reveals without first holding the partner's commitment", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired", peerCommit: undefined } }];
    const seen: BumpOutcome[] = [];
    const session = new BumpSession("ark1test", (o) => seen.push(o));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(seen.at(-1)?.kind).toBe("error"));
    expect(revealBodies).toHaveLength(0);
    expect(seen.map((o) => o.kind)).not.toContain("paired");
  });

  it("a partner nonce that doesn't open its commitment: never shown, and the pairing is called off", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired" } }];
    peer.nonce = "cd".repeat(16); // not what peer.commit commits to
    const seen: BumpOutcome[] = [];
    const session = new BumpSession("ark1test", (o) => seen.push(o));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: "error", quiet: false }));
    expect(seen.map((o) => o.kind)).not.toContain("paired");
    await vi.waitFor(() => expect(progressBodies).toContainEqual({ id: "me", stage: "cancelled" }));
  });

  it("a later answer naming a different partner fails the pairing, even after it was shown", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired" } }];
    const seen: BumpOutcome[] = [];
    const session = new BumpSession("ark1test", (o) => seen.push(o));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(seen.at(-1)?.kind).toBe("paired"));
    statusOverride = { peerAddress: "ark1mallory" };
    await vi.waitFor(() => expect(seen.at(-1)?.kind).toBe("error"), { timeout: 3000 });
  });

  it("a faint pairing that fails before it was ever shown ends quietly", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired" } }];
    peer.nonce = "cd".repeat(16);
    const seen: BumpOutcome[] = [];
    const session = new BumpSession("ark1test", (o) => seen.push(o));
    await session.start();
    candidate(session)(4, performance.now(), "soft");
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: "error", quiet: true }));
  });

  it("stays 'settling' until the server's settle time has passed, then offers the choice", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired", settlesInMs: 250 } }];
    statusOverride = { settlesInMs: 250 };
    const seen: BumpOutcome[] = [];
    const session = new BumpSession("ark1test", (o) => seen.push(o));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: "paired", settling: true }));
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: "paired", settling: false }), { timeout: 2000 });
    // One emit per flip, not one per poll.
    expect(seen.filter((o) => o.kind === "paired")).toHaveLength(2);
    session.stop();
  });

  it("a soft candidate that pairs is just as good as a hard one", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired", settlesInMs: 0 } }];
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    candidate(session)(4, performance.now(), "soft");
    await vi.waitFor(() => expect(outcomes).toContain("paired"));
    expect(tapBodies[0].kind).toBe("soft");
    session.stop();
  });

  it("a pairing reached through a faint tap is quiet, a firm one isn't (so a stranger's phone never takes over its screen)", async () => {
    tapAnswers = [{ body: { id: "me", state: "paired", settlesInMs: 0 } }];
    const seen: BumpOutcome[] = [];
    const soft = new BumpSession("ark1test", (o) => seen.push(o));
    await soft.start();
    candidate(soft)(4, performance.now(), "soft");
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: "paired", quiet: true }));
    soft.stop();
    revealed = false;

    const hard = new BumpSession("ark1test", (o) => seen.push(o));
    await hard.start();
    candidate(hard)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: "paired", quiet: false }));
    hard.stop();
  });

  it("throttles soft candidates but never hard ones", async () => {
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    const send = candidate(session);
    send(4, performance.now(), "soft");
    send(4, performance.now(), "soft");
    send(12, performance.now(), "hard");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(2));
    await settle();
    // Which request leaves first is not defined: each candidate awaits its own
    // clock sync and SHA-256 commitment (a thread-pool digest) before posting,
    // and of two concurrent digests the second finishes first in a few percent
    // of runs. What is defined: the second soft one is dropped, the hard one is
    // not, and nothing else follows.
    expect(tapBodies.map((b) => b.kind).sort()).toEqual(["hard", "soft"]);
    session.stop();
  });

  it("caps how many candidates are in flight at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bump/tap")) {
        tapBodies.push(JSON.parse(String(init?.body)));
        await gate;
        return new Response(JSON.stringify({ id: "t", state: "expired" }));
      }
      return base(input, init);
    }) as typeof fetch;
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    for (let i = 0; i < 10; i++) candidate(session)(12, performance.now(), "hard");
    await settle();
    expect(tapBodies).toHaveLength(4);
    release();
    session.stop();
  });

  it("backs off silently after a 429 instead of showing an error", async () => {
    tapAnswers = [{ status: 429, body: { error: "Too many requests." } }, { body: { id: "t", state: "expired" } }];
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(1));
    await settle();
    candidate(session)(12, performance.now(), "hard");
    await settle();
    expect(tapBodies).toHaveLength(1);
    expect(outcomes).toEqual(["armed"]);
    session.stop();
  });

  it("an ambiguous hard tap asks for a retap; an ambiguous soft one stays silent", async () => {
    tapAnswers = [{ body: { id: "t", state: "ambiguous" } }];
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    candidate(session)(4, performance.now(), "soft");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(1));
    await settle();
    expect(outcomes).toEqual(["armed"]);
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(outcomes).toContain("ambiguous"));
    expect(fakeWindow.totalCount()).toBe(0);
    session.stop();
  });


  it("a late hard tap says the network was slow; a late soft one stays silent", async () => {
    tapAnswers = [
      { body: { state: "expired", reason: "late" } },
      { body: { state: "expired", reason: "late" } },
    ];
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    candidate(session)(4, performance.now(), "soft");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(1));
    await settle();
    expect(outcomes).toEqual(["armed"]);
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(outcomes).toContain("slow"));
    session.stop();
  });

  // A late tap was never stored server-side, so unlike an ambiguous one it
  // cannot have spoiled anything: settling here would abort a sibling request
  // the server may have already paired, leaving the other phone alone on a
  // verified emoji screen. Whichever candidate comes back last reports it.
  it("a late answer stays quiet while another candidate is still on the wire", async () => {
    const base = globalThis.fetch;
    let releaseFirst: (r: Response) => void = () => {};
    let taps = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bump/tap")) {
        taps++;
        if (taps === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve));
        return new Response(JSON.stringify({ state: "expired", reason: "late" }));
      }
      return base(input, init);
    }) as typeof fetch;
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(taps).toBe(1));
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(taps).toBe(2));
    await settle();
    expect(outcomes).toEqual(["armed"]);

    releaseFirst(new Response(JSON.stringify({ state: "expired", reason: "late" })));
    await vi.waitFor(() => expect(outcomes).toContain("slow"));
    session.stop();
    globalThis.fetch = base;
  });

  it("stop() aborts candidates still waiting on the server", async () => {
    const signals: AbortSignal[] = [];
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bump/tap")) {
        signals.push(init!.signal!);
        return new Promise<Response>(() => {});
      }
      return base(input, init);
    }) as typeof fetch;
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    candidate(session)(12, performance.now(), "hard");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    session.stop();
    expect(signals[0].aborted).toBe(true);
  });
});

describe("tap timing helpers", () => {
  it("clockSampleFromRoundTrip assumes the server stamped mid-round-trip", () => {
    expect(clockSampleFromRoundTrip(1000, 1200, 50_100)).toEqual({ offsetMs: 49_000, rttMs: 200 });
  });

  it("perfToWallMs maps a past performance.now() instant onto the wall clock", () => {
    expect(perfToWallMs(900, 1000, 1_700_000_000_000)).toBe(1_700_000_000_000 - 100);
  });

  it("motionSampleTime prefers the event's own timestamp, but only when it's on the performance timeline", () => {
    expect(motionSampleTime(980, 1000)).toBe(980);
    expect(motionSampleTime(0, 1000)).toBe(1000);
    expect(motionSampleTime(1_700_000_000_000, 1000)).toBe(1000); // epoch-based legacy value
    expect(motionSampleTime(5000, 1000)).toBe(1000); // "in the future"
    expect(motionSampleTime(-1, 1000)).toBe(1000);
    expect(motionSampleTime(NaN, 1000)).toBe(1000);
  });
});

describe("TapDetector reports the moment of impact", () => {
  function motion(z: number, timeStamp: number): DeviceMotionEvent {
    return { acceleration: { x: 0, y: 0, z }, accelerationIncludingGravity: null, timeStamp } as unknown as DeviceMotionEvent;
  }

  it("passes the peak sample's timestamp, not the later decay sample's", () => {
    const taps: { peak: number; time: number }[] = [];
    const detector = new TapDetector(6, (peak, time) => taps.push({ peak, time }));
    // Samples must sit on the performance timeline (motionSampleTime rejects
    // anything "in the future"), which starts near 0 in a fresh worker.
    let now = 10_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    const feed = (z: number, t: number) => {
      now = t;
      detector.handle(motion(z, t));
    };
    const base = 9_500;
    for (let i = 0; i < 10; i++) feed(0.1, base + i * 16);
    feed(4, base + 176); // arms
    feed(12, base + 192); // peak
    feed(5, base + 208);
    feed(0.2, base + 272); // decays under armLevel -> classified here
    // ...and released once the post-peak window has passed quietly.
    for (let t = base + 288; t <= base + 192 + 620; t += 16) feed(0.1, t);
    expect(taps).toHaveLength(1);
    expect(taps[0].time).toBe(base + 192);
    expect(taps[0].peak).toBeGreaterThan(11);
    nowSpy.mockRestore();
  });
});

describe("TapDetector hard/soft classification", () => {
  let clock = 10_000;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock = 10_000;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => nowSpy.mockRestore());

  // Feeds a resting baseline, one spike peaking at `peak` m/s^2 over it, and
  // the decay, advancing the mocked clock 16ms per sample (60Hz). `quiet`
  // then keeps feeding stillness past the shape check's post-peak window.
  const sample = (detector: TapDetector, z: number) => {
    clock += 16;
    detector.handle({ acceleration: { x: 0, y: 0, z }, accelerationIncludingGravity: null, timeStamp: clock } as unknown as DeviceMotionEvent);
  };
  function spike(detector: TapDetector, peak: number, quiet = true) {
    for (let i = 0; i < 10; i++) sample(detector, 0.1);
    sample(detector, peak * 0.6);
    sample(detector, peak);
    sample(detector, 0.2);
    for (let i = 0; i < (quiet ? 45 : 5); i++) sample(detector, 0.1);
  }

  it("full threshold is hard, a third of it is soft, below that is nothing", () => {
    const got: string[] = [];
    const detector = new TapDetector(6, (_p, _t, strength) => got.push(strength));
    spike(detector, 8);
    spike(detector, 4);
    spike(detector, 2.5);
    spike(detector, 1.5);
    expect(got).toEqual(["hard", "soft", "soft"]);
  });

  it("a spike followed by continued motion is handling, not a tap", () => {
    const got: string[] = [];
    let spikes = 0;
    let dropped = 0;
    const detector = new TapDetector(
      6,
      (_p, _t, strength) => got.push(strength),
      () => false,
      () => spikes++,
      () => dropped++,
    );
    spike(detector, 10, false);
    for (let i = 0; i < 45; i++) sample(detector, 1.5 + (i % 3)); // the hand keeps moving
    for (let i = 0; i < 45; i++) sample(detector, 0.1);
    expect(got).toEqual([]);
    // Seen as a spike (the network is woken), then thrown out by the shape check.
    expect(dropped).toBe(spikes);
    expect(dropped).toBeGreaterThan(0);
  });

  // Recorded waves and lifts spread over half a second or more.
  it("a broad swell (a wave, a lift) is not a tap, however high it peaks", () => {
    const got: string[] = [];
    const detector = new TapDetector(6, (_p, _t, strength) => got.push(strength));
    for (let i = 0; i < 20; i++) sample(detector, 0.1);
    for (let i = 0; i <= 30; i++) sample(detector, 9 * Math.sin((Math.PI * i) / 30) + 0.1);
    for (let i = 0; i < 45; i++) sample(detector, 0.1);
    expect(got).toEqual([]);
  });

  it("a coinciding screen touch downgrades to soft instead of dropping the tap", () => {
    const got: string[] = [];
    const detector = new TapDetector(6, (_p, _t, strength) => got.push(strength), () => true);
    spike(detector, 10);
    expect(got).toEqual(["soft"]);
  });

  it("a soft spike (the hand's approach) doesn't debounce away the hard impact right after it", () => {
    const got: string[] = [];
    const detector = new TapDetector(6, (_p, _t, strength) => got.push(strength));
    spike(detector, 4, false);
    spike(detector, 10);
    expect(got).toEqual(["soft", "hard"]);
  });

  it("a second hard spike inside the debounce is still one tap", () => {
    const got: string[] = [];
    const detector = new TapDetector(6, (_p, _t, strength) => got.push(strength));
    spike(detector, 10, false);
    spike(detector, 10);
    expect(got).toEqual(["hard"]);
  });
});

describe("BumpSession tap request timing", () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;
  let originalWindow: unknown;
  let originalFetch: typeof fetch;
  let tapBodies: Record<string, unknown>[];

  beforeEach(() => {
    __resetClockSyncForTests();
    fakeWindow = makeFakeWindow();
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window: unknown }).window = fakeWindow;
    originalFetch = globalThis.fetch;
    tapBodies = [];
  });

  afterEach(() => {
    (globalThis as { window: unknown }).window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  function stubFetch(serverClockAheadMs: number | null) {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/bump/sync")) {
        if (serverClockAheadMs === null) return new Response("{}", { status: 503 });
        return new Response(JSON.stringify({ serverTime: Date.now() + serverClockAheadMs }), { status: 200 });
      }
      if (url.includes("/api/bump/tap")) {
        tapBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "t1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ state: "expired" }), { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  type Candidate = (peak: number, time: number, strength: "hard" | "soft") => void;
  const hardTap = (session: BumpSession) =>
    (session as unknown as { onCandidate: Candidate }).onCandidate.call(session, 12, performance.now(), "hard");

  it("sends the tap time converted to server time, with the sync's uncertainty", async () => {
    stubFetch(60_000);
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    const before = Date.now();
    hardTap(session);
    await vi.waitFor(() => expect(tapBodies).toHaveLength(1));
    session.stop();

    expect(tapBodies).toHaveLength(1);
    const { clientTapTime, clockUncertaintyMs } = tapBodies[0] as { clientTapTime: number; clockUncertaintyMs: number };
    expect(Math.abs(clientTapTime - (before + 60_000))).toBeLessThan(50);
    expect(clockUncertaintyMs).toBeGreaterThanOrEqual(0);
    expect(clockUncertaintyMs).toBeLessThan(50);
  });

  it("sends nothing at all when the clock sync failed (the server can't match a tap without a synced time)", async () => {
    stubFetch(null);
    const outcomes: string[] = [];
    const session = new BumpSession("ark1test", (o) => outcomes.push(o.kind));
    await session.start();
    hardTap(session);
    await new Promise((r) => setTimeout(r, 50));
    session.stop();
    expect(tapBodies).toHaveLength(0);
    expect(outcomes).toEqual(["armed"]);
  });

  it("reuses one clock sync across restarted sessions instead of re-measuring each time", async () => {
    const calls = stubFetch(0);
    for (let i = 0; i < 4; i++) {
      const session = new BumpSession("ark1test", () => {});
      await session.start();
      session.stop();
    }
    // A fast stub: two samples are already tight enough.
    expect(calls.filter((u) => u.includes("/api/bump/sync"))).toHaveLength(2);
  });

  it("keeps sampling, up to five, while the round trips stay slow", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      await new Promise((r) => setTimeout(r, 40));
      return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
    }) as typeof fetch;
    const sync = await ensureClockSync();
    expect(calls).toHaveLength(5);
    expect(sync!.uncertaintyMs).toBeGreaterThan(15);
  });

  it("the periodic resync skips a hidden page", async () => {
    const calls = stubFetch(0);
    const doc = { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} };
    const originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = doc;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const session = new BumpSession("ark1test", () => {});
      await session.start();
      calls.length = 0;
      vi.setSystemTime(Date.now() + 11 * 60_000); // the cached offset is now stale
      vi.advanceTimersByTime(10 * 60_000);
      await Promise.resolve();
      expect(calls).toEqual([]);
      doc.visibilityState = "visible";
      vi.advanceTimersByTime(10 * 60_000);
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      session.stop();
    } finally {
      vi.useRealTimers();
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  it("any same-origin request keeps the connection warm, other origins don't", async () => {
    stubFetch(0);
    let deliver: (entries: { name: string; responseEnd: number; startTime: number; duration: number }[]) => void = () => {};
    const OriginalObserver = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    const originalLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = class {
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
        deliver = (entries) => cb({ getEntries: () => entries });
      }
      observe() {}
      disconnect() {}
    };
    (globalThis as { location?: unknown }).location = { origin: "https://wallet.test" };
    const realNow = performance.now.bind(performance);
    let spy: { mockRestore: () => void } | null = null;
    try {
      const session = new BumpSession("ark1test", () => {});
      await session.start();
      const later = realNow() + 60_000;
      spy = vi.spyOn(performance, "now").mockImplementation(() => later);
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("ok");
      }) as typeof fetch;
      deliver([{ name: "https://elsewhere.test/x", responseEnd: later - 1000, startTime: 0, duration: 0 }]);
      deliver([{ name: "https://wallet.test/api/price/simple", responseEnd: later - 1000, startTime: 0, duration: 0 }]);
      warmUp(session);
      expect(calls).toEqual([]);
      (session as unknown as { lastWarmUpAt: number }).lastWarmUpAt = -Infinity;
      deliver([{ name: "https://elsewhere.test/y", responseEnd: later, startTime: 0, duration: 0 }]);
      spy.mockRestore();
      spy = vi.spyOn(performance, "now").mockImplementation(() => later + 6000);
      warmUp(session);
      expect(calls).toEqual(["/bump-warm.txt"]);
      session.stop();
    } finally {
      spy?.mockRestore();
      __resetClockSyncForTests();
      (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = OriginalObserver;
      (globalThis as { location?: unknown }).location = originalLocation;
    }
  });

  const warmUp = (session: BumpSession) => (session as unknown as { warmUp: () => void }).warmUp.call(session);

  it("a warm-up ping goes to the static file, never to the Worker", async () => {
    const calls = stubFetch(0);
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    // Backdate the last request past the warm window.
    const realNow = performance.now.bind(performance);
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + 60_000);
    calls.length = 0;
    warmUp(session);
    spy.mockRestore();
    session.stop();
    expect(calls).toEqual(["/bump-warm.txt"]);
  });

  it("skips the warm-up while a bump request was just made, and reports both counts with the next tap", async () => {
    const calls = stubFetch(0);
    const session = new BumpSession("ark1test", () => {});
    await session.start();
    calls.length = 0;
    warmUp(session); // the clock sync just ran: connection still warm
    expect(calls).toEqual([]);

    const realNow = performance.now.bind(performance);
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + 60_000);
    warmUp(session);
    expect(calls).toEqual(["/bump-warm.txt"]);
    hardTap(session);
    spy.mockRestore();
    await vi.waitFor(() => expect(tapBodies).toHaveLength(1));
    expect(tapBodies[0]).toMatchObject({ warmSent: 1, warmSkipped: 1 });
    expect(tapBodies[0].spikesDropped).toBeUndefined();

    // Handed over once, not resent with the next tap.
    (session as unknown as { onCandidate: Candidate }).onCandidate.call(session, 12, performance.now() + 5000, "hard");
    await vi.waitFor(() => expect(tapBodies).toHaveLength(2));
    session.stop();
    expect(tapBodies[1].warmSent).toBeUndefined();
    expect(tapBodies[1].warmSkipped).toBeUndefined();
  });

  it("starts listening before the clock sync finishes", async () => {
    let releaseSync: () => void = () => {};
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseSync = () => resolve(new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 }));
        }),
    ) as typeof fetch;
    const session = new BumpSession("ark1test", () => {});
    const started = session.start();
    expect(fakeWindow.countFor("devicemotion")).toBe(1);
    session.stop();
    for (let i = 0; i < 5; i++) {
      releaseSync();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    await started;
    expect(fakeWindow.totalCount()).toBe(0);
  });
});

// Two real BumpSessions talking to one real BumpLab in-process: fetch is
// routed straight into the Durable Object class, so this exercises the
// client's follow loop, long-polls and progress calls against the actual
// server logic, end to end.
describe("BumpSession shared flow against a real BumpLab", () => {
  let originalWindow: unknown;
  let originalFetch: typeof fetch;
  let sessions: BumpSession[];

  // Only Date is faked (frozen, moved on by hand): the server's settle time
  // is ~4.4s after a tap, which these tests skip over rather than wait out.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    __resetClockSyncForTests();
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window: unknown }).window = makeFakeWindow();
    originalFetch = globalThis.fetch;
    const lab = new BumpLab(null, null);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://wallet.test");
      if (url.pathname === "/api/bump/sync") return new Response(JSON.stringify({ serverTime: Date.now() }));
      return lab.fetch(new Request(url, { method: init?.method ?? "GET", body: init?.body }));
    }) as typeof fetch;
    sessions = [];
  });

  afterEach(() => {
    for (const s of sessions) s.stop();
    (globalThis as { window: unknown }).window = originalWindow;
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const skipSettle = () =>
    vi.setSystemTime(Date.now() + BUMP_MATCHING.MAX_MATCH_SPAN_MS + BUMP_MATCHING.MAX_ARRIVAL_LAG_MS + 100);

  type Candidate = (peak: number, time: number, strength: "hard" | "soft") => void;
  async function pairedPhones({ settle = true } = {}) {
    const log = { a: [] as BumpOutcome[], b: [] as BumpOutcome[] };
    const a = new BumpSession("ark1alice", (o) => log.a.push(o));
    const b = new BumpSession("ark1bob", (o) => log.b.push(o));
    sessions.push(a, b);
    await a.start();
    await b.start();
    const now = performance.now();
    (a as unknown as { onCandidate: Candidate }).onCandidate(12, now, "hard");
    (b as unknown as { onCandidate: Candidate }).onCandidate(4, now, "soft");
    await vi.waitFor(() => {
      expect(log.a.at(-1)?.kind).toBe("paired");
      expect(log.b.at(-1)?.kind).toBe("paired");
    });
    if (settle) skipSettle();
    return { a, b, log };
  }
  const last = (list: BumpOutcome[]) => list.at(-1)!;

  it("both phones verify each other and show the same emoji, settling at first", async () => {
    const { log } = await pairedPhones({ settle: false });
    const pa = last(log.a) as Extract<BumpOutcome, { kind: "paired" }>;
    const pb = last(log.b) as Extract<BumpOutcome, { kind: "paired" }>;
    expect(pa.emoji).toBe(pb.emoji);
    expect(pa.emoji.split(" ")).toHaveLength(BUMP_SAS_EMOJI_COUNT);
    for (const e of pa.emoji.split(" ")) expect(BUMP_EMOJI).toContain(e);
    expect(pa).toMatchObject({ peerAddress: "ark1bob", settling: true, quiet: false });
    expect(pb).toMatchObject({ peerAddress: "ark1alice", settling: true, quiet: true });
  });

  it("choosing too early is refused by the server; the session waits it out and gets through", async () => {
    const { a, log } = await pairedPhones({ settle: false });
    const choosing = a.choose("send");
    await new Promise((r) => setTimeout(r, 100));
    expect(last(log.a).kind).toBe("paired"); // still refused
    skipSettle();
    await choosing;
    expect(last(log.a)).toMatchObject({ kind: "sending", flow: { stage: "entering" } });
  });

  it("pay flow: the receiver follows every step and the sender sees the confirmation", async () => {
    const { a, b, log } = await pairedPhones();
    const emojiA = (last(log.a) as { emoji: string }).emoji;
    expect((last(log.b) as { emoji: string }).emoji).toBe(emojiA);

    await a.choose("send");
    expect(last(log.a)).toMatchObject({ kind: "sending", peerAddress: "ark1bob", flow: { stage: "entering" } });
    await vi.waitFor(() => expect(last(log.b)).toMatchObject({ kind: "receiving", flow: { stage: "entering" } }));

    expect(await a.announceSending(2500)).toBe(true);
    await vi.waitFor(() => expect(last(log.b)).toMatchObject({ kind: "receiving", flow: { stage: "sending", amountSats: 2500 } }));

    a.reportSendResult(true);
    await vi.waitFor(() => expect(last(log.b)).toMatchObject({ flow: { stage: "sent" } }));

    await b.confirmReceived();
    await vi.waitFor(() => expect(last(log.a)).toMatchObject({ kind: "sending", flow: { stage: "received" } }));
  });

  it("the receiver cancelling shows up on the sender's phone and stops the payment", async () => {
    const { a, b, log } = await pairedPhones();
    await a.choose("send");
    await vi.waitFor(() => expect(last(log.b).kind).toBe("receiving"));
    b.cancel();
    await vi.waitFor(() => expect(last(log.a).kind).toBe("cancelled"));
    expect(await a.announceSending(1000)).toBe(false);
  });

  it("the other phone's choice switches this one without it touching anything", async () => {
    const { b, log } = await pairedPhones();
    await b.choose("send");
    await vi.waitFor(() => expect(last(log.a)).toMatchObject({ kind: "receiving", flow: { stage: "entering" } }));
  });

  it("a payer whose peer picks first keeps the emoji question for at least BUMP_MIN_QUESTION_MS", async () => {
    const { a, b, log } = await pairedPhones();
    const shownAt = performance.now();
    await b.choose("receive");
    await new Promise((r) => setTimeout(r, 500));
    expect(last(log.a).kind).toBe("paired"); // the peer already chose, this phone is still on the question
    await vi.waitFor(() => expect(last(log.a)).toMatchObject({ kind: "sending", flow: { stage: "entering" } }), {
      timeout: 6000,
    });
    expect(performance.now() - shownAt).toBeGreaterThanOrEqual(BUMP_MIN_QUESTION_MS - 200);
    expect(a.closed).toBe(false);
  }, 10_000);

  it("a phone that presses the button itself is not held", async () => {
    const { a, log } = await pairedPhones();
    await a.choose("send");
    expect(last(log.a)).toMatchObject({ kind: "sending", flow: { stage: "entering" } });
  });

  it("stopping while the role is held does not adopt it afterwards", async () => {
    const { a, b, log } = await pairedPhones();
    await b.choose("receive");
    a.stop();
    await new Promise((r) => setTimeout(r, BUMP_MIN_QUESTION_MS + 300));
    expect(log.a.some((o) => o.kind === "sending")).toBe(false);
  }, 10_000);

  it("both picking at once: the first pick wins on both phones", async () => {
    const { a, b, log } = await pairedPhones();
    await Promise.all([a.choose("send"), b.choose("send")]);
    await vi.waitFor(() => {
      const kinds = [last(log.a).kind, last(log.b).kind].sort();
      expect(kinds).toEqual(["receiving", "sending"]);
    });
  });
});

describe("motion context: rest and direction", () => {
  let clock = 10_000;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock = 10_000;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => nowSpy.mockRestore());

  type V = { x: number; y: number; z: number };
  const UP: V = { x: 0, y: 0, z: 9.81 }; // flat, face up: the at-rest reading points up
  // One sample with separate linear acceleration (most devices) or, with
  // `noLinear`, only accelerationIncludingGravity (some Androids).
  function sample(d: TapDetector, lin: V, gravity: V = UP, noLinear = false) {
    clock += 16;
    const incl = { x: gravity.x + lin.x, y: gravity.y + lin.y, z: gravity.z + lin.z };
    d.handle({ acceleration: noLinear ? null : lin, accelerationIncludingGravity: incl, timeStamp: clock } as unknown as DeviceMotionEvent);
  }
  function run(d: TapDetector, opts: { tremor: number; impulse: V; gravity?: V; noLinear?: boolean }) {
    // Tremor that actually varies the magnitude (a sign flip alone wouldn't).
    for (let i = 0; i < 40; i++) {
      const j = (i % 2) * opts.tremor;
      sample(d, { x: j, y: -j, z: j }, opts.gravity, opts.noLinear);
    }
    const k = (f: number) => ({ x: opts.impulse.x * f, y: opts.impulse.y * f, z: opts.impulse.z * f });
    sample(d, k(0.6), opts.gravity, opts.noLinear);
    sample(d, k(1), opts.gravity, opts.noLinear);
    sample(d, { x: 0, y: 0, z: 0.05 }, opts.gravity, opts.noLinear);
    // Past the shape check's post-peak window, holding as still as before.
    for (let i = 0; i < 45; i++) {
      const j = (i % 2) * opts.tremor;
      sample(d, { x: j, y: -j, z: j }, opts.gravity, opts.noLinear);
    }
  }
  const collect = () => {
    const got: { strength: string; rested: boolean; vertical?: number }[] = [];
    const d = new TapDetector(6, (_p, _t, strength, f) => got.push({ strength, rested: f.rested, vertical: f.vertical }));
    return { d, got };
  };

  it("verticalShare: up is +1, sideways 0, down -1", () => {
    expect(verticalShare({ x: 0, y: 0, z: 5 }, UP)).toBeCloseTo(1);
    expect(verticalShare({ x: 5, y: 0, z: 0 }, UP)).toBeCloseTo(0);
    expect(verticalShare({ x: 0, y: 0, z: -5 }, UP)).toBeCloseTo(-1);
    expect(verticalShare({ x: 0, y: 0, z: 0 }, UP)).toBeUndefined();
  });

  it("picking a phone up off a table: rested, sharply upward, sent only as soft", () => {
    const { d, got } = collect();
    run(d, { tremor: 0.01, impulse: { x: 0, y: 0, z: 10 } });
    expect(got).toHaveLength(1);
    expect(got[0].strength).toBe("soft");
    expect(got[0].rested).toBe(true);
    expect(got[0].vertical).toBeGreaterThan(0.9);
  });

  it("a sideways bump in the hand: not rested, hard, horizontal", () => {
    const { d, got } = collect();
    run(d, { tremor: 0.3, impulse: { x: 10, y: 0, z: 0 } });
    expect(got).toEqual([{ strength: "hard", rested: false, vertical: expect.closeTo(0, 1) }]);
  });

  it("a held phone knocked on its top edge (leaning in): hard and downward", () => {
    const { d, got } = collect();
    // Held nearly upright: gravity mostly along the device's y axis.
    const upright: V = { x: 0, y: 9.3, z: 3.1 };
    run(d, { tremor: 0.3, impulse: { x: 0, y: -9, z: -1 }, gravity: upright });
    expect(got[0].strength).toBe("hard");
    expect(got[0].rested).toBe(false); // upright isn't flat, whatever the tremor
    expect(got[0].vertical).toBeLessThan(-0.75);
  });

  it("works from accelerationIncludingGravity alone (no separate linear acceleration)", () => {
    const { d, got } = collect();
    // Strength there is |total acceleration| minus its baseline, which
    // undercounts a sideways jolt; 14 m/s^2 sideways still clears 6 over 9.81.
    run(d, { tremor: 0.3, impulse: { x: 14, y: 0, z: 0 }, noLinear: true });
    expect(got[0].strength).toBe("hard");
    expect(Math.abs(got[0].vertical ?? 1)).toBeLessThan(0.3);
  });
});

// The receiver recognises the bump payment by a new movement in its own
// history, not by the balance rising: a finished VTXO refresh or an unrelated
// payment raises spendable too, and used to produce a false "Přijato" /
// "Doručeno" for money that was never sent.
describe("findBumpArrival", () => {
  const mv = (id: number, effectiveBalanceSats: number, subsystemKind = "arkoor", status = "successful") => ({
    id,
    effectiveBalanceSats,
    subsystemKind,
    status,
  });

  it("maxMovementId is -1 for an empty history and ignores order", () => {
    expect(maxMovementId([])).toBe(-1);
    expect(maxMovementId([mv(4, 1), mv(9, 1), mv(2, 1)])).toBe(9);
  });

  it("finds a new incoming movement for the announced amount", () => {
    const history = [mv(1, 5000), mv(2, -300, "send"), mv(3, 2500)];
    expect(findBumpArrival(history, 2, 2500)?.id).toBe(3);
  });

  it("ignores movements at or below the baseline, even with the right amount", () => {
    expect(findBumpArrival([mv(1, 2500), mv(2, 2500)], 2, 2500)).toBeNull();
  });

  it("never counts a refresh or round as the payment", () => {
    for (const kind of ["refresh", "round", "board", "offboard", "exit"]) {
      expect(findBumpArrival([mv(5, 2500, kind)], 4, 2500)).toBeNull();
    }
  });

  it("ignores outgoing, zero, failed and wrong-amount movements", () => {
    expect(findBumpArrival([mv(5, -2500)], 4, 2500)).toBeNull();
    expect(findBumpArrival([mv(5, 0)], 4, 2500)).toBeNull();
    expect(findBumpArrival([mv(5, 2500, "arkoor", "failed")], 4, 2500)).toBeNull();
    // More than announced is a different payment, not this one.
    expect(findBumpArrival([mv(5, 2501)], 4, 2500)).toBeNull();
    // Far less than announced is not it either.
    expect(findBumpArrival([mv(5, 1000)], 4, 2500)).toBeNull();
  });

  it("tolerates a hair less than announced, but not more than 2%", () => {
    expect(findBumpArrival([mv(5, 9800)], 4, 10_000)?.id).toBe(5);
    expect(findBumpArrival([mv(5, 9799)], 4, 10_000)).toBeNull();
  });

  it("picks the oldest match regardless of history order", () => {
    const history = [mv(8, 2500), mv(6, 2500), mv(7, 2500)];
    expect(findBumpArrival(history, 5, 2500)?.id).toBe(6);
  });

  it("without a known amount, any new incoming payment counts", () => {
    expect(findBumpArrival([mv(3, 1), mv(5, 777)], 3, undefined)?.id).toBe(5);
    expect(findBumpArrival([mv(5, 777, "refresh")], 3, undefined)).toBeNull();
  });
});

describe("commit-reveal primitives", () => {
  it("the client's commitment is byte-identical to the worker's", async () => {
    for (const address of ["ark1abc", "ark1ščř😀", "x".repeat(200)]) {
      const nonce = newBumpNonce();
      expect(await bumpCommitment(address, nonce)).toBe(await workerBumpCommitment(address, nonce));
    }
  });

  it("nonces are fresh 128-bit hex", () => {
    const a = newBumpNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newBumpNonce()).not.toBe(a);
  });

  it("the commitment encoding is unambiguous (address and nonce can't trade characters)", async () => {
    const n = "0".repeat(32);
    expect(await bumpCommitment("ark1a", n)).not.toBe(await bumpCommitment("ark1a:", n.slice(1) + "0"));
    expect(await bumpCommitment("ab", n)).not.toBe(await bumpCommitment("a", "b" + n.slice(1)));
  });

  it("the emoji set: 64 distinct single code points, none needing a variation selector or ZWJ", () => {
    expect(BUMP_EMOJI).toHaveLength(64);
    expect(new Set(BUMP_EMOJI).size).toBe(64);
    for (const e of BUMP_EMOJI) {
      expect([...e]).toHaveLength(1);
      expect(e).not.toMatch(/\uFE0F|\u200D/);
    }
  });

  it("emoji in a row are always different, and every emoji is equally likely in every position", async () => {
    const N = 64 * 60;
    const counts = [0, 1, 2].map(() => new Map<string, number>());
    for (let i = 0; i < N; i++) {
      const row = (await bumpSasEmoji({ address: "ark1a", nonce: newBumpNonce() }, { address: "ark1b", nonce: "22".repeat(16) })).split(" ");
      expect(row).toHaveLength(BUMP_SAS_EMOJI_COUNT);
      expect(new Set(row).size).toBe(row.length);
      row.forEach((e, pos) => counts[pos].set(e, (counts[pos].get(e) ?? 0) + 1));
    }
    // Expected 60 per emoji per position. A skew as small as one emoji being
    // twice as likely would put it near 120; a missing one at 0.
    for (const byEmoji of counts) {
      expect(byEmoji.size).toBe(64);
      for (const n of byEmoji.values()) {
        expect(n).toBeGreaterThan(25);
        expect(n).toBeLessThan(105);
      }
    }
  });

  it("emoji: BUMP_SAS_EMOJI_COUNT of them, order-independent, and they change with either nonce", async () => {
    const a = { address: "ark1alice", nonce: "11".repeat(16) };
    const b = { address: "ark1bob", nonce: "22".repeat(16) };
    const sas = await bumpSasEmoji(a, b);
    expect(sas.split(" ")).toHaveLength(BUMP_SAS_EMOJI_COUNT);
    expect(await bumpSasEmoji(b, a)).toBe(sas);
    // Same two addresses, different nonces: not the old address-only emoji
    // that anyone relaying the addresses could precompute.
    const variants = new Set<string>();
    for (let i = 0; i < 20; i++) variants.add(await bumpSasEmoji({ ...a, nonce: newBumpNonce() }, b));
    expect(variants.size).toBeGreaterThan(15);
  });
});

describe("rateLimitBackoffMs", () => {
  it("costs one retap the first time and only escalates if it keeps happening", () => {
    // The flat 30s this replaced meant one unlucky 429 left the phone deaf
    // for half a minute with nothing on screen to explain it.
    expect(rateLimitBackoffMs(1)).toBe(2000);
    expect(rateLimitBackoffMs(2)).toBe(4000);
    expect(rateLimitBackoffMs(3)).toBe(8000);
  });

  it("still reaches the old ceiling for anything that keeps tripping it", () => {
    expect(rateLimitBackoffMs(5)).toBe(30_000);
    expect(rateLimitBackoffMs(50)).toBe(30_000);
    expect(rateLimitBackoffMs(2000)).toBe(30_000);
  });

  it("is zero while nothing has been refused", () => {
    expect(rateLimitBackoffMs(0)).toBe(0);
    expect(rateLimitBackoffMs(-1)).toBe(0);
  });
});
