// Web Push, implemented by hand against the Web Crypto API (available in the
// Workers runtime) rather than an npm package — this project deliberately
// keeps a minimal, audited dependency surface (see ARCHITECTURE.md's Network
// hardening section), and Web Push is a fully specified standard (RFC 8291
// payload encryption, RFC 8292 VAPID) rather than something that benefits
// from a third-party abstraction. This needs to be exercised against a real
// browser subscription before being trusted — see ARCHITECTURE.md's push section
// for how that was verified.

import { upstreamSignal } from "./upstream";

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dhBase64Url: string;
  authBase64Url: string;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

/** HKDF-Expand(prk, info, len) — HKDF-Extract is just hmacSha256(salt, ikm), inlined at call sites. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const input = concatBytes([info, new Uint8Array([1])]);
  const t1 = await hmacSha256(prk, input);
  return t1.slice(0, length);
}

/**
 * Encrypts `plaintext` per RFC 8291 (Web Push "aes128gcm" content encoding)
 * for one subscriber. Returns the full request body to POST to the push
 * endpoint — no library, straight ECDH + HKDF + AES-128-GCM via
 * crypto.subtle.
 */
export async function encryptPushPayload(
  keys: Pick<PushSubscriptionKeys, "p256dhBase64Url" | "authBase64Url">,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const subscriberPublicKeyBytes = base64UrlToBytes(keys.p256dhBase64Url);
  const authSecret = base64UrlToBytes(keys.authBase64Url);

  const subscriberKey = await crypto.subtle.importKey(
    "raw",
    subscriberPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const serverKeyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const serverPublicKeyBytes = new Uint8Array((await crypto.subtle.exportKey("raw", serverKeyPair.publicKey)) as ArrayBuffer);

  const ecdhSecret = new Uint8Array(
    // workerd's generated typings spell the member `$public`; the runtime (and the
    // WebCrypto standard) name it `public`, so the algorithm is cast.
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: subscriberKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      serverKeyPair.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3/3.4: derive the content-encryption IKM from the ECDH
  // secret, keyed (HKDF-Extract salt) by the subscription's auth secret.
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatBytes([
    new TextEncoder().encode("WebPush: info\0"),
    subscriberPublicKeyBytes,
    serverPublicKeyBytes,
  ]);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 (aes128gcm content coding) keyed by a fresh random salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");
  const cekBytes = await hkdfExpand(prk, cekInfo, 16);
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  // A single record: plaintext followed by the RFC 8188 "last record" delimiter (0x02), no padding.
  const recordPlaintext = concatBytes([plaintext, new Uint8Array([2])]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, recordPlaintext),
  );

  // RFC 8188 header: salt(16) || record size(4, BE) || key id length(1) || key id (server ephemeral public key).
  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPublicKeyBytes.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = serverPublicKeyBytes.length;
  header.set(serverPublicKeyBytes, 21);

  return concatBytes([header, ciphertext]);
}

async function importVapidPrivateKey(privateKeyJwk: string): Promise<CryptoKey> {
  // Raw 32-byte P-256 scalar -> PKCS8 isn't trivial to build by hand, so the
  // private key is stored (and imported here) as a plain JWK JSON string
  // instead — see generateVapidKeys() below, which is what produces the
  // value that ends up in the VAPID_PRIVATE_KEY secret.
  const jwk = JSON.parse(privateKeyJwk) as JsonWebKey;
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Builds the `Authorization: vapid t=..., k=...` header per RFC 8292. */
export async function vapidAuthorizationHeader(
  pushEndpoint: string,
  vapidPrivateKeyJwk: string,
  vapidPublicKeyBase64Url: string,
  subject: string,
): Promise<string> {
  const aud = new URL(pushEndpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject };
  const encode = (obj: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${encode(header)}.${encode(payload)}`;

  const key = await importVapidPrivateKey(vapidPrivateKeyJwk);
  // ECDSA via Web Crypto with a named curve produces the raw (r || s) IEEE
  // P1363 signature format JWT's ES256 expects directly — no DER involved.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)),
  );
  const jwt = `${signingInput}.${bytesToBase64Url(sig)}`;
  return `vapid t=${jwt}, k=${vapidPublicKeyBase64Url}`;
}

// The VAPID header is valid for 12 hours and the same for every subscriber of
// one push service, so an isolate signs it once per service and hour rather
// than once per push (an ECDSA signature is most of a push's CPU).
const VAPID_REUSE_MS = 60 * 60 * 1000;
const vapidCache = new Map<string, { header: string; until: number }>();

async function cachedVapidHeader(
  pushEndpoint: string,
  vapidPrivateKeyJwk: string,
  vapidPublicKeyBase64Url: string,
  subject: string,
): Promise<string> {
  const key = `${new URL(pushEndpoint).origin}|${vapidPublicKeyBase64Url}|${subject}`;
  const now = Date.now();
  const hit = vapidCache.get(key);
  if (hit && hit.until > now) return hit.header;
  const header = await vapidAuthorizationHeader(pushEndpoint, vapidPrivateKeyJwk, vapidPublicKeyBase64Url, subject);
  vapidCache.set(key, { header, until: now + VAPID_REUSE_MS });
  return header;
}

/**
 * Sends one encrypted push message. Returns true on success (2xx from the push service).
 * `extraHeaders` carries RFC 8030 `urgency` and `topic` for the callers that use them.
 */
export async function sendWebPush(
  keys: PushSubscriptionKeys,
  payload: Uint8Array,
  vapidPrivateKeyJwk: string,
  vapidPublicKeyBase64Url: string,
  subject: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; shouldDeleteSubscription: boolean }> {
  const body = await encryptPushPayload(keys, payload);
  const authHeader = await cachedVapidHeader(keys.endpoint, vapidPrivateKeyJwk, vapidPublicKeyBase64Url, subject);
  const res = await fetch(keys.endpoint, {
    method: "POST",
    headers: {
      ttl: "86400",
      ...extraHeaders,
      authorization: authHeader,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
    },
    body,
    signal: upstreamSignal(),
  });
  // 404/410 from the push service means the subscription is gone (user
  // uninstalled, cleared site data, etc.) — the caller should drop it rather
  // than retrying forever.
  return { ok: res.ok, status: res.status, shouldDeleteSubscription: res.status === 404 || res.status === 410 };
}

/**
 * Generates a fresh VAPID keypair. Run once, out of band (see ARCHITECTURE.md) —
 * not called at runtime. The private key is stored as a JWK string (see
 * importVapidPrivateKey's comment for why: raw scalar -> PKCS8 isn't
 * hand-rollable, JWK import is the exact same key material without needing
 * ASN.1 encoding).
 */
export async function generateVapidKeys(): Promise<{ publicKeyBase64Url: string; privateKeyJwk: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKeyBase64Url: bytesToBase64Url(publicKeyBytes),
    privateKeyJwk: JSON.stringify(privateJwk),
  };
}
