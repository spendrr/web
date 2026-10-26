// Thin edge proxy in front of CoinGecko, added so the wallet's shared Demo
// API key can never be abused by one client to exhaust the quota for
// everyone else. The key used to live in the shipped JS bundle (any user
// could read it out and hammer CoinGecko directly, ignoring whatever
// throttling the app's own JS does); now it's a Worker secret the browser
// never sees, and every request is rate-limited per source IP at Cloudflare's
// edge before it ever reaches CoinGecko — a client-side throttle can't stop
// someone who just calls the API directly, but this can.
//
// Also runs the background push-notification watch (see ARCHITECTURE.md's push
// notifications section): /api/push/* stores what's needed to poll a
// wallet's Ark mailbox on its behalf, and the scheduled() cron handler below
// does that polling and relays a Web Push when a payment arrives. This
// Worker never sees a mnemonic — only a public mailbox identifier and a
// time-limited *read* authorization the SDK explicitly documents as safe to
// hand to a third party.
//
// Everything that isn't one of these routes falls through to the static SPA
// build, so this replaces the previous assets-only Worker without changing
// how the app itself is served.

import {
  COINGECKO_BASE,
  PRICE_CACHE_TTL_SECONDS,
  historyCacheTtlSeconds,
  PRICE_HISTORY_STALE_TTL_SECONDS,
  priceCacheKey,
  priceJsonResponse,
  fetchJsonCached,
  fetchSimplePriceCached,
  refreshHistoryIfStale,
  sharedHistoryBody,
  refreshSimplePriceIfStale,
  type RateLimiter,
} from "./priceCache";
import type { Currency } from "./priceSeries";
import { ARK_SERVER, MAX_PLAUSIBLE_BLOCKHEIGHT, SUBSCRIPTION_TTL_SECONDS, isKnownPushEndpoint } from "./mailboxShared";
import { FCM_ENDPOINT_PREFIX, isValidFcmToken } from "./fcm";
import { probeMailboxAuthorization } from "./mailbox";
import { decodeBolt11Amount, decodeBolt11PaymentHash } from "../src/lib/send/destination";
import { checkHandle, handleFromPath, isReservedName } from "../src/lib/names/handle";
import { CHAT_BIND_PREFIX, CHAT_RELAYS } from "../src/lib/chat/relays";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { escapeHtml, profileMeta, profileMetaTags } from "./profileMeta";
import { prefersEnglishLearn } from "./learnLang";
import { avatarPng, isAvatarAddress } from "./avatarPng";
import {
  ARK_ADDRESS_MAX_CHARS,
  isPlausibleArkAddress,
  mailboxAuthorizationFreshness,
  mailboxAuthorizationProblem,
} from "./names";
import { refreshBtcMapCacheIfStale, handleBtcMapElements, handleBtcMapTile } from "./btcmap";
import { parseVersion, resolveCommitVersion } from "./backupVersion";
import { WRITE_TOKEN_RE, checkWriteToken, hashWriteToken } from "./backupAuth";
import { HEIGHT_TOKEN_RE, hashHeightToken } from "./pushHeight";
import {
  buildPayRequest,
  buildVerifyResponse,
  classifyBarkdStatus,
  type BarkdFailure,
  isPlausiblePaymentHash,
  lnAddressMetadataString,
  lnurlErrorResponse,
  lnurlJsonResponse,
  parseCallbackAmountMsat,
  parseCallbackComment,
} from "./lnurl";
import type { ReceiveRecord } from "./lnLedger";
import { lnAddrHealthResponse, syncLnAddrRefusing } from "./lnAddrHealth";
export { MailboxWatcher } from "./mailboxWatcher";
export { BumpLab } from "./bump";
export { NameRegistry } from "./names";
export { LnLedger } from "./lnLedger";
import { networkPrefix, guardPrefix, bumpRateLimitKey } from "./bump";
import { isCanonicalBase64, readBodyCapped } from "./requestGuard";
import { getSliding, putSliding, touchSliding, type SlidingRead } from "./kvSliding";
import { cachedNameLookup, invalidateNameLookup } from "./nameLookupCache";
import { currentNameSnapshot, invalidateNameSnapshot } from "./nameSnapshot";
import { cachedUpstream, type CachedResult } from "./upstreamCache";
import { upstreamSignal } from "./upstream";
import { relayConfigured, relayHealthy, verifyHook } from "./pushRelay";
import { buildStatusReport, sendStatusReport } from "./statusReport";
import { handleAppRelease } from "./appRelease";
import { hasSealKey, isBlob, isSlot, MAX_SLOTS_PER_REQUEST, openToken, parseTarget, sealToken, sendChatPush } from "./chatPush";

interface DurableObjectId {
  readonly name?: string;
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  getWithMetadata<M = unknown>(key: string): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Matches Cloudflare's real R2Object: metadata only, no body. head() and
// get() resolve to this shape (get()'s R2ObjectBody adds the body on top) —
// keeping both accurate, rather than head() resolving to `unknown` as
// before, matters now that handleBackupCommit/handleBackupMeta read
// `.customMetadata` straight off a head() result (the version check,
// backupVersion.ts) instead of only ever checking it against `null`.
interface R2Object {
  customMetadata?: Record<string, string>;
  etag?: string;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  text(): Promise<string>;
}

interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string; cacheControl?: string };
      // A put whose precondition fails writes nothing and resolves to null.
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<unknown>;
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectBody | null>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    include?: string[];
  }): Promise<{
    objects: { key: string; size: number; customMetadata?: Record<string, string> }[];
    truncated: boolean;
    cursor?: string;
  }>;
  // Existence check without transferring the (up to 20MB) object body —
  // used to tell a brand-new lookupKey apart from a repeat upload by an
  // already-known one (see DAILY_NEW_BACKUP_CAP), and to read the current
  // version for the commit/meta version check (backupVersion.ts) without
  // paying for the object body.
  head(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  ASSETS: Fetcher;
  COINGECKO_API_KEY?: string;
  PRICE_RATE_LIMITER: RateLimiter;
  // /api/push/{subscribe,height,unsubscribe}. Its own bucket: it used to be
  // PRICE_RATE_LIMITER's, so price traffic from one address (or a whole carrier
  // NAT) could 429 a push subscribe, and a lost subscribe is a silent loss of
  // payment notifications.
  PUSH_RATE_LIMITER: RateLimiter;
  BACKUP_RATE_LIMITER: RateLimiter;
  // Reads get their own, far more generous bucket rather than sharing the
  // write one — see handleBackupFetch.
  BACKUP_READ_RATE_LIMITER: RateLimiter;
  // Repurposed: no longer full subscription records (those now live in each
  // mailbox's own MailboxWatcher Durable Object storage) — just a lightweight
  // endpoint -> mailboxId reverse lookup, needed because the client only
  // knows its own push endpoint at disable time (see notifications.ts),
  // never the mailboxId, so handlePushUnsubscribe needs some way to find the
  // right Durable Object without a global list to walk.
  PUSH_SUBSCRIPTIONS: KVNamespace;
  WALLET_BACKUPS: R2Bucket;
  // Public bucket behind https://data.spendrr.app holding only the price
  // (priceCache.ts's publishPublicPrice). Optional until it is set up.
  PRICE_PUBLIC?: R2Bucket;
  // The Android app's update channel (worker/appRelease.ts): update.json and the APKs. Optional until the bucket exists.
  APP_RELEASES?: R2Bucket;
  MAILBOX_WATCHER: DurableObjectNamespace;
  VAPID_PRIVATE_KEY?: string;
  // Firebase service account JSON for pushes to the Android app (fcm.ts).
  // Unset: FCM subscriptions are stored but nothing is sent to them.
  FCM_SERVICE_ACCOUNT?: string;
  // Dead-man's-switch for the per-minute mailbox cron (see scheduled() and
  // pingHealthcheck below) — a healthchecks.io (or compatible) ping URL.
  // Optional: unset just means no external alert exists yet, not an error.
  HEALTHCHECK_PING_URL?: string;
  // Payment push relay (pushRelay.ts, docs/payment-push-relay.md): its tunnel
  // URL (behind the same Access service token as BARKD_URL), the bearer it
  // expects, and the secret its pokes are signed with. Any missing: no relay,
  // the shards poll every minute as before.
  PUSH_RELAY_URL?: string;
  PUSH_RELAY_TOKEN?: string;
  PUSH_RELAY_HOOK_SECRET?: string;
  // Money chat push (chatPush.ts): 64 hex characters sealing the per-contact
  // tokens. Unset: both chat push endpoints answer 503.
  CHAT_PUSH_SEAL_KEY?: string;
  // /api/chat/poke per source, and per conversation (the token's slot), so a
  // contact holding a token cannot flood the recipient.
  CHAT_POKE_RATE_LIMITER: RateLimiter;
  CHAT_POKE_SLOT_RATE_LIMITER: RateLimiter;
  // Same, for the Lightning-address service node (pingLnHealthcheck). Its own
  // check, not HEALTHCHECK_PING_URL, so an LN outage alerts as one. Optional
  // secret: npx wrangler secret put LN_HEALTHCHECK_PING_URL
  LN_HEALTHCHECK_PING_URL?: string;
  // Same, for the push relay (pingRelayHealthcheck): with the shard sweep at
  // 15 minutes either way, a relay outage only shows as late pushes, so it
  // needs its own alert. Optional secret:
  // npx wrangler secret put RELAY_HEALTHCHECK_PING_URL
  RELAY_HEALTHCHECK_PING_URL?: string;
  // Ed25519 private key (PKCS#8, base64) signing the status report sent to the
  // status Worker every 5 minutes (statusReport.ts). Set by
  // scripts/status-keygen.mjs. Unset: no report is sent.
  STATUS_REPORT_KEY?: string;
  // Utility hub's btcmap.org merchant map (see btcmap.ts). Optional — an
  // unconfigured/undeployed KV namespace just makes handleBtcMapElements
  // report 503 rather than throwing, same "missing config degrades
  // gracefully" posture as the other optional secrets above.
  BTCMAP_ELEMENTS?: KVNamespace;
  BTCMAP_ELEMENTS_RATE_LIMITER?: RateLimiter;
  // MapTiler API key for /api/btcmap/tile/* (see btcmap.ts's own comment on
  // why tiles are proxied rather than fetched by the client directly).
  BTCMAP_TILES_API_KEY?: string;
  BTCMAP_TILE_RATE_LIMITER?: RateLimiter;
  // Tap-to-pay's pairing backend (see bump.ts): a single global Durable
  // Object, not sharded like MAILBOX_WATCHER. No mnemonic and no payment
  // ever reaches it, only the Ark addresses the two phones exchange and the
  // announced amount.
  BUMP_LAB: DurableObjectNamespace;
  // @handle registry (see names.ts): one global Durable Object, name -> Ark
  // address. Reads are public; writes prove mailbox ownership first.
  NAME_REGISTRY: DurableObjectNamespace;
  NAME_LOOKUP_RATE_LIMITER: RateLimiter;
  // Charged only for a lookup the edge cache could not answer, i.e. one that
  // costs a Durable Object request (worker/nameLookupCache.ts). Optional so a
  // deploy that lacks the binding falls back to a `miss:` key on the limiter above.
  NAME_MISS_RATE_LIMITER?: RateLimiter;
  NAME_WRITE_RATE_LIMITER: RateLimiter;
  // JSON {"spendrr": "<mailbox id>"}: reserved names handed to one mailbox each
  // (wrangler.toml [vars], read by the NameRegistry Durable Object itself).
  RESERVED_NAME_OWNERS?: string;
  // Bearer token for /api/names/admin/* (a secret). Unset means the admin routes
  // answer 503, i.e. nobody can moderate.
  NAMES_ADMIN_TOKEN?: string;
  // Lightning-address beta (docs/ln-address-plan.md): <name>@spendrr.app pays
  // through a small non-custodial service node (barkd) this Worker calls
  // over a Cloudflare Tunnel. One global LnLedger Durable Object tracks
  // every open/settled/expired invoice; see lnLedger.ts.
  LN_LEDGER: DurableObjectNamespace;
  // Public LNURL endpoints (payRequest + callback) — a sender's wallet hits
  // these, so generous like NAME_LOOKUP_RATE_LIMITER, but the callback also
  // costs a real call to the service node, so it gets its own bucket.
  LNURL_RATE_LIMITER: RateLimiter;
  // https://ln-node.example.com — the Cloudflare Tunnel hostname in front of
  // Caddy's allowlist (docs/ln-address-plan.md section 4.1). A [vars] entry,
  // not a secret: the hostname itself isn't sensitive, Cloudflare Access and
  // barkd's own bearer auth are what actually gate it.
  BARKD_URL?: string;
  // Cloudflare Access service-token credentials for BARKD_URL (secrets):
  //   npx wrangler secret put CF_ACCESS_CLIENT_ID
  //   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  // barkd's own bearer token (`barkd secret show` on the node), on top of
  // Cloudflare Access — two independent secrets, so a leak of either one
  // alone still isn't enough to reach the node:
  //   npx wrangler secret put BARKD_TOKEN
  BARKD_TOKEN?: string;
  // Real "action" (a physical tap) — tight, since a legitimate tester
  // produces at most a handful of these per minute.
  BUMP_RATE_LIMITER: RateLimiter;
  // Clock-sync pings and /status polling — much more generous, since one
  // pairing attempt alone is a handful of sync round-trips plus a poll every
  // ~150ms for up to a few seconds.
  BUMP_POLL_RATE_LIMITER: RateLimiter;
  // Tap-to-pay sensor recordings (src/lib/bump/bumpRecorder.ts), for tuning the
  // detector offline. Uploads are accepted only while BUMP_LAB_RECORDING is
  // "1" (wrangler.toml [vars]); reads need BUMP_LAB_TOKEN (a secret).
  BUMP_LAB_RECORDINGS?: R2Bucket;
  BUMP_LAB_RECORDING?: string;
  BUMP_LAB_TOKEN?: string;
  // Remote off switch for tap-to-pay: "1" makes every new tap come back
  // unpaired, for every client build at once, including old cached ones.
  // Pairs already in progress keep working so no payment is cut off
  // halfway. A secret rather than a [vars] entry so flipping it needs no
  // code deploy: `echo 1 | npx wrangler secret put BUMP_TAPS_OFF`, and
  // `npx wrangler secret delete BUMP_TAPS_OFF` to turn it back on.
  BUMP_TAPS_OFF?: string;
  // "1" switches off the spray penalty (worker/bump.ts's StrikeLedger) if it
  // ever blocks honest phones: `echo 1 | npx wrangler secret put BUMP_STRIKES_OFF`.
  BUMP_STRIKES_OFF?: string;
  // "enforce" drops every tap from a source over worker/bump.ts's
  // HOT_SOURCE_TAPS instead of only counting it (`hot` in /api/bump/stats).
  // Off until the `srcRate` histogram says the threshold spares honest phones:
  // `echo enforce | npx wrangler secret put BUMP_HOT_SOURCES`, and
  // `npx wrangler secret delete BUMP_HOT_SOURCES` to go back to counting.
  BUMP_HOT_SOURCES?: string;
}

const ALLOWED_CURRENCIES = new Set(["czk", "eur", "usd"]);
const ALLOWED_DAYS = new Set(["1", "7", "30", "90", "365"]);

// Same hosts src/lib/wallet/walletWorkerGuard.ts already trusts as this wallet's
// chain source (second.tech's own mempool/esplora instance, with
// mempool.space as its documented fallback) — reused here so Settings'
// "Poplatky v síti" widget can read fee estimates without going anywhere
// near the wallet Worker's own request queue (see handleFeesProxy below).
// mempool.second.tech is a plain esplora and has no /api/v1/fees/recommended
// (404, checked 2026-09-26), so in practice every fee request falls through
// to mempool.space; the primary is kept in case it gains the route.
const FEES_PRIMARY = "https://mempool.second.tech/api/v1/fees/recommended";
const FEES_FALLBACK = "https://mempool.space/api/v1/fees/recommended";
// The tip block for the v2 fee widget. Esplora's /api/blocks (newest first)
// exists on both hosts.
const TIP_BLOCKS_PRIMARY = "https://mempool.second.tech/api/blocks";
const TIP_BLOCKS_FALLBACK = "https://mempool.space/api/blocks";

// The seam between the payment/expiry-check logic in mailboxShared.ts (moved
// there — see its own top-of-file comment for why — but otherwise unchanged
// from the old shared-cron design) and wherever a record actually lives now —
// a MailboxWatcher Durable Object's own storage, one instance per mailbox,
// instead of a shared KV entry every mailbox used to compete for.
export interface RecordStore {
  get(): Promise<PushSubscriptionRecord | null>;
  put(record: PushSubscriptionRecord): Promise<void>;
  delete(): Promise<void>;
}

export interface PushSubscriptionRecord {
  mailboxAuthorization: string;
  authExpiresAt: number;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  // Decimal string, not number — checkpoint is a real uint64 (time-based,
  // easily exceeding Number.MAX_SAFE_INTEGER) and JSON can't hold a bigint
  // directly. Parsed to BigInt at the two places that need to compare/send
  // it. See mailbox.ts's encodeVarintBig comment for the corruption bug this
  // replaced (every cron tick was re-fetching and re-notifying the entire
  // mailbox history).
  checkpoint: string;
  lastSeenAt: number;
  // Blockheight of the client's soonest-expiring VTXO, and the BTC/USD price
  // it had on hand at that same moment — both best-effort snapshots the
  // client re-reports on every real balance/history change (see
  // src/lib/notifications.ts's postSubscription). Used by the expiry-nudge
  // check below; absent entirely for a wallet with no VTXOs or that hasn't
  // reported yet, which the check treats as "nothing to watch".
  firstExpiringVtxoBlockheight?: number;
  lastKnownPriceUsd?: number;
  // Dedup: which firstExpiringVtxoBlockheight value has already gotten its
  // first/reminder/urgent nudge, so a re-run of the same cron tick (or the value not
  // having changed since) doesn't re-send. Once the client reports a new
  // (later) blockheight — meaning that VTXO got refreshed — these simply
  // stop matching and the watch naturally resets, no manual clearing needed.
  expiryNotifiedForHeight?: number;
  expiryReminderNotifiedForHeight?: number;
  expiryUrgentNotifiedForHeight?: number;
  // SHA-256 of the client's height token, set by a verified subscribe; lets
  // /api/push/height move the watch while the Ark server is down (pushHeight.ts).
  heightTokenHash?: string;
  // True while the mailbox's first read (its whole history, drained without
  // notifying) is spread over several ticks, with `checkpoint` holding how far
  // it got. Must survive every rewrite of the record: without it a checkpoint
  // above 0 reads as "up to date" and the rest of the history would be sent as
  // fresh payments. See mailboxShared.ts's checkMailboxForPayments.
  backfilling?: boolean;
}

