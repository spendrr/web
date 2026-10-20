// public/fetch-guard.js lets exactly one cross-origin request through: a GET
// of the public price file. Run in a bare realm with just what it patches.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PUBLIC_PRICE_URL } from "../src/lib/price";

function loadGuard() {
  const sent: string[] = [];
  const win: Record<string, unknown> = {
    location: { href: "https://spendrr.app/", host: "spendrr.app" },
    fetch: async (req: Request) => {
      sent.push(`${req.method} ${req.url}`);
      return new Response("ok");
    },
    WebSocket: function () {},
    Worker: function () {},
  };
  // DOM constructors the guard patches further down; empty stand-ins suffice
  // for the fetch part under test.
  const dom: Record<string, unknown> = {};
  for (const name of [
    "Node",
    "Element",
    "Document",
    "DocumentFragment",
    "ShadowRoot",
    "Range",
    "HTMLAnchorElement",
    "HTMLEmbedElement",
    "HTMLFrameElement",
    "HTMLIFrameElement",
    "HTMLLinkElement",
    "HTMLObjectElement",
  ]) {
    dom[name] = function () {};
  }
  const ctx = {
    ...dom,
    window: win,
    navigator: {},
    Navigator: function () {},
    XMLHttpRequest: { prototype: { open() {} } },
    Request,
    URL,
    Promise,
    Object,
    Array,
    String,
    Error,
    console: { error() {} },
  };
  runInNewContext(readFileSync("public/fetch-guard.js", "utf8"), ctx);
  return { fetch: win.fetch as (input: string, init?: RequestInit) => Promise<Response>, sent };
}

describe("fetch-guard: the public price exception", () => {
  it("must name the same URL as the price client", () => {
    expect(readFileSync("public/fetch-guard.js", "utf8")).toContain(`"${PUBLIC_PRICE_URL}"`);
  });

  it("lets a GET of exactly that URL through, and same-origin as before", async () => {
    const g = loadGuard();
    await g.fetch(PUBLIC_PRICE_URL, { credentials: "omit" });
    await g.fetch("https://spendrr.app/api/price/simple"); // Node has no page URL to resolve a relative one
    expect(g.sent).toEqual([`GET ${PUBLIC_PRICE_URL}`, "GET https://spendrr.app/api/price/simple"]);
  });

  it("refuses everything else on that host or anywhere else", async () => {
    const g = loadGuard();
    for (const [url, init] of [
      [`${PUBLIC_PRICE_URL}?s=secret`, undefined],
      [`${PUBLIC_PRICE_URL}#x`, undefined],
      ["https://data.spendrr.app/other.json", undefined],
      ["https://data.spendrr.app/price.json/../x", undefined],
      [PUBLIC_PRICE_URL, { method: "POST", body: "secret" }],
      ["https://evil.test/price.json", undefined],
    ] as [string, RequestInit | undefined][]) {
      await expect(g.fetch(url, init)).rejects.toThrow("Blocked unexpected network request");
    }
    expect(g.sent).toEqual([]);
  });
});
