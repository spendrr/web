// fetchTipHeightCached is what every expiry nudge depends on. It once lost an
// import (upstreamSignal) in a refactor and silently returned undefined for
// everyone, because its callers treat any failure as "skip this check".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTipHeightCached } from "../worker/mailboxShared";

beforeEach(() => {
  const store = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(req: Request) {
        return store.get(req.url)?.clone();
      },
      async put(req: Request, res: Response) {
        store.set(req.url, res);
      },
    },
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchTipHeightCached", () => {
  it("reads the height from the primary host and passes a deadline", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return new Response("912345\n", { status: 200 });
      }),
    );
    expect(await fetchTipHeightCached()).toBe(912345);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the second host", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return url.includes("second.tech") ? new Response("no", { status: 500 }) : new Response("912346", { status: 200 });
      }),
    );
    expect(await fetchTipHeightCached()).toBe(912346);
    expect(urls).toHaveLength(2);
  });

  it("is cached: a second call makes no request", async () => {
    const f = vi.fn(async () => new Response("912347", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await fetchTipHeightCached();
    await fetchTipHeightCached();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when both hosts fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await fetchTipHeightCached()).toBeUndefined();
  });
});
