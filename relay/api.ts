// The relay's internal API, on 127.0.0.1 behind cloudflared (Cloudflare Tunnel
// + Access): only the Worker calls it, with the shared bearer token.
//   POST /register   {mailboxId, authorization, checkpoint, shard}
//   POST /unregister {mailboxId, shard?}
//   GET  /health     {ok, warm, ...counts}
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizationExpiry } from "../worker/mailboxProto.ts";
import type { Store } from "./store.ts";
import type { StreamManager } from "./streams.ts";

const MAX_BODY_BYTES = 4096;
const HEX_66 = /^[0-9a-f]{66}$/;
const SHARD_ID = /^shard-\d{1,3}$/;
// Far above what the Worker's shards can carry; only a broken or stolen
// Worker token could get here, and it must not grow the relay without end.
export const MAX_REGISTRATIONS = 50_000;
// The relay counts as knowing every daily subscriber once its database is
// older than this (each app open registers). Authorizations last 30 days, so
// after losing its database it doesn't know the ones who haven't opened the
// app since; the shards' sweep covers them meanwhile.
export const WARM_AFTER_S = 25 * 60 * 60;
// Healthy while at least this share of live registrations has a stream the
// server accepted. Refused ones count against it: if the server turns everyone
// away, the shards must go back to the minute sweep.
const MIN_OPEN_SHARE = 0.8;

export interface ApiDeps {
  store: Store;
  streams: StreamManager;
  hook: { healthy: boolean; waiting: number };
  token: string;
  nowS?: () => number;
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Requests by "<path> <status>" since the last drainApiCounts(), for the
// minute log line: it is the only sign of what the Worker's calls get here.
const counts = new Map<string, number>();

export function drainApiCounts(): string {
  const line = [...counts].map(([k, v]) => `${k}:${v}`).join(" ") || "0";
  counts.clear();
  return line;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  const path = (res.req?.url ?? "?").split("?")[0];
  const key = `${["/register", "/unregister", "/health"].includes(path) ? path : "other"} ${status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

export function health(deps: ApiDeps): {
  ok: boolean;
  warm: boolean;
  live: number;
  open: number;
  refused: number;
  sessions: number;
  hookOk: boolean;
  waiting: number;
} {
  const nowS = (deps.nowS ?? (() => Math.floor(Date.now() / 1000)))();
  const live = deps.store.all().filter((r) => r.expiresAt > nowS).length;
  const stats = deps.streams.stats();
  const hookOk = deps.hook.healthy;
  const ok = hookOk && (live === 0 || stats.open >= MIN_OPEN_SHARE * live);
  return {
    ok,
    warm: nowS - deps.store.createdAt >= WARM_AFTER_S,
    live,
    open: stats.open,
    refused: stats.refused,
    sessions: stats.sessions,
    hookOk,
    waiting: deps.hook.waiting,
  };
}

export function apiHandler(deps: ApiDeps) {
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!tokenOk(req.headers.authorization, deps.token)) return send(res, 401);
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, health(deps));
    if (req.method !== "POST") return send(res, 404);
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      return send(res, 400);
    }
    if (url.pathname === "/register") {
      const { mailboxId, authorization, checkpoint, shard } = body;
      if (typeof mailboxId !== "string" || !HEX_66.test(mailboxId)) return send(res, 400);
      if (typeof authorization !== "string" || typeof checkpoint !== "string" || !/^\d{1,20}$/.test(checkpoint)) return send(res, 400);
      if (typeof shard !== "string" || !SHARD_ID.test(shard)) return send(res, 400);
      const expiresAt = authorizationExpiry(authorization);
      // The authorization carries its mailbox key first: one for another
      // mailbox is refused here rather than by the Ark server.
      if (expiresAt === null || !authorization.startsWith(mailboxId)) return send(res, 400);
      if (expiresAt <= nowS()) return send(res, 410);
      if (!deps.store.get(mailboxId) && deps.store.count() >= MAX_REGISTRATIONS) return send(res, 507);
      const reg = deps.store.upsert({ mailboxId, authorization, expiresAt, checkpoint, shard });
      deps.streams.ensure(reg);
      return send(res, 204);
    }
    if (url.pathname === "/unregister") {
      const { mailboxId, shard } = body;
      if (typeof mailboxId !== "string" || !HEX_66.test(mailboxId)) return send(res, 400);
      if (shard !== undefined && (typeof shard !== "string" || !SHARD_ID.test(shard))) return send(res, 400);
      if (deps.store.remove(mailboxId, shard)) deps.streams.stop(mailboxId);
      return send(res, 204);
    }
    return send(res, 404);
  };
}
