// worker/lnLedger.ts (the Cloudflare Worker) imports src/lib/send/destination.ts.
// The Worker is bundled by wrangler, which does not know Vite's `__NETWORK__`
// define, so anything in that import graph that reads it (network.ts, and
// through it bitcoinAddress.ts) crashes the Worker at startup with
// "ReferenceError: __NETWORK__ is not defined". `vite build` and vitest both
// define it, so neither notices: this happened once, caught only by running
// `wrangler dev`. Network-aware checks live in destinationCheck.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("destination.ts stays importable from the Worker", () => {
  it("has no imports at all", () => {
    const source = readFileSync("src/lib/send/destination.ts", "utf8");
    expect(source.match(/^\s*import\s/gm)).toBeNull();
  });
});
