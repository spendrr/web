// Nostr primitives for the money chat: NIP-01 events, NIP-44 v2 encryption and
// NIP-59 gift wrap as used by NIP-17 private messages. Pure (no network, no
// storage), so it runs in the chat worker and in unit tests alike.
//
// Implemented on @noble directly rather than nostr-tools: the surface needed is
// small, and every byte of it is pinned and reviewable. tests/chatNostr.test.ts
// checks it against the official NIP-44 vectors.
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface Rumor extends UnsignedEvent {
  id: string;
}

export interface NostrEvent extends Rumor {
  sig: string;
}

export const KIND_SEAL = 13;
export const KIND_CHAT = 14;
// NIP-25 reaction, gift-wrapped like a message inside a NIP-17 conversation.
export const KIND_REACTION = 7;
export const KIND_GIFT_WRAP = 1059;
// A gift wrap in the ephemeral range: relays pass it to whoever is subscribed
// right now and keep nothing. Carries the typing and read signals.
export const KIND_EPHEMERAL_WRAP = 21059;
export const KIND_DM_RELAYS = 10050;
export const KIND_PROFILE = 0;

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

export function publicKeyOf(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

export function isPublicKeyHex(value: unknown): value is string {
  if (typeof value !== "string" || !HEX_32.test(value)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${value}`));
    return true;
  } catch {
    return false;
  }
}

function serialize(e: UnsignedEvent): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

export function eventId(e: UnsignedEvent): string {
  return bytesToHex(sha256(new TextEncoder().encode(serialize(e))));
}

export function signEvent(template: Omit<UnsignedEvent, "pubkey">, secretKey: Uint8Array): NostrEvent {
  const unsigned: UnsignedEvent = { ...template, pubkey: publicKeyOf(secretKey) };
  const id = eventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { ...unsigned, id, sig };
}

function isStringMatrix(tags: unknown): tags is string[][] {
  return Array.isArray(tags) && tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"));
}

// Shape only, no signature: a rumor (kind 14 inside a seal) is unsigned by design.
export function isRumorShape(e: unknown): e is Rumor {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    HEX_32.test(r.id) &&
    isPublicKeyHex(r.pubkey) &&
    typeof r.created_at === "number" &&
    Number.isSafeInteger(r.created_at) &&
    typeof r.kind === "number" &&
    Number.isSafeInteger(r.kind) &&
    isStringMatrix(r.tags) &&
    typeof r.content === "string"
  );
}

export function verifyEvent(e: unknown): e is NostrEvent {
  if (!isRumorShape(e)) return false;
  const sig = (e as { sig?: unknown }).sig;
  if (typeof sig !== "string" || !HEX_64.test(sig)) return false;
  if (eventId(e) !== e.id) return false;
  try {
    return schnorr.verify(hexToBytes(sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

// ---- NIP-44 v2 ---------------------------------------------------------------

const NIP44_SALT = new TextEncoder().encode("nip44-v2");
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;

export function conversationKey(secretKey: Uint8Array, publicKeyHex: string): Uint8Array {
  const shared = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${publicKeyHex}`));
  return hkdfExtract(sha256, shared.subarray(1, 33), NIP44_SALT);
}

export function paddedLength(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const bytes = new TextEncoder().encode(plaintext);
  const len = bytes.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) throw new Error("nip44: invalid plaintext length");
  const out = new Uint8Array(2 + paddedLength(len));
  out[0] = len >> 8;
  out[1] = len & 0xff;
  out.set(bytes, 2);
  return out;
}

function unpad(padded: Uint8Array): string {
  const len = (padded[0] << 8) | padded[1];
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT || padded.length !== 2 + paddedLength(len)) {
    throw new Error("nip44: invalid padding");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(padded.subarray(2, 2 + len));
}

