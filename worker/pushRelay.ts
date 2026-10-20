// The Worker's side of the payment push relay (docs/payment-push-relay.md):
// a small process on a VPS holds one Ark SubscribeMailbox stream per watched
// mailbox and pokes back here when a payment lands. The relay never sends a
// push and never sees a push subscription; the shard Durable Object reads
// the mailbox itself, so a compromised relay can cause reads, not fake
// notifications.
//
// Unconfigured (no PUSH_RELAY_URL and friends) everything here is a no-op and
// the shards' 15-minute sweep (SWEEP_INTERVAL_MS) is the only way a payment
// push goes out.

export type RelayEnv = {
  PUSH_RELAY_URL?: string;
  PUSH_RELAY_TOKEN?: string;
  PUSH_RELAY_HOOK_SECRET?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
};

const RELAY_TIMEOUT_MS = 2500;
const HEALTH_CACHE_MS = 60_000;
export const HOOK_MAX_SKEW_S = 60;
export const HOOK_MAX_IDS = 500;
const HEX_66 = /^[0-9a-f]{66}$/;
// The shard a mailbox lives in (shardIdFor/allocateIntoPackedShard in index.ts).
// The relay keeps it with the registration and hands it back in its pokes, so
// the hook needs no KV lookup per id; index.ts still checks it is a real shard.
export const SHARD_ID = /^shard-\d{1,3}$/;
const HEX_210 = /^[0-9a-f]{210}$/;

export function relayConfigured(env: RelayEnv): boolean {
  return !!(env.PUSH_RELAY_URL && env.PUSH_RELAY_TOKEN && env.PUSH_RELAY_HOOK_SECRET && env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET);
}

// Same transport as the Lightning service node (callBarkd in index.ts):
// Cloudflare Tunnel behind Access, plus the relay's own bearer token.
async function callRelay(env: RelayEnv, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Response | null> {
  if (!relayConfigured(env)) return null;
  try {
    return await fetch(`${env.PUSH_RELAY_URL}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.PUSH_RELAY_TOKEN}`,
        "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID!,
        "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET!,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: "manual",
    });
  } catch {
    return null;
  }
}

// Best effort both ways. A registration the relay did not take makes the
// subscribe answer 202 (mailboxWatcher.ts), so the app sends the next one
// again rather than waiting out its resend interval; the shard's sweep covers
// the mailbox in between.
export async function relayRegister(env: RelayEnv, mailboxId: string, authorization: string, checkpoint: string, shard: string): Promise<boolean> {
  if (!HEX_66.test(mailboxId) || !HEX_210.test(authorization) || !/^\d{1,20}$/.test(checkpoint) || !SHARD_ID.test(shard)) return false;
  const res = await callRelay(env, "/register", { method: "POST", body: { mailboxId, authorization, checkpoint, shard } });
  return res?.status === 204;
}

// With the shard, the relay forgets the mailbox only if that shard still owns
// it: a stale record in an old shard must not end the live one's stream.
export async function relayUnregister(env: RelayEnv, mailboxId: string, shard: string | undefined): Promise<void> {
  await callRelay(env, "/unregister", { method: "POST", body: shard ? { mailboxId, shard } : { mailboxId } });
}

// Whether the relay is up and has been long enough to know every active
// subscriber (it says so itself: `warm`). Cached per isolate, so a burst of
// shard alarms costs one request.
let health: { ok: boolean; until: number } | null = null;

export async function relayHealthy(env: RelayEnv, now = Date.now()): Promise<boolean> {
  if (!relayConfigured(env)) return false;
  if (health && health.until > now) return health.ok;
  const res = await callRelay(env, "/health", { method: "GET" });
  let ok = false;
  if (res?.ok) {
    try {
      const body = (await res.json()) as { ok?: unknown; warm?: unknown };
      ok = body.ok === true && body.warm === true;
    } catch {
      ok = false;
    }
  }
  health = { ok, until: now + HEALTH_CACHE_MS };
  return ok;
}

export function resetRelayHealthForTests(): void {
  health = null;
}

// ---- the relay's pokes -------------------------------------------------------

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hookSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A genuine poke's mailbox ids by shard, or null. Body {shards: {"shard-3": [ids]}},
// signed over "<unix seconds>.<body>" with PUSH_RELAY_HOOK_SECRET, at most
// HOOK_MAX_SKEW_S old.
export async function verifyHook(
  env: RelayEnv,
  timestamp: string | null,
  signature: string | null,
  body: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<Map<string, string[]> | null> {
  if (!env.PUSH_RELAY_HOOK_SECRET || !timestamp || !signature || !/^\d{10}$/.test(timestamp)) return null;
  if (Math.abs(nowS - Number(timestamp)) > HOOK_MAX_SKEW_S) return null;
  if (!sameText(await hookSignature(env.PUSH_RELAY_HOOK_SECRET, timestamp, body), signature)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const shards = (parsed as { shards?: unknown } | null)?.shards;
  if (typeof shards !== "object" || shards === null || Array.isArray(shards)) return null;
  const out = new Map<string, string[]>();
  let total = 0;
  for (const [shard, ids] of Object.entries(shards)) {
    if (!SHARD_ID.test(shard) || !Array.isArray(ids) || ids.length === 0) return null;
    total += ids.length;
    if (total > HOOK_MAX_IDS) return null;
    if (!ids.every((id) => typeof id === "string" && HEX_66.test(id))) return null;
    out.set(shard, [...new Set(ids as string[])]);
  }
  return out.size > 0 ? out : null;
}

// How long a shard waits before its next sweep, relay or not. The relay's
// pokes are the fast path; the sweep is the safety net and the VTXO expiry
// nudge (hours of blocks). It used to drop to a minute whenever the relay
// was down or cold, which made one VPS outage cost every active shard 1,440
// Durable Object requests a day: at a few dozen shards that is the account's
// whole daily budget, taking @names, the Lightning address and tap to pay down
// with it. While the relay is down a payment push arrives up to this late;
// the open app shows the payment itself either way. The outage is alerted on
// (worker/index.ts's pingRelayHealthcheck).
export const SWEEP_INTERVAL_MS = 15 * 60_000;