// Every route. Split out of the default export so one try/catch below covers
// them all: a Durable Object call that throws (daily request limit spent, object
// overloaded, reset) used to escape as an uncaught exception, i.e. Cloudflare's
// opaque 1101 page, on the handlers that don't catch it themselves (bump, push).
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.startsWith("/api/avatar/")) {
    return handleAvatarPng(request, url, env, ctx);
  }
  if (url.pathname === "/api/price/simple" || url.pathname === "/api/price/history") {
    return handlePriceProxy(request, url, env);
  }
  if (url.pathname === "/api/fees/recommended") {
    return handleFeesProxy(request, env);
  }
  if (url.pathname === "/api/fees/tip") {
    return handleTipBlock(request, env);
  }
  if (url.pathname === "/api/btcmap/elements") {
    return handleBtcMapElements(request, url, env);
  }
  if (url.pathname.startsWith("/api/btcmap/tile/")) {
    return handleBtcMapTile(request, url, env);
  }
  if (request.method === "POST" && url.pathname === "/api/push/subscribe") {
    return handlePushSubscribe(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/push/height") {
    return handlePushHeight(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/push/unsubscribe") {
    return handlePushUnsubscribe(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/push/hook") {
    return handlePushHook(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/chat/push/tokens") {
    return handleChatPushTokens(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/chat/poke") {
    return handleChatPoke(request, env);
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/names/admin/")) {
    return handleNameAdmin(request, url, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/names/")) {
    return handleNameLookup(request, url, env);
  }
  if (request.method === "POST" && url.pathname === "/api/names/set") {
    return handleNameSet(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/names/release") {
    return handleNameRelease(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/names/mine") {
    return handleNameMine(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/names/chat") {
    return handleNameChat(request, env);
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/.well-known/nostr.json") {
    return handleNip05(request, url, env);
  }
  if (request.method === "POST" && url.pathname === "/api/names/ln") {
    return handleNameLnToggle(request, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/.well-known/lnurlp/")) {
    return handleLnurlPayRequest(request, url, env);
  }
  if (request.method === "GET" && /^\/api\/lnurlp\/[^/]+\/cb$/.test(url.pathname)) {
    return handleLnurlCallback(request, url, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/lnurlp/verify/")) {
    return handleLnurlVerify(request, url, env);
  }
  if (request.method === "POST" && url.pathname === "/api/lnaddr/receipts") {
    return handleLnAddrReceipts(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/lnaddr/health") {
    return lnAddrHealthResponse(caches.default, env.PUSH_SUBSCRIPTIONS, !!env.BARKD_URL);
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/lnaddr/admin/")) {
    return handleLnAddrAdmin(request, url, env);
  }
  if (request.method === "POST" && url.pathname === "/api/backup/upload-tmp") {
    return handleBackupUploadTmp(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/backup/commit") {
    return handleBackupCommit(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/backup/fetch") {
    return handleBackupFetch(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/backup/fetch-tmp") {
    return handleBackupFetchTmp(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/backup/meta") {
    return handleBackupMeta(request, env);
  }
  if (url.pathname === "/api/bump/sync") {
    return handleBumpSync(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/bump/stats") {
    return handleBumpStats(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/bump/tap") {
    // Looks exactly like a tap nobody else made: clients stay silent.
    if (env.BUMP_TAPS_OFF === "1") return new Response(JSON.stringify({ state: "expired" }), { headers: { "content-type": "application/json" } });
    return handleBumpForward(request, env, env.BUMP_RATE_LIMITER);
  }
  if (request.method === "GET" && url.pathname === "/api/bump/status") {
    return handleBumpForward(request, env, env.BUMP_POLL_RATE_LIMITER);
  }
  if (request.method === "POST" && url.pathname === "/api/bump/choose") {
    return handleBumpForward(request, env, env.BUMP_RATE_LIMITER);
  }
  if (request.method === "POST" && url.pathname === "/api/bump/progress") {
    return handleBumpForward(request, env, env.BUMP_RATE_LIMITER);
  }
  if (request.method === "POST" && url.pathname === "/api/bump/reveal") {
    return handleBumpForward(request, env, env.BUMP_RATE_LIMITER);
  }
  if (request.method === "POST" && url.pathname === "/api/bump/lab/upload") {
    return handleBumpLabUpload(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/bump/lab/list") {
    return handleBumpLabList(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/bump/lab/get") {
    return handleBumpLabGet(request, env);
  }
  if (url.pathname === "/manifest.json") {
    return handleManifest(request, env);
  }
  if (url.pathname === "/app/update.json" || url.pathname.startsWith("/app/apk/")) {
    return handleAppRelease(request, env.APP_RELEASES, url.pathname);
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/.well-known/assetlinks.json") {
    return handleAssetLinks();
  }
  if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/donate" || url.pathname === "/donate/" || url.pathname.startsWith("/tip/"))) {
    return handleTipPage(request, url, env);
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/learn") {
    return handleLearnPage(request, url, env);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const profileName = handleFromPath(url.pathname);
    if (profileName !== null) return handleProfilePage(request, env, profileName);
  }
  return env.ASSETS.fetch(request);
}

// public/_headers only reaches what the asset layer serves. Everything this
// Worker builds itself (every /api/* answer, the LNURL routes, the manifest)
// went out without them, checked with curl on 2026-09-30. Added here once for
// all routes instead of in each handler: a new route cannot forget them.
// nosniff stops a browser reading a JSON or PNG answer as HTML/script, and
// no-referrer matches the app. Only set when missing, so a handler (or the
// asset layer's own _headers) always wins. No CORP/COEP here: the LNURL routes
// are read cross-origin by other wallets on purpose.
function withBaselineHeaders(res: Response): Response {
  if (res.status === 101 || res.headers.has("x-content-type-options")) return res;
  const out = new Response(res.body, res);
  out.headers.set("X-Content-Type-Options", "nosniff");
  if (!out.headers.has("Referrer-Policy")) out.headers.set("Referrer-Policy", "no-referrer");
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withBaselineHeaders(await route(request, env, ctx));
    } catch (e) {
      console.error("unhandled", new URL(request.url).pathname, e instanceof Error ? e.message : e);
      return withBaselineHeaders(
        new Response(JSON.stringify({ error: "Service busy. Try again shortly." }), {
          status: 503,
          headers: { "content-type": "application/json", "cache-control": "no-store", "Retry-After": "60" },
        }),
      );
    }
  },

  // Mailbox payment/expiry checking no longer happens here — each
  // subscribed mailbox is its own MailboxWatcher Durable Object with its own
  // self-scheduling alarm (see mailboxWatcher.ts and handlePushSubscribe).
  // This trigger's main remaining job is proving the base Worker/cron
  // machinery itself is alive, via the dead-man's-switch ping below — it
  // deliberately does NOT try to verify every individual mailbox's health
  // (there's no shared list left to walk, by design), only that Cloudflare
  // Cron Triggers are still firing at all. Piggybacks the btcmap.org cache
  // refresh on the same per-minute tick rather than a second cron trigger —
  // refreshBtcMapCacheIfStale no-ops on its own until 30 minutes have
  // passed, so this costs nothing on the 29 ticks out of 30 it skips.
  //
  // The status report rides on every STATUS_REPORT_EVERY_MIN-th tick. Not a
  // second cron trigger: one that fires in the same minute as this one is not
  // invoked separately (seen live, 2026-10-05). It adds two external
  // subrequests (relay health, the POST) to this invocation's budget.
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const reportDue = new Date(event.scheduledTime).getUTCMinutes() % STATUS_REPORT_EVERY_MIN === 0;
    await Promise.all([
      pingHealthcheck(env),
      refreshBtcMapCacheIfStale(env),
      refreshSimplePriceIfStale(env),
      refreshHistoryIfStale(env),
      // The status report takes the ledger's part from the sweep's own
      // ledger call (one Durable Object request a tick, not two). Chained, so
      // the relay ping then reuses reportStatus's cached /health answer.
      sweepLnLedger(env, reportDue).then((ledger) =>
        reportDue ? reportStatus(env, ledger).then(() => pingRelayHealthcheck(env)) : undefined,
      ),
    ]);
  },
};

const STATUS_REPORT_EVERY_MIN = 5;

// What only this Worker can see, for spendrr.app/status (statusReport.ts).
// Each part reads, never writes: the ledger's summary (from the sweep's tick,
// null when the sweep could not reach the ledger), one registry request, an
// R2 HEAD and the relay's health (cached per isolate).
async function reportStatus(env: Env, ledger: LedgerSummary | null): Promise<void> {
  if (!env.STATUS_REPORT_KEY) return;
  const [names, backups, relay] = await Promise.all([
    nameRegistryStub(env)
      .fetch("https://name-registry.internal/lookup", { method: "POST", body: JSON.stringify({ name: "status" }) })
      .then((res) => res.ok)
      .catch(() => false),
    env.WALLET_BACKUPS.head("status-probe")
      .then(() => true)
      .catch(() => false),
    relayHealthy(env).catch(() => false),
  ]);
  const report = buildStatusReport(
    { ledger: env.BARKD_URL ? ledger : null, relay, pushConfigured: !!env.VAPID_PRIVATE_KEY, names, backups },
    Date.now(),
  );
  if (!(await sendStatusReport(env.STATUS_REPORT_KEY, report))) console.error("reportStatus: status Worker did not take the report");
}

// Fire-and-forget ping to an external dead-man's-switch (healthchecks.io or
// compatible): the service alerts a human when a ping doesn't arrive within
// its configured grace period — no alert-sending code needed on this side.
// Deliberately never throws: a failed ping (the monitoring service itself
// being unreachable) must not be mistaken for, or interfere with, anything
// else in this Worker.
async function pingHealthcheck(env: Env, suffix = ""): Promise<void> {
  if (!env.HEALTHCHECK_PING_URL) return;
  try {
    await fetch(env.HEALTHCHECK_PING_URL + suffix);
  } catch {
    // Nothing more to do — see the comment above.
  }
}

// Android's installed-PWA ("WebAPK") status bar reads its background from
// this static file, baked into the native shell at install time — unlike a
// regular browser tab, it does NOT react to the page's live
// `<meta name="theme-color">` afterwards. But the app itself supports both
// a light and dark look (src/lib/ui/theme.ts), and Android separately decides
// status-bar *icon* color (light/dark content) purely from the device's
// system-wide appearance setting, not from contrast against the actual
// background — so serving one fixed color here means one of the two modes
// always gets invisible icons. Chrome sends `Sec-CH-Prefers-Color-Scheme`
// on the manifest fetch (once the document response opts in below), letting
// this pick the manifest variant that actually matches the icon color
// Android is about to choose. Must stay in sync with src/index.css's
// light/dark `--bg` and src/lib/ui/theme.ts's meta tag colors.
const DARK_THEME_COLOR = "#100e0a";

// Request headers that would make the asset layer answer 304 or 206 with no
// usable body. The dark variant is built from the whole file, so a browser
// revalidating its copy (If-None-Match) must not reach the asset layer as is:
// `response.json()` on that empty 304 threw, and every dark-mode Chrome that
// had the manifest cached got a 503.
const MANIFEST_CONDITIONAL_HEADERS = ["If-None-Match", "If-Modified-Since", "If-Match", "If-Unmodified-Since", "If-Range", "Range"];

async function handleManifest(request: Request, env: Env): Promise<Response> {
  const prefersDark = request.headers.get("Sec-CH-Prefers-Color-Scheme") === "dark";
  if (!prefersDark) return env.ASSETS.fetch(request);

  const plain = new Headers(request.headers);
  for (const h of MANIFEST_CONDITIONAL_HEADERS) plain.delete(h);
  const response = await env.ASSETS.fetch(new Request(request, { headers: plain }));
  if (!response.ok) return response;

  const manifest = (await response.json()) as Record<string, unknown>;
  manifest.theme_color = DARK_THEME_COLOR;
  manifest.background_color = DARK_THEME_COLOR;

  // The file's own validators and length describe the light file, not this body.
  const headers = new Headers(response.headers);
  for (const h of ["ETag", "Last-Modified", "Content-Length", "Content-Encoding"]) headers.delete(h);
  headers.set("Content-Type", "application/manifest+json");
  headers.set("Vary", "Sec-CH-Prefers-Color-Scheme");
  headers.set("Cache-Control", "no-cache");
  return new Response(JSON.stringify(manifest), { headers });
}

// Tap-to-pay's clock-sync ping: a bare timestamp echo so the client can
// estimate its own clock offset from the server (taps are matched on their
// clock-synced tap time, see worker/bump.ts). No same-origin check: this
// alone reveals nothing (just Date.now()). Rate-limited anyway since it's
// still a live request per call.
async function handleBumpSync(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.BUMP_POLL_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Too many requests.");
  return new Response(JSON.stringify({ serverTime: Date.now() }), {
    headers: { "content-type": "application/json" },
  });
}

const MAX_BUMP_BODY_BYTES = 2048;

// Forwards /api/bump/tap, /status, /choose, /progress and /reveal to the one
// global BumpLab Durable Object (see bump.ts). It was briefly one object per
// country; that is reverted, because two phones that are physically touching
// must pair whatever Cloudflare thinks their countries are, and separate
// objects cannot see each other at all. A global rendezvous has to live
// somewhere, so somebody is always far from it — but only the tap request's
// travel time depends on that, and it has MAX_ARRIVAL_LAG_MS (1.5s) of room.
// Matching precision does not: the clock sync it rests on is answered by this
// Worker at the edge (handleBumpSync), not by the object.
// The same-origin and rate-limit gates live here, not in the DO, so the DO
// stays a plain in-memory pairing map with no knowledge of IPs or origins.
// Cloudflare's colo/city/country for this request (request.cf) don't survive
// the internal fetch to a Durable Object, so they're read here — where the
// real client connection lands — and passed along as headers instead.
async function handleBumpForward(request: Request, env: Env, limiter: RateLimiter): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Too many requests.");

  // Capped before anything is forwarded: the one global BumpLab object parses
  // whatever arrives, so an unbounded body here is a way to stall the whole
  // feature. A real tap/choose/progress/reveal body is a few hundred bytes.
  let bodyText: string | undefined;
  if (request.method === "POST") {
    const capped = await readCappedBody(request, MAX_BUMP_BODY_BYTES);
    if (typeof capped !== "string") return capped;
    bodyText = capped;
  }

  const cf = (request as Request & { cf?: { colo?: string; city?: string; country?: string } }).cf;
  const headers = new Headers(request.headers);
  // These are this Worker's word to the DO, never the client's: strip any a
  // client sent itself, or it could claim to share a victim's network and
  // outrank their real partner (see worker/bump.ts's matchLevel).
  for (const name of ["X-Bump-Colo", "X-Bump-City", "X-Bump-Country", "X-Bump-Net", "X-Bump-Guard"]) headers.delete(name);
  // Same-network signal for pairing priority. Hashed so the DO never holds
  // a raw IP; truncated because it only needs to compare equal.
  if (ip !== "unknown") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`bump-net:${networkPrefix(ip)}`));
    headers.set(
      "X-Bump-Net",
      [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
  }
  // Who a penalty is charged to (worker/bump.ts's StrikeLedger): coarser than
  // the pairing network, since a /64 is free to rotate.
  if (ip !== "unknown") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`bump-guard:${guardPrefix(ip)}`));
    headers.set(
      "X-Bump-Guard",
      [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
  }
  if (cf?.colo) headers.set("X-Bump-Colo", cf.colo);
  if (cf?.city) headers.set("X-Bump-City", cf.city);
  if (cf?.country) headers.set("X-Bump-Country", cf.country);

  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: bodyText,
  });

  const stub = env.BUMP_LAB.get(env.BUMP_LAB.idFromName("global"));
  return stub.fetch(forwarded);
}

// GET /api/bump/stats — aggregate counters (see worker/bump.ts's
// BumpDayStats). Token-gated like the lab endpoints and deliberately not
// same-origin checked: it is read with curl, not by the app.
async function handleBumpStats(request: Request, env: Env): Promise<Response> {
  if (!env.BUMP_LAB_TOKEN) return jsonError(503, "Not configured.");
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  if (!timingSafeEqual(token, env.BUMP_LAB_TOKEN)) return jsonError(403, "Forbidden.");
  const stub = env.BUMP_LAB.get(env.BUMP_LAB.idFromName("global"));
  const res = await stub.fetch(new Request("https://bump/api/bump/stats"));
  // Not res.json(): if the object threw, the body is not JSON and parsing it
  // would replace the actual error with an opaque 500 — from the one endpoint
  // whose job is to say what is going on.
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "The object returned a non-JSON response.", status: res.status, body: text.slice(0, 500) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(body), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

async function handlePriceProxy(request: Request, url: URL, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

  if (url.pathname === "/api/price/simple") {
    const result = await fetchSimplePriceCached(env, { limiter: env.PRICE_RATE_LIMITER, key: bumpRateLimitKey(ip) });
    // Not cached by the browser: the edge copy is already up to
    // PRICE_CACHE_TTL_SECONDS old, and a browser keeping it for that long
    // again doubled the worst-case age (the client has its own cache, which
    // already waits for the next refresh, see src/lib/price.ts).
    return priceJsonResponse(result, PRICE_CACHE_TTL_SECONDS, 0);
  }

  const currency = url.searchParams.get("vs_currency") ?? "";
  const days = url.searchParams.get("days") ?? "";
  if (!ALLOWED_CURRENCIES.has(currency) || !ALLOWED_DAYS.has(days)) {
    return jsonError(400, "Invalid query parameters.");
  }
  // No `interval` param for days <= 90: CoinGecko auto-selects hourly
  // granularity there (vs. one point per day for the whole range), which is
  // what actually makes the chart's press-and-drag scrubbing useful. Above
  // 90 days it already auto-selects daily on its own, so forcing it
  // explicitly for 365 is redundant but harmless — keeps the request shape
  // obviously intentional rather than relying on undocumented default
  // behavior for the one range where it matters least.
  const interval = days === "365" ? "&interval=daily" : "";
  const target = `${COINGECKO_BASE}/coins/bitcoin/market_chart?vs_currency=${currency}&days=${days}${interval}`;
  // The shared series with the app's own price stitched on as its tail: as
  // fresh as the price shown next to it, and no CoinGecko call per request
  // (priceSeries.ts). Only when there is none yet (first minutes after a
  // deploy, cron down) does it fall through to asking CoinGecko from here.
  const shared = await sharedHistoryBody(env, currency as Currency, Number(days));
  if (shared !== null) return priceJsonResponse({ status: 200, body: shared }, 60, 60);

  // Cache key is this Worker's own path + validated query string (a small,
  // fixed key space — one entry per currency/days combination), a
  // shared edge cache. This is
  // what actually decouples the number of real CoinGecko calls from the
  // number of users: every request that lands on a warm cache entry costs
  // zero upstream calls, no matter how many different people are asking.
  const historyTtl = historyCacheTtlSeconds(days);
  const cacheKey = priceCacheKey(`/history?vs_currency=${currency}&days=${days}`);
  const result = await fetchJsonCached(
    env,
    cacheKey,
    target,
    historyTtl,
    { limiter: env.PRICE_RATE_LIMITER, key: bumpRateLimitKey(ip) },
    PRICE_HISTORY_STALE_TTL_SECONDS,
  );
  if (result.status < 200 || result.status >= 300) {
    // CoinGecko refuses too: an older shared series still beats an error.
    const old = await sharedHistoryBody(env, currency as Currency, Number(days), true);
    if (old !== null) return priceJsonResponse({ status: 200, body: old }, 60, 0);
  }
  // A stale copy (upstream failing) is never kept by the browser either.
  return priceJsonResponse(result, historyTtl, result.stale ? 0 : historyTtl);
}

// Plain byte-by-byte compare, not `a === b` — a JS string comparison
// short-circuits on the first differing byte, so its timing leaks how many
// leading bytes of a guessed secret were correct. Not constant-time in the
// strictest sense (the length check below still returns early), but that
// only leaks the secret's length, not any of its content.
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

// Cache key for the edge cache below — a fixed internal URL, not the actual
// incoming request, since every caller wants the exact same fee estimate
// (same pattern as priceCache.ts's priceCacheKey and this app's other public
// read proxies).
const FEES_CACHE_KEY = new Request("https://fees-cache.internal/recommended");
// Real fee estimates don't move meaningfully faster than blocks land
// (~10min), and the client already self-throttles to one request per 30s
// (Settings.tsx's NetworkFeesWidget) — 60s trades a small amount of that
// margin for the thing that actually matters here: collapsing however many
// callers ask within the window into at most one real upstream fetch,
// regardless of caller count.
const FEES_CACHE_TTL_SECONDS = 60;
// Concurrent misses share one upstream call (upstreamCache.ts).
const feesRequestsInFlight = new Map<string, Promise<CachedResult>>();
// How long the last good fee estimate may still be served when both mempool
// hosts fail, and how long a failure is remembered.
const FEES_STALE_TTL_SECONDS = 15 * 60;
const FEES_FAILURE_TTL_SECONDS = 15;
const FEES_FETCH_TIMEOUT_MS = 8000;

// This endpoint used to have no rate limit, no cache, and no method/origin
// restriction at all — mempool.space's own public API has no key to
// protect, so a per-caller cap felt unnecessary at the time, but that left
// upstream call volume completely unbounded: a single caller (no botnet
// needed) could fetch as fast as it wanted, and every single request
// fanned out to mempool.second.tech (this app's own paid infra, not just a
// third party) with a mempool.space fallback on top. The edge cache is what
// bounds real upstream volume independent of caller count, same as
// handlePriceProxy; PRICE_RATE_LIMITER's per-IP budget is reused (rather than
// a new binding) as a second layer, spent only on a genuine cache miss.
async function handleFeesProxy(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const result = await cachedUpstream({
    cache: caches.default,
    key: FEES_CACHE_KEY,
    ttlSeconds: FEES_CACHE_TTL_SECONDS,
    staleTtlSeconds: FEES_STALE_TTL_SECONDS,
    failureTtlSeconds: FEES_FAILURE_TTL_SECONDS,
    inFlight: feesRequestsInFlight,
    allowMiss: async () => (await env.PRICE_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) })).success,
    fetcher: async () => {
      let res: Response;
      try {
        res = await fetch(FEES_PRIMARY, { signal: upstreamSignal(FEES_FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`primary responded ${res.status}`);
      } catch {
        res = await fetch(FEES_FALLBACK, { signal: upstreamSignal(FEES_FETCH_TIMEOUT_MS) });
      }
      return { status: res.status, body: await res.text() };
    },
  });
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Last mined block for Settings' v2 fee widget: height, timestamp, tx_count
// and weight of the newest block, nothing else (the upstream list is ten full
// block objects). Same shape as handleFeesProxy: shared edge cache, per-IP
// limit only on a miss, one upstream fetch per isolate at a time.
const TIP_CACHE_KEY = new Request("https://fees-cache.internal/tip");
const TIP_CACHE_TTL_SECONDS = 30;
const tipRequestsInFlight = new Map<string, Promise<CachedResult>>();
const TIP_STALE_TTL_SECONDS = 15 * 60;
const TIP_FAILURE_TTL_SECONDS = 15;

function pickTipBlock(data: unknown): string | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const b = data[0] as Record<string, unknown>;
  const { height, timestamp, tx_count, weight } = b;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!ok(height) || !ok(timestamp) || !ok(tx_count) || !ok(weight)) return null;
  return JSON.stringify({ height, timestamp, tx_count, weight });
}

async function handleTipBlock(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const result = await cachedUpstream({
    cache: caches.default,
    key: TIP_CACHE_KEY,
    ttlSeconds: TIP_CACHE_TTL_SECONDS,
    staleTtlSeconds: TIP_STALE_TTL_SECONDS,
    failureTtlSeconds: TIP_FAILURE_TTL_SECONDS,
    inFlight: tipRequestsInFlight,
    allowMiss: async () => (await env.PRICE_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) })).success,
    fetcher: async () => {
      for (const source of [TIP_BLOCKS_PRIMARY, TIP_BLOCKS_FALLBACK]) {
        try {
          const res = await fetch(source, { signal: upstreamSignal(FEES_FETCH_TIMEOUT_MS) });
          if (!res.ok) continue;
          const body = pickTipBlock(await res.json());
          if (body) return { status: 200, body };
        } catch {
          // try the next source
        }
      }
      return { status: 502, body: JSON.stringify({ error: "Upstream block source unreachable." }) };
    },
  });
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const HEX_66 = /^[0-9a-f]{66}$/;
const HEX_210 = /^[0-9a-f]{210}$/;

// How many mailboxes a MailboxWatcher Durable Object (mailboxWatcher.ts)
// batches through one alarm firing, rather than one DO per mailbox — see
// that file's own top comment for the two different free-tier caps this
// balances (Durable Objects' ~3M requests/month vs. Cloudflare's ~50
// external-subrequests-per-invocation). 64 keeps each shard's average
// mailbox count comfortably under mailboxWatcher.ts's own BATCH_SIZE (20)
// well past this app's current scale, without needing a shard-count bump
// (and the mailbox-reassignment that would require) any time soon.
const SHARD_COUNT = 64;

// mailboxId is validated against HEX_66 before this is ever called — a
// pseudorandom pubkey-derived hex string, not attacker-chosen in any way
// that could skew shard distribution beyond what the existing per-IP
// subscribe rate limit and SUBSCRIPTION_TTL_SECONDS self-cleanup already
// bound. Hashing the leading bytes is enough for a roughly even spread;
// no real hash function is needed for that.
function shardIdFor(mailboxId: string): string {
  const n = parseInt(mailboxId.slice(0, 8), 16) % SHARD_COUNT;
  return `shard-${n}`;
}

function isShardId(shard: string): boolean {
  const m = /^shard-(\d{1,3})$/.exec(shard);
  return !!m && String(Number(m[1])) === m[1] && Number(m[1]) < SHARD_COUNT;
}

// Shard allocator: bin-packs new subscribers into the fewest active shards
// instead of shardIdFor's uniform hash spread. The hash spread means any
// subscriber base above roughly (SHARD_COUNT * ln(SHARD_COUNT)) — a couple
// hundred, at 64 shards — statistically lands at least one mailbox in nearly
// every shard, so all 64 alarms end up firing every minute (each one a
// Durable Object request) regardless of whether the actual mailbox count
// would fit in a handful of shards. Since that DO request budget (~3M/month
// on the free plan) is shared account-wide with NameRegistry and BumpLab,
// hash-spreading starves them long before the real 64*SHARD_TARGET_MAX_MAILBOXES
// subscriber ceiling is anywhere close. Packing keeps active shard count at
// ceil(subscribers / SHARD_TARGET_MAX_MAILBOXES) — the two ceilings (DO
// budget vs. per-shard capacity) end up converging near the same subscriber
// count instead of the budget one triggering ~17x earlier.
//
// A mailboxId's shard, once decided (by whichever path below), is
// remembered in KV so every later call (a renewal, an unsubscribe) goes
// straight back to it — a request is never re-packed once placed, only ever
// looked up. TTL matches SUBSCRIPTION_TTL_SECONDS and is refreshed on every
// renewal, the same pattern already used for the endpoint->mailboxId reverse
// lookup below.
const SHARD_ASSIGNMENT_KV_PREFIX = "shard-assign:";
// Where the next brand-new subscriber's search starts, so it doesn't re-probe
// already-full low-index shards from scratch every time. Plain KV get/put,
// not compare-and-swap — under concurrent new subscribes two callers can
// race to the same shard, but the DO's own SHARD_TARGET_MAX_MAILBOXES check
// is what actually enforces capacity (see mailboxWatcher.ts's handleSubscribe);
// a lost cursor race just costs an extra probe on the next call, never an
// over-full shard. No TTL: an expired cursor only means restarting the scan
// at shard-0, which self-corrects after a few wasted probes against shards
// that are already full.
const SHARD_CURSOR_KEY = "shard-cursor";

// An entry is rewritten (its TTL slides forward) when it is older than a
// quarter of its lifetime, so a subscriber who renews at all keeps it for as
// long as they stay active, at about one KV write per 10 days instead of one
// per request (see kvSliding.ts).
const KV_REFRESH_AFTER_SECONDS = SUBSCRIPTION_TTL_SECONDS / 4;

async function readShardAssignment(env: Env, mailboxId: string): Promise<SlidingRead> {
  return getSliding(env.PUSH_SUBSCRIPTIONS, `${SHARD_ASSIGNMENT_KV_PREFIX}${mailboxId}`);
}

async function rememberShardAssignment(env: Env, mailboxId: string, shardId: string): Promise<void> {
  await putSliding(env.PUSH_SUBSCRIPTIONS, `${SHARD_ASSIGNMENT_KV_PREFIX}${mailboxId}`, shardId, SUBSCRIPTION_TTL_SECONDS);
}

// Used only for the read/write paths that must find an *existing*
// subscription (unsubscribe, the daily-cap rollback) — never allocates.
// Pre-allocator subscribers have no KV assignment yet, so this falls back to
// the same hash function that originally placed them; that's exactly where
// their record still lives until their next subscribe backfills the KV
// assignment (see subscribeToAssignedShard).
async function resolveShardForLookup(env: Env, mailboxId: string): Promise<string> {
  return (await readShardAssignment(env, mailboxId)).value ?? shardIdFor(mailboxId);
}

function mailboxWatcherStub(env: Env, shardId: string) {
  return env.MAILBOX_WATCHER.get(env.MAILBOX_WATCHER.idFromName(shardId));
}

async function postSubscribe(env: Env, shardId: string, doBody: Record<string, unknown>): Promise<Response> {
  // The shard learns its own name here: it hands it to the push relay.
  return mailboxWatcherStub(env, shardId).fetch("https://mailbox-watcher.internal/subscribe", {
    method: "POST",
    body: JSON.stringify({ ...doBody, shard: shardId }),
  });
}

async function mailboxExistsInShard(env: Env, shardId: string, mailboxId: string): Promise<boolean> {
  const res = await mailboxWatcherStub(env, shardId).fetch("https://mailbox-watcher.internal/has", {
    method: "POST",
    body: JSON.stringify({ mailboxId }),
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as { exists?: boolean } | null;
  return data?.exists === true;
}

// Bounds allocateIntoPackedShard's scan, well under Cloudflare's ~50
// external-subrequests-per-invocation cap on the free plan (see
// mailboxWatcher.ts's own top comment for that number) rather than walking
// all the way to SHARD_COUNT. Near the real subscriber ceiling (all/most
// shards genuinely full), a scan that kept going shard-by-shard could itself
// spend up to SHARD_COUNT (64) subrequests in one Worker invocation and blow
// through that cap — turning a clean 429 into a hard invocation failure at
// exactly the moment capacity pressure is already the problem. Capped well
// short of 50 to leave headroom for the /has probe subscribeToAssignedShard
// may have already spent before reaching here. A scan that exhausts this
// bound without finding room returns its last 429 as-is — indistinguishable
// to the caller from "genuinely full," and self-correcting on a retry once
// SHARD_CURSOR_KEY has advanced from other calls in the meantime.
const MAX_ALLOCATION_PROBES = 30;

// Bin-packs a brand-new mailboxId into the first shard with room, starting
// from SHARD_CURSOR_KEY rather than shard-0 every time. See
// MAX_ALLOCATION_PROBES for why this doesn't scan all SHARD_COUNT shards.
async function allocateIntoPackedShard(
  env: Env,
  mailboxId: string,
  doBody: Record<string, unknown>,
): Promise<{ shardId: string; response: Response }> {
  const startRaw = await env.PUSH_SUBSCRIPTIONS.get(SHARD_CURSOR_KEY);
  const start = startRaw ? (parseInt(startRaw, 10) || 0) % SHARD_COUNT : 0;
  let lastShardId = `shard-${start}`;
  let lastResponse: Response | null = null;
  for (let i = 0; i < MAX_ALLOCATION_PROBES; i++) {
    const idx = (start + i) % SHARD_COUNT;
    const shardId = `shard-${idx}`;
    const response = await postSubscribe(env, shardId, doBody);
    if (response.status !== 429) {
      await rememberShardAssignment(env, mailboxId, shardId);
      await env.PUSH_SUBSCRIPTIONS.put(SHARD_CURSOR_KEY, String(idx));
      return { shardId, response };
    }
    lastShardId = shardId;
    lastResponse = response;
  }
  return { shardId: lastShardId, response: lastResponse! };
}

// Single entry point handlePushSubscribe uses to find (or, only for a
// genuinely new mailboxId, allocate) the shard to subscribe into. Three
// cases, checked in order: already KV-assigned (a renewal, or a
// previously-migrated pre-allocator subscriber) -> use it directly; not
// assigned but already resident in its legacy hash shard (a pre-allocator
// subscriber's first call since this shipped) -> backfill the KV assignment
// and use that shard, never bin-pack it somewhere else (see handleHas's own
// comment for why that matters); neither -> a genuinely new subscriber,
// bin-pack it.
async function subscribeToAssignedShard(
  env: Env,
  mailboxId: string,
  doBody: Record<string, unknown>,
): Promise<{ shardId: string; response: Response }> {
  const assignment = await readShardAssignment(env, mailboxId);
  const assigned = assignment.value;
  if (assigned) {
    const response = await postSubscribe(env, assigned, doBody);
    // Slide the assignment forward. It was written only when the mailbox was
    // first placed and expired 40 days later however active the subscriber
    // was; the next renewal then found no assignment, bin-packed the mailbox
    // into whichever shard the cursor pointed at, and left the old record
    // polling the same mailbox in the first shard (double load and double
    // pushes) until its own TTL ran out. An unsubscribe in that state looked
    // in the wrong shard and left the record pushing.
    // Only for a subscribe the shard accepted: a forged or invalid authorization
    // (403) must not write to KV.
    if (response.ok) {
      await touchSliding(
        env.PUSH_SUBSCRIPTIONS,
        `${SHARD_ASSIGNMENT_KV_PREFIX}${mailboxId}`,
        assigned,
        assignment,
        SUBSCRIPTION_TTL_SECONDS,
        KV_REFRESH_AFTER_SECONDS,
      );
    }
    // A renewal into its own already-assigned shard can't hit the
    // SHARD_TARGET_MAX_MAILBOXES check (that only guards a genuinely new
    // entry — see mailboxWatcher.ts's handleSubscribe), so this branch is
    // defensive rather than expected: fall through to a fresh allocation
    // rather than hand the caller a dead end if it somehow still happens.
    if (response.status !== 429) return { shardId: assigned, response };
  } else {
    const legacyShard = shardIdFor(mailboxId);
    if (await mailboxExistsInShard(env, legacyShard, mailboxId)) {
      const response = await postSubscribe(env, legacyShard, doBody);
      if (response.status !== 429) {
        await rememberShardAssignment(env, mailboxId, legacyShard);
        return { shardId: legacyShard, response };
      }
    }
  }
  return allocateIntoPackedShard(env, mailboxId, doBody);
}

const MAX_SUBSCRIBE_BODY_BYTES = 4096;

// Global (account-wide, not per-IP) daily circuit-breakers, shared machinery
// behind DAILY_NEW_SUBSCRIBE_CAP and DAILY_NEW_BACKUP_CAP below (see each for
// what it protects and why per-IP/per-key limiting alone isn't enough: both
// let a caller pick their own key freely — mailboxId, lookupKey — so a
// botnet spread across many IPs sails past a per-IP bucket while rotating
// that key every request). One counter per (prefix, UTC day), backed by a
// single KV entry rather than a Cloudflare Rate Limiting binding because
// this must span every IP, not throttle one. KV has no compare-and-swap, so
// under real concurrent abuse the count can overshoot slightly — acceptable
// for a cost circuit-breaker, not meant as a precise security boundary.
async function allowUnderDailyCap(env: Env, keyPrefix: string, cap: number): Promise<boolean> {
  // Fails open on any KV error: this is a cost circuit-breaker, not a
  // security boundary (see the comment above this function), so a KV
  // hiccup must never itself become the reason a legitimate subscribe or
  // backup request fails. Worst case on a real outage: the cap is
  // unenforced for as long as KV is down, same as if this check didn't
  // exist at all — never worse than that.
  try {
    const key = `${keyPrefix}:${new Date().toISOString().slice(0, 10)}`;
    const raw = await env.PUSH_SUBSCRIPTIONS.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    if (count >= cap) return false;
    // 2-day TTL, not 1: the key is only ever written for "today" (UTC), so a
    // shorter TTL risks the entry expiring mid-day on a slow clock skew and
    // silently resetting the count early — harmless either way since this is
    // a soft cap, but there's no reason to cut it close.
    await env.PUSH_SUBSCRIPTIONS.put(key, String(count + 1), { expirationTtl: 2 * 24 * 60 * 60 });
    return true;
  } catch (err) {
    console.error("allowUnderDailyCap KV error, failing open", err);
    return true;
  }
}

// The global daily cap for something only a NEW wallet does (first backup, first
// push subscription) plus a per-source one in front of it. Global alone let one
// source spend the whole day's budget with throwaway keys (200 new backups,
// 500 subscriptions) and turn every genuinely new wallet away until midnight
// UTC. The per-source count is read first, so a source over its share does not
// draw from the global budget at all; it is an IPv4 address or an IPv6 /48
// (guardPrefix). Sized generously: a mobile carrier's CGNAT puts thousands of
// phones behind one IPv4, and turning a genuinely new wallet away costs it its
// first backup. It bounds one source to a fraction of the global budget (200 and
// 500), it is not meant to catch a household.
async function allowNewUnderCaps(
  env: Env,
  request: Request,
  name: string,
  globalCap: number,
  perSourceCap: number,
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const sourceKey = ip === "unknown" ? null : `${name}-src:${await sha256Hex(guardPrefix(ip))}:${utcDay()}`;
  if (sourceKey !== null && (await dailyCount(env, sourceKey)) >= perSourceCap) return false;
  if (!(await allowUnderDailyCap(env, `${name}-cap`, globalCap))) return false;
  if (sourceKey !== null) await bumpDailyCount(env, sourceKey);
  return true;
}

// Caps genuinely *new* mailboxId/endpoint pairs handlePushSubscribe accepts
// (only counted once the DO has verified mailboxAuthorization against the
// real Ark server and actually stored the record — see isNewPair's own
// comment). A renewal from an already-subscribed browser (its endpoint
// already mapped to this exact mailboxId) never counts against this, so
// normal use (mount/unlock, 30s-debounced balance change) never gets near
// it. Before mailboxAuthorization was verified, this endpoint let an
// attacker register unlimited mailboxIds for free, each one a Durable Object
// with its own perpetual 60s alarm (see mailboxWatcher.ts) — now doing that
// requires an authorization the real Ark server actually accepts, which is
// far more expensive to mint at volume. 500/day is comfortably above any
// realistic organic growth rate for this app today.
const DAILY_NEW_SUBSCRIBE_CAP = 500;
const DAILY_NEW_SUBSCRIBE_CAP_PER_SOURCE = 40;

// Shared by every endpoint that has no legitimate cross-origin caller —
// without this, any site could POST arbitrary junk (or, for /api/push/*, a
// legitimate authorization it doesn't own) into this Worker cross-origin.
//
// Every legitimate caller is this app's own page hitting fetch()/XHR, and
// all current browsers attach Sec-Fetch-Site (and an Origin) to those. This
// stops OTHER WEBSITES (a browser will not let a page forge these headers),
// and it is all it stops: curl sets `Sec-Fetch-Site: same-origin` as easily
// as any other header. So the /api/backup/* store, keyed only by a
// caller-chosen lookupKey, remains a read/write dead drop for anyone with a
// terminal. That is why the wallet worker's network guard refuses every
// same-origin write (walletWorkerGuard.ts); the page's own guard cannot.
function checkSameOrigin(request: Request): Response | null {
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  if (secFetchSite !== null) {
    if (secFetchSite !== "same-origin") return jsonError(403, "Cross-origin request rejected.");
    return null;
  }
  const origin = request.headers.get("Origin");
  if (origin === null || origin !== new URL(request.url).origin) {
    return jsonError(403, "Cross-origin request rejected.");
  }
  return null;
}

// Reads and size-caps a request body as text; the stream is cut off at the cap
// (requestGuard.ts), so a body with no or a forged Content-Length costs no more
// than maxBytes.
async function readCappedBody(request: Request, maxBytes: number): Promise<string | Response> {
  const result = await readBodyCapped(request, maxBytes);
  if (result.ok) return result.text;
  return jsonError(result.status, result.status === 413 ? "Body too large." : "Invalid body.");
}

// Android App Links (Digital Asset Links): lets the separate Android app
// (spendrr-android, package app.spendrr.wallet) open spendrr.app/@name, /g and
// /r links directly instead of in a browser. Android checks that this file
// names the package and the SHA-256 of the certificate the APK is signed with.
// Public by design; changing the app's signing key means changing this.
const ANDROID_APP_PACKAGE = "app.spendrr.wallet";
const ANDROID_APP_CERT_SHA256 =
  "24:82:A8:E3:D4:A0:9C:6A:F8:AD:C0:DA:93:46:B4:0B:AC:C7:32:55:C6:99:9D:E1:9A:75:75:32:DD:7B:A4:08";
// The native Kotlin app (spendrr-android-kotlin, package app.spendrr.kotlin), signed with its own release key
// (~/.spendrr-kotlin/release.jks). Both apps are listed, so either opens these links.
const ANDROID_KOTLIN_APP_PACKAGE = "app.spendrr.kotlin";
const ANDROID_KOTLIN_APP_CERT_SHA256 =
  "09:97:F3:56:93:0C:70:31:A8:D5:EB:01:A1:FC:59:A0:91:FE:77:AB:A8:A9:35:74:28:66:D7:03:50:62:E5:3B";

function handleAssetLinks(): Response {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_APP_PACKAGE,
        sha256_cert_fingerprints: [ANDROID_APP_CERT_SHA256],
      },
    },
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_KOTLIN_APP_PACKAGE,
        sha256_cert_fingerprints: [ANDROID_KOTLIN_APP_CERT_SHA256],
      },
    },
  ];
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}

async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // Per-IP cap on PUSH_RATE_LIMITER (shared by the three push endpoints). This endpoint had none: a
  // caller could register unlimited distinct mailboxIds, each one a Durable
  // Object that actively re-fires its own alarm forever — a slow but
  // unbounded way to keep spending real subrequests indefinitely (bounded
  // only by SUBSCRIPTION_TTL_SECONDS eventually kicking in). A legitimate
  // client posts here only on mount/unlock and on a 30s-debounced balance
  // change, so 20/min is far above real use.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.PUSH_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  const bodyText = await readCappedBody(request, MAX_SUBSCRIBE_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "Invalid body.");
  const { mailboxId, mailboxAuthorization, subscription, fcmToken, firstExpiringVtxoBlockheight, priceUsd, heightToken } =
    body as Record<string, unknown>;
  if (typeof mailboxId !== "string" || !HEX_66.test(mailboxId)) {
    return jsonError(400, "Invalid mailboxId.");
  }
  if (typeof mailboxAuthorization !== "string" || !HEX_210.test(mailboxAuthorization)) {
    return jsonError(400, "Invalid mailboxAuthorization.");
  }
  // Both optional and best-effort — unlike mailboxId/mailboxAuthorization
  // above, an invalid value here must NOT reject the whole request: this
  // same endpoint also carries the mailboxAuthorization renewal the
  // pre-existing payment-push feature depends on to survive its 24h expiry,
  // and that renewal must keep working even if something about the newer
  // expiry-nudge fields is malformed (a future SDK edge case, a bug here).
  // An out-of-range/malformed value is simply treated as "not provided".
  //
  // firstExpiringVtxoBlockheight is tri-state, not just present/absent:
  //   - a valid number: the client's current soonest-expiry watch point.
  //   - explicit `null`: the client successfully checked and the wallet now
  //     has zero VTXOs — clear any previously-watched height.
  //   - absent/malformed (undefined here): the client couldn't tell (a
  //     transient SDK-call failure) — preserve whatever was last known.
  // Collapsing "genuinely zero VTXOs" into the same "absent" bucket as "don't
  // know" was a real bug: the server kept watching a stale, possibly
  // long-spent VTXO's blockheight forever and could send a nudge for funds
  // that no longer exist. The client (src/lib/notifications.ts) sends `null`
  // precisely to distinguish that case.
  const validFirstExpiringVtxoBlockheight: number | null | undefined =
    firstExpiringVtxoBlockheight === null
      ? null
      : typeof firstExpiringVtxoBlockheight === "number" &&
          Number.isInteger(firstExpiringVtxoBlockheight) &&
          firstExpiringVtxoBlockheight > 0 &&
          firstExpiringVtxoBlockheight <= MAX_PLAUSIBLE_BLOCKHEIGHT
        ? firstExpiringVtxoBlockheight
        : undefined;
  const validPriceUsd =
    typeof priceUsd === "number" && Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : undefined;
  // The Android app (spendrr-android) sends an FCM registration token instead
  // of a Web Push subscription. It is stored the same way, under the endpoint
  // `fcm:<token>` with empty keys (see fcm.ts), so everything below (renewal
  // detection, the reverse lookup, unsubscribe, the per-shard caps) works
  // unchanged.
  let endpoint: unknown;
  let p256dh: unknown;
  let auth: unknown;
  if (fcmToken !== undefined) {
    if (!isValidFcmToken(fcmToken)) return jsonError(400, "Invalid fcmToken.");
    endpoint = `${FCM_ENDPOINT_PREFIX}${fcmToken}`;
    p256dh = "";
    auth = "";
  } else {
    endpoint = (subscription as { endpoint?: unknown } | null)?.endpoint;
    p256dh = (subscription as { keys?: { p256dh?: unknown } } | null)?.keys?.p256dh;
    auth = (subscription as { keys?: { auth?: unknown } } | null)?.keys?.auth;
  }
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    return jsonError(400, "Invalid subscription.");
  }
  if (!isKnownPushEndpoint(endpoint)) {
    // Logged, not silent — see PUSH_ENDPOINT_HOSTS: a real browser landing
    // here means that list needs a host adding, and there is no other signal
    // that would tell us.
    console.error("rejected push endpoint host", endpoint);
    return jsonError(400, "Unrecognized push endpoint.");
  }

  // A renewal (same browser re-posting on mount/unlock or a balance change —
  // its endpoint already maps to this exact mailboxId) never counts against
  // DAILY_NEW_SUBSCRIBE_CAP; only a genuinely new pair does. See that
  // constant's own comment for why this exists at all (per-IP limiting above
  // doesn't bound a botnet spread across many IPs). Checked *after* the DO
  // call below succeeds, not before — mailboxAuthorization is now verified
  // against the real Ark server there (see verifyMailboxAuthorization), so
  // charging this budget for a request that was never going to be accepted
  // would let an attacker who can't pass that check still exhaust the shared
  // daily allowance for real new subscribers with nothing but rejected junk.
  const endpointMapping = await getSliding(env.PUSH_SUBSCRIPTIONS, `endpoint:${endpoint}`);
  const isNewPair = endpointMapping.value !== mailboxId;

  // The actual record merge (preserving checkpoint/dedup markers against
  // whatever this mailbox's Durable Object already has stored) now happens
  // inside the DO itself — see mailboxWatcher.ts's handleSubscribe, which
  // mirrors this same tri-state firstExpiringVtxoBlockheight handling
  // against its own storage instead of a shared KV record. Presence-vs-
  // absence of the key must survive the trip, not just its value — a bare
  // `undefined` gets dropped by JSON.stringify, so it's only included when
  // actually provided as a request field (see validFirstExpiringVtxoBlockheight's
  // own tri-state comment above for why "not sent" and "explicit null" mean
  // different things).
  const doBody: Record<string, unknown> = {
    mailboxId,
    mailboxAuthorization,
    subscription: { endpoint, keys: { p256dh, auth } },
  };
  if (validPriceUsd !== undefined) doBody.priceUsd = validPriceUsd;
  // Optional and best-effort like the fields above: a malformed token just
  // isn't stored. Only the hash leaves this function (pushHeight.ts).
  if (typeof heightToken === "string" && HEIGHT_TOKEN_RE.test(heightToken)) {
    doBody.heightTokenHash = await hashHeightToken(heightToken);
  }
  if (firstExpiringVtxoBlockheight !== undefined) {
    doBody.firstExpiringVtxoBlockheight = validFirstExpiringVtxoBlockheight ?? null;
  }
  const { shardId, response: doResponse } = await subscribeToAssignedShard(env, mailboxId, doBody);
  if (!doResponse.ok) {
    // 403 (verifyMailboxAuthorization failed) and 429 (every shard at
    // SHARD_TARGET_MAX_MAILBOXES — subscribeToAssignedShard already tried
    // all SHARD_COUNT of them) are meaningful, not-worth-retrying-immediately
    // outcomes — forwarded as-is rather than flattened into a generic 502,
    // which used to make a genuinely invalid authorization look like a
    // transient failure.
    if (doResponse.status === 403) return jsonError(403, "Invalid mailbox authorization.");
    if (doResponse.status === 429) return jsonError(429, "Shard capacity reached — try again later.");
    return jsonError(502, "Failed to store subscription.");
  }

  // Only reachable once the DO has actually verified+stored this pair — see
  // isNewPair's own comment above. A cap hit here means the subscription was
  // just written for a *new* mailboxId; undo it rather than leave a stored
  // record the caller was told to treat as rejected.
  if (isNewPair && !(await allowNewUnderCaps(env, request, "subscribe", DAILY_NEW_SUBSCRIBE_CAP, DAILY_NEW_SUBSCRIBE_CAP_PER_SOURCE))) {
    await mailboxWatcherStub(env, shardId).fetch("https://mailbox-watcher.internal/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ mailboxId, endpoint }),
    });
    return jsonError(429, "Daily subscription limit reached — try again tomorrow.");
  }

  // The client only knows its own push endpoint at disable time, never this
  // mailboxId (see notifications.ts's disableNotifications) — this reverse
  // lookup is what lets handlePushUnsubscribe find the right Durable Object
  // without a global list to walk. Refreshed on every subscribe (not just
  // new ones) so its TTL keeps sliding forward the same way the old record's
  // did, and so it stays correct if the endpoint ever changes for the same
  // mailboxId (a re-enable from a different browser).
  //
  // Written only when the mapping is new or old (kvSliding.ts): a KV write per
  // subscribe call made the Free plan's 1,000 writes a day the ceiling on push
  // users.
  await touchSliding(
    env.PUSH_SUBSCRIPTIONS,
    `endpoint:${endpoint}`,
    mailboxId,
    endpointMapping,
    SUBSCRIPTION_TTL_SECONDS,
    KV_REFRESH_AFTER_SECONDS,
  );
  // 202: stored, but the push relay did not take the registration (the
  // shard's handleSubscribe). The app sends the next subscribe again.
  return new Response(null, { status: doResponse.status === 202 ? 202 : 204 });
}

// Moves the watched height of an existing subscription without the Ark
// server, proven by the height token a verified subscribe stored. See
// pushHeight.ts (external audit 2026-09-27, N1). Same origin check and
// per-IP budget as unsubscribe; it can't create a record, only update one.
async function handlePushHeight(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.PUSH_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  const bodyText = await readCappedBody(request, MAX_SUBSCRIBE_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const { mailboxId, heightToken, firstExpiringVtxoBlockheight } = (body ?? {}) as Record<string, unknown>;
  if (typeof mailboxId !== "string" || !HEX_66.test(mailboxId)) return jsonError(400, "Invalid mailboxId.");
  if (typeof heightToken !== "string" || !HEIGHT_TOKEN_RE.test(heightToken)) return jsonError(400, "Invalid heightToken.");
  const height =
    firstExpiringVtxoBlockheight === null
      ? null
      : typeof firstExpiringVtxoBlockheight === "number" &&
          Number.isInteger(firstExpiringVtxoBlockheight) &&
          firstExpiringVtxoBlockheight > 0 &&
          firstExpiringVtxoBlockheight <= MAX_PLAUSIBLE_BLOCKHEIGHT
        ? firstExpiringVtxoBlockheight
        : undefined;
  if (height === undefined) return jsonError(400, "Invalid firstExpiringVtxoBlockheight.");

  const shardId = await resolveShardForLookup(env, mailboxId);
  const res = await mailboxWatcherStub(env, shardId).fetch("https://mailbox-watcher.internal/height", {
    method: "POST",
    body: JSON.stringify({ mailboxId, heightTokenHash: await hashHeightToken(heightToken), height }),
  });
  if (res.status === 204) return new Response(null, { status: 204 });
  // 403 and 404 look the same from outside: no probing which mailboxes exist.
  if (res.status === 403 || res.status === 404) return jsonError(403, "Not allowed.");
  return jsonError(502, "Failed to update.");
}

// The payment push relay's pokes (pushRelay.ts): signed lists of mailboxes
// where a payment just landed. Grouped by shard, one Durable Object request
// per shard; each shard reads those mailboxes itself. Server to server, so no
// origin check: the signature is the gate, checked before anything else
// costs a lookup.
const MAX_PUSH_HOOK_BODY_BYTES = 40_000;

async function handlePushHook(request: Request, env: Env): Promise<Response> {
  const bodyText = await readCappedBody(request, MAX_PUSH_HOOK_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  const byShard = await verifyHook(env, request.headers.get("x-relay-timestamp"), request.headers.get("x-relay-signature"), bodyText);
  if (!byShard) return jsonError(403, "Not allowed.");
  // Each shard checks only ids it carries itself, so a wrong shard costs one
  // wasted DO request, never a push. A failed poke answers 503: the relay
  // retries it and reports itself unhealthy, which puts the shards back on
  // the minute sweep.
  const results = await Promise.all(
    [...byShard].map(async ([shard, ids]) => {
      if (!isShardId(shard)) return true;
      try {
        const res = await mailboxWatcherStub(env, shard).fetch("https://mailbox-watcher.internal/poke", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });
        return res.ok;
      } catch (e) {
        console.error("push hook: shard poke failed", shard, e instanceof Error ? e.message : e);
        return false;
      }
    }),
  );
  return new Response(null, { status: results.every(Boolean) ? 204 : 503 });
}

// Money chat push (worker/chatPush.ts, docs/chat-push-design.md). Tokens: one
// sealed token per slot for the caller's own push subscription. Nothing is
// stored and nothing is proven beyond the shape: a token only ever reaches the
// subscription it was made for, and pushes to it are capped per slot.
const MAX_CHAT_TOKENS_BODY_BYTES = 8192;
const MAX_CHAT_POKE_BODY_BYTES = 3072;

async function handleChatPushTokens(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.PUSH_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");
  if (!hasSealKey(env.CHAT_PUSH_SEAL_KEY)) return jsonError(503, "Chat push not configured.");
  const bodyText = await readCappedBody(request, MAX_CHAT_TOKENS_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const { subscription, fcmToken, slots } = (body ?? {}) as Record<string, unknown>;
  const target = parseTarget(subscription, fcmToken);
  if (!target) return jsonError(400, "Invalid subscription.");
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > MAX_SLOTS_PER_REQUEST) return jsonError(400, "Invalid slots.");
  if (!slots.every(isSlot) || new Set(slots).size !== slots.length) return jsonError(400, "Invalid slots.");
  const tokens = await Promise.all(slots.map((slot) => sealToken(env.CHAT_PUSH_SEAL_KEY, target, slot)));
  return new Response(JSON.stringify({ tokens }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// One push for one token. 410 tells the sender to drop the token and ask the
// recipient for a new one (unknown, too old, or the subscription is gone).
async function handleChatPoke(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.CHAT_POKE_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");
  if (!hasSealKey(env.CHAT_PUSH_SEAL_KEY)) return jsonError(503, "Chat push not configured.");
  const bodyText = await readCappedBody(request, MAX_CHAT_POKE_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const { token, blob } = (body ?? {}) as Record<string, unknown>;
  if (!isBlob(blob)) return jsonError(400, "Invalid blob.");
  const opened = await openToken(env.CHAT_PUSH_SEAL_KEY, token);
  if (!opened) return jsonError(410, "Token not valid.");
  const slotLimit = await env.CHAT_POKE_SLOT_RATE_LIMITER.limit({ key: opened.slot });
  if (!slotLimit.success) return jsonError(429, "Rate limit exceeded.");
  const result = await sendChatPush(env, opened, blob);
  if (result === "sent") return new Response(null, { status: 204 });
  if (result === "gone") return jsonError(410, "Subscription gone.");
  return jsonError(502, "Push failed.");
}

async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
  // This was the one /api/* POST with none of the checks every other one
  // has. That mattered more than "someone could unsubscribe a stranger's
  // endpoint": the reverse-lookup KV read below is uncapped and callable
  // cross-origin from any page, so a loop of these could burn the daily KV
  // read quota with no origin check at all.
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  // PUSH_RATE_LIMITER's per-IP budget, shared with subscribe and height:
  // unsubscribe is a one-shot user action, and notifications.ts already treats a failed unsubscribe as
  // best-effort — the worst case is a stale endpoint mapping that just ages
  // out via its own expirationTtl.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.PUSH_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  const bodyText = await readCappedBody(request, MAX_SUBSCRIBE_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== "string") return jsonError(400, "Invalid endpoint.");

  // The client only knows its own push endpoint at disable time, never the
  // mailboxId itself (see notifications.ts) — this reverse lookup (written
  // in handlePushSubscribe) is what finds the right Durable Object without a
  // global list to walk. Already-gone is a normal, silent no-op: the mapping
  // may have expired, or already been used once.
  const mailboxId = await env.PUSH_SUBSCRIPTIONS.get(`endpoint:${endpoint}`);
  if (mailboxId) {
    // A lookup, never an allocation — see resolveShardForLookup's own
    // comment for why a missing KV assignment falls back to the legacy hash
    // shard instead of bin-packing (there's nothing to pack here, only an
    // existing record to find).
    const shardId = await resolveShardForLookup(env, mailboxId);
    // The DO itself re-checks that its *currently stored* endpoint still
    // matches before deleting anything — see mailboxWatcher.ts's
    // handleUnsubscribe for why (a stale request from an old browser session
    // must never wipe out a newer subscription for the same mailboxId).
    await mailboxWatcherStub(env, shardId).fetch("https://mailbox-watcher.internal/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ mailboxId, endpoint }),
    });
    await env.PUSH_SUBSCRIPTIONS.delete(`endpoint:${endpoint}`);
  }
  return new Response(null, { status: 204 });
}

// Full-state wallet backups (see ARCHITECTURE.md's backup section). This Worker
// never sees a mnemonic or plaintext balance/history — `lookupKey` and the
// AES-GCM key are both derived client-side from the mnemonic via HKDF with
// distinct info strings (src/lib/backup/backupCrypto.ts), so the server can never
// compute one from the other. Upload is two-phase (upload-tmp, then commit)
// so a partial/corrupt upload can never clobber the last good backup: the
// client uploads to a tmp object, downloads it back, decrypts and verifies
// the plaintext hash itself, and only then calls commit to promote tmp to
// the real key. Commit also carries an optimistic-concurrency version check
// (backupVersion.ts) — the two-phase upload alone only proves the uploaded
// blob is internally consistent, not that it's newer than what's already
// committed, which matters once the same mnemonic can be open on more than
// one device (see handleBackupCommit's own comment for the exact scenario
// this closes).
const LOOKUP_KEY_RE = /^[0-9a-f]{64}$/;
const IV_HEX_RE = /^[0-9a-f]{24}$/; // 12-byte AES-GCM IV
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// A full IndexedDB dump for a real wallet is expected to stay well under a
// few MB even with a long history — this ceiling is generous headroom for
// growth while still bounding the abuse surface (a single request body this
// Worker will ever buffer in memory).
const MAX_BACKUP_BODY_BYTES = 20 * 1024 * 1024;

// Global daily cap on brand-new lookupKeys handleBackupUploadTmp accepts —
// see the isKnownLookupKey check there for what this protects against and
// why the per-IP/per-lookupKey limiters alone don't cover it. Sized against
// the worst case, not the typical one: every one of the 200 slots maxed out
// at MAX_BACKUP_BODY_BYTES is 4GB, comfortably under R2's 10GB free-tier
// storage ceiling with room for real backups alongside it, while staying far
// above this app's actual pace of new wallets (41 backups total as of
// 2026-09-14).
const DAILY_NEW_BACKUP_CAP = 200;
const DAILY_NEW_BACKUP_CAP_PER_SOURCE = 30;

// A `.tmp`-suffixed key (`${lookupKey}.tmp`) used to be indistinguishable
// from a real committed backup (`lookupKey`, bare) by anything other than
// string comparison — R2's lifecycle-rule API can only filter by key
// *prefix*, never by suffix, so there was no way to point an auto-expiry
// rule at "every tmp object" without it also matching every real backup
// (a `.tmp`-suffixed key still starts with its own `lookupKey`, and so does
// the bare committed key it's paired with, at that same prefix). Every tmp
// object thus lived until a matching commit deleted it — nothing did for one
// that was never committed (an abandoned/abusive upload-tmp, or a client
// that crashed between upload-tmp and commit) — see handleBackupUploadTmp's
// own comment for the unbounded-R2-storage cost that left open.
//
// A dedicated `tmp/` prefix makes tmp objects a disjoint key space from real
// backups (which stay bare `lookupKey`, no prefix), so a lifecycle rule
// scoped to exactly that prefix (`wrangler r2 bucket lifecycle add
// btc-wallet-backups expire-tmp-uploads tmp/ --expire-days 1`, a one-time
// bucket-level setup step, not something this Worker's own code runs) can
// safely auto-delete anything under it without ever being able to touch a
// real committed backup. One day is generous headroom over the seconds a
// legitimate client actually needs between upload-tmp and commit (fetch the
// tmp object back, decrypt, hash-verify, then commit).
// Bucket for the per-wallet write limiter. A lookupKey is public by design, so
// keying the bucket by it alone let anyone who knew a victim's key send
// well-formed requests with a made-up token and keep the victim's own uploads
// at 429. The write token is derived from the seed, so mixing it in gives an
// outsider a bucket of their own. Hashed: the token never reaches the limiter.
async function backupKeyBucket(lookupKey: string, writeToken: string): Promise<string> {
  return `k:${await hashWriteToken(`${lookupKey}:${writeToken}`)}`;
}

function tmpKeyFor(lookupKey: string): string {
  return `tmp/${lookupKey}`;
}

async function handleBackupUploadTmp(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // The per-IP bucket is charged BEFORE the body is read: this endpoint takes
  // up to 20MB, and reading, parsing and regex-checking that is the expensive
  // part. Behind the limiter, a flood of oversized or malformed uploads is
  // refused for the price of a header check instead of a full body each.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.BACKUP_RATE_LIMITER.limit({ key: `ip:${bumpRateLimitKey(ip)}` })).success) {
    return jsonError(429, "Rate limit exceeded.");
  }

  const bodyText = await readCappedBody(request, MAX_BACKUP_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "Invalid body.");
  const { lookupKey, writeToken, iv, ciphertext, sha256 } = body as Record<string, unknown>;
  if (typeof lookupKey !== "string" || !LOOKUP_KEY_RE.test(lookupKey)) {
    return jsonError(400, "Invalid lookupKey.");
  }
  // Required on every write (see backupAuth.ts).
  if (typeof writeToken !== "string" || !WRITE_TOKEN_RE.test(writeToken)) {
    return jsonError(400, "Invalid writeToken.");
  }
  if (typeof iv !== "string" || !IV_HEX_RE.test(iv)) return jsonError(400, "Invalid iv.");
  if (typeof ciphertext !== "string" || !isCanonicalBase64(ciphertext)) {
    return jsonError(400, "Invalid ciphertext.");
  }
  if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) return jsonError(400, "Invalid sha256.");

  // Two buckets on the same limiter. The per-lookupKey one bounds a single
  // wallet re-uploading in a loop; the per-IP one is the load-bearing check,
  // because lookupKey is a 64-hex value the caller picks freely — rotating it
  // every request makes the per-key limit alone a no-op while each request
  // still writes an up-to-20MB tmp object into R2 (deleted by a matching
  // commit — never committed at all, it just sits there until the tmp/*
  // lifecycle rule ages it out, see tmpKeyFor's own comment). The `ip:`
  // prefix keeps this bucket clear of the 64-hex lookupKey namespace.
  if (!(await env.BACKUP_RATE_LIMITER.limit({ key: await backupKeyBucket(lookupKey, writeToken) })).success) {
    return jsonError(429, "Rate limit exceeded.");
  }

  // The per-IP check (charged before the body was read) is still a
  // single-attacker throttle, not a botnet one — a caller spread across many IPs, each minting a fresh
  // lookupKey per request, sails past both BACKUP_RATE_LIMITER buckets
  // while still writing up to MAX_BACKUP_BODY_BYTES (20MB) here every time.
  // DAILY_NEW_BACKUP_CAP is the actual backstop for that: a lookupKey with
  // an existing committed backup is an already-known wallet re-uploading
  // (never counted against the cap, however often it happens — that's what
  // the per-key limiter above already governs); only a lookupKey never seen
  // before — a brand-new wallet, or an attacker's freshly-minted one — draws
  // from the shared daily budget.
  // Fails CLOSED on error: the same head() now also carries the write-token
  // hash this upload must match, and an upload we could not authorize must
  // not happen. It used to fail open (the cap alone is only a cost control);
  // a transient R2 error now costs one failed upload cycle, which the client
  // records and retries on its next trigger.
  let existing: R2Object | null;
  try {
    existing = await env.WALLET_BACKUPS.head(lookupKey);
  } catch (err) {
    console.error("backup lookupKey head() failed", err);
    return jsonError(503, "Backup storage unavailable.");
  }
  const writeTokenHash = await hashWriteToken(writeToken);
  if (checkWriteToken(existing?.customMetadata?.writeTokenHash, writeTokenHash) === "forbidden") {
    return jsonError(403, "Write token rejected.");
  }
  if (existing === null && !(await allowNewUnderCaps(env, request, "backup", DAILY_NEW_BACKUP_CAP, DAILY_NEW_BACKUP_CAP_PER_SOURCE))) {
    return jsonError(429, "Daily new-backup limit reached — try again tomorrow.");
  }

  await env.WALLET_BACKUPS.put(tmpKeyFor(lookupKey), ciphertext, {
    customMetadata: { iv, sha256, writeTokenHash, updatedAt: String(Date.now()) },
  });
  return new Response(null, { status: 204 });
}

// Same fields as readLookupKeyBody plus the sha256 the client hash-verified
// the tmp object against right before calling commit — see
// handleBackupCommit's own comment for why this can't just reuse
// readLookupKeyBody as-is. `baseVersion` is the server version the client
// believed was current when it started this upload cycle (0 = "never
// synced against a real backup") — see backupVersion.ts's
// resolveCommitVersion for what this feeds into and why.
async function readCommitBody(
  request: Request,
): Promise<{ lookupKey: string; writeToken: string; sha256: string; baseVersion: number } | Response> {
  const bodyText = await readCappedBody(request, 4096);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const { lookupKey, writeToken, sha256, baseVersion } = (body as Record<string, unknown> | null) ?? {};
  if (typeof lookupKey !== "string" || !LOOKUP_KEY_RE.test(lookupKey)) {
    return jsonError(400, "Invalid lookupKey.");
  }
  if (typeof writeToken !== "string" || !WRITE_TOKEN_RE.test(writeToken)) {
    return jsonError(400, "Invalid writeToken.");
  }
  if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) {
    return jsonError(400, "Invalid sha256.");
  }
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return jsonError(400, "Invalid baseVersion.");
  }
  return { lookupKey, writeToken, sha256, baseVersion };
}

