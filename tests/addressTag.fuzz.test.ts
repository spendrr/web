// Tests for the password-keyed authentication tag in src/lib/vault/crypto.ts.
//
// This guards the unilateral-exit destination address, which is stored in
// plain localStorage so the UI can show it for the weeks an exit runs — and
// is therefore rewritable by anything with script access on this origin.
// Redirecting it moves the entire wallet balance and needs no network at
// all, so the app's fetch allowlist does nothing against it. The property
// that matters is the third test: swapping the address must invalidate the
// tag.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeValueTag, encryptMnemonic, verifyValueTag } from "../src/lib/vault/crypto";

// Each vault costs two real 600k-iteration PBKDF2 derivations, so keep the
// run counts small — same reasoning as crypto.fuzz.test.ts.
const RUNS = 5;

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ATTACKER = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

describe("computeValueTag / verifyValueTag", () => {
  it("verifies a tag it produced, with the same password", async () => {
    const vault = await encryptMnemonic("test mnemonic", "correct horse");
    const tag = await computeValueTag(ADDRESS, "correct horse", vault);
    expect(await verifyValueTag(ADDRESS, tag, "correct horse", vault)).toBe(true);
  });

  it("rejects a tag under a different password", async () => {
    const vault = await encryptMnemonic("test mnemonic", "correct horse");
    const tag = await computeValueTag(ADDRESS, "correct horse", vault);
    expect(await verifyValueTag(ADDRESS, tag, "wrong horse", vault)).toBe(false);
  });

  it("rejects a swapped address — the actual attack this exists for", async () => {
    const vault = await encryptMnemonic("test mnemonic", "correct horse");
    const tag = await computeValueTag(ADDRESS, "correct horse", vault);
    // An attacker with script access rewrites the stored address but cannot
    // produce a matching tag without the password.
    expect(await verifyValueTag(ATTACKER, tag, "correct horse", vault)).toBe(false);
  });

  it("returns false rather than throwing on a malformed or empty tag", async () => {
    const vault = await encryptMnemonic("test mnemonic", "correct horse");
    for (const bad of ["", "not base64 !!!", "AAAA", "x".repeat(100)]) {
      expect(await verifyValueTag(ADDRESS, bad, "correct horse", vault)).toBe(false);
    }
  });

  it("roundtrips for arbitrary values and passwords", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), async (value, password) => {
        const vault = await encryptMnemonic("m", password);
        const tag = await computeValueTag(value, password, vault);
        expect(await verifyValueTag(value, tag, password, vault)).toBe(true);
        expect(await verifyValueTag(value + "x", tag, password, vault)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });
});
