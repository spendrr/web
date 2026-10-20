// Push to the Android app (spendrr-android) through Firebase Cloud Messaging,
// the HTTP v1 API, hand-rolled like webPush.ts: no firebase-admin, just a
// service-account JWT exchanged for an OAuth token, then one POST per message.
//
// A subscription from the app is stored in the same place and shape as a
// browser's Web Push one, with the endpoint `fcm:<registration token>` and
// empty keys (see handlePushSubscribe). sendPush in mailboxShared.ts picks the
// transport from that prefix.
//
// Unlike Web Push, FCM payloads are not end-to-end encrypted: Google sees the
// notification text. So the caller sends payment notifications without the
// amount (describeEventForFcm in mailboxShared.ts).
//
// The service account key is the FCM_SERVICE_ACCOUNT Worker secret (the JSON
// file Firebase generates). Unset means FCM subscriptions are accepted but
// nothing is sent to them.

import { upstreamSignal } from "./upstream";

export const FCM_ENDPOINT_PREFIX = "fcm:";

// Registration tokens are ~160 characters of [A-Za-z0-9_-] with a colon.
// Generous bounds, a strict alphabet: this string ends up in a KV key and a
// JSON body, nothing else.
const FCM_TOKEN_RE = /^[A-Za-z0-9_:-]{32,512}$/;

export function isValidFcmToken(token: unknown): token is string {
  return typeof token === "string" && FCM_TOKEN_RE.test(token);
}

export function isFcmEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(FCM_ENDPOINT_PREFIX) && isValidFcmToken(endpoint.slice(FCM_ENDPOINT_PREFIX.length));
}

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    if (
      d.type !== "service_account" ||
      typeof d.project_id !== "string" ||
      typeof d.client_email !== "string" ||
      typeof d.private_key !== "string"
    ) {
      return null;
    }
    return { projectId: d.project_id, clientEmail: d.client_email, privateKeyPem: d.private_key };
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// RS256 JWT for Google's OAuth "JWT bearer" grant.
export async function buildServiceAccountJwt(sa: ServiceAccount, nowSec: number): Promise<string> {
  const enc = new TextEncoder();
  const header = base64UrlEncode(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64UrlEncode(
    enc.encode(
      JSON.stringify({ iss: sa.clientEmail, scope: FCM_SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signingInput = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput)));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

// One OAuth token per isolate, reused until 5 minutes before it expires
// (tokens live an hour). A Durable Object's isolate sends many messages per
// token; a cold one just asks again.
let cachedToken: { clientEmail: string; token: string; expiresAt: number } | null = null;

export function resetFcmTokenCacheForTests(): void {
  cachedToken = null;
}

async function getAccessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.clientEmail === sa.clientEmail && cachedToken.expiresAt - 300 > now) {
    return cachedToken.token;
  }
  const assertion = await buildServiceAccountJwt(sa, now);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: upstreamSignal(),
  });
  if (!res.ok) {
    console.error("FCM OAuth token request failed", res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string") return null;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedToken = { clientEmail: sa.clientEmail, token: data.access_token, expiresAt: now + expiresIn };
  return data.access_token;
}

export interface PushMessage {
  title: string;
  body: string;
  type?: "expiry" | "chat";
  // Extra data fields (string values, as FCM requires).
  data?: Record<string, string>;
}

export function buildFcmMessage(token: string, msg: PushMessage): unknown {
  const expiry = msg.type === "expiry";
  return {
    message: {
      token,
      notification: { title: msg.title, body: msg.body },
      data: { ...msg.data, type: msg.type ?? "payment" },
      android: {
        priority: "HIGH",
        ttl: "86400s",
        notification: {
          // Channels are created by the app (src/lib/notifications.ts); a
          // chat message rides on the payments channel.
          channel_id: expiry ? "expiry" : "payments",
          // Same split as sw.js's tags: an expiry nudge never replaces a
          // payment notification in the tray or the other way round.
          tag: expiry ? "spendrr-expiry" : msg.type === "chat" ? "spendrr-chat" : "spendrr-payment",
          icon: "ic_stat_spendrr",
        },
      },
    },
  };
}

// FCM v1 answers a token that is gone for good (app uninstalled, data
// cleared, token rotated) with 404 UNREGISTERED, and a token that was never
// valid with 400 INVALID_ARGUMENT naming the registration token. Only those
// drop the subscription; any other failure is retried on the next event.
export function fcmShouldDeleteSubscription(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  return status === 400 && /registration token/i.test(bodyText);
}

export async function sendFcm(
  serviceAccountJson: string | undefined,
  endpoint: string,
  msg: PushMessage,
): Promise<{ ok: boolean; status: number; shouldDeleteSubscription: boolean }> {
  const sa = serviceAccountJson ? parseServiceAccount(serviceAccountJson) : null;
  if (!sa) {
    console.error("FCM_SERVICE_ACCOUNT missing or malformed, skipping FCM push");
    return { ok: false, status: 0, shouldDeleteSubscription: false };
  }
  const token = endpoint.slice(FCM_ENDPOINT_PREFIX.length);
  const accessToken = await getAccessToken(sa);
  if (!accessToken) return { ok: false, status: 0, shouldDeleteSubscription: false };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.projectId)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(buildFcmMessage(token, msg)),
    signal: upstreamSignal(),
  });
  if (res.ok) return { ok: true, status: res.status, shouldDeleteSubscription: false };
  const text = await res.text();
  // A rejected OAuth token (revoked key, clock skew) must not stick around.
  if (res.status === 401) cachedToken = null;
  console.error("FCM send failed", res.status, text.slice(0, 300));
  return { ok: false, status: res.status, shouldDeleteSubscription: fcmShouldDeleteSubscription(res.status, text) };
}
