// Chain tip failover in normal operation (walletWorkerGuard.ts): only the tip and block-height GETs may move to another
// esplora, a failed source is skipped for a while, a fallback's answer is cached, a lagging or nonsense height is a failed source,
// and without a primary answer two fallbacks must agree before any fallback answer is taken.
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  TIP_MAX_LAG_BLOCKS,
  TIP_MAX_LEAD_BLOCKS,
  TIP_BLOCK_ALLOWANCE_MS,
  TIP_AGREEMENT_BLOCKS,
  TIP_PAUSE_MS,
  TIP_REFUSAL_PAUSE_MS,
  exitAnswerCache,
  fetchTipWithFailover,
  tipFailoverPath,
  type TipFailoverState,
} from "../src/lib/wallet/walletWorkerGuard";

const P = "https://primary.test/api";
const A = "https://a.test/api";
const B = "https://b.test/api";
const SOURCES = [P, A, B];
const PATH = "/blocks/tip/height";

let t = 1_000_000;
const now = () => t;
let state: TipFailoverState;
let calls: string[];
const failovers: string[] = [];

type Reply = Response | Error;
function fakeFetch(replies: Record<string, Reply[]>) {
  return async (r: Request) => {
    calls.push(r.url);
    const key = SOURCES.find((s) => r.url.startsWith(s))!;
    const queue = replies[key] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error("unexpected call to " + r.url);
    if (next instanceof Error) throw next;
    return next.clone();
  };
}
const ok = (body: string, status = 200) => new Response(body, { status });
const req = (path = PATH, signal?: AbortSignal) => new Request(P + path, { signal });
const fresh = (): TipFailoverState => ({ pausedUntil: new Map(), highest: 0, highestAt: 0, agreed: 0, agreedAt: 0 });
// The primary answered 900 just now: the reference most tests judge fallbacks by.
const primaryAnswered = (): TipFailoverState => ({ ...fresh(), highest: 900, highestAt: t });
const run = (replies: Record<string, Reply[]>, path = PATH, signal?: AbortSignal) =>
  fetchTipWithFailover(req(path, signal), path, SOURCES, fakeFetch(replies), (s, st) => failovers.push(`${s}:${st}`), state, now);

beforeEach(() => {
  t = 1_000_000;
  state = primaryAnswered();
  calls = [];
  failovers.length = 0;
  exitAnswerCache.clear();
});

describe("tipFailoverPath", () => {
  it("accepts exactly the tip and block-height GETs of the primary", () => {
    const base = CONFIG.esploraAddress;
    expect(tipFailoverPath("GET", base + "/blocks/tip/height")).toBe("/blocks/tip/height");
    expect(tipFailoverPath("GET", base + "/blocks/tip/hash")).toBe("/blocks/tip/hash");
    expect(tipFailoverPath("GET", base + "/block-height/123")).toBe("/block-height/123");
  });
  it("never accepts anything that names an address, a transaction or a script, or a write", () => {
    const base = CONFIG.esploraAddress;
    for (const u of [
      "/address/bc1qxyz/txs",
      "/scripthash/abc/utxo",
      "/tx/abc",
      "/tx",
      "/fee-estimates",
      "/block-height/12x",
      "/block-height/",
      "/blocks/tip/height/extra",
      "/blocks/tip/height?x=1",
    ]) {
      expect(tipFailoverPath("GET", base + u), u).toBeNull();
    }
    expect(tipFailoverPath("POST", base + "/blocks/tip/height")).toBeNull();
    expect(tipFailoverPath("GET", "https://elsewhere.test/api/blocks/tip/height")).toBeNull();
  });
});