function messageKeys(convKey: Uint8Array, nonce: Uint8Array) {
  const keys = hkdfExpand(sha256, convKey, nonce, 76);
  return { chachaKey: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// `nonce` is only for test vectors: real callers never pass one.
export function nip44Encrypt(plaintext: string, convKey: Uint8Array, nonce: Uint8Array = randomBytes(32)): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return toBase64(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}

export function nip44Decrypt(payload: string, convKey: Uint8Array): string {
  if (payload.length < 132 || payload.length > 87472 || payload[0] === "#") throw new Error("nip44: invalid payload");
  let data: Uint8Array;
  try {
    data = fromBase64(payload);
  } catch {
    throw new Error("nip44: invalid base64");
  }
  if (data.length < 99 || data.length > 65603 || data[0] !== 2) throw new Error("nip44: unknown version");
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  if (!equalBytes(hmac(sha256, hmacKey, concatBytes(nonce, ciphertext)), mac)) throw new Error("nip44: invalid MAC");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

// ---- NIP-59 gift wrap / NIP-17 -----------------------------------------------

// NIP-59: seal and wrap timestamps are spread up to two days into the past so a
// relay cannot line a wrap up with the moment it was sent.
const TWO_DAYS_S = 2 * 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomPastTimestamp(): number {
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  return nowSeconds() - (r[0] % TWO_DAYS_S);
}

export function makeRumor(
  senderPubkey: string,
  kind: number,
  content: string,
  tags: string[][],
  createdAt = nowSeconds(),
): Rumor {
  const unsigned: UnsignedEvent = { pubkey: senderPubkey, created_at: createdAt, kind, tags, content };
  return { ...unsigned, id: eventId(unsigned) };
}

// One wrap per recipient. NIP-17 senders also wrap a copy to themselves so the
// message shows up on their other devices; that is just another call here.
export function giftWrap(
  rumor: Rumor,
  senderSecret: Uint8Array,
  recipientPubkey: string,
  wrapKind: typeof KIND_GIFT_WRAP | typeof KIND_EPHEMERAL_WRAP = KIND_GIFT_WRAP,
): NostrEvent {
  const seal = signEvent(
    {
      kind: KIND_SEAL,
      created_at: randomPastTimestamp(),
      tags: [],
      content: nip44Encrypt(JSON.stringify(rumor), conversationKey(senderSecret, recipientPubkey)),
    },
    senderSecret,
  );
  const ephemeral = secp256k1.utils.randomSecretKey();
  return signEvent(
    {
      kind: wrapKind,
      // Nothing is stored for an ephemeral wrap, so there is no history to
      // blur, and a live subscription only matches a current time.
      created_at: wrapKind === KIND_EPHEMERAL_WRAP ? nowSeconds() : randomPastTimestamp(),
      tags: [["p", recipientPubkey]],
      content: nip44Encrypt(JSON.stringify(seal), conversationKey(ephemeral, recipientPubkey)),
    },
    ephemeral,
  );
}

// Throws on anything that is not a well-formed wrap addressed to us, with a
// valid seal from the same author as the rumor inside. The rumor's author is
// therefore authenticated by the seal signature.
export function unwrapGift(wrap: NostrEvent, mySecret: Uint8Array): Rumor {
  if ((wrap.kind !== KIND_GIFT_WRAP && wrap.kind !== KIND_EPHEMERAL_WRAP) || !verifyEvent(wrap)) {
    throw new Error("unwrap: bad wrap");
  }
  const seal: unknown = JSON.parse(nip44Decrypt(wrap.content, conversationKey(mySecret, wrap.pubkey)));
  if (!verifyEvent(seal) || seal.kind !== KIND_SEAL) throw new Error("unwrap: bad seal");
  const rumor: unknown = JSON.parse(nip44Decrypt(seal.content, conversationKey(mySecret, seal.pubkey)));
  if (!isRumorShape(rumor) || rumor.pubkey !== seal.pubkey || eventId(rumor) !== rumor.id) {
    throw new Error("unwrap: bad rumor");
  }
  return rumor;
}
