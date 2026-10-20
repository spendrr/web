// Fuzz/property tests for src/lib/backup/backupCrypto.ts — the mnemonic-derived key
// material behind the cloud backup feature (see ARCHITECTURE.md's backup section).
// These properties matter more than usual: deriveBackupKeys must be
// deterministic and stable forever, since changing it silently orphans every
// backup already uploaded under the old derivation.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deriveBackupKeys, encryptBackupBlob, decryptBackupBlob, sha256Hex } from "../src/lib/backup/backupCrypto";

const RUNS = 15;
const mnemonicArb = fc.string({ minLength: 1, maxLength: 200 });

describe("deriveBackupKeys", () => {
  it("is deterministic: the same mnemonic always yields the same lookupKey", async () => {
    await fc.assert(
      fc.asyncProperty(mnemonicArb, async (mnemonic) => {
        const a = await deriveBackupKeys(mnemonic);
        const b = await deriveBackupKeys(mnemonic);
        expect(a.lookupKey).toBe(b.lookupKey);
        expect(a.lookupKey).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: RUNS },
    );
  });

  it("derives functionally identical encryptionKeys across calls (roundtrip across two derivations)", async () => {
    await fc.assert(
      fc.asyncProperty(mnemonicArb, fc.string({ maxLength: 500 }), async (mnemonic, plaintext) => {
        const first = await deriveBackupKeys(mnemonic);
        const second = await deriveBackupKeys(mnemonic);
        const bytes = new TextEncoder().encode(plaintext);
        const blob = await encryptBackupBlob(first.encryptionKey, bytes);
        const decrypted = await decryptBackupBlob(second.encryptionKey, blob.ivHex, blob.cipherB64);
        expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
      }),
      { numRuns: RUNS },
    );
  });

  it("gives different mnemonics unrelated lookupKeys and encryptionKeys", async () => {
    await fc.assert(
      fc.asyncProperty(mnemonicArb, mnemonicArb, async (a, b) => {
        fc.pre(a !== b);
        const keysA = await deriveBackupKeys(a);
        const keysB = await deriveBackupKeys(b);
        expect(keysA.lookupKey).not.toBe(keysB.lookupKey);

        // encryptionKey is non-extractable, so compare indirectly: a
        // ciphertext encrypted under A's key must not decrypt under B's key.
        const bytes = new TextEncoder().encode("probe");
        const blob = await encryptBackupBlob(keysA.encryptionKey, bytes);
        await expect(decryptBackupBlob(keysB.encryptionKey, blob.ivHex, blob.cipherB64)).rejects.toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  it("never lets the server-visible lookupKey and the secret encryptionKey be swapped", async () => {
    // Sanity check on the domain separation itself, not just its outputs:
    // the two info strings must differ, or HKDF would produce the same bits
    // for both purposes.
    const keys = await deriveBackupKeys("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    expect(keys.lookupKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.encryptionKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(keys.encryptionKey.extractable).toBe(false);
  });
});

describe("encryptBackupBlob / decryptBackupBlob roundtrip", () => {
  it("decrypts back to the exact original bytes for arbitrary content", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 2000 }), async (text) => {
        const { encryptionKey } = await deriveBackupKeys("test mnemonic phrase");
        const bytes = new TextEncoder().encode(text);
        const blob = await encryptBackupBlob(encryptionKey, bytes);
        const decrypted = await decryptBackupBlob(encryptionKey, blob.ivHex, blob.cipherB64);
        expect(new TextDecoder().decode(decrypted)).toBe(text);
      }),
      { numRuns: RUNS },
    );
  });

  it("produces a different IV (and ciphertext) on every call, even for identical input", async () => {
    const { encryptionKey } = await deriveBackupKeys("another test mnemonic");
    const bytes = new TextEncoder().encode("same plaintext every time");
    const a = await encryptBackupBlob(encryptionKey, bytes);
    const b = await encryptBackupBlob(encryptionKey, bytes);
    expect(a.ivHex).not.toBe(b.ivHex);
    expect(a.cipherB64).not.toBe(b.cipherB64);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and matches the known SHA-256 of an empty input", async () => {
    const hash = await sha256Hex(new Uint8Array(0));
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("gives different inputs different hashes (collision-free for practical purposes)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), async (a, b) => {
        fc.pre(a !== b);
        const ha = await sha256Hex(new TextEncoder().encode(a));
        const hb = await sha256Hex(new TextEncoder().encode(b));
        expect(ha).not.toBe(hb);
      }),
      { numRuns: RUNS },
    );
  });
});

// Pinned so a changed info string (or salt) fails here instead of silently
// orphaning every backup (lookupKey) or locking every backup out of its own
// updates (writeToken, recorded server-side on first use).
describe("deriveBackupKeys pinned vectors", () => {
  it("matches the recorded lookupKey and writeToken for a fixed mnemonic", async () => {
    const k = await deriveBackupKeys(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(k.lookupKey).toBe("0389dac19f934d4ef96c543b6a36e549261aff9953ab2314d02abbc106646aa6");
    expect(k.writeToken).toBe("fb58b7b00a770ba3c8cfe1a0c307082f5c207d1d8aa6317fc857859199e4ec58");
  });

  it("never derives the writeToken equal to the lookupKey", async () => {
    await fc.assert(
      fc.asyncProperty(mnemonicArb, async (m) => {
        const k = await deriveBackupKeys(m);
        expect(k.writeToken).toMatch(/^[0-9a-f]{64}$/);
        expect(k.writeToken).not.toBe(k.lookupKey);
      }),
      { numRuns: RUNS },
    );
  });
});
