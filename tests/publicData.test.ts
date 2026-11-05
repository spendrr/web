import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allPublicDataUrls, FEES_MAX_AGE_MS, historyMaxAgeMs, PUBLIC_FEES_URL, readPublicCopy } from "../src/lib/publicData";
import { isChartPoints } from "../src/lib/publicHistory";

let now: number;
let calls: string[];

beforeEach(() => {
  now = 1_900_000_000_000;
  calls = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function serve(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return handler(url);
  });
}

// A distinct URL per test: the failure memory is per URL and lives as long as the module.
let n = 0;
const fresh = () => `https://data.spendrr.app/test-${n++}.json`;

describe("readPublicCopy", () => {
  it("returns a copy whose `at` is recent", async () => {
    serve(() => Response.json({ at: now - 1000, fastestFee: 5 }));
    expect((await readPublicCopy(fresh(), FEES_MAX_AGE_MS))?.fastestFee).toBe(5);
  });

  it("refuses a copy that is too old, has no `at`, or is not an object", async () => {
    for (const body of [{ at: now - FEES_MAX_AGE_MS - 1 }, { fastestFee: 5 }, { at: "yesterday" }, [1, 2], "text", null]) {
      serve(() => Response.json(body));
      expect(await readPublicCopy(fresh(), FEES_MAX_AGE_MS)).toBeNull();
    }
  });

  it("refuses an error status, a body that is not JSON and a request that fails", async () => {
    serve(() => new Response("nope", { status: 404 }));
    expect(await readPublicCopy(fresh(), FEES_MAX_AGE_MS)).toBeNull();
    serve(() => new Response("<html>", { status: 200 }));
    expect(await readPublicCopy(fresh(), FEES_MAX_AGE_MS)).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("blocked by CORS");
    });
    expect(await readPublicCopy(fresh(), FEES_MAX_AGE_MS)).toBeNull();
  });

  it("stays off a URL that failed for ten minutes, then tries it again", async () => {
    const url = fresh();
    serve(() => new Response("nope", { status: 404 }));
    expect(await readPublicCopy(url, FEES_MAX_AGE_MS)).toBeNull();
    expect(calls).toEqual([url]);

    serve(() => Response.json({ at: now }));
    now += 9 * 60_000;
    expect(await readPublicCopy(url, FEES_MAX_AGE_MS)).toBeNull();
    expect(calls).toEqual([url]); // no second request

    now += 2 * 60_000;
    expect(await readPublicCopy(url, FEES_MAX_AGE_MS)).not.toBeNull();
    expect(calls.length).toBe(2);
  });

  it("asks without credentials and revalidates", async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, i?: RequestInit) => {
      init = i;
      return Response.json({ at: now });
    });
    await readPublicCopy(PUBLIC_FEES_URL, FEES_MAX_AGE_MS);
    expect(init?.credentials).toBe("omit");
    expect(init?.cache).toBe("no-cache");
  });
});

describe("freshness limits", () => {
  it("allow longer for the charts the cron rewrites less often", () => {
    expect(historyMaxAgeMs(1)).toBeLessThan(historyMaxAgeMs(30));
    expect(historyMaxAgeMs(30)).toBeLessThan(historyMaxAgeMs(365));
  });
});

describe("allPublicDataUrls", () => {
  it("lists every file once, all on the data origin", () => {
    const urls = allPublicDataUrls();
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((u) => u.startsWith("https://data.spendrr.app/"))).toBe(true);
  });
});

describe("isChartPoints", () => {
  it("accepts [time, price] pairs and nothing else", () => {
    expect(isChartPoints([[1, 2], [3, 4]])).toBe(true);
    expect(isChartPoints([])).toBe(true);
    expect(isChartPoints([null])).toBe(false);
    expect(isChartPoints([[1]])).toBe(false);
    expect(isChartPoints([[1, 2, 3]])).toBe(false);
    expect(isChartPoints([[1, 0]])).toBe(false);
    expect(isChartPoints([[1, NaN]])).toBe(false);
    expect(isChartPoints({ length: 1 })).toBe(false);
  });
});
