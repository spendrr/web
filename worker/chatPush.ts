// Push for the money chat (docs/chat-push-design.md). The Worker keeps nothing:
// a recipient gets one sealed token per contact (its push subscription and a
// random slot, AES-GCM under CHAT_PUSH_SEAL_KEY), hands it to that contact
// inside the end-to-end encrypted chat, and the contact's app "pokes" with it
// after a message. The Worker opens the token and sends a Web Push carrying
// the slot and the sender's blob, which is encrypted to a key only the two of
// them have; the Worker can neither read nor change what the notification says.
//
// No KV, no Durable Object: a poke costs this request and the push subrequest.
// A token cannot be revoked here; the recipient rotates its push subscription
// instead (the old endpoint dies with it), and tokens expire.
import { FCM_ENDPOINT_PREFIX, isFcmEndpoint, isValidFcmToken, sendFcm } from "./fcm";
import { isKnownPushEndpoint, VAPID_PUBLIC_KEY, VAPID_SUBJECT } from "./mailboxShared";
import { sendWebPush } from "./webPush";

export interface ChatPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export const TOKEN_PREFIX = "c1.";
export const TOKEN_MAX_AGE_DAYS = 60;
export const MAX_SLOTS_PER_REQUEST = 50;
// 512 padded bytes plus nonce and tag, base64url: ~720 characters.
export const MAX_BLOB_CHARS = 1024;
// Tokens are ~600 characters for the longest real endpoints.
export const MAX_TOKEN_CHARS = 1500;
const TOKEN_AAD = new TextEncoder().encode("spendrr-chat-push-token-v1");

const SLOT_RE = /^[0-9a-f]{32}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL_RE.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isSlot(v: unknown): v is string {
  return typeof v === "string" && SLOT_RE.test(v);
}

// A browser subscription (uncompressed P-256 key, 16-byte auth secret) or the
// Android app's FCM token, in the same shape handlePushSubscribe stores.
export function parseTarget(subscription: unknown, fcmToken: unknown): ChatPushTarget | null {
  if (fcmToken !== undefined) {
    return isValidFcmToken(fcmToken) ? { endpoint: `${FCM_ENDPOINT_PREFIX}${fcmToken}`, p256dh: "", auth: "" } : null;
  }
  const sub = subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 1000 || !isKnownPushEndpoint(endpoint) || isFcmEndpoint(endpoint)) return null;
  if (typeof p256dh !== "string" || b64urlToBytes(p256dh)?.length !== 65) return null;
  if (typeof auth !== "string" || b64urlToBytes(auth)?.length !== 16) return null;
  return { endpoint, p256dh, auth };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

// The secret is 64 hex characters (32 bytes). Anything else is a setup error:
// the endpoints answer 503 rather than sealing under a weak key.
function sealKey(secret: string | undefined): Promise<CryptoKey> | null {
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) return null;
  let key = keyCache.get(secret);
  if (!key) {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = parseInt(secret.slice(i * 2, i * 2 + 2), 16);
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secret, key);
  }
  return key;
}

export function hasSealKey(secret: string | undefined): boolean {
  return sealKey(secret) !== null;
}

function unixDay(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

export async function sealToken(secret: string | undefined, target: ChatPushTarget, slot: string, nowMs = Date.now()): Promise<string> {
  const key = sealKey(secret);
  if (!key) throw new Error("no seal key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(
    JSON.stringify({ e: target.endpoint, p: target.p256dh, a: target.auth, s: slot, d: unixDay(nowMs) }),
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: TOKEN_AAD }, await key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return TOKEN_PREFIX + bytesToB64url(out);
}

export type OpenedToken = { target: ChatPushTarget; slot: string };

// null for anything not sealed by us, tampered with, or too old.
export async function openToken(secret: string | undefined, token: unknown, nowMs = Date.now()): Promise<OpenedToken | null> {
  const key = sealKey(secret);
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN_CHARS || !token.startsWith(TOKEN_PREFIX)) return null;
  const bytes = b64urlToBytes(token.slice(TOKEN_PREFIX.length));
  if (!bytes || bytes.length < 12 + 16) return null;
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: TOKEN_AAD }, await key, bytes.slice(12));
  } catch {
    return null;
  }
  let v: { e?: unknown; p?: unknown; a?: unknown; s?: unknown; d?: unknown };
  try {
    v = JSON.parse(new TextDecoder().decode(plain)) as typeof v;
  } catch {
    return null;
  }
  if (typeof v.e !== "string" || typeof v.p !== "string" || typeof v.a !== "string" || !isSlot(v.s)) return null;
  if (typeof v.d !== "number" || !Number.isInteger(v.d)) return null;
  const age = unixDay(nowMs) - v.d;
  if (age < 0 || age > TOKEN_MAX_AGE_DAYS) return null;
  return { target: { endpoint: v.e, p256dh: v.p, auth: v.a }, slot: v.s };
}

export function isBlob(v: unknown): v is string {
  return typeof v === "string" && v.length >= 40 && v.length <= MAX_BLOB_CHARS && B64URL_RE.test(v);
}

// RFC 8030 Topic: at most 32 base64url characters. One per conversation, so a
// push service holding pushes for an offline phone keeps only the newest.
export async function topicFor(slot: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`spendrr-chat-topic:${slot}`)));
  return bytesToB64url(digest).slice(0, 32);
}

export type ChatPushEnv = { VAPID_PRIVATE_KEY?: string; FCM_SERVICE_ACCOUNT?: string };

// "gone" means the push service dropped the subscription: the sender should
// stop using this token and ask for a new one.
export async function sendChatPush(env: ChatPushEnv, opened: OpenedToken, blob: string): Promise<"sent" | "gone" | "failed"> {
  try {
    if (isFcmEndpoint(opened.target.endpoint)) {
      // Google reads FCM payloads, so the app gets the generic text; the blob
      // rides along for a native client that can open it.
      const r = await sendFcm(env.FCM_SERVICE_ACCOUNT, opened.target.endpoint, {
        title: "Spendrr",
        body: "Nová zpráva",
        type: "chat",
        data: { s: opened.slot, b: blob },
      });
      return r.ok ? "sent" : r.shouldDeleteSubscription ? "gone" : "failed";
    }
    if (!env.VAPID_PRIVATE_KEY) return "failed";
    const payload = new TextEncoder().encode(JSON.stringify({ type: "chat", s: opened.slot, b: blob }));
    const r = await sendWebPush(
      { endpoint: opened.target.endpoint, p256dhBase64Url: opened.target.p256dh, authBase64Url: opened.target.auth },
      payload,
      env.VAPID_PRIVATE_KEY,
      VAPID_PUBLIC_KEY,
      VAPID_SUBJECT,
      { urgency: "high", topic: await topicFor(opened.slot) },
    );
    return r.ok ? "sent" : r.shouldDeleteSubscription ? "gone" : "failed";
  } catch (e) {
    console.error("chat push threw", e instanceof Error ? e.message : e);
    return "failed";
  }
}
