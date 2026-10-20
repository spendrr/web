import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetBtcRatesForTests, btcRatesUpdatedAt, fetchBtcRates, PUBLIC_PRICE_URL } from "../src/lib/price";

// A model of the Worker side (worker/priceCache.ts): the cron rewrites the
// shared copy on the first minute tick at least 330 s after the last write,
// and each colo keeps what it read for 60 s.
function serverModel(start: number) {
  let written = start;
  let coloUntil = -Infinity;
  let coloCopy = written;
  return {
    tick(now: number) {
      if (now - written >= 330_000) written = now;
    },
    answer(now: number): number {
      if (now >= coloUntil) {
        coloCopy = written;
        coloUntil = now + 60_000;
      }
      return coloCopy;
    },
    written: () => written,
  };
}

describe("fetchBtcRates polling against the shared price copy", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    __resetBtcRatesForTests();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  // Runs a caller polling every 60 s (Dashboard) for `minutes`, with the
  // cron on its own minute ticks offset by `cronPhaseMs`. Returns how many
  // requests reached the Worker and the worst age of the price on screen,
  // counted from when the server wrote it.
  async function simulate(minutes: number, cronPhaseMs: number, legacy: boolean) {
    const t0 = Date.now();
    const server = serverModel(t0 - 200_000);
    let requests = 0;
    globalThis.fetch = vi.fn(async () => {
      requests++;
      const copy = server.answer(Date.now());
      return new Response(
        JSON.stringify({ bitcoin: { czk: copy % 1000, eur: 1, usd: 1, last_updated_at: Math.floor(copy / 1000) } }),
      );
    }) as typeof fetch;

    let shownWrittenAt = 0;
    let worstLag = 0;
    let legacyAt = -Infinity;
    for (let s = 0; s <= minutes * 60; s++) {
      const now = t0 + s * 1000;
      vi.setSystemTime(now);
      if ((s * 1000 - cronPhaseMs) % 60_000 === 0) server.tick(now);
      if (s % 60 === 0) {
        if (legacy) {
          // The old rule: one request per minute, whatever.
          if (now - legacyAt >= 60_000) {
            legacyAt = now;
            requests++;
            shownWrittenAt = server.answer(now);
          }
        } else {
          await fetchBtcRates();
          await vi.advanceTimersByTimeAsync(0);
          shownWrittenAt = (btcRatesUpdatedAt() ?? 0);
        }
      }
      // How long a newer copy than the one shown has been sitting on the server.
      if (server.written() > shownWrittenAt) worstLag = Math.max(worstLag, now - server.written());
    }
    return { requests, worstLag };
  }

  it("asks far less often, and the price on screen is never older than with one request a minute", async () => {
    for (const phase of [0, 7_000, 23_000, 41_000, 59_000]) {
      __resetBtcRatesForTests();
      vi.setSystemTime(1_800_000_000_000);
      const before = await simulate(120, phase, true);
      __resetBtcRatesForTests();
      vi.setSystemTime(1_800_000_000_000);
      const after = await simulate(120, phase, false);
      expect(after.worstLag).toBeLessThanOrEqual(before.worstLag);
      expect(after.requests).toBeLessThan(before.requests * 0.6);
    }
  });

  // These two run against the Worker alone, as before the public copy existed
  // (not set up yet: the public URL answers 404).
  it("without a known update time it stays at one request a minute", async () => {
    let requests = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === PUBLIC_PRICE_URL) return new Response("", { status: 404 });
      requests++;
      return new Response(JSON.stringify({ bitcoin: { czk: requests, eur: 1, usd: 1 } }));
    }) as typeof fetch;
    for (let m = 0; m < 10; m++) {
      await fetchBtcRates();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(requests).toBe(10);
  });

  it("a change seen after a gap (hidden tab) does not start the quiet period", async () => {
    let updated = 1_000;
    let requests = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === PUBLIC_PRICE_URL) return new Response("", { status: 404 });
      requests++;
      return new Response(JSON.stringify({ bitcoin: { czk: 1, eur: 1, usd: 1, last_updated_at: updated } }));
    }) as typeof fetch;
    await fetchBtcRates();
    await vi.advanceTimersByTimeAsync(10 * 60_000); // nobody asked for ten minutes
    updated = 2_000;
    await fetchBtcRates();
    await vi.advanceTimersByTimeAsync(60_000);
    await fetchBtcRates();
    expect(requests).toBe(3);
  });
});

describe("the public price copy", () => {
  let originalFetch: typeof fetch;
  let calls: string[];
  let publicAnswer: (init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    __resetBtcRatesForTests();
    originalFetch = globalThis.fetch;
    calls = [];
    publicAnswer = () => body(Date.now() - 2 * 60_000, 100);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === PUBLIC_PRICE_URL) return publicAnswer(init);
      return body(Date.now() - 60_000, 200);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const body = (updatedAtMs: number, czk: number) =>
    new Response(JSON.stringify({ bitcoin: { czk, eur: 1, usd: 1, last_updated_at: Math.floor(updatedAtMs / 1000) } }));
  const workerCalls = () => calls.filter((u) => u !== PUBLIC_PRICE_URL).length;

  it("a fresh public copy is used and the Worker is never asked", async () => {
    expect((await fetchBtcRates()).czk).toBe(100);
    await vi.advanceTimersByTimeAsync(60_000);
    await fetchBtcRates();
    expect(workerCalls()).toBe(0);
  });

  it("the public copy is asked with credentials omitted and revalidated, never served from an old browser cache", async () => {
    let seen: RequestInit | undefined;
    publicAnswer = (init) => {
      seen = init;
      return body(Date.now() - 2 * 60_000, 100);
    };
    await fetchBtcRates();
    expect(seen?.credentials).toBe("omit");
    expect(seen?.cache).toBe("no-cache");
  });

  it("a stale, broken or missing copy falls back to the Worker, which is then used alone for a while", async () => {
    for (const bad of [
      () => body(Date.now() - 20 * 60_000, 100), // the cron stopped
      () => new Response("{}"), // not a price
      () => new Response("", { status: 404 }), // not set up
    ]) {
      __resetBtcRatesForTests();
      calls = [];
      publicAnswer = bad;
      expect((await fetchBtcRates()).czk).toBe(200);
      await vi.advanceTimersByTimeAsync(60_000);
      await fetchBtcRates();
      expect(calls.filter((u) => u === PUBLIC_PRICE_URL)).toHaveLength(1);
      expect(workerCalls()).toBe(2);
    }
  });

  it("a copy that hangs is given up after 5 s and the Worker answers", async () => {
    publicAnswer = (init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const rates = fetchBtcRates();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await rates).czk).toBe(200);
  });

  it("an unreachable copy (CORS, DNS) is tried again after half an hour", async () => {
    publicAnswer = () => {
      throw new TypeError("Failed to fetch");
    };
    await fetchBtcRates();
    publicAnswer = () => body(Date.now() - 60_000, 100);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect((await fetchBtcRates()).czk).toBe(200);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect((await fetchBtcRates()).czk).toBe(100);
  });
});
