// The wallet's WASM SDK is the code that holds the seed and signs. Pin the
// exact bytes of the npm build so a changed tarball (a bump, a re-publish or
// a swapped file in node_modules) fails the test instead of shipping quietly.
//
// This is not a proof of the source: the npm build does not reproduce
// byte-for-byte from the public source (the WASM build check is recorded in
// the internal notes). It catches silent changes. Any bump must update
// this pin in the same change, after reading the diff.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import pin from "./fixtures/bark-wasm.pin.json" with { type: "json" };

const wasmPath = fileURLToPath(new URL(`../node_modules/${pin.package}/${pin.file}`, import.meta.url));

describe("bark WASM pin", () => {
  it("pins the version the package.json declares", () => {
    expect(pkg.dependencies[pin.package]).toBe(pin.version);
  });

  it("matches the installed WASM bytes", () => {
    const actual = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
    expect(actual).toBe(pin.sha256);
  });
});
