// The wallet worker's same-origin rule (src/lib/wallet/walletWorkerGuard.ts). Its own
// origin hosts a store anyone can write to and read back (/api/backup/*), so
// the worker may only ever GET static assets from it.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CONFIG,
  FALLBACK_ESPLORA_ADDRESS,
  INDEPENDENT_REFUSAL_LIMIT_MS,
  type IndependentEsploraState,
  cachedExitAnswer,
  exitAnswerCache,
  exitCacheKey,
  fetchViaIndependentEsplora,
  rememberExitAnswer,
  independentEsploraFailed,
  isAllowedSameOriginRequest,
  redirectEsploraUrl,
  WITHHELD_RETRY_STATUS,
  withoutEsploraRetry,
} from "../src/lib/wallet/walletWorkerGuard";

const origin = "https://spendrr.app";
const at = (path: string) => new URL(path, origin);

describe("isAllowedSameOriginRequest", () => {
  it("allows the SDK's wasm in a build", () => {
    expect(isAllowedSameOriginRequest(at("/assets/bark_ffi_wasm_bg-DzisTqmc.wasm"), "GET", false)).toBe(true);
    expect(isAllowedSameOriginRequest(at("/assets/x.wasm"), "head", false)).toBe(true);
  });

  it("refuses the backup dead drop and every other API path", () => {
    for (const path of ["/api/backup/upload-tmp", "/api/backup/commit", "/api/backup/fetch", "/api/names/x", "/"]) {
      expect(isAllowedSameOriginRequest(at(path), "GET", false)).toBe(false);
      expect(isAllowedSameOriginRequest(at(path), "POST", false)).toBe(false);
    }
  });

  it("refuses path tricks that would still reach /api", () => {
    for (const path of ["/assets/../api/backup/fetch", "/assets/%2e%2e/api/backup/fetch", "/assets/x.wasm?s=secret"]) {
      expect(isAllowedSameOriginRequest(at(path), "GET", false)).toBe(false);
    }
  });

  it("never allows a same-origin write, in dev or a build", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("POST", "PUT", "PATCH", "DELETE", "post", "OPTIONS"),
        fc.webPath(),
        fc.boolean(),
        (method, path, dev) => !isAllowedSameOriginRequest(new URL(origin + "/assets" + path), method, dev),
      ),
    );
  });
});

describe("redirectEsploraUrl (exit chain source)", () => {
  const primary = "https://mempool.second.tech/api";
  const independent = "https://mempool.space/api";

  it("moves every esplora path onto the independent host", () => {
    expect(redirectEsploraUrl(`${primary}/txs/package`, primary, independent)).toBe(`${independent}/txs/package`);
    expect(redirectEsploraUrl(`${primary}/tx/ab/status`, primary, independent)).toBe(`${independent}/tx/ab/status`);
    expect(redirectEsploraUrl(`${primary}/fee-estimates`, primary, independent)).toBe(`${independent}/fee-estimates`);
    expect(redirectEsploraUrl(primary, primary, independent)).toBe(independent);
    expect(redirectEsploraUrl(`${primary}?x=1`, primary, independent)).toBe(`${independent}?x=1`);
  });

  it("leaves everything else alone", () => {
    expect(redirectEsploraUrl("https://ark.second.tech/ark.v1.ArkService/GetArkInfo", primary, independent)).toBeNull();
    // Same host, outside the /api prefix.
    expect(redirectEsploraUrl("https://mempool.second.tech/apiary", primary, independent)).toBeNull();
    expect(redirectEsploraUrl("https://mempool.second.tech/", primary, independent)).toBeNull();
    // A look-alike host.
    expect(redirectEsploraUrl("https://mempool.second.tech.evil.com/api/tx", primary, independent)).toBeNull();
    expect(redirectEsploraUrl(`${independent}/tx`, primary, independent)).toBeNull();
    expect(redirectEsploraUrl(`${primary}/tx`, primary, primary)).toBeNull();
  });

  it("uses this build's hosts by default", () => {
    const out = redirectEsploraUrl(`${CONFIG.esploraAddress}/blocks/tip/height`);
    expect(out).toBe(`${FALLBACK_ESPLORA_ADDRESS}/blocks/tip/height`);
  });
});

describe("independentEsploraFailed", () => {
  it("falls back only when the independent host didn't answer", () => {
    expect(independentEsploraFailed(null)).toBe(true);
    expect(independentEsploraFailed(502)).toBe(true);
    // Answers, never asked of Second instead: a 404 is "unknown transaction"
    // (bark re-broadcasts), a 400 a rejected broadcast, a 429 a rate limit
    // (retried once at the same host by fetchViaIndependentEsplora).
    expect(independentEsploraFailed(429)).toBe(false);
    expect(independentEsploraFailed(404)).toBe(false);
    expect(independentEsploraFailed(400)).toBe(false);
    expect(independentEsploraFailed(200)).toBe(false);
  });
});

