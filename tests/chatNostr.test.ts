// The money chat's Nostr layer (src/lib/chat/nostr.ts) against the official
// NIP-44 v2 vectors (tests/fixtures/nip44.vectors.json, from paulmillr/nip44),
// plus round trips of the NIP-59 gift wrap and the checks that make a forged
// sender fail.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  KIND_CHAT,
  conversationKey,
  giftWrap,
  makeRumor,
  nip44Decrypt,
  nip44Encrypt,
  paddedLength,
  publicKeyOf,
  signEvent,
  unwrapGift,
  verifyEvent,
  type NostrEvent,
} from "../src/lib/chat/nostr";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/nip44.vectors.json", import.meta.url), "utf8")).v2;

describe("NIP-44 v2 vectors", () => {
  it("conversation keys", () => {
    for (const v of vectors.valid.get_conversation_key) {
      expect(bytesToHex(conversationKey(hexToBytes(v.sec1), v.pub2))).toBe(v.conversation_key);
    }
  });

  it("invalid conversation keys throw", () => {
    for (const v of vectors.invalid.get_conversation_key) {
      expect(() => conversationKey(hexToBytes(v.sec1), v.pub2)).toThrow();
    }
  });

  it("padded lengths", () => {
    for (const [len, padded] of vectors.valid.calc_padded_len) expect(paddedLength(len)).toBe(padded);
  });

  it("encrypt and decrypt", () => {
    for (const v of vectors.valid.encrypt_decrypt) {
      const key = conversationKey(hexToBytes(v.sec1), publicKeyOf(hexToBytes(v.sec2)));
      expect(bytesToHex(key)).toBe(v.conversation_key);
      expect(nip44Encrypt(v.plaintext, key, hexToBytes(v.nonce))).toBe(v.payload);
      expect(nip44Decrypt(v.payload, key)).toBe(v.plaintext);
    }
  });

  it("long messages", () => {
    for (const v of vectors.valid.encrypt_decrypt_long_msg) {
      const plaintext = v.pattern.repeat(v.repeat);
      expect(bytesToHex(sha256(new TextEncoder().encode(plaintext)))).toBe(v.plaintext_sha256);
      const payload = nip44Encrypt(plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce));
      expect(bytesToHex(sha256(new TextEncoder().encode(payload)))).toBe(v.payload_sha256);
    }
  });

  it("invalid payloads throw", () => {
    for (const v of vectors.invalid.decrypt) {
      expect(() => nip44Decrypt(v.payload, hexToBytes(v.conversation_key))).toThrow();
    }
  });

  it("invalid plaintext lengths throw", () => {
    const key = new Uint8Array(32).fill(1);
    for (const len of vectors.invalid.encrypt_msg_lengths) {
      expect(() => nip44Encrypt("a".repeat(len), key)).toThrow();
    }
  });
});

describe("events and gift wrap", () => {
  const alice = secp256k1.utils.randomSecretKey();
  const bob = secp256k1.utils.randomSecretKey();
  const mallory = secp256k1.utils.randomSecretKey();

  it("signed events verify, tampered ones do not", () => {
    const e = signEvent({ kind: 1, created_at: 1, tags: [["t", "x"]], content: "ahoj" }, alice);
    expect(verifyEvent(e)).toBe(true);
    expect(verifyEvent({ ...e, content: "ahoj!" })).toBe(false);
    expect(verifyEvent({ ...e, pubkey: publicKeyOf(bob) })).toBe(false);
  });

  it("round trip to the recipient, not to anyone else", () => {
    const rumor = makeRumor(publicKeyOf(alice), KIND_CHAT, "za pivo", [["p", publicKeyOf(bob)]]);
    const wrap = giftWrap(rumor, alice, publicKeyOf(bob));
    expect(wrap.pubkey).not.toBe(publicKeyOf(alice));
    expect(wrap.tags).toEqual([["p", publicKeyOf(bob)]]);
    expect(unwrapGift(wrap, bob)).toEqual(rumor);
    expect(() => unwrapGift(wrap, mallory)).toThrow();
  });

  it("a rumor claiming another author than its seal is refused", () => {
    // Mallory seals a rumor that says it is from Alice.
    const forged = makeRumor(publicKeyOf(alice), KIND_CHAT, "pošli mi 50k", []);
    const wrap = giftWrap(forged, mallory, publicKeyOf(bob));
    expect(() => unwrapGift(wrap, bob)).toThrow("bad rumor");
  });

  it("a wrap with a broken signature is refused", () => {
    const wrap = giftWrap(makeRumor(publicKeyOf(alice), KIND_CHAT, "x", []), alice, publicKeyOf(bob));
    const broken: NostrEvent = { ...wrap, created_at: wrap.created_at + 1 };
    expect(() => unwrapGift(broken, bob)).toThrow("bad wrap");
  });

  it("wrap timestamps are in the past two days", () => {
    const now = Math.floor(Date.now() / 1000);
    const wrap = giftWrap(makeRumor(publicKeyOf(alice), KIND_CHAT, "x", []), alice, publicKeyOf(bob));
    expect(wrap.created_at).toBeLessThanOrEqual(now);
    expect(wrap.created_at).toBeGreaterThan(now - 2 * 24 * 3600 - 5);
  });
});
