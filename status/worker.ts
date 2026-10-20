// Status probe for spendrr.app/status, on its own Cloudflare account (see
// status/wrangler.toml) so it neither shares the app's Free plan limits nor
// goes down with the app's Worker. Every minute the cron probes the services
// the way the app sees them and hands the results to one Durable Object; the
// app itself reports what only it can see (POST /v1/report, signed). GET
// /v1/status returns the snapshot. State logic: status/logic.ts.

import { DurableObject } from "cloudflare:workers";
import {
  acceptReport,
  applyProbes,
  SPENDRR_EVERY_MIN,
  toPublic,
  type ProbeResults,
  type PublicSnapshot,
  type State,
} from "./logic.ts";
import { REPORT_SIGNATURE_HEADER, verifyReport, type StatusReport } from "./report.ts";
import { REPORT_PUBLIC_KEY } from "./reportKey.ts";
import { RECORDED_INCIDENTS, RECORDED_KNOWN_FROM } from "./recorded.ts";
import { grpcWebMessage, readVarintField1 } from "./grpcWeb.ts";

interface Env {
  STATUS: DurableObjectNamespace<StatusStore>;
}

const PAGE_ORIGIN = "https://spendrr.app";
const ARK = "https://ark.second.tech/bark_server.ArkService";
const PROBE_TIMEOUT_MS = 10_000;
// Snapshot kept per isolate: the Cache API does nothing on workers.dev, and
// without this every page view would also be a Durable Object request.
const SNAPSHOT_TTL_MS = 20_000;
const MAX_REPORT_BYTES = 1024;

export class StatusStore extends DurableObject<Env> {
  private async load(): Promise<State | null> {
    const state = (await this.ctx.storage.get<State>("state")) ?? null;
    // v1 states predate the push row and the report; start over rather than migrate.
    return state?.v === 2 ? state : null;
  }

  async record(results: ProbeResults, now: number): Promise<void> {
    await this.ctx.storage.put("state", applyProbes(await this.load(), results, now));
  }

  async report(report: StatusReport, now: number): Promise<void> {
    await this.ctx.storage.put("state", acceptReport(await this.load(), report, now));
  }

  async snapshot(): Promise<PublicSnapshot | null> {
    const state = await this.load();
    return state ? toPublic(state, RECORDED_INCIDENTS, RECORDED_KNOWN_FROM) : null;
  }
}

// The name is the history: a new one starts it over (the old object is just
// left unused). "launch": the first one carried a false push outage from the
// day the report never ran.
const store = (env: Env) => env.STATUS.get(env.STATUS.idFromName("launch"));

// The reply message of an empty-request unary call, or null on any failure.
async function grpcWeb(method: string): Promise<Uint8Array | null> {
  const res = await fetch(`${ARK}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", origin: PAGE_ORIGIN },
    body: new Uint8Array(5),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return grpcWebMessage(res.status, res.headers.get("grpc-status"), new Uint8Array(await res.arrayBuffer()));
}

// GetArkInfo is what the wallet asks first; NextRoundTime tells whether rounds
// keep coming (the server pushes it forward after each one).
async function probeArk(): Promise<ProbeResults["ark"]> {
  const [info, next] = await Promise.all([
    grpcWeb("GetArkInfo").catch(() => null),
    grpcWeb("NextRoundTime").catch(() => null),
  ]);
  const secs = next ? readVarintField1(next) : null;
  return { up: info !== null, nextRoundAt: secs === null ? null : secs * 1000 };
}

async function probeTip(base: string): Promise<number | null> {
  const res = await fetch(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const text = (await res.text()).trim();
  return res.ok && /^\d+$/.test(text) ? Number(text) : null;
}

// One request to the app's Worker covers "is spendrr.app up" and the Lightning
// address kill switch.
async function probeSpendrr(): Promise<{ up: boolean; lnaddrOk: boolean }> {
  const res = await fetch(`${PAGE_ORIGIN}/api/lnaddr/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) return { up: false, lnaddrOk: false };
  const body = await res.json<{ ok?: unknown }>().catch(() => null);
  if (body === null) return { up: false, lnaddrOk: false };
  return { up: true, lnaddrOk: body.ok === true };
}

async function handleReport(request: Request, env: Env): Promise<Response> {
  if (!REPORT_PUBLIC_KEY) return new Response(null, { status: 404 });
  const signature = request.headers.get(REPORT_SIGNATURE_HEADER);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!signature || declared > MAX_REPORT_BYTES) return new Response(null, { status: 400 });
  const body = await request.text();
  if (body.length > MAX_REPORT_BYTES) return new Response(null, { status: 400 });
  const now = Date.now();
  const report = await verifyReport(body, signature, REPORT_PUBLIC_KEY, now);
  if (!report) return new Response(null, { status: 403 });
  await store(env).report(report, now);
  return new Response(null, { status: 204 });
}

let cached: { at: number; body: string } | null = null;

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const [ark, chainPrimary, chainFallback, spendrr] = await Promise.all([
      probeArk(),
      probeTip("https://mempool.second.tech/api").catch(() => null),
      probeTip("https://mempool.space/api").catch(() => null),
      minute % SPENDRR_EVERY_MIN === 0 ? probeSpendrr().catch(() => ({ up: false, lnaddrOk: false })) : Promise.resolve(undefined),
    ]);
    await store(env).record(
      { ark, chainPrimary, chainFallback, spendrr, reportsExpected: REPORT_PUBLIC_KEY !== "" },
      event.scheduledTime,
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/report") return handleReport(request, env);
    if (request.method !== "GET" || url.pathname !== "/v1/status") return new Response("Not found", { status: 404 });

    const now = Date.now();
    if (!cached || now - cached.at > SNAPSHOT_TTL_MS) {
      const snap = await store(env).snapshot();
      if (!snap) return json('{"error":"no-data"}', 503);
      cached = { at: now, body: JSON.stringify(snap) };
    }
    return json(cached.body, 200);
  },
} satisfies ExportedHandler<Env>;

function json(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=20",
      "access-control-allow-origin": PAGE_ORIGIN,
      "x-content-type-options": "nosniff",
    },
  });
}
