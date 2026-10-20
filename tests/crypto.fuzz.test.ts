// Fuzz/property tests for src/lib/vault/crypto.ts — the vault encryption at the
// core of seed storage. Run with `npm test`. Kept to a small numRuns since
// each roundtrip does two real PBKDF2 derivations at 600k iterations.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  decryptMnemonic,
  decryptVaultBytes,
  encryptMnemonic,
  encryptVaultBytes,
  fromB64,
  resolveIterations,
  toB64,
  vaultNeedsRehash,
  verifyVaultPassword,
  zeroBytes,
  type EncryptedVault,
} from "../src/lib/vault/crypto";

const CRYPTO_RUNS = 15;

describe("encryptMnemonic / decryptMnemonic roundtrip", () => {
  it("decrypts back to the exact original mnemonic for arbitrary text and password", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 500 }),
        fc.string({ minLength: 1, maxLength: 200 }),
        async (mnemonic, password) => {
          const vault = await encryptMnemonic(mnemonic, password);
          const decrypted = await decryptMnemonic(vault, password);
          expect(decrypted).toBe(mnemonic);
        },
      ),
      { numRuns: CRYPTO_RUNS },
    );
  });

  it("never decrypts successfully with a different password", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        async (mnemonic, password, wrongPassword) => {
          fc.pre(password !== wrongPassword);
          const vault = await encryptMnemonic(mnemonic, password);
          await expect(decryptMnemonic(vault, wrongPassword)).rejects.toThrow();
        },
      ),
      { numRuns: CRYPTO_RUNS },
    );
  });

  it("handles unicode/emoji mnemonics and passwords without corrupting the roundtrip", async () => {
    const weird = ["🔥🔥🔥", "seed with\nnewlines\tand\ttabs", "日本語のシード", "a".repeat(2000), ""];
    for (const text of weird) {
      const vault = await encryptMnemonic(text, "correct horse battery staple 🐴");
      expect(await decryptMnemonic(vault, "correct horse battery staple 🐴")).toBe(text);
    }
  });
});

describe("toB64 / fromB64", () => {
  it("round-trips arbitrary byte arrays", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 2000 }), (bytes) => {
        const b64 = toB64(bytes.buffer as ArrayBuffer);
        expect(fromB64(b64)).toEqual(bytes);
      }),
    );
  });

  // Regression: a production wallet backup upload hit "RangeError: Maximum
  // call stack size exceeded" because the original implementation spread a
  // large Uint8Array as String.fromCharCode(...bytes) call arguments — a
  // mnemonic-sized buffer never got big enough to hit the per-engine
  // argument-count limit, but a real encrypted IndexedDB dump did.
  it("round-trips buffers far larger than any per-engine call-stack argument limit", () => {
    const bytes = new Uint8Array(500_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const b64 = toB64(bytes.buffer);
    expect(fromB64(b64)).toEqual(bytes);
  });
});

describe("vaultNeedsRehash", () => {
  it("flags legacy vaults (no iterations field) as needing rehash", () => {
    const legacy: EncryptedVault = { saltB64: "AAAA", ivB64: "AAAA", cipherB64: "AAAA" };
    expect(vaultNeedsRehash(legacy)).toBe(true);
  });

  it("flags any vault below the current target as needing rehash, never above", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000 }), (iterations) => {
        const vault: EncryptedVault = { saltB64: "AAAA", ivB64: "AAAA", cipherB64: "AAAA", iterations };
        expect(vaultNeedsRehash(vault)).toBe(iterations < 600_000);
      }),
    );
  });
});

// `iterations` is read straight out of localStorage, which anything with
// script access on this origin can rewrite. A hostile or corrupted value
// there used to go directly into crypto.subtle.deriveKey — an absurd count
// sits in a non-interruptible native PBKDF2 loop and hangs the unlock
// screen with no error and no way out but a reload, which it then does
// again on the next attempt. See resolveIterations in vaultCrypto.ts.
describe("resolveIterations clamping", () => {
  const base: EncryptedVault = { saltB64: "", ivB64: "", cipherB64: "" };

  it("falls back to the legacy count for a vault written before the field existed", () => {
    expect(resolveIterations(base)).toBe(210_000);
  });

  it("treats a malformed value as legacy rather than propagating NaN", () => {
    for (const bad of [NaN, Infinity, -Infinity, "600000", null, {}, []]) {
      const vault = { ...base, iterations: bad as unknown as number };
      expect(resolveIterations(vault)).toBe(210_000);
    }
  });

  it("clamps an absurd count to something that can actually finish", () => {
    expect(resolveIterations({ ...base, iterations: 1e12 })).toBe(4_000_000);
    expect(resolveIterations({ ...base, iterations: Number.MAX_SAFE_INTEGER })).toBe(4_000_000);
  });

  it("clamps a lowered count up to the floor", () => {
    // Not a confidentiality control — a vault only decrypts at the count it
    // was written with, so a lowered value just fails to decrypt. The floor
    // is the lowest count this app has ever written, so no real vault is
    // excluded by it.
    expect(resolveIterations({ ...base, iterations: 1 })).toBe(210_000);
    expect(resolveIterations({ ...base, iterations: -5 })).toBe(210_000);
  });

  it("passes through every count this app has actually written", () => {
    expect(resolveIterations({ ...base, iterations: 210_000 })).toBe(210_000);
    expect(resolveIterations({ ...base, iterations: 600_000 })).toBe(600_000);
  });

  it("never reports a vault as needing a rehash just because its field is junk", () => {
    // A junk field resolves to the legacy count, which does need a rehash —
    // but a clamped-high one must not, or every unlock would rewrite the
    // vault forever.
    expect(vaultNeedsRehash({ ...base, iterations: 1e12 })).toBe(false);
    expect(vaultNeedsRehash({ ...base, iterations: 600_000 })).toBe(false);
    expect(vaultNeedsRehash({ ...base, iterations: 210_000 })).toBe(true);
  });
});

// The byte-level path exists so callers that only need to re-encrypt the
// seed (change password, biometric enrolment) or merely check a password
// (the send/exit confirmation prompts) never build an unzeroable plaintext
// mnemonic string. See vaultCrypto.ts.
describe("byte-level vault primitives", () => {
  const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("round-trips bytes and agrees with the string API", async () => {
    const bytes = new TextEncoder().encode(SEED);
    const vault = await encryptVaultBytes(bytes, "pw");
    expect(new TextDecoder().decode(await decryptVaultBytes(vault, "pw"))).toBe(SEED);
    // A vault written through the string API opens through the byte API and
    // vice versa — the change-password flow relies on exactly that.
    const stringVault = await encryptMnemonic(SEED, "pw");
    expect(new TextDecoder().decode(await decryptVaultBytes(stringVault, "pw"))).toBe(SEED);
    expect(await decryptMnemonic(vault, "pw")).toBe(SEED);
  });

  it("verifyVaultPassword answers yes/no without throwing either way", async () => {
    const vault = await encryptMnemonic(SEED, "pw");
    expect(await verifyVaultPassword(vault, "pw")).toBe(true);
    expect(await verifyVaultPassword(vault, "wrong")).toBe(false);
    // A structurally broken vault is a "no", not an exception — the
    // confirmation prompts that call this have no other failure path.
    expect(await verifyVaultPassword({ saltB64: "!!", ivB64: "!!", cipherB64: "!!" }, "pw")).toBe(false);
  });

  it("zeroBytes actually clears the buffer", () => {
    const bytes = new TextEncoder().encode(SEED);
    zeroBytes(bytes);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });
});
