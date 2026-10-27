// GET /api/bip353?n=user@domain: gathers the DNSSEC proof for a BIP 353 name
// and hands it to the app, which validates it (src/lib/bip353/dnssec.ts).
//
// This endpoint is transport, not authority. The app is same-origin only and
// cannot reach a DoH resolver itself; the Worker can. Nothing here is trusted:
// a lying Worker or resolver produces a proof that fails validation, and the
// worst it can do is deny a payment. So there is deliberately no DNSSEC check
// in this file (10 ms CPU on the Free plan would not fit one anyway).
//
// Budget: one Worker request per lookup, and a cache miss fans out to at most
// MAX_LABELS * 2 + 2 DoH queries (primary resolver, fallback on failure only),
// which stays under the 50 subrequest limit. The edge cache bounds upstream
// volume; the per-IP limiter is spent only on a miss.
import { bumpRateLimitKey } from "./bump";
import { cachedUpstream, type CachedResult, type UpstreamCache } from "./upstreamCache";
import { upstreamSignal } from "./upstream";
import { Bip353Error } from "../src/lib/bip353/errors";
import { decodeProof, labelCount, parseResponse, TYPE_TXT } from "../src/lib/bip353/dnsWire";
import { parseHumanName } from "../src/lib/bip353/name";
import { collectProof, type DnsQuery } from "../src/lib/bip353/proofCollector";

export const DOH_PRIMARY = "https://cloudflare-dns.com/dns-query";
export const DOH_FALLBACK = "https://dns.google/dns-query";
// Queries run in parallel, so a stalled primary costs one timeout and then the
// fallback wave costs another: 2 * this must stay under the client's 8 s deadline
// (src/lib/bip353/client.ts), or a primary outage fails lookups the fallback could serve.
const DOH_TIMEOUT_MS = 3_000;
const DOH_MAX_RESPONSE = 64 * 1024;
// Cloudflare Free allows 50 subrequests; 10 labels is 22 queries, 44 with every
// one falling back (a failed primary retries on the fallback, so the worst case
// is 2 * 22, still under 50).
const MAX_LABELS = 10;

// Payment instructions change (a rotated Ark address, a new offer), so the
// edge cache is short and the stale copy, served only when the resolvers fail,
// is short too. Signatures stay valid for days; the app checks them itself.
const FRESH_SECONDS = 120;
const STALE_SECONDS = 10 * 60;
const FAILURE_SECONDS = 30;

export interface Bip353Deps {
  ip: string;
  limiter: { limit(options: { key: string }): Promise<{ success: boolean }> };
  cache: UpstreamCache;
  inFlight: Map<string, Promise<CachedResult>>;
  fetchImpl?: typeof fetch;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked: spreading a large buffer into String.fromCharCode overflows the stack.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

function dohQuery(fetchImpl: typeof fetch): DnsQuery {
  const ask = async (url: string, query: Uint8Array): Promise<Uint8Array> => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
      body: query,
      signal: upstreamSignal(DOH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`doh ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > DOH_MAX_RESPONSE) throw new Error("doh response too large");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > DOH_MAX_RESPONSE) throw new Error("doh response too large");
    return bytes;
  };
  // A resolver that answers 200 with SERVFAIL, REFUSED or a truncated message has
  // failed as much as one that errors out: the fallback gets its turn. NOERROR and
  // NXDOMAIN are answers (proofCollector tells the rest apart).
  const answered = (bytes: Uint8Array): Uint8Array => {
    const msg = parseResponse(bytes);
    if ((msg.rcode !== 0 && msg.rcode !== 3) || msg.truncated) throw new Error(`doh rcode ${msg.rcode}`);
    return bytes;
  };
  return async (query) => {
    try {
      return answered(await ask(DOH_PRIMARY, query));
    } catch {
      return ask(DOH_FALLBACK, query);
    }
  };
}

function reply(status: number, body: object): CachedResult {
  return { status, body: JSON.stringify(body) };
}

function errorStatus(e: Bip353Error): number {
  if (e.code === "malformed") return 400;
  if (e.code === "no_record") return 404;
  return 502;
}

async function lookup(dnsName: string, fetchImpl: typeof fetch): Promise<CachedResult> {
  try {
    const proof = await collectProof(dnsName, dohQuery(fetchImpl), MAX_LABELS);
    // Nothing to validate when the name has no TXT at all; saying so here saves
    // the app a proof it would only throw away.
    if (!decodeProof(proof).some((r) => r.type === TYPE_TXT && r.name === dnsName)) return reply(404, { error: "no_record" });
    return reply(200, { proof: toBase64(proof) });
  } catch (e) {
    if (e instanceof Bip353Error) return reply(errorStatus(e), { error: e.code });
    return reply(502, { error: "resolver" });
  }
}

export async function handleBip353(request: Request, deps: Bip353Deps): Promise<Response> {
  const respond = (r: CachedResult) =>
    new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const name = new URL(request.url).searchParams.get("n");
  if (!name || name.length > 320) return respond(reply(400, { error: "malformed" }));
  let dnsName: string;
  try {
    dnsName = parseHumanName(name).dnsName;
    // Refused before the limiter or cache: it could never be answered.
    if (labelCount(dnsName) > MAX_LABELS) return respond(reply(400, { error: "malformed" }));
  } catch {
    return respond(reply(400, { error: "malformed" }));
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const result = await cachedUpstream({
    cache: deps.cache,
    key: new Request(`https://bip353-cache.internal/v1?n=${encodeURIComponent(dnsName)}`),
    ttlSeconds: FRESH_SECONDS,
    staleTtlSeconds: STALE_SECONDS,
    failureTtlSeconds: FAILURE_SECONDS,
    // Only a resolver failure (502) may be answered from the stale copy; "no
    // record" is an answer, and an old proof must not stand in for it.
    staleOn: (status) => status >= 500,
    inFlight: deps.inFlight,
    allowMiss: async () => (await deps.limiter.limit({ key: bumpRateLimitKey(deps.ip) })).success,
    fetcher: () => lookup(dnsName, fetchImpl),
  });
  return respond(result);
}
