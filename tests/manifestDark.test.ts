// /manifest.json is served by the Worker so a dark-mode Chrome gets the dark
// theme-color (worker/index.ts, handleManifest). Revalidating a cached copy
// used to throw "Unexpected end of JSON input" (a 503) in that variant.
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const FILE = JSON.stringify({ name: "Spendrr", theme_color: "#ffffff", background_color: "#ffffff" });
const ETAG = 'W/"abc"';

// What the asset layer does: 304 with no body for a matching If-None-Match.
function assets(seen: Request[] = []) {
  return {
    async fetch(req: Request) {
      seen.push(req);
      if (req.headers.get("If-None-Match") === ETAG) return new Response(null, { status: 304, headers: { ETag: ETAG } });
      return new Response(FILE, { headers: { "Content-Type": "application/json", ETag: ETAG, "Content-Length": String(FILE.length) } });
    },
  };
}

const get = (headers: Record<string, string>, seen?: Request[]) =>
  worker.fetch(new Request("https://spendrr.app/manifest.json", { headers }), { ASSETS: assets(seen) } as never, ctx);

describe("/manifest.json", () => {
  it("dark: a conditional request gets the full dark manifest, not a 503", async () => {
    const seen: Request[] = [];
    const res = await get({ "Sec-CH-Prefers-Color-Scheme": "dark", "If-None-Match": ETAG }, seen);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.theme_color).toBe("#100e0a");
    expect(body.background_color).toBe("#100e0a");
    expect(seen[0].headers.get("If-None-Match")).toBeNull();
  });

  it("dark: the light file's validators do not leak onto the dark body", async () => {
    const res = await get({ "Sec-CH-Prefers-Color-Scheme": "dark" });
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Content-Length")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Sec-CH-Prefers-Color-Scheme");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("light: passes the asset answer through, 304 included", async () => {
    const res = await get({ "If-None-Match": ETAG });
    expect(res.status).toBe(304);
    const plain = await get({});
    expect(((await plain.json()) as Record<string, string>).theme_color).toBe("#ffffff");
  });

  it("dark: an asset error is passed on as it is", async () => {
    const env = { ASSETS: { fetch: async () => new Response("nope", { status: 404 }) } };
    const res = await worker.fetch(new Request("https://spendrr.app/manifest.json", { headers: { "Sec-CH-Prefers-Color-Scheme": "dark" } }), env as never, ctx);
    expect(res.status).toBe(404);
  });
});
