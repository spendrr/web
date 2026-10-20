// A Durable Object call that throws (daily request limit spent, object
// overloaded, a reset) must reach the client as a plain retryable 503, not as
// Cloudflare's opaque 1101 page from an uncaught exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

const throwingNamespace = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async () => {
      throw new Error("Durable Object is overloaded. Too many requests queued.");
    },
  }),
};

const ok = { limit: async () => ({ success: true }) };

function env() {
  return {
    BUMP_RATE_LIMITER: ok,
    BUMP_POLL_RATE_LIMITER: ok,
    BUMP_LAB: throwingNamespace,
  } as never;
}

afterEach(() => vi.restoreAllMocks());

describe("Durable Object failure", () => {
  it("a bump tap answers 503 with Retry-After", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await worker.fetch(
      new Request("https://spendrr.app/api/bump/tap", {
        method: "POST",
        headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.30", "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Service busy. Try again shortly." });
  });

  it("a bump status poll answers 503 too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await worker.fetch(
      new Request("https://spendrr.app/api/bump/status?pairId=x", {
        headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.31" },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("the failure is logged, once", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.fetch(
      new Request("https://spendrr.app/api/bump/tap", {
        method: "POST",
        headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.32", "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env(),
      ctx,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