describe("fetchViaIndependentEsplora", () => {
  const second = "https://mempool.second.tech/api/txs/package";
  const space = "https://mempool.space/api/txs/package";
  const stream = "https://blockstream.info/api/txs/package";
  const post = (signal?: AbortSignal) =>
    new Request(second, { method: "POST", headers: { "content-type": "application/json" }, body: '["aa"]', signal });
  const fresh = (): IndependentEsploraState => ({ preferred: 0, refusingSince: null });

  function fake(responses: Array<number | "throw">) {
    const seen: { url: string; body: string; signal: AbortSignal }[] = [];
    const realFetch = async (r: Request) => {
      seen.push({ url: r.url, body: await r.text(), signal: r.signal });
      const next = responses.shift();
      if (next === "throw" || next === undefined) throw new TypeError("network");
      return new Response("x", { status: next });
    };
    return { realFetch, seen };
  }

  it("answers from the first independent host with the same method and body", async () => {
    const { realFetch, seen } = fake([200]);
    const fallbacks: (number | null)[] = [];
    const res = await fetchViaIndependentEsplora(post(), [space, stream], realFetch, (s) => fallbacks.push(s), fresh());
    expect(res.status).toBe(200);
    expect(seen.map((x) => x.url)).toEqual([space]);
    expect(seen[0].body).toBe('["aa"]');
    expect(fallbacks).toEqual([]);
  });

  it("returns a 404 as an answer, never asking anyone else", async () => {
    const { realFetch, seen } = fake([404]);
    const fallbacks: (number | null)[] = [];
    const res = await fetchViaIndependentEsplora(post(), [space, stream], realFetch, (s) => fallbacks.push(s), fresh());
    expect(res.status).toBe(404);
    expect(seen.map((x) => x.url)).toEqual([space]);
    expect(fallbacks).toEqual([]);
  });

  it("moves to the next independent host on a 429, 5xx or network error, and remembers it", async () => {
    for (const first of [429, 502, "throw"] as const) {
      const state = fresh();
      const { realFetch, seen } = fake([first, 200]);
      const res = await fetchViaIndependentEsplora(post(), [space, stream], realFetch, () => {}, state);
      expect(res.status).toBe(200);
      expect(seen.map((x) => x.url)).toEqual([space, stream]);
      expect(seen[1].body).toBe('["aa"]');
      expect(state).toEqual({ preferred: 1, refusingSince: null });
      const next = fake([200]);
      await fetchViaIndependentEsplora(post(), [space, stream], next.realFetch, () => {}, state);
      expect(next.seen.map((x) => x.url)).toEqual([stream]);
    }
  });

  it("falls back to Second, body intact, only when every independent host is down", async () => {
    const { realFetch, seen } = fake([503, "throw", 200]);
    const fallbacks: (number | null)[] = [];
    const res = await fetchViaIndependentEsplora(post(), [space, stream], realFetch, (s) => fallbacks.push(s), fresh());
    expect(res.status).toBe(200);
    expect(seen.map((x) => x.url)).toEqual([space, stream, second]);
    expect(seen[2].body).toBe('["aa"]');
    expect(fallbacks).toEqual([null]);
  });

  it("hands a refusal back while every host refuses, then uses Second after the limit", async () => {
    const state = fresh();
    let t = 1_000;
    const now = () => t;
    const first = fake([429, 429]);
    const fallbacks: (number | null)[] = [];
    expect((await fetchViaIndependentEsplora(post(), [space, stream], first.realFetch, (s) => fallbacks.push(s), state, now)).status).toBe(429);
    expect(first.seen.map((x) => x.url)).toEqual([space, stream]);
    expect(state.refusingSince).toBe(1_000);
    t += INDEPENDENT_REFUSAL_LIMIT_MS - 1;
    const still = fake([429, 429]);
    expect((await fetchViaIndependentEsplora(post(), [space, stream], still.realFetch, (s) => fallbacks.push(s), state, now)).status).toBe(429);
    expect(fallbacks).toEqual([]);
    t += 1;
    const late = fake([429, 429, 200]);
    expect((await fetchViaIndependentEsplora(post(), [space, stream], late.realFetch, (s) => fallbacks.push(s), state, now)).status).toBe(200);
    expect(late.seen.map((x) => x.url)).toEqual([space, stream, second]);
    expect(fallbacks).toEqual([429]);
  });

  it("an answer from any independent host resets the refusal clock", async () => {
    const state = fresh();
    let t = 0;
    await fetchViaIndependentEsplora(post(), [space, stream], fake([429, 429]).realFetch, () => {}, state, () => t);
    t = 10_000;
    await fetchViaIndependentEsplora(post(), [space, stream], fake([429, 200]).realFetch, () => {}, state, () => t);
    expect(state.refusingSince).toBeNull();
  });

  it("keeps bark's abort signal and never falls back after an abort", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const realFetch = async (r: Request) => {
      seen.push(r.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const fallbacks: (number | null)[] = [];
    await expect(
      fetchViaIndependentEsplora(post(controller.signal), [space, stream], realFetch, (s) => fallbacks.push(s), fresh()),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(true);
    expect(fallbacks).toEqual([]);
  });
});

describe("exit answer cache", () => {
  const primary = "https://mempool.second.tech/api";

  it("caches only the tip and fee GETs under the primary esplora", () => {
    expect(exitCacheKey("GET", `${primary}/blocks/tip/height`, primary)).toBe("/blocks/tip/height");
    expect(exitCacheKey("GET", `${primary}/fee-estimates`, primary)).toBe("/fee-estimates");
    expect(exitCacheKey("POST", `${primary}/blocks/tip/height`, primary)).toBeNull();
    expect(exitCacheKey("GET", `${primary}/tx/abc/status`, primary)).toBeNull();
    expect(exitCacheKey("GET", `${primary}.evil/blocks/tip/height`, primary)).toBeNull();
    expect(exitCacheKey("GET", `${primary}/block-height/325250`, primary)).toBe("/block-height/325250");
    expect(exitCacheKey("GET", `${primary}/block-height/`, primary)).toBeNull();
    expect(exitCacheKey("GET", `${primary}/block-height/1x`, primary)).toBeNull();
  });

  it("serves a 200 until its TTL, url kept, and never caches an error", async () => {
    exitAnswerCache.clear();
    const ok = new Response("325248", { status: 200, headers: { "content-type": "text/plain" } });
    Object.defineProperty(ok, "url", { value: "https://mempool.space/api/blocks/tip/height" });
    const first = await rememberExitAnswer("/blocks/tip/height", ok, 0);
    expect(await first.text()).toBe("325248");
    const hit = cachedExitAnswer("/blocks/tip/height", 29_999);
    expect(hit && (await hit.text())).toBe("325248");
    expect(hit?.url).toBe("https://mempool.space/api/blocks/tip/height");
    expect(cachedExitAnswer("/blocks/tip/height", 30_000)).toBeNull();
    const fees = await rememberExitAnswer("/fee-estimates", new Response("{}", { status: 203 }), 0);
    expect(fees.status).toBe(203);
    expect(cachedExitAnswer("/fee-estimates", 59_999)?.status).toBe(203);
    exitAnswerCache.clear();
    const limited = await rememberExitAnswer("/fee-estimates", new Response("no", { status: 429 }), 0);
    expect(limited.status).toBe(429);
    expect(cachedExitAnswer("/fee-estimates", 1)).toBeNull();
  });
});

describe("withoutEsploraRetry (bark's esplora retry panics on wasm)", () => {
  const second = `${CONFIG.esploraAddress}/blocks/tip/height`;
  const independent = `${FALLBACK_ESPLORA_ADDRESS}/fee-estimates`;

  it("turns 429, 500 and 503 from either esplora into a 502, body and headers kept", async () => {
    for (const url of [second, independent]) {
      for (const status of [429, 500, 503]) {
        const original = new Response("slow down", { status, headers: { "retry-after": "5" } });
        Object.defineProperty(original, "url", { value: url });
        const res = withoutEsploraRetry(url, original);
        expect(res.status).toBe(WITHHELD_RETRY_STATUS);
        expect(res.url).toBe(url);
        expect(await res.text()).toBe("slow down");
        expect(res.headers.get("retry-after")).toBe("5");
      }
    }
  });

  it("leaves every other status alone (404 means an unknown tx to bark)", () => {
    for (const status of [200, 400, 404, 502, 504]) {
      const original = new Response(null, { status });
      expect(withoutEsploraRetry(second, original)).toBe(original);
    }
  });

  it("leaves non-esplora hosts alone, look-alike prefixes included", () => {
    for (const url of [
      `${CONFIG.serverAddress}/bark_server.ArkService/Handshake`,
      `${CONFIG.esploraAddress}.evil.example/blocks/tip/height`,
      "https://example.com/api/blocks/tip/height",
    ]) {
      const original = new Response(null, { status: 429 });
      expect(withoutEsploraRetry(url, original)).toBe(original);
    }
  });

  it("no retryable status ever reaches bark from an esplora URL", () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 599 }), fc.constantFrom(second, independent), (status, url) => {
        const res = withoutEsploraRetry(url, new Response(null, { status }));
        expect([429, 500, 503]).not.toContain(res.status);
      }),
    );
  });
});
