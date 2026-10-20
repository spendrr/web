// Everything the Worker builds itself must carry the baseline headers that
// public/_headers only gives to static assets.
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

describe("Worker responses", () => {
  it("a handler's own answer gets nosniff and no-referrer", async () => {
    const res = await worker.fetch(new Request("https://spendrr.app/api/backup/meta", { method: "POST" }), {} as never, ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("the catch-all 503 carries them too", async () => {
    // No bindings at all: the handler throws, the wrapper turns it into a 503.
    const res = await worker.fetch(
      new Request("https://spendrr.app/api/price/history?vs_currency=usd&days=7"),
      {} as never,
      ctx,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps what the handler already set", async () => {
    const res = await worker.fetch(
      new Request("https://spendrr.app/.well-known/assetlinks.json"),
      {} as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
