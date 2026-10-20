// The wallet worker's half of the connectivity probe (see netProbeState.ts
// and connectivity.ts). Runs in wallet.worker.ts's bootstrap, NOT through
// walletWorkerImpl.ts's FIFO queue: the probe exists for exactly the moment a
// wallet call is hanging, and anything queued behind that call would hang
// with it. No SDK dependency, and every request still goes through the
// worker's network guard, which already allows both hosts below.
import { CONFIG, FALLBACK_ESPLORA_ADDRESS } from "../wallet/walletWorkerGuard";

export type NetProbeRequest = { type: "netProbe"; probeId: number };
export type NetProbeReply = { netProbe: number; mempool: boolean; ark: boolean };

export function isNetProbeRequest(data: unknown): data is NetProbeRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "netProbe" &&
    typeof (data as { probeId?: unknown }).probeId === "number"
  );
}

const PROBE_FETCH_TIMEOUT_MS = 5_000;

// Not AbortSignal.timeout(): missing before Safari 16, and a throw there would
// read as "unreachable" and make the probe call a working network offline.
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// mempool.space: a different operator and network from both Cloudflare and
// second.tech, and it answers CORS with `*`. Only a plain block height counts,
// so a portal or a proxy error page doesn't.
async function probeMempool(): Promise<boolean> {
  try {
    const res = await fetch(`${FALLBACK_ESPLORA_ADDRESS}/blocks/tip/height`, {
      cache: "no-store",
      signal: timeoutSignal(PROBE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    return /^\d+$/.test((await res.text()).trim());
  } catch {
    return false;
  }
}

// The Ark server, via the same gRPC-web path the SDK uses. A plain GET gets a
// 404 without CORS headers, which a browser reports exactly like a network
// failure, so it would read every healthy server as down; gRPC-web requests
// get CORS for this origin. An empty GetArkInfo frame is the cheapest real
// call (a few hundred bytes back). Measured 2026-09-25: HTTP 200, status in
// the trailer. Envoy reports an unreachable backend as HTTP 503 or as
// grpc-status 14 (UNAVAILABLE) in the headers; any other answer means the
// server is there, even one refusing this particular call.
const ARK_PROBE_BODY = new Uint8Array(5);
async function probeArk(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.serverAddress}/bark_server.ArkService/GetArkInfo`, {
      method: "POST",
      headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1" },
      body: ARK_PROBE_BODY,
      cache: "no-store",
      signal: timeoutSignal(PROBE_FETCH_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    return res.ok && res.headers.get("grpc-status") !== "14";
  } catch {
    return false;
  }
}

export async function runNetProbe(req: NetProbeRequest): Promise<NetProbeReply> {
  const [mempool, ark] = await Promise.all([probeMempool(), probeArk()]);
  return { netProbe: req.probeId, mempool, ark };
}