describe("fetchTipWithFailover", () => {
  it("a healthy primary answers and nothing else is asked", async () => {
    const res = await run({ [P]: [ok("900")] });
    expect(await res!.text()).toBe("900");
    expect(calls).toEqual([P + PATH]);
    expect(state.highest).toBe(900);
  });

  it("a primary that does not answer moves the request to the next source, and the next one is cached", async () => {
    const replies = { [P]: [new Error("net")], [A]: [ok("901")] };
    expect(await (await run(replies))!.text()).toBe("901");
    expect(calls).toEqual([P + PATH, A + PATH]);
    expect(failovers).toEqual([`${P}:null`]);
    calls.length = 0;
    expect(await (await run(replies))!.text()).toBe("901"); // within the pause and the cache window
    expect(calls).toEqual([]);
  });

  it("a 5xx pauses a source for TIP_PAUSE_MS, then it is asked first again", async () => {
    await run({ [P]: [ok("", 503), ok("905")], [A]: [ok("902")] });
    calls.length = 0;
    exitAnswerCache.clear();
    t += TIP_PAUSE_MS - 1;
    await run({ [P]: [ok("905")], [A]: [ok("903")] });
    expect(calls).toEqual([A + PATH]); // still paused
    calls.length = 0;
    exitAnswerCache.clear();
    t += 2;
    expect(await (await run({ [P]: [ok("905")], [A]: [ok("903")] }))!.text()).toBe("905");
    expect(calls).toEqual([P + PATH]);
  });

  it("a refusal (429) pauses much longer than a failure", async () => {
    await run({ [P]: [ok("", 429)], [A]: [ok("900")] });
    exitAnswerCache.clear();
    t += TIP_PAUSE_MS + 1;
    calls.length = 0;
    await run({ [P]: [ok("900")], [A]: [ok("900")] });
    expect(calls).toEqual([A + PATH]);
    expect(TIP_REFUSAL_PAUSE_MS).toBeGreaterThan(TIP_PAUSE_MS);
  });

  it("walks on to the next fallback when the first one also fails", async () => {
    const res = await run({ [P]: [new Error("net")], [A]: [ok("", 500)], [B]: [ok("902")] });
    expect(await res!.text()).toBe("902");
    expect(calls).toEqual([P + PATH, A + PATH, B + PATH]);
  });

  it("a body that fails after the answer arrived is a failed source, and the next fallback is asked", async () => {
    const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("stream")) }), { status: 200 });
    const res = await run({ [P]: [new Error("net")], [A]: [broken()], [B]: [ok("902")] });
    expect(await res!.text()).toBe("902");
    expect(calls).toEqual([P + PATH, A + PATH, B + PATH]);
    expect(failovers).toEqual([`${P}:null`, `${A}:200`]);
    // The broken one is paused: a later request does not ask it again.
    exitAnswerCache.clear();
    calls.length = 0;
    await run({ [P]: [new Error("net")], [A]: [ok("903")], [B]: [ok("903")] });
    expect(calls).toEqual([B + PATH]);
  });

  it("a primary whose body cannot be read moves on to a fallback, and when none answers the caller gets null", async () => {
    const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("stream")) }), { status: 200 });
    const res = await run({ [P]: [broken()], [A]: [ok("901")] });
    expect(await res!.text()).toBe("901");
    expect(failovers).toEqual([`${P}:200`]);
    exitAnswerCache.clear();
    state.pausedUntil.clear();
    expect(await run({ [P]: [broken()], [A]: [new Error("net")], [B]: [new Error("net")] })).toBeNull();
  });

  it("a hash whose height lookup is refused pauses that source as long as a refusal", async () => {
    const H = "/blocks/tip/hash";
    const hash = "ab".repeat(32);
    state.highest = 1000;
    state.highestAt = t;
    await run({ [P]: [new Error("net")], [A]: [ok(hash), ok("", 429)], [B]: [ok(hash), ok("1001")] }, H);
    expect(failovers).toContain(`${A}:429`);
    exitAnswerCache.clear();
    t += TIP_PAUSE_MS + 1;
    calls.length = 0;
    await run({ [P]: [new Error("net")], [A]: [ok("1001")], [B]: [ok("1001")] });
    expect(calls).toEqual([P + PATH, B + PATH]); // A is still paused, the primary's short pause is over
  });

  it("a cached fallback height is dropped once the primary's reference no longer allows it", async () => {
    await run({ [P]: [new Error("net")], [A]: [ok("902")] });
    state.highest = 902 - TIP_MAX_LEAD_BLOCKS - 50;
    state.highestAt = t;
    calls.length = 0;
    const res = await run({ [A]: [ok(String(state.highest))] });
    expect(await res!.text()).toBe(String(state.highest));
    expect(calls).toEqual([A + PATH]);
  });

  it("a fallback trailing a known height by more than the allowed lag is treated as failed", async () => {
    state.highest = 1000;
    state.highestAt = t;
    const stale = String(1000 - TIP_MAX_LAG_BLOCKS - 1);
    const fine = String(1000 - TIP_MAX_LAG_BLOCKS);
    const res = await run({ [P]: [new Error("net")], [A]: [ok(stale)], [B]: [ok(fine)] });
    expect(await res!.text()).toBe(fine);
    expect(calls).toEqual([P + PATH, A + PATH, B + PATH]);
  });

  it("a fallback far ahead of the primary's last height is a failed source and does not move the reference", async () => {
    state.highest = 1000;
    state.highestAt = t;
    const res = await run({ [P]: [new Error("net")], [A]: [ok("999999999")], [B]: [ok("1002")] });
    expect(await res!.text()).toBe("1002");
    expect(calls).toEqual([P + PATH, A + PATH, B + PATH]);
    expect(state.highest).toBe(1000);
  });

  it("the allowed lead grows with the time since the primary last answered", async () => {
    state.highest = 1000;
    state.highestAt = t;
    t += 2 * TIP_BLOCK_ALLOWANCE_MS;
    const res = await run({ [P]: [new Error("net")], [A]: [ok(String(1000 + TIP_MAX_LEAD_BLOCKS + 2))] });
    expect(await res!.text()).toBe(String(1000 + TIP_MAX_LEAD_BLOCKS + 2));
  });

  it("a fallback height never becomes the reference: honest fallbacks keep passing after a lie", async () => {
    state.highest = 1000;
    state.highestAt = t;
    await run({ [P]: [new Error("net")], [A]: [ok("999999999")], [B]: [ok("1001")] });
    expect(state.highest).toBe(1000);
  });

  it("a tip hash from a fallback needs a 64-digit hex string and a plausible height from the same source", async () => {
    const H = "/blocks/tip/hash";
    const hash = "ab".repeat(32);
    state.highest = 1000;
    state.highestAt = t;
    // A: hash fine, its height far behind. B: hash fine, height fine.
    const res = await run({ [P]: [new Error("net")], [A]: [ok(hash), ok("500")], [B]: [ok(hash), ok("1001")] }, H);
    expect(await res!.text()).toBe(hash);
    expect(calls).toEqual([P + H, A + H, A + "/blocks/tip/height", B + H, B + "/blocks/tip/height"]);
    // Not hex at all.
    exitAnswerCache.clear();
    state.pausedUntil.clear();
    calls = [];
    const res2 = await run({ [P]: [new Error("net")], [A]: [ok("<html>")], [B]: [ok(hash), ok("1000")] }, H);
    expect(await res2!.text()).toBe(hash);
    expect(calls[1]).toBe(A + H);
    expect(calls[2]).toBe(B + H);
  });

  it("a block-height lookup above any tip the primary could have is a failed source", async () => {
    const BH = "/block-height/999999";
    const hash = "cd".repeat(32);
    state.highest = 1000;
    state.highestAt = t;
    const res = await run({ [P]: [new Error("net")], [A]: [ok(hash)], [B]: [ok(hash)] }, BH);
    expect(res).toBeNull();
  });

  it("a height that is not a number is a failed source", async () => {
    for (const body of ["abc", "", "12.5", "-3", "<html>"]) {
      state = primaryAnswered();
      exitAnswerCache.clear();
      calls = [];
      const res = await run({ [P]: [new Error("net")], [A]: [ok(body)], [B]: [ok("901")] });
      expect(await res!.text(), body).toBe("901");
    }
  });

  it("when every source fails it returns null, so the caller sends the original request as before", async () => {
    const res = await run({ [P]: [new Error("net")], [A]: [ok("", 503)], [B]: [ok("", 429)] });
    expect(res).toBeNull();
  });

  it("an answer other than success from the primary is returned as it is (a 404 is an answer)", async () => {
    const res = await run({ [P]: [ok("", 404)] }, "/block-height/5");
    expect(res!.status).toBe(404);
    expect(calls).toEqual([P + "/block-height/5"]);
  });

  it("an abort is never retried on another host", async () => {
    const c = new AbortController();
    c.abort();
    const abortErr = new DOMException("aborted", "AbortError");
    await expect(run({ [P]: [abortErr], [A]: [ok("900")] }, PATH, c.signal)).rejects.toBe(abortErr);
    expect(calls).toEqual([P + PATH]);
  });

  it("every request to a fallback is a GET of the same path, nothing else", async () => {
    const seen: Request[] = [];
    const real = async (r: Request) => {
      seen.push(r);
      if (r.url.startsWith(P)) throw new Error("net");
      return ok("900");
    };
    await fetchTipWithFailover(req(), PATH, SOURCES, real, () => {}, state, now);
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${P}${PATH}`, `GET ${A}${PATH}`]);
    expect(seen[1].redirect).toBe("error");
  });
});

describe("fetchTipWithFailover without any primary answer in this worker", () => {
  beforeEach(() => {
    state = fresh();
  });

  it("takes a fallback answer only after two fallbacks agree, asked one after the other", async () => {
    const res = await run({ [P]: [new Error("net")], [A]: [ok("901")], [B]: [ok(String(901 + TIP_AGREEMENT_BLOCKS))] });
    expect(await res!.text()).toBe("901");
    expect(calls).toEqual([P + PATH, A + PATH, B + PATH, A + PATH]);
    expect(state.agreed).toBe(901);
    expect(state.highest).toBe(0); // a fallback never becomes the primary's reference
  });

  it("one fallback alone is never believed: the other one down means no fallback answer", async () => {
    const res = await run({ [P]: [new Error("net")], [A]: [ok("901")], [B]: [ok("", 503)] });
    expect(res).toBeNull();
    expect(state.agreed).toBe(0);
    expect(failovers).toEqual([`${P}:null`, `${B}:503`]);
    expect(exitAnswerCache.size).toBe(0);
  });

  it("a fallback far in the future does not agree with an honest one, so neither is taken", async () => {
    const res = await run({ [P]: [new Error("net")], [A]: [ok("999999")], [B]: [ok("901")] });
    expect(res).toBeNull();
    expect(state.agreed).toBe(0);
    const res2 = await run({ [P]: [new Error("net")], [A]: [ok("901")], [B]: [ok(String(901 + TIP_AGREEMENT_BLOCKS + 1))] });
    expect(res2).toBeNull();
  });

  it("a hash or a block lookup also waits for agreement", async () => {
    const hash = "ab".repeat(32);
    expect(await run({ [P]: [new Error("net")], [A]: [ok(hash)], [B]: [ok("", 503)] }, "/block-height/900")).toBeNull();
    expect(calls).toEqual([P + "/block-height/900", A + PATH, B + PATH]); // the block itself was never asked for
  });

  it("the agreed height then bounds a fallback's later answers like the primary's would", async () => {
    // A agrees at 900, then claims a far future tip for the request itself: refused, B's answer taken.
    const res = await run({ [P]: [new Error("net")], [A]: [ok("900"), ok("999999")], [B]: [ok("901")] });
    expect(await res!.text()).toBe("901");
    expect(state.agreed).toBe(900);
    exitAnswerCache.clear();
    const BH = `/block-height/${900 + TIP_MAX_LEAD_BLOCKS + 1}`;
    state.pausedUntil.clear();
    expect(await run({ [P]: [new Error("net")], [A]: [ok("cd".repeat(32))], [B]: [ok("cd".repeat(32))] }, BH)).toBeNull();
  });

  it("once the primary answers, its height is the reference again", async () => {
    await run({ [P]: [new Error("net")], [A]: [ok("900")], [B]: [ok("900")] });
    t += TIP_PAUSE_MS + 1;
    exitAnswerCache.clear();
    await run({ [P]: [ok("950")] });
    expect(state.highest).toBe(950);
    t += 1;
    exitAnswerCache.clear();
    calls = [];
    const res = await run({ [P]: [new Error("net")], [A]: [ok("901")], [B]: [ok("950")] });
    expect(await res!.text()).toBe("950"); // 901 is far behind the primary's 950
  });
});