async function handleBackupCommit(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const parsed = await readCommitBody(request);
  if (parsed instanceof Response) return parsed;
  const { lookupKey, writeToken, sha256, baseVersion } = parsed;

  // Same two-bucket check as handleBackupUploadTmp — see its comment.
  if (!(await env.BACKUP_RATE_LIMITER.limit({ key: await backupKeyBucket(lookupKey, writeToken) })).success) {
    return jsonError(429, "Rate limit exceeded.");
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.BACKUP_RATE_LIMITER.limit({ key: `ip:${bumpRateLimitKey(ip)}` })).success) {
    return jsonError(429, "Rate limit exceeded.");
  }

  // Never called speculatively by a correct client — the client only commits
  // after it has already downloaded and hash-verified the tmp object. A
  // missing tmp object here means something raced or expired; the client's
  // response is to retry the whole upload from scratch, not to assume commit
  // succeeded.
  const tmp = await env.WALLET_BACKUPS.get(tmpKeyFor(lookupKey));
  if (!tmp) return jsonError(404, "No pending upload to commit.");
  // The two-phase design's whole point is that a partial/corrupt upload can
  // never clobber the last good backup — the client only ever calls commit
  // after downloading the tmp object back and hash-verifying it. But without
  // this check, commit blindly promotes whatever currently sits at the tmp
  // key, not necessarily the bytes the client actually verified: a second
  // upload-tmp (a concurrent device, a retry racing this one) landing
  // between that verify and this commit overwrites the tmp object first, and
  // this call would then promote THAT unverified content instead — silently
  // defeating the integrity guarantee the two-phase flow exists to provide.
  // Comparing against the sha256 recorded at upload-tmp time (customMetadata,
  // set once and never touched again until commit or the next upload-tmp
  // overwrites it) catches exactly that race: a mismatch means the tmp
  // object changed underneath this commit, so refuse rather than promote it.
  if (tmp.customMetadata?.sha256 !== sha256) {
    return jsonError(409, "Tmp object changed since it was verified — retry the upload.");
  }
  // The tmp object must have been uploaded with this same token (a tmp
  // without one predates tokens and is never promoted), and the committed
  // backup, if it has a token recorded, must match it too (backupAuth.ts).
  const writeTokenHash = await hashWriteToken(writeToken);
  if (tmp.customMetadata?.writeTokenHash !== writeTokenHash) {
    return jsonError(403, "Write token rejected.");
  }

  // Optimistic-concurrency check against a silent cross-device overwrite
  // (see backupVersion.ts's own top-of-file comment for the full story): the
  // sha256 check above only protects the upload-tmp -> commit window, not
  // whether the content being committed is actually newer than what's
  // already there. A fresh head() right here — not a version learned
  // earlier in this request, and not one cached from an earlier request —
  // is what closes the TOCTOU gap between the client deciding to upload and
  // this call actually promoting it.
  const existing = await env.WALLET_BACKUPS.head(lookupKey);
  if (checkWriteToken(existing?.customMetadata?.writeTokenHash, writeTokenHash) === "forbidden") {
    return jsonError(403, "Write token rejected.");
  }
  const currentVersion = parseVersion(existing?.customMetadata?.version);
  const decision = resolveCommitVersion(currentVersion, baseVersion);
  if (decision === "conflict") {
    return jsonError(409, "Backup version conflict: a newer backup already exists — restore before uploading again.");
  }
  const nextVersion = decision;

  // Compare-and-swap on the object's etag, not just on the version read above:
  // head() and put() are two calls, and two devices committing from the same
  // base version in that gap both passed the check and the later put silently
  // replaced the earlier one. With the precondition the loser writes nothing
  // and gets the same 409 a stale base does. A first-ever backup has no etag to
  // match and is written unconditionally, as before: a create-only precondition
  // (etagDoesNotMatch "*") behaves in local R2 but has not been checked against
  // the real service, and getting it wrong would refuse every new wallet's first
  // backup, which costs far more than the narrow first-write race it would close.
  const committed = await env.WALLET_BACKUPS.put(lookupKey, tmp.body, {
    customMetadata: { ...tmp.customMetadata, writeTokenHash, version: String(nextVersion) },
    ...(existing?.etag ? { onlyIf: { etagMatches: existing.etag } } : {}),
  });
  if (committed === null) {
    return jsonError(409, "Backup version conflict: a newer backup already exists — restore before uploading again.");
  }
  await env.WALLET_BACKUPS.delete(tmpKeyFor(lookupKey));
  // The client needs the version it just committed to remember as its own
  // "known" baseline for the next upload cycle (see src/lib/backup/backup.ts's
  // setKnownVersion) — a bare 204 gave it no way to learn this without an
  // extra round trip.
  return new Response(JSON.stringify({ version: nextVersion }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// writeToken is optional here: a read is only refused when the object has a
// token recorded (checkWriteToken), so a backup from before tokens can still
// be restored by a client that sends one.
async function readLookupKeyBody(request: Request): Promise<{ lookupKey: string; writeTokenHash: string | null } | Response> {
  const bodyText = await readCappedBody(request, 4096);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const { lookupKey, writeToken } = (body as { lookupKey?: unknown; writeToken?: unknown } | null) ?? {};
  if (typeof lookupKey !== "string" || !LOOKUP_KEY_RE.test(lookupKey)) {
    return jsonError(400, "Invalid lookupKey.");
  }
  if (writeToken === undefined) return { lookupKey, writeTokenHash: null };
  if (typeof writeToken !== "string" || !WRITE_TOKEN_RE.test(writeToken)) {
    return jsonError(400, "Invalid writeToken.");
  }
  return { lookupKey, writeTokenHash: await hashWriteToken(writeToken) };
}

async function respondWithBackupObject(env: Env, r2Key: string, writeTokenHash: string | null): Promise<Response> {
  const object = await env.WALLET_BACKUPS.get(r2Key);
  // 404 is the expected, normal response for every wallet that predates this
  // feature (or has beta disabled, or has never completed a first backup) —
  // the client must treat this as "no backup, fall back to normal recovery",
  // not as an error.
  if (!object) return jsonError(404, "No backup found.");
  if (checkWriteToken(object.customMetadata?.writeTokenHash, writeTokenHash) === "forbidden") {
    // Nothing read: the body stream is simply dropped.
    return jsonError(403, "Write token rejected.");
  }
  const iv = object.customMetadata?.iv;
  if (!iv) return jsonError(500, "Corrupt backup record.");
  const ciphertext = await new Response(object.body).text();
  // Lets a successful restore (fetchAndDecryptBackup) seed the client's own
  // "known version" baseline for free, without a separate meta round trip —
  // see src/lib/backup/backup.ts's setKnownVersion call site. Meaningless on the
  // tmp object (handleBackupFetchTmp shares this function; a tmp object
  // never carries a version tag) but harmless to include there too.
  const version = parseVersion(object.customMetadata?.version);
  return new Response(JSON.stringify({ iv, ciphertext, version }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Cheap version-only lookup, used right before an upload cycle decides what
// baseVersion to commit against (see src/lib/backup/backup.ts's performUpload) —
// deliberately a head(), not the full get() respondWithBackupObject does,
// so a routine per-upload check never pays for decrypting or transferring a
// full wallet dump just to read one number.
async function handleBackupMeta(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const parsed = await readLookupKeyBody(request);
  if (parsed instanceof Response) return parsed;
  const limitError = await limitBackupRead(request, env);
  if (limitError) return limitError;
  const existing = await env.WALLET_BACKUPS.head(parsed.lookupKey);
  if (checkWriteToken(existing?.customMetadata?.writeTokenHash, parsed.writeTokenHash) === "forbidden") {
    return jsonError(403, "Write token rejected.");
  }
  const version = existing ? parseVersion(existing.customMetadata?.version) : 0;
  // sha256 of the committed plaintext, so a client whose commit reply got
  // lost can recognise the new version as its own (backup.ts's
  // adoptOwnLostCommit). A hash of ciphertext-protected content, nothing new.
  const sha256 = existing?.customMetadata?.sha256 ?? null;
  return new Response(JSON.stringify({ version, sha256 }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Per-IP only, and on a bucket of its own (BACKUP_READ_RATE_LIMITER) rather
// than the write limiter the upload path uses. Two reasons it can't share that
// bucket: a single upload cycle already spends two slots there (upload-tmp +
// commit) and would spend a third on fetch-tmp, so folding reads in would
// start 429-ing legitimate uploads; and a 429 on a *restore* fetch is not a
// harmless retry — App.tsx can't tell it apart from a corrupt backup, so it
// latches the restore-failure flag and switches uploads off. Hence a bucket
// sized so normal use (roughly one fetch per open, one meta+fetch-tmp per upload)
// stays nowhere near it.
//
// Not keyed by lookupKey at all: the caller picks that value freely, so a
// per-key bucket is trivially bypassed by rotating it, and it would add a
// second way to 429 a legitimate restore for nothing. The cost being bounded
// here is R2 egress — a response is a full encrypted wallet dump, up to
// MAX_BACKUP_BODY_BYTES — and that is per source, not per key.
async function limitBackupRead(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.BACKUP_READ_RATE_LIMITER.limit({ key: `ip:${bumpRateLimitKey(ip)}` })).success) {
    return jsonError(429, "Rate limit exceeded.");
  }
  return null;
}

async function handleBackupFetch(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const parsed = await readLookupKeyBody(request);
  if (parsed instanceof Response) return parsed;
  const limitError = await limitBackupRead(request, env);
  if (limitError) return limitError;
  return respondWithBackupObject(env, parsed.lookupKey, parsed.writeTokenHash);
}

// Lets the client read back exactly what upload-tmp just wrote, before it
// ever calls commit — the round-trip half of the upload's integrity check
// (the client decrypts this and compares against the plaintext hash it
// computed before encrypting). Same shape/response as handleBackupFetch,
// just addressing the tmp object instead of the committed one.
async function handleBackupFetchTmp(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  const parsed = await readLookupKeyBody(request);
  if (parsed instanceof Response) return parsed;
  const limitError = await limitBackupRead(request, env);
  if (limitError) return limitError;
  return respondWithBackupObject(env, tmpKeyFor(parsed.lookupKey), parsed.writeTokenHash);
}


// --- Tap-to-pay sensor recordings (Settings → Záznamník ťuknutí) ---------
// Raw motion data only: bumpRecorder.ts never sends an address or anything
// else wallet-related. Stored one object per chunk under
// v1/<session>/<device>/<chunk>.json, pulled with scripts/bump-lab-pull.mjs.
const BUMP_LAB_MAX_BYTES = 600_000;
const BUMP_LAB_ID = /^[A-Za-z0-9-]{8,40}$/;

async function handleBumpLabUpload(request: Request, env: Env): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;
  if (env.BUMP_LAB_RECORDING !== "1" || !env.BUMP_LAB_RECORDINGS) return jsonError(403, "Recording is switched off.");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.BUMP_RATE_LIMITER.limit({ key: `lab:${bumpRateLimitKey(ip)}` });
  if (!success) return jsonError(429, "Too many requests.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > BUMP_LAB_MAX_BYTES) return jsonError(413, "Too large.");
  const text = await request.text();
  if (text.length > BUMP_LAB_MAX_BYTES) return jsonError(413, "Too large.");
  let body: { kind?: unknown; sessionId?: unknown; deviceId?: unknown; chunk?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  const { kind, sessionId, deviceId, chunk } = body;
  if (typeof sessionId !== "string" || !BUMP_LAB_ID.test(sessionId)) return jsonError(400, "Bad sessionId.");
  if (typeof deviceId !== "string" || !BUMP_LAB_ID.test(deviceId)) return jsonError(400, "Bad deviceId.");
  let name: string;
  if (kind === "meta") name = "meta";
  else if (kind === "chunk" && Number.isInteger(chunk) && (chunk as number) >= 0 && (chunk as number) < 1000) {
    name = String(chunk).padStart(3, "0");
  } else return jsonError(400, "Bad kind/chunk.");
  const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf;
  await env.BUMP_LAB_RECORDINGS.put(`v1/${sessionId}/${deviceId}/${name}.json`, text, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { receivedAt: String(Date.now()), colo: cf?.colo ?? "", country: cf?.country ?? "" },
  });
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}

function bumpLabAuth(request: Request, env: Env): Response | null {
  if (!env.BUMP_LAB_TOKEN || !env.BUMP_LAB_RECORDINGS) return jsonError(503, "Not configured.");
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  if (!timingSafeEqual(token, env.BUMP_LAB_TOKEN)) return jsonError(403, "Forbidden.");
  return null;
}

async function handleBumpLabList(request: Request, env: Env): Promise<Response> {
  const authError = bumpLabAuth(request, env);
  if (authError) return authError;
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const listed = await env.BUMP_LAB_RECORDINGS!.list({ prefix: "v1/", cursor, include: ["customMetadata"] });
  return new Response(
    JSON.stringify({
      objects: listed.objects.map((o) => ({ key: o.key, size: o.size, meta: o.customMetadata ?? {} })),
      cursor: listed.truncated ? listed.cursor : null,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function handleBumpLabGet(request: Request, env: Env): Promise<Response> {
  const authError = bumpLabAuth(request, env);
  if (authError) return authError;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key.startsWith("v1/")) return jsonError(400, "Bad key.");
  const obj = await env.BUMP_LAB_RECORDINGS!.get(key);
  if (!obj) return jsonError(404, "Not found.");
  return new Response(obj.body, { headers: { "content-type": "application/json" } });
}

// ---- @handle registry (names.ts) -------------------------------------------

const MAX_NAME_BODY_BYTES = 2048;
const NAME_MAX_INPUT_CHARS = 64;

// Every write attempt whose authorization the Ark server has accepted (charged
// after the probe, see proveNameMailbox). Bounds what one caller with unlimited
// throwaway keys can register per day; same idea as DAILY_NEW_SUBSCRIBE_CAP.
const DAILY_NAME_WRITE_CAP = 1000;

// Taking a name (claim, rename, takeover) is the scarce thing, since a mailbox
// key costs nothing to make. Two daily budgets, both charged only when a name
// was actually taken (never on a refused or address-only call):
//  - account-wide, so a farm of throwaway keys can grab at most this many names
//    a day. Deliberately NOT the general write cap above: that one also counts
//    release and the weekly "mine" sign of life, which scale with users.
//  - per source (a whole IPv4 / IPv6 /48, hashed), so one caller cannot spend
//    the account-wide budget alone and lock everyone else out of registering.
// Address changes for a name a mailbox already holds are never blocked by these.
const DAILY_NAME_CLAIM_CAP = 50;
const DAILY_NAME_CLAIM_CAP_PER_SOURCE = 5;

async function dailyCount(env: Env, key: string): Promise<number> {
  try {
    const raw = await env.PUSH_SUBSCRIPTIONS.get(key);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    // Same stance as allowUnderDailyCap: a KV hiccup must not block a person.
    return 0;
  }
}

async function bumpDailyCount(env: Env, key: string): Promise<void> {
  try {
    const count = await dailyCount(env, key);
    await env.PUSH_SUBSCRIPTIONS.put(key, String(count + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  } catch (err) {
    console.error("bumpDailyCount KV error", err);
  }
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

function nameRegistryStub(env: Env) {
  return env.NAME_REGISTRY.get(env.NAME_REGISTRY.idFromName("global"));
}

async function callNameRegistry<T>(env: Env, path: string, body: unknown): Promise<T | null> {
  try {
    const res = await nameRegistryStub(env).fetch(`https://name-registry.internal${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Name lookups through the edge cache (nameLookupCache.ts). A miss is what
// costs a Durable Object request, so only a miss is charged to the stricter
// per-source limiter.
async function lookupNameCached(env: Env, request: Request, handle: string, nameForRegistry: string) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const source = bumpRateLimitKey(ip);
  return cachedNameLookup(
    caches.default,
    handle,
    () =>
      callNameRegistry<{ status: string; name?: string; address?: string; lnAddress?: boolean }>(env, "/lookup", {
        name: nameForRegistry,
      }),
    async () =>
      (env.NAME_MISS_RATE_LIMITER
        ? await env.NAME_MISS_RATE_LIMITER.limit({ key: source })
        : await env.NAME_LOOKUP_RATE_LIMITER.limit({ key: `miss:${source}` })
      ).success,
    // Asked only when the name's own cache entry missed, so a name in use never
    // waits for a snapshot. A name the registry knows nothing about is answered
    // here, exactly as it would answer (`reserved` for the static list, else
    // `free`), and costs no Durable Object request however many such names are
    // asked (nameSnapshot.ts). No snapshot at hand: the registry, as before it.
    async () => {
      const snapshot = await currentNameSnapshot(caches.default, () =>
        nameRegistryStub(env)
          .fetch("https://name-registry.internal/snapshot", { method: "POST", body: "{}" })
          .catch(() => null),
      );
      if (!snapshot || snapshot.has(handle)) return null;
      return { status: isReservedName(handle) ? "reserved" : "free" };
    },
  );
}

// GET /api/names/<name>: 200 {name, address} when the name resolves, otherwise
// 404 {status}. Public on purpose (it is what a sender resolves before paying);
// no-store so a changed address is never served stale.
async function handleNameLookup(request: Request, url: URL, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_LOOKUP_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  let raw: string;
  try {
    raw = decodeURIComponent(url.pathname.slice("/api/names/".length));
  } catch {
    raw = "";
  }
  if (raw.length > NAME_MAX_INPUT_CHARS) raw = "";

  // The registry runs this same check first and answers "invalid", so a name
  // that fails it is answered here: one global Durable Object serves every
  // lookup, and a person typing a name sends a request per pause. Reserved names
  // pass (allowReserved): some have an owner, and that is the registry's call.
  const syntax = checkHandle(raw, { allowReserved: true });
  if (!syntax.ok) {
    return new Response(JSON.stringify({ status: "invalid" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const looked = await lookupNameCached(env, request, syntax.handle, raw);
  if (looked.kind === "limited") return jsonError(429, "Rate limit exceeded.");
  if (looked.kind === "unavailable") return jsonError(502, "Name registry unavailable.");
  const result = looked.result;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (result.status === "taken") {
    return new Response(
      JSON.stringify({
        name: result.name,
        address: result.address,
        lnAddress: result.lnAddress === true,
        ...(result.chatPubkey ? { chatPubkey: result.chatPubkey } : {}),
      }),
      { status: 200, headers },
    );
  }
  return new Response(JSON.stringify({ status: result.status }), { status: 404, headers });
}

type NameWriteBody = Record<string, unknown> & { mailboxId: string; mailboxAuthorization: string };

// The shared front of every name write: same-origin, per-IP limit, capped JSON
// body, well-formed mailbox id + authorization, the account-wide daily cap and
// finally proof of the mailbox. Returns the parsed body or the Response to send.
async function readAuthorizedNameWrite(request: Request, env: Env): Promise<NameWriteBody | Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_WRITE_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  const bodyText = await readCappedBody(request, MAX_NAME_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "Invalid body.");
  const fields = body as Record<string, unknown>;
  const { mailboxId, mailboxAuthorization } = fields;
  if (typeof mailboxId !== "string" || !HEX_66.test(mailboxId)) return jsonError(400, "Invalid mailboxId.");
  if (typeof mailboxAuthorization !== "string" || !HEX_210.test(mailboxAuthorization)) {
    return jsonError(400, "Invalid mailboxAuthorization.");
  }
  return { ...fields, mailboxId, mailboxAuthorization };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Separate from readAuthorizedNameWrite so a handler can reject a bad name or
// address (cheap, local) BEFORE spending a call to the Ark server on it.
//
// A name change needs more than a valid authorization, which lives 24 hours and
// is meant to be shareable: it must also have been signed a moment ago (the
// SDK's lifetime is exactly 24h, so the time of signing follows from the
// expiry) and it can be used once. A device whose clock is far off is told so,
// rather than shown a generic refusal.
async function proveNameMailbox(
  env: Env,
  mailboxId: string,
  mailboxAuthorization: string,
  { countsAsWrite = true }: { countsAsWrite?: boolean } = {},
): Promise<Response | null> {
  const nowSeconds = Date.now() / 1000;
  if (mailboxAuthorizationProblem(mailboxId, mailboxAuthorization, nowSeconds) !== null) {
    return jsonError(403, "Invalid mailbox authorization.");
  }
  if (mailboxAuthorizationFreshness(mailboxAuthorization, nowSeconds) !== null) {
    return jsonError(403, "clock");
  }
  if (!(await probeMailboxAuthorization(ARK_SERVER, mailboxId, mailboxAuthorization))) {
    return jsonError(403, "Invalid mailbox authorization.");
  }
  // Charged only once the Ark server has accepted the signature. It used to sit
  // before the probe, and the local checks above pass any well-formed hex with
  // a plausible expiry, so one IP at the per-IP limit could burn the whole
  // account-wide cap in under an hour and lock every wallet out of names. What
  // bounds unverified attempts (each one a call to the Ark server) is the
  // per-IP limiter in readAuthorizedNameWrite.
  //
  // `mine` is not a name write from the registry's
  // point of view (mine only refreshes lastSeenAt, at most once a day per
  // name), so it skips it: the cap is a KV write per call, and the account
  // has 1,000 KV writes a day in total. Counting `mine` let ~1,000 throwaway
  // wallets' profile opens lock every real name write out and starve the push
  // subscription writes that share the same budget.
  if (countsAsWrite && !(await allowUnderDailyCap(env, "name-write-cap", DAILY_NAME_WRITE_CAP))) {
    return jsonError(429, "Daily name limit reached, try again tomorrow.");
  }
  // Last, so a request that failed anything above does not use up the token.
  const used = await callNameRegistry<{ ok: boolean }>(env, "/consume", { hash: await sha256Hex(mailboxAuthorization) });
  if (!used) return jsonError(502, "Name registry unavailable.");
  if (!used.ok) return jsonError(403, "Invalid mailbox authorization.");
  return null;
}

const NAME_SET_STATUS: Record<string, number> = {
  invalid: 400,
  reserved: 400,
  "bad-address": 400,
  taken: 409,
  quarantined: 409,
  "rate-limited": 429,
  closed: 429,
  banned: 403,
};

async function handleNameSet(request: Request, env: Env): Promise<Response> {
  const parsed = await readAuthorizedNameWrite(request, env);
  if (parsed instanceof Response) return parsed;
  const { name, address, mailboxId, mailboxAuthorization } = parsed;
  if (typeof name !== "string" || name.length > NAME_MAX_INPUT_CHARS) return jsonError(400, "Invalid name.");
  if (typeof address !== "string" || address.length > ARK_ADDRESS_MAX_CHARS) return jsonError(400, "Invalid address.");
  // Reserved names are not turned away here: whether this mailbox is the one
  // configured to hold a given reserved name is the registry's call.
  const check = checkHandle(name, { allowReserved: true });
  if (!check.ok) return jsonError(400, "Invalid name.");
  if (!isPlausibleArkAddress(address)) return jsonError(400, "Invalid address.");

  const proofError = await proveNameMailbox(env, mailboxId, mailboxAuthorization);
  if (proofError) return proofError;

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const sourceKey = `name-claim-src:${await sha256Hex(guardPrefix(ip))}:${utcDay()}`;
  const globalKey = `name-claim-cap:${utcDay()}`;
  const allowNewName =
    (await dailyCount(env, globalKey)) < DAILY_NAME_CLAIM_CAP &&
    (ip === "unknown" || (await dailyCount(env, sourceKey)) < DAILY_NAME_CLAIM_CAP_PER_SOURCE);

  const result = await callNameRegistry<
    { ok: true; action: string; name: string; address: string } | { ok: false; error: string }
  >(env, "/set", { name: check.handle, mailboxId, address, allowNewName });
  if (!result) return jsonError(502, "Name registry unavailable.");
  if (!result.ok) return jsonError(NAME_SET_STATUS[result.error] ?? 400, result.error);
  if (result.action === "claimed" || result.action === "renamed") {
    await bumpDailyCount(env, globalKey);
    if (ip !== "unknown") await bumpDailyCount(env, sourceKey);
  }
  // The writer must see the new state at once (nameLookupCache.ts). A rename's
  // old name expires by itself within the cache TTL.
  await invalidateNameLookup(caches.default, check.handle);
  await invalidateNameSnapshot(caches.default);
  return new Response(JSON.stringify({ name: result.name, address: result.address, action: result.action }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function handleNameRelease(request: Request, env: Env): Promise<Response> {
  const parsed = await readAuthorizedNameWrite(request, env);
  if (parsed instanceof Response) return parsed;
  const { mailboxId, mailboxAuthorization } = parsed;
  const proofError = await proveNameMailbox(env, mailboxId, mailboxAuthorization);
  if (proofError) return proofError;

  const result = await callNameRegistry<{ ok: true; name: string } | { ok: false; error: string }>(
    env,
    "/release",
    { mailboxId },
  );
  if (!result) return jsonError(502, "Name registry unavailable.");
  if (!result.ok) return jsonError(404, result.error);
  await invalidateNameLookup(caches.default, result.name);
  await invalidateNameSnapshot(caches.default);
  return new Response(null, { status: 204 });
}

// POST rather than GET: the authorization travels in the body, never a URL.
async function handleNameMine(request: Request, env: Env): Promise<Response> {
  const parsed = await readAuthorizedNameWrite(request, env);
  if (parsed instanceof Response) return parsed;
  const { mailboxId, mailboxAuthorization } = parsed;
  const proofError = await proveNameMailbox(env, mailboxId, mailboxAuthorization, { countsAsWrite: false });
  if (proofError) return proofError;

  const result = await callNameRegistry<{ name: string; address: string } | null>(env, "/mine", { mailboxId });
  if (result === null) return jsonError(404, "No name.");
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Moderation: POST /api/names/admin/{get,list,assign,remove,block,unblock,unban}, each
// with `Authorization: Bearer <NAMES_ADMIN_TOKEN>`. Not for browsers: no
// same-origin check (it is called from scripts/names-admin.mjs), the token is
// the whole gate, and a wrong one gets the same 403 whatever the route.
const ADMIN_ACTIONS = new Set(["get", "list", "assign", "remove", "block", "unblock", "unban"]);

async function handleNameAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.NAMES_ADMIN_TOKEN) return jsonError(503, "Not configured.");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_WRITE_RATE_LIMITER.limit({ key: `admin:${ip}` });
  if (!success) return jsonError(429, "Rate limit exceeded.");
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!timingSafeEqual(token, env.NAMES_ADMIN_TOKEN)) return jsonError(403, "Forbidden.");

  const action = url.pathname.slice("/api/names/admin/".length);
  if (!ADMIN_ACTIONS.has(action)) return jsonError(404, "Not found.");
  const bodyText = await readCappedBody(request, MAX_NAME_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = bodyText === "" ? {} : JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "Invalid body.");

  const res = await nameRegistryStub(env).fetch(`https://name-registry.internal/admin/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  // remove, block, unblock, assign and unban change what a name reads as.
  if (action !== "get" && action !== "list") {
    const named = typeof (body as { name?: unknown }).name === "string" ? checkHandle((body as { name: string }).name, { allowReserved: true }) : null;
    if (named?.ok) await invalidateNameLookup(caches.default, named.handle);
    await invalidateNameSnapshot(caches.default);
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// The single-page app for spendrr.app/@name, with link-preview tags added when
// the name is registered (see profileMeta.ts). Served by the Worker rather than
// the asset layer for this one route, which also means Cloudflare's redirect of
// "/@name" to "/%40name" no longer happens here; the app reads both spellings.
//
// Never breaks the page: any failure (registry down, rate limited, no such
// name) serves the ordinary app. Two headers from the "/" entry are dropped:
// the ETag, which would describe the plain HTML rather than this one, and
// Critical-CH, which forces a visible reload on a first visit and this is often
// a stranger's first page. Accept-CH stays, so later requests carry the hint.
// GET /api/avatar/<ark address>.png: the address's avatar as a PNG, for link
// previews (profileMeta.ts's og:image). Keyed by the address, not the name,
// so the image is immutable and cacheable forever: a name that moves to
// another address gets another URL. Only a well-formed Ark address is drawn,
// and a cache miss (which costs a render) is rate-limited per IP.
async function handleAvatarPng(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const match = /^\/api\/avatar\/([^/]+)\.png$/.exec(url.pathname);
  const address = match ? match[1] : "";
  if (!isAvatarAddress(address)) return new Response("Not found.", { status: 404 });

  const cacheKey = new Request(`${url.origin}/api/avatar/${address}.png`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_LOOKUP_RATE_LIMITER.limit({ key: `avatar:${bumpRateLimitKey(ip)}` });
  if (!success) return new Response("Rate limit exceeded.", { status: 429 });

  const png = await avatarPng(address);
  const response = new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// /learn is the Czech landing page (public/learn.html); /learn/en the English
// one. A browser that prefers another language is redirected to English
// (learnLang.ts), unless it asked for Czech explicitly with ?lang=cs: that is
// where the English page's "Česky" link points, or it could never get back.
// Only this exact path is routed here (run_worker_first in wrangler.toml).
async function handleLearnPage(request: Request, url: URL, env: Env): Promise<Response> {
  const explicitCzech = url.searchParams.get("lang") === "cs";
  if (!explicitCzech && prefersEnglishLearn(request.headers.get("accept-language"))) {
    return new Response(null, {
      status: 302,
      headers: {
        location: new URL("/learn/en", url).toString(),
        vary: "Accept-Language",
        "cache-control": "no-store",
      },
    });
  }
  const response = await env.ASSETS.fetch(request);
  if (explicitCzech) return response;
  const out = new Response(response.body, response);
  out.headers.append("vary", "Accept-Language");
  return out;
}

// /tip/<name> and /donate are one static page (tip.html, served at /tip) that
// reads the name from its own URL. Nothing is looked up here: the page asks the
// ordinary name and LNURL routes, which carry their own limiters.
async function handleTipPage(request: Request, url: URL, env: Env): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL("/tip", url).toString(), { headers: request.headers }));
  const out = new Response(page.body, page);
  out.headers.set("cache-control", "no-cache");
  return out;
}

async function handleProfilePage(request: Request, env: Env, name: string): Promise<Response> {
  const base = await env.ASSETS.fetch(new Request(new URL("/", request.url).toString(), { headers: { accept: "text/html" } }));
  if (!base.ok) return base;
  const headers = new Headers(base.headers);
  headers.delete("etag");
  headers.delete("content-length");
  headers.delete("critical-ch");
  headers.set("cache-control", "no-cache");
  const plain = () => new Response(base.body, { status: 200, headers });

  // handleFromPath only decodes, so a path like /@a or /@%25 used to reach the
  // Durable Object just to be told "invalid". Syntax is checked here first.
  const syntax = checkHandle(name, { allowReserved: true });
  if (!syntax.ok) return plain();

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_LOOKUP_RATE_LIMITER.limit({ key: `page:${bumpRateLimitKey(ip)}` });
  if (!success) return plain();
  const looked = await lookupNameCached(env, request, syntax.handle, name);
  if (looked.kind !== "result") return plain();
  const result = looked.result;
  if (result.status !== "taken" || typeof result.name !== "string") return plain();

  const meta = profileMeta(result.name, new URL(request.url).origin, {
    address: typeof result.address === "string" && isAvatarAddress(result.address) ? result.address : null,
    lnAddress: result.lnAddress === true,
  });
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(profileMetaTags(meta), { html: true });
      },
    })
    .on("title", {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", escapeHtml(meta.description));
      },
    })
    .transform(new Response(base.body, { status: 200, headers }));
}

// ---- Lightning address (lnurl.ts / lnLedger.ts) ----------------------------
//
// docs/ln-address-plan.md section 4.2. A payer's wallet talks LNURL-pay to
// this Worker; the Worker talks a narrow slice of barkd's REST API to the
// service node over BARKD_URL (Cloudflare Tunnel + Access, see the node
// section of the plan); barkd never appears anywhere in this app's own
// client bundle. LnLedger (one global Durable Object) is the source of truth
// for which invoices are open, so the per-name/global caps can't race.

const LNURL_CB_TIMEOUT_MS = 8000;
const LN_VERIFY_MISS_TTL_SECONDS = 30;
// A known invoice's verify answer, remembered per colo. A payer's wallet polls
// verify every second or two, and each poll was a ledger request. Pending can
// only turn settled at the cron sweep (once a minute), so 10 s adds at most
// that to a wait already measured in a minute. Only settled is final: the
// ledger's settle() also accepts an expired record.
const LN_VERIFY_OPEN_TTL_SECONDS = 4;
const LN_VERIFY_SETTLED_TTL_SECONDS = 3600;
const MAX_LNADDR_BODY_BYTES = 2048;

function lnLedgerStub(env: Env) {
  return env.LN_LEDGER.get(env.LN_LEDGER.idFromName("global"));
}

// Tells "the ledger answered" from "it did not" (an error, an overloaded or
// over-quota object), which callLnLedger folds into null together with a
// genuine null answer. A caller that remembers a negative answer needs the
// difference: a failure must never be cached as "not found".
async function callLnLedgerDetailed<T>(
  env: Env,
  path: string,
  body: unknown,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const res = await lnLedgerStub(env).fetch(`https://ln-ledger.internal${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false };
    return { ok: true, value: (await res.json()) as T };
  } catch {
    return { ok: false };
  }
}

async function callLnLedger<T>(env: Env, path: string, body: unknown): Promise<T | null> {
  const result = await callLnLedgerDetailed<T>(env, path, body);
  return result.ok ? result.value : null;
}

// Whether a name currently takes Lightning payments, from the edge-cached
// registry lookup (nameLookupCache.ts) instead of a Durable Object request per
// call: /.well-known/lnurlp and the callback are public and unauthenticated, and
// a name that is not a handle, does not exist or has the feature off is
// answered without touching the registry. A miss is charged to the same stricter
// limiter as plain name lookups. Up to NAME_LOOKUP_CACHE_TTL_SECONDS stale, which
// is why the callback still asks the registry itself (lnAddressTarget) before it
// issues anything.
async function lnAddressAvailable(
  env: Env,
  request: Request,
  raw: string,
): Promise<{ kind: "yes"; name: string } | { kind: "no" } | { kind: "limited" }> {
  if (raw.length > NAME_MAX_INPUT_CHARS) return { kind: "no" };
  const syntax = checkHandle(raw, { allowReserved: true });
  if (!syntax.ok) return { kind: "no" };
  const looked = await lookupNameCached(env, request, syntax.handle, raw);
  if (looked.kind === "limited") return { kind: "limited" };
  if (looked.kind === "unavailable") return { kind: "no" };
  const found = looked.result;
  if (found.status === "taken" && found.lnAddress === true) return { kind: "yes", name: found.name ?? syntax.handle };
  return { kind: "no" };
}

type BarkdResult<T> =
  | { ok: true; json: T }
  | { ok: false; reason: "unconfigured" | BarkdFailure | "bad-response"; status?: number };

// Whether the node itself answered, which is what node health is about: an
// error barkd returns for one request is still a live node (see
// classifyBarkdStatus in lnurl.ts for which answers count as which).
function barkdAnswered<T>(result: BarkdResult<T>): boolean {
  return result.ok || result.reason === "http-error" || result.reason === "bad-response";
}

// Every call to the service node in one place: the two independent secrets
// (Cloudflare Access service token, barkd's own bearer) attached, an 8s
// timeout (a hung node must not hang a payer's wallet indefinitely), and a
// uniform result shape so callers never have to think about fetch's own
// exception surface. `path` is one of the handful of routes Caddy's
// allowlist actually passes through — anything else 404s at the node
// regardless of what's sent here.
//
// `redirect: "manual"`: Cloudflare Access answers a bad service token with a
// redirect to its login page. Followed, that is a 200 HTML page, which would
// read as a live node that returned garbage. A redirect that stays on
// BARKD_URL's own origin (a trailing-slash normalisation by barkd or Caddy) is
// still followed, once, by hand.
async function callBarkd<T>(env: Env, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<BarkdResult<T>> {
  if (!env.BARKD_URL || !env.BARKD_TOKEN || !env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
    return { ok: false, reason: "unconfigured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LNURL_CB_TIMEOUT_MS);
  const send = (target: string) =>
    fetch(target, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.BARKD_TOKEN}`,
        "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID!,
        "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET!,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
  let res: Response;
  try {
    const target = `${env.BARKD_URL}${path}`;
    res = await send(target);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location !== null) {
      const next = new URL(location, target);
      if (next.origin === new URL(env.BARKD_URL).origin) res = await send(next.toString());
    }
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: "unreachable" };
  }
  try {
    if (!res.ok) return { ok: false, reason: classifyBarkdStatus(res.status), status: res.status };
    return { ok: true, json: (await res.json()) as T };
  } catch {
    // Timed out mid-body counts as unreachable; a body that isn't JSON is a
    // node that answered.
    return { ok: false, reason: controller.signal.aborted ? "unreachable" : "bad-response", status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// GET /.well-known/lnurlp/<name>: LUD-06/16 payRequest. Public, no rate limit
// beyond the generous shared LNURL bucket — this is exactly what a sender's
// wallet fetches first, unauthenticated, same posture as GET /api/names/<name>.
async function handleLnurlPayRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.LNURL_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return lnurlErrorResponse("Příliš mnoho požadavků.");

  let raw: string;
  try {
    raw = decodeURIComponent(url.pathname.slice("/.well-known/lnurlp/".length));
  } catch {
    raw = "";
  }

  const available = await lnAddressAvailable(env, request, raw);
  if (available.kind === "limited") return lnurlErrorResponse("Příliš mnoho požadavků.");
  if (available.kind === "no") return lnurlErrorResponse("Tato Lightning adresa není dostupná.");

  return lnurlJsonResponse(buildPayRequest(available.name, url.origin));
}

// GET /api/lnurlp/<name>/cb?amount=<msat>&comment=…: the actual invoice
// request. Checks run in the order docs/ln-address-plan.md lays out: kill
// switch (inside LnLedger.precheck) → name/opt-in → amount → IP rate limit →
// ledger budget → the service node itself → commit to the ledger.
async function handleLnurlCallback(request: Request, url: URL, env: Env): Promise<Response> {
  let raw: string;
  try {
    raw = decodeURIComponent(url.pathname.replace(/^\/api\/lnurlp\//, "").replace(/\/cb$/, ""));
  } catch {
    raw = "";
  }
  if (raw.length > NAME_MAX_INPUT_CHARS) return lnurlErrorResponse("Neplatné jméno.");

  // Cheap local checks first, then the source's limit, and only then anything
  // that costs a Durable Object request. This used to ask the registry for the
  // name before either, so any made-up name was a free request to the one global
  // registry, unlimited.
  if (!checkHandle(raw, { allowReserved: true }).ok) return lnurlErrorResponse("Tato Lightning adresa není dostupná.");
  const amountResult = parseCallbackAmountMsat(url.searchParams.get("amount"));
  if (!amountResult.ok) return lnurlErrorResponse("Neplatná částka.");
  const commentResult = parseCallbackComment(url.searchParams.get("comment"));
  if (!commentResult.ok) return lnurlErrorResponse("Komentář je příliš dlouhý.");

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.LNURL_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return lnurlErrorResponse("Příliš mnoho požadavků.");
  // The ledger's per-source cap on open invoices is keyed on the /48 for IPv6:
  // a subscriber holds a /48 or /56 and can present a fresh /64 per request, so
  // on the /64 four of them filled a name's 20 open slots (and ~400 the global
  // 2000) for as long as they kept asking every 10 minutes.
  const source = guardPrefix(ip);

  const available = await lnAddressAvailable(env, request, raw);
  if (available.kind === "limited") return lnurlErrorResponse("Příliš mnoho požadavků.");
  if (available.kind === "no") return lnurlErrorResponse("Tato Lightning adresa není dostupná.");

  // Authoritative: the cached lookup above may be a few seconds old, and this is
  // where the owner's mailbox comes from.
  const target = await callNameRegistry<{ name: string; address: string; mailboxId: string } | null>(
    env,
    "/ln-address/target",
    { name: raw },
  );
  if (target === null) return lnurlErrorResponse("Tato Lightning adresa není dostupná.");

  const budget = await callLnLedger<{ ok: true } | { ok: false; error: string }>(env, "/precheck", {
    name: target.name,
    source,
  });
  if (!budget) return lnurlErrorResponse("Dočasně nedostupné.");
  if (!budget.ok) {
    return lnurlErrorResponse(budget.error === "killed" ? "Dočasně nedostupné." : "Příliš mnoho otevřených faktur.");
  }

  const description = lnAddressMetadataString(target.name, url.origin);
  const invoiceResult = await callBarkd<{ invoice: string }>(env, "/api/v1/lightning/receives/invoice/for-address", {
    method: "POST",
    body: { amount_sat: amountResult.sats, address: target.address, description },
  });
  if (!invoiceResult.ok) {
    await callLnLedger(env, "/invoice/result", { ok: false });
    return lnurlErrorResponse("Dočasně nedostupné.");
  }
  await callLnLedger(env, "/health/report", { invoice: true });

  // The payment hash (the ledger's key) and the amount come out of the invoice
  // itself: no second round trip to the node, and an invoice for another amount
  // than was asked (a bug or a compromised node) is not handed to the payer.
  // The node is asked only when the invoice does not decode locally.
  const invoiceString = invoiceResult.json.invoice;
  if (decodeBolt11Amount(invoiceString) !== amountResult.sats) return lnurlErrorResponse("Dočasně nedostupné.");
  let paymentHash = decodeBolt11PaymentHash(invoiceString);
  if (paymentHash === null || !isPlausiblePaymentHash(paymentHash)) {
    const statusResult = await callBarkd<{ payment_hash: string }>(
      env,
      `/api/v1/lightning/receives/${encodeURIComponent(invoiceString)}`,
      { method: "GET" },
    );
    if (!statusResult.ok || !isPlausiblePaymentHash(statusResult.json.payment_hash)) {
      return lnurlErrorResponse("Dočasně nedostupné.");
    }
    paymentHash = statusResult.json.payment_hash;
  }

  const reserved = await callLnLedger<{ ok: true; record: ReceiveRecord } | { ok: false; error: string }>(env, "/reserve", {
    hash: paymentHash,
    name: target.name,
    address: target.address,
    amountSats: amountResult.sats,
    comment: commentResult.comment,
    pr: invoiceResult.json.invoice,
    source,
    mailboxId: target.mailboxId,
  });
  if (!reserved || !reserved.ok) return lnurlErrorResponse("Dočasně nedostupné.");

  return lnurlJsonResponse({ pr: invoiceResult.json.invoice, routes: [], verify: `${url.origin}/api/lnurlp/verify/${paymentHash}` });
}

// GET /api/lnurlp/verify/<hash>: LUD-21. Answers from the ledger, which the
// minute cron keeps fresh. On top of that a poll may ask the node about this one
// invoice itself (settlementFromNode), so a payer is told "paid" within seconds
// instead of waiting for the next tick. What bounds that is decided in the
// ledger (claimVerifyCheck): once per invoice per VERIFY_CHECK_GAP_MS and
// VERIFY_CHECKS_PER_MINUTE for all invoices together; a poll without the
// allowance reads the ledger as before. The hash is 256 bits and only the payer
// has it, and the per-source limiter above applies to every poll.
async function handleLnurlVerify(request: Request, url: URL, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.LNURL_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return lnurlErrorResponse("Příliš mnoho požadavků.");

  const hash = url.pathname.slice("/api/lnurlp/verify/".length);
  if (!isPlausiblePaymentHash(hash)) return lnurlErrorResponse("Neplatný identifikátor.");

  // An unknown hash is remembered briefly: the id is 256 bits and free to
  // invent, and every one asked the ledger. Only a real "not found" is
  // remembered, never a failed call. A hash only ever becomes known through a
  // reserve, whose response is what hands out the verify URL, so a remembered miss
  // cannot hide an invoice that exists.
  const missKey = new Request(`https://ln-verify-cache.internal/miss/${hash}`);
  const answerKey = new Request(`https://ln-verify-cache.internal/answer/${hash}`);
  try {
    if (await caches.default.match(missKey)) return lnurlErrorResponse("Faktura nenalezena.");
    const remembered = await caches.default.match(answerKey);
    if (remembered) return lnurlJsonResponse(await remembered.json());
  } catch {
    // A broken cache read is a miss.
  }
  const looked = await callLnLedgerDetailed<{ record: ReceiveRecord | null; check: boolean }>(env, "/verify-claim", {
    hash,
    graceMs: LN_EXPIRE_GRACE_MS,
  });
  if (!looked.ok) return lnurlErrorResponse("Faktura nenalezena.");
  let record = looked.value.record;
  if (!record) {
    try {
      await caches.default.put(
        missKey,
        new Response("1", { headers: { "cache-control": `public, max-age=${LN_VERIFY_MISS_TTL_SECONDS}` } }),
      );
    } catch {
      // Not remembered: the next poll asks again.
    }
    return lnurlErrorResponse("Faktura nenalezena.");
  }

  if (looked.value.check) {
    const preimage = await settlementFromNode(env, record.pr, hash);
    if (preimage) {
      // The ledger is told, so the cron and later polls agree; the answer is built from what
      // was just verified, not from the ledger's reply.
      await callLnLedger(env, "/settle", { hash, preimage });
      record = { ...record, state: "settled", preimage };
    }
  }

  const answer = buildVerifyResponse({ settled: record.state === "settled", preimage: record.preimage ?? null, pr: record.pr });
  const ttl = record.state === "settled" ? LN_VERIFY_SETTLED_TTL_SECONDS : LN_VERIFY_OPEN_TTL_SECONDS;
  try {
    await caches.default.put(
      answerKey,
      new Response(JSON.stringify(answer), { headers: { "cache-control": `public, max-age=${ttl}` } }),
    );
  } catch {
    // Not remembered: the next poll asks the ledger again.
  }
  return lnurlJsonResponse(answer);
}

// POST /api/names/chat: the owner publishes the money chat key behind their
// name, `{chatPubkey, chatSig}` alongside the usual mailbox proof. chatSig is a
// Schnorr signature by chatPubkey over sha256(CHAT_BIND_PREFIX + mailboxId):
// the name may only claim a Nostr identity whose key it actually holds, since
// NIP-05 below vouches for it to every Nostr client.
async function handleNameChat(request: Request, env: Env): Promise<Response> {
  const parsed = await readAuthorizedNameWrite(request, env);
  if (parsed instanceof Response) return parsed;
  const { mailboxId, mailboxAuthorization, chatPubkey, chatSig } = parsed as NameWriteBody & {
    chatPubkey?: unknown;
    chatSig?: unknown;
  };
  if (typeof chatPubkey !== "string" || !/^[0-9a-f]{64}$/.test(chatPubkey)) return jsonError(400, "Invalid body.");
  if (typeof chatSig !== "string" || !/^[0-9a-f]{128}$/.test(chatSig)) return jsonError(400, "Invalid body.");
  let signed = false;
  try {
    const digest = nobleSha256(new TextEncoder().encode(CHAT_BIND_PREFIX + mailboxId));
    signed = schnorr.verify(hexToBytes(chatSig), digest, hexToBytes(chatPubkey));
  } catch {
    signed = false;
  }
  if (!signed) return jsonError(403, "Invalid chat signature.");

  const proofError = await proveNameMailbox(env, mailboxId, mailboxAuthorization);
  if (proofError) return proofError;

  const result = await callNameRegistry<{ ok: true; chatPubkey: string; name?: string } | { ok: false; error: string }>(
    env,
    "/chat/set",
    { mailboxId, chatPubkey },
  );
  if (!result) return jsonError(502, "Name registry unavailable.");
  if (!result.ok) return jsonError(result.error === "no-name" ? 404 : 400, result.error);
  return new Response(JSON.stringify({ chatPubkey: result.chatPubkey }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// GET /.well-known/nostr.json?name=<name>: NIP-05, so name@spendrr.app is also a
// verified Nostr identity and other clients know where to deliver DMs. Public,
// CORS-open as NIP-05 requires, same limiter and edge cache as GET /api/names/.
async function handleNip05(request: Request, url: URL, env: Env): Promise<Response> {
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_LOOKUP_RATE_LIMITER.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return new Response(JSON.stringify({ names: {} }), { status: 429, headers });

  const raw = (url.searchParams.get("name") ?? "").slice(0, NAME_MAX_INPUT_CHARS);
  const syntax = checkHandle(raw, { allowReserved: true });
  if (!syntax.ok) return new Response(JSON.stringify({ names: {} }), { status: 404, headers });
  const looked = await lookupNameCached(env, request, syntax.handle, raw);
  if (looked.kind === "limited") return new Response(JSON.stringify({ names: {} }), { status: 429, headers });
  if (looked.kind === "unavailable") return new Response(JSON.stringify({ names: {} }), { status: 502, headers });
  const result = looked.result;
  if (result.status !== "taken" || !result.name || !result.chatPubkey) {
    return new Response(JSON.stringify({ names: {} }), { status: 404, headers });
  }
  // The query may be any case; NIP-05 clients compare the local part they asked for.
  const body = {
    names: { [result.name]: result.chatPubkey, ...(raw !== result.name ? { [raw]: result.chatPubkey } : {}) },
    relays: { [result.chatPubkey]: CHAT_RELAYS },
  };
  return new Response(JSON.stringify(body), { status: 200, headers });
}

// POST /api/names/ln: owner opt-in/opt-out, proven the same way as
// /api/names/set (proveNameMailbox). `{enabled: boolean}` alongside the usual
// mailboxId/mailboxAuthorization.
async function handleNameLnToggle(request: Request, env: Env): Promise<Response> {
  const parsed = await readAuthorizedNameWrite(request, env);
  if (parsed instanceof Response) return parsed;
  const { mailboxId, mailboxAuthorization, enabled } = parsed as NameWriteBody & { enabled?: unknown };
  if (typeof enabled !== "boolean") return jsonError(400, "Invalid body.");

  const proofError = await proveNameMailbox(env, mailboxId, mailboxAuthorization);
  if (proofError) return proofError;

  const result = await callNameRegistry<{ ok: true; lnAddress: boolean } | { ok: false; error: string }>(
    env,
    "/ln-address/set",
    { mailboxId, enabled },
  );
  if (!result) return jsonError(502, "Name registry unavailable.");
  if (!result.ok) return jsonError(404, result.error);
  return new Response(JSON.stringify({ lnAddress: result.lnAddress }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// POST /api/lnaddr/receipts: the owner's own incoming-Lightning history, so
// the app can label matching Ark movements. Proven the same way as every
// other owner-only name write, and filed by owner mailbox (see
// LnLedgerCore.receiptsForMailbox): the proven mailbox gets exactly the
// invoices issued while it held the name, whatever it is called now or
// whether it still has one. A name's later holder gets none of them.
async function handleLnAddrReceipts(request: Request, env: Env): Promise<Response> {
  const parsed = await readAuthorizedNameWrite(request, env);
  if (parsed instanceof Response) return parsed;
  const { mailboxId, mailboxAuthorization } = parsed;
  const proofError = await proveNameMailbox(env, mailboxId, mailboxAuthorization);
  if (proofError) return proofError;

  const receipts = await callLnLedger<ReceiveRecord[]>(env, "/receipts", { mailboxId });
  if (!receipts) return jsonError(502, "Ledger unavailable.");
  return new Response(JSON.stringify(receipts), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Moderation/ops: POST /api/lnaddr/admin/{kill,status}, same bearer as the
// @handle admin routes (NAMES_ADMIN_TOKEN) — one admin, one token.
const LNADDR_ADMIN_ACTIONS = new Set(["kill", "status"]);

async function handleLnAddrAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.NAMES_ADMIN_TOKEN) return jsonError(503, "Not configured.");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.NAME_WRITE_RATE_LIMITER.limit({ key: `lnaddr-admin:${ip}` });
  if (!success) return jsonError(429, "Rate limit exceeded.");
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!timingSafeEqual(token, env.NAMES_ADMIN_TOKEN)) return jsonError(403, "Forbidden.");

  const action = url.pathname.slice("/api/lnaddr/admin/".length);
  if (!LNADDR_ADMIN_ACTIONS.has(action)) return jsonError(404, "Not found.");
  const bodyText = await readCappedBody(request, MAX_LNADDR_BODY_BYTES);
  if (typeof bodyText !== "string") return bodyText;
  let body: unknown;
  try {
    body = bodyText === "" ? {} : JSON.parse(bodyText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "Invalid body.");

  const res = await lnLedgerStub(env).fetch(`https://ln-ledger.internal/admin/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (action === "kill" && res.ok) await syncLnAddrRefusingLogged(env, text);
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Cron sweep: settle/expire pending invoices and watch node health, so
// nothing depends purely on a wallet actively polling /verify. Runs every
// minute alongside pingHealthcheck/refreshBtcMapCacheIfStale (see
// scheduled() above). Never throws — a bad tick just tries again next minute.
const LN_PENDING_SWEEP_AGE_MS = 30_000;
// Invoices looked at per tick. Each costs one subrequest to the node (plus a
// DO call when it settles/expires), in the same invocation as pingHealthcheck
// and the BTC Map refresh; a backlog is worked through over several ticks,
// least recently checked first (LnLedgerCore.listPending).
const LN_SWEEP_MAX_ITEMS = 20;
// An unpaid invoice is expired this long after its own BOLT11 expiry, not
// before: until then the payer can still pay it (captaind's default is 48h).
const LN_EXPIRE_GRACE_MS = 2 * 60 * 1000;

// The ledger's "refusing new invoices" state into KV for GET
// /api/lnaddr/health (lnAddrHealth.ts). Takes the ledger's reply as parsed
// JSON or raw text; never throws, a failed write is retried next minute.
async function syncLnAddrRefusingLogged(env: Env, reply: unknown): Promise<void> {
  try {
    const parsed = typeof reply === "string" ? (JSON.parse(reply) as unknown) : reply;
    const refusing = typeof parsed === "object" && parsed !== null ? (parsed as { refusing?: unknown }).refusing : undefined;
    const outcome = await syncLnAddrRefusing(env.PUSH_SUBSCRIPTIONS, refusing);
    if (outcome === "set" || outcome === "cleared") console.log(`lnaddr health: refusing ${outcome}`);
  } catch (err) {
    console.error("lnaddr health: KV sync failed", err);
  }
}

// Alert channel for the Lightning-address service node: a healthchecks.io (or
// compatible) check, separate from HEALTHCHECK_PING_URL so an LN outage pages
// as such. Pinged on every healthy sweep, "/fail" while the automatic kill
// switch is on; healthchecks.io alerts on the fail and on pings stopping.
// Every STATUS_REPORT_EVERY_MIN minutes: "" while the relay answers ok and
// warm, "/fail" otherwise. Runs after reportStatus, whose relayHealthy answer
// is cached per isolate, so it costs only the ping itself.
async function pingRelayHealthcheck(env: Env): Promise<void> {
  if (!env.RELAY_HEALTHCHECK_PING_URL || !relayConfigured(env)) return;
  const ok = await relayHealthy(env).catch(() => false);
  try {
    await fetch(env.RELAY_HEALTHCHECK_PING_URL + (ok ? "" : "/fail"));
  } catch {
    // Best-effort, like pingHealthcheck.
  }
}

async function pingLnHealthcheck(env: Env, suffix: "" | "/fail"): Promise<void> {
  if (!env.LN_HEALTHCHECK_PING_URL) return;
  try {
    await fetch(env.LN_HEALTHCHECK_PING_URL + suffix);
  } catch {
    // Best-effort, like pingHealthcheck.
  }
}

// A barkd movement's metadata says which preimage it revealed; checking it
// hashes to the invoice's payment hash makes sure the movement found by
// invoice string really is this invoice's before /verify hands it out.
async function preimageMatchesHash(preimage: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(preimage)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(preimage.slice(i * 2, i * 2 + 2), 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") === hash;
}

type BarkdMovement = { status: string; metadata?: { payment_preimage?: unknown } };

type LedgerSummary = { lnNode: boolean; lnRefusing: boolean; lnInvoicesFailing: boolean };
type LedgerTick = {
  health: { lifted?: boolean; downForMs?: number; autoKilled?: boolean; justTripped?: boolean; refusing: boolean };
  pending: { hash: string; name: string; pr: string; createdAt: number; expiresAt: number }[];
  summary?: LedgerSummary;
};

// One ledger request a tick (lnLedger.ts's /tick): it prunes, records the
// node's health from the probe made just before it, and lists what is due.
// Settling, expiring and marking checked follow only when something is due.
// Returns the ledger's status summary when asked for one (status report ticks).
// The settlement test of sweepLnLedger for one invoice: the node's movement for
// it is "successful" and its preimage hashes to the payment hash. null for
// anything else, including a node that does not answer (the cron tries again).
async function settlementFromNode(env: Env, pr: string, hash: string): Promise<string | null> {
  const history = await callBarkd<BarkdMovement[]>(env, `/api/v1/history?type=invoice&value=${encodeURIComponent(pr)}`, {
    method: "GET",
  });
  if (!history.ok || !Array.isArray(history.json)) return null;
  const preimage = history.json.find((m) => m.status === "successful")?.metadata?.payment_preimage;
  return typeof preimage === "string" && (await preimageMatchesHash(preimage, hash)) ? preimage : null;
}

async function sweepLnLedger(env: Env, withSummary = false): Promise<LedgerSummary | null> {
  if (!env.BARKD_URL) return null; // Feature not configured yet — nothing to sweep.
  try {
    // Health first, so it can travel in the same ledger request. GET
    // receives-list is one of the paths Caddy's allowlist passes; an error
    // barkd itself returns still proves the node is up (barkdAnswered).
    const probe = await callBarkd<unknown>(env, "/api/v1/lightning/receives", { method: "GET" });
    const nodeUp = barkdAnswered(probe);
    if (!nodeUp) console.error("sweepLnLedger: node unreachable", probe.ok ? "" : probe.reason);

    const tick = await callLnLedger<LedgerTick>(env, "/tick", {
      node: nodeUp ? "ok" : "down",
      olderThanMs: LN_PENDING_SWEEP_AGE_MS,
      limit: LN_SWEEP_MAX_ITEMS,
      summary: withSummary,
    });
    if (!tick) return null;

    if (nodeUp) {
      if (tick.health.lifted) console.log("sweepLnLedger: node back, automatic kill switch lifted");
      await syncLnAddrRefusingLogged(env, tick.health);
      await pingLnHealthcheck(env, "");
    } else {
      // Down. The ledger counts the outage from its first failed check and
      // sets the automatic kill switch once it passes NODE_DOWN_AUTO_KILL_MS;
      // the next healthy check lifts it again, no admin needed. An admin's own
      // switch (/api/lnaddr/admin/kill) is separate and never lifted here.
      if (tick.health.justTripped) console.error("sweepLnLedger: node down, automatic kill switch set");
      await syncLnAddrRefusingLogged(env, tick.health);
      // The alert: LN_HEALTHCHECK_PING_URL gets a /fail ping on every tick the
      // switch is on, and nothing while the outage is still shorter than that,
      // so a blip under 3 minutes never pages anyone.
      if (tick.health.autoKilled) await pingLnHealthcheck(env, "/fail");
    }

    // The ledger lists nothing while the node is down: every lookup would
    // only wait out its timeout.
    const stillOpen: string[] = [];
    for (const item of tick.pending) {
      // Settlement signal: barkd's movement history for this exact invoice.
      // `GET /api/v1/lightning/receives/{hash}` can't tell paid from unpaid
      // (its `payment_preimage` is filled from the moment the invoice is
      // created, since the receiver generates it), found live 2026-09-22.
      //
      // Per bark-0.7.0's actions/lightning/receive.rs, the movement appears
      // once the server grants the HTLCs (status "pending", effective balance
      // = HTLC amount, preimage not revealed yet) and turns "successful" only
      // after the claim and, for a claim to someone else's address, the
      // mailbox delivery (deliver_lightning_receive), which also resets its
      // effective balance to 0 because the funds left this wallet. So the
      // test is `status === "successful"` alone: an effective-balance check
      // would never match a real delivery to another wallet. The movement is
      // looked up by invoice string (received_on), which is why the Caddy
      // allowlist on the node passes `/api/v1/history?type=invoice`.
      const historyResult = await callBarkd<BarkdMovement[]>(
        env,
        `/api/v1/history?type=invoice&value=${encodeURIComponent(item.pr)}`,
        { method: "GET" },
      );
      if (!historyResult.ok) {
        if (barkdAnswered(historyResult)) {
          // The node is up but refuses this one lookup. Push it back like an
          // unpaid check, or a few such invoices would sit at the head of the
          // worklist (least recently checked first) and starve the rest.
          // Never expired on this basis: whether it was paid is unknown.
          stillOpen.push(item.hash);
          console.error("sweepLnLedger: history lookup failed", item.hash, historyResult.reason, historyResult.status);
        }
        continue;
      }
      const movements = Array.isArray(historyResult.json) ? historyResult.json : [];

      const done = movements.find((m) => m.status === "successful");
      if (done) {
        const preimage = done.metadata?.payment_preimage;
        if (typeof preimage === "string" && (await preimageMatchesHash(preimage, item.hash))) {
          await callLnLedger(env, "/settle", { hash: item.hash, preimage });
        } else {
          console.error("sweepLnLedger: successful movement without a matching preimage", item.hash);
          stillOpen.push(item.hash);
        }
        continue;
      }

      // Expire only once the invoice itself can no longer be paid, and never
      // while a movement is still pending: that is a payment already in
      // flight (HTLCs granted, claim or delivery not finished yet).
      const inFlight = movements.some((m) => m.status === "pending");
      if (!inFlight && Date.now() > item.expiresAt + LN_EXPIRE_GRACE_MS) {
        await callLnLedger(env, "/expire", { hash: item.hash });
      } else {
        stillOpen.push(item.hash);
      }
    }
    if (stillOpen.length > 0) await callLnLedger(env, "/checked", { hashes: stillOpen });
    return tick.summary ?? null;
  } catch (err) {
    console.error("sweepLnLedger error", err);
    return null;
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
