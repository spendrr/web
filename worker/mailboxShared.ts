// Mailbox payment/expiry-check logic, shared between index.ts (validation +
// routing for /api/push/*) and mailboxWatcher.ts (the Durable Object that
// actually runs this on its own per-mailbox alarm). Split out of index.ts
// for the same reason priceCache.ts is: index.ts re-exports the
// MailboxWatcher Durable Object class, and the Workers runtime requires
// every OTHER export of that entry module to be the default handler itself —
// any other runtime value (a const, a function) exported from index.ts
// crashes at startup. Anything a second file needs must live in its own
// module, never re-exported through index.ts.

import { probeMailboxAuthorization, readMailbox, type MailboxReceiveEvent } from "./mailbox";
import { mailboxAuthorizationProblem } from "./names";
import { authorizationExpiry } from "./mailboxProto";
import { sendWebPush, type PushSubscriptionKeys } from "./webPush";
import { isFcmEndpoint, sendFcm, type PushMessage } from "./fcm";
import { upstreamSignal } from "./upstream";
import { fetchSimplePriceCached } from "./priceCache";
import type { Env, PushSubscriptionRecord, RecordStore } from "./index";

export const ARK_SERVER = "https://ark.second.tech";
// Public half of the VAPID keypair — safe to duplicate here (also lives in
// src/lib/notifications.ts for pushManager.subscribe()). The private half is
// the VAPID_PRIVATE_KEY Worker secret, never shipped to the client.
export const VAPID_PUBLIC_KEY = "BJC6rFgeWdYbvL0yiHdCZtabhpCaFgmHb75QO9BvE5m_ps68dHDGpmVapOVIfQIkmO7z9GCavu8PcusvKC-McCA";
export const VAPID_SUBJECT = "https://spendrr.app";

// The longest push authorization a shard accepts; it watches the mailbox
// until the authorization's own expiry. The app signs for exactly this
// (src/lib/notifications.ts PUSH_AUTH_LIFETIME_S): a user who opens it at
// least once in that time keeps getting payment pushes. It must stay below a
// name proof's lifetime (worker/names.ts NAME_PROOF_LIFETIME_S): a push
// authorization near the end of its life must never pass as a freshly signed
// name proof.
export const PUSH_AUTH_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// The client's clock against ours, on top of that.
export const PUSH_AUTH_CLOCK_SKEW_SECONDS = 300;

// When a push authorization expires, or null when a shard must not take it:
// malformed, already expired, or longer than PUSH_AUTH_MAX_LIFETIME_SECONDS.
export function pushAuthExpiry(authorizationHex: string, nowSeconds: number): number | null {
  const expiry = authorizationExpiry(authorizationHex);
  if (expiry === null || expiry <= nowSeconds) return null;
  if (expiry > nowSeconds + PUSH_AUTH_MAX_LIFETIME_SECONDS + PUSH_AUTH_CLOCK_SKEW_SECONDS) return null;
  return expiry;
}

// First nudge: the refresh engine (src/lib/refreshEngine/plan.ts, POLICY.DUE_BLOCKS
// = 250) treats a coin as due once fewer than 250 blocks are left, so a tap on
// this push must find something to refresh. The 10 block margin covers a device
// whose tip is a block or two behind the Worker's. tests/expiryNudgeThresholds
// keeps the two numbers apart by exactly the margin. Exit wake-ups report
// wake + this (src/lib/exit/exitNudge.ts), so keep that in step.
// Below the engine's threshold this is purely a "come open the app" reminder,
// not a fund-safety deadline: an expired VTXO doesn't disappear (the Ark
// server still allows spending it), it just loses its unilateral-exit
// guarantee, so every stage but the last stays a calm reminder.
export const EXPIRY_NUDGE_THRESHOLD_BLOCKS = 240;
// Second, calm reminder (~24 h before expiry) if the first went unanswered.
export const EXPIRY_REMINDER_THRESHOLD_BLOCKS = 144;
// A last, single push if the same VTXO is now close to its actual expiry
// (~24 blocks ≈ 4h at 10min/block).
const EXPIRY_URGENT_THRESHOLD_BLOCKS = 24;
// Sanity cap on the client-reported blockheight, checked at subscribe time
// without needing the actual current tip — generous enough (~190 years of
// blocks) to never need bumping, just enough to reject obviously-bogus
// values (negative, NaN, accidentally-sent-a-timestamp).
export const MAX_PLAUSIBLE_BLOCKHEIGHT = 10_000_000;

// A subscribed mailbox's Durable Object (see mailboxWatcher.ts) actively
// re-fires its own alarm forever unless something stops it — unlike the old
// shared-KV-record design, where an abandoned/attacker-junk entry was at
// least passive (it just sat there costing a read on someone else's cron
// tick). That makes an equivalent bound *more* important here, not less: a
// junk subscription with no expiry check would otherwise keep spending real
// subrequests every minute, forever. MailboxWatcher's alarm() checks this
// against lastSeenAt and self-deletes (no reschedule) once it's stale.
// Comfortably longer than a VTXO's ~28-day validity window (see
// EXPIRY_NUDGE_THRESHOLD_BLOCKS' own comment) so the expiry-nudge feature —
// whose whole point is surviving a long stretch with the app closed — keeps
// working for an inactive-but-real user.
export const SUBSCRIPTION_TTL_SECONDS = 40 * 24 * 60 * 60;

// Pages of a mailbox's first-read backlog one check may fetch (see
// checkMailboxForPayments). Kept well under the 50 subrequests a Free plan
// invocation allows, so a shard's other mailboxes still get their read in the
// same tick.
export const MAX_BACKLOG_PAGES_PER_TICK = 5;

// Same primary/fallback esplora-compatible hosts as index.ts's
// FEES_PRIMARY/FALLBACK (and src/lib/wallet/walletWorkerGuard.ts's client-side
// config) — already trusted as this wallet's chain source, so reusing them
// here for a tip-height read needs no new allowlist entry.
const TIP_HEIGHT_PRIMARY = "https://mempool.second.tech/api/blocks/tip/height";
const TIP_HEIGHT_FALLBACK = "https://mempool.space/api/blocks/tip/height";

// The expiry check only needs a fresh-enough tip (blocks land every ~10min;
// EXPIRY_NUDGE_THRESHOLD_BLOCKS/EXPIRY_URGENT_THRESHOLD_BLOCKS work in whole
// blocks anyway), not a per-request one.
async function fetchTipHeight(): Promise<number | undefined> {
  for (const url of [TIP_HEIGHT_PRIMARY, TIP_HEIGHT_FALLBACK]) {
    try {
      const res = await fetch(url, { signal: upstreamSignal() });
      if (!res.ok) continue;
      const text = await res.text();
      const height = Number(text.trim());
      if (Number.isInteger(height) && height > 0) return height;
    } catch {
      // Try the fallback (or give up after both fail) — a missed check just
      // means the expiry check skips this run, not a broken push.
    }
  }
  return undefined;
}

// Every subscribed mailbox's own Durable Object alarm calls this
// independently (see mailboxWatcher.ts) — there's no single shared tick left
// to memoize across the way the old global-cron design had, so without a
// cache this would scale linearly with subscriber count instead of staying
// flat. mempool.space/second.tech have no CoinGecko-style credit budget to
// protect, but there's still no reason to make N redundant calls a minute
// for data that's stale the instant a new block lands roughly every 10
// minutes anyway — a short edge cache, same caches.default pattern as the
// price proxy, collapses however many DOs ask within the window into at
// most one real call.
const TIP_HEIGHT_CACHE_TTL_SECONDS = 120;
const TIP_HEIGHT_CACHE_KEY = new Request("https://price-cache.internal/tip-height");

export async function fetchTipHeightCached(): Promise<number | undefined> {
  const cache = caches.default;
  const cached = await cache.match(TIP_HEIGHT_CACHE_KEY);
  if (cached) {
    const data = (await cached.json()) as { height: number };
    return data.height;
  }
  const height = await fetchTipHeight();
  if (height !== undefined) {
    await cache.put(
      TIP_HEIGHT_CACHE_KEY,
      new Response(JSON.stringify({ height }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${TIP_HEIGHT_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  }
  return height;
}

// Reuses the exact same cache entry (and in-flight fetch) as index.ts's
// handlePriceProxy /api/price/simple branch, via the same
// SIMPLE_PRICE_CACHE_KEY/SIMPLE_PRICE_TARGET — every subscribed mailbox's own
// Durable Object alarm calls this independently, but the underlying edge
// cache still collapses however many DOs ask within the same
// PRICE_CACHE_TTL_SECONDS window into at most one real upstream call, so the
// CoinGecko cost stays flat regardless of subscriber count. No rate-limit
// key: this is server-initiated, not attributable to a caller.
export async function fetchCurrentBtcPriceUsd(env: Env): Promise<number | undefined> {
  try {
    const result = await fetchSimplePriceCached(env);
    if (result.status < 200 || result.status >= 300) return undefined;
    const data = JSON.parse(result.body) as { bitcoin?: { usd?: number } };
    const usd = data.bitcoin?.usd;
    return typeof usd === "number" && usd > 0 ? usd : undefined;
  } catch {
    return undefined;
  }
}

// Deliberately calm, non-technical copy, see EXPIRY_NUDGE_THRESHOLD_BLOCKS's
// comment above for why: an unrefreshed VTXO doesn't lose funds, only its
// unilateral-exit guarantee, so only the last stage says it is running out.
// Only the first stage carries the price: a move since the last look is the
// reason to open the app now, the later stages just repeat the ask.
// currentPriceUsd/baselinePriceUsd are best-effort snapshots, either missing
// (or a ~0% move) leaves the price clause out.
export function describeExpiryNudge(
  stage: "first" | "reminder" | "urgent",
  baselinePriceUsd: number | undefined,
  currentPriceUsd: number | undefined,
): string {
  if (stage === "urgent") return "Mince brzy vyprší. Otevři Spendrr hned.";
  if (stage === "reminder") return "Obnova mincí pořád čeká. Otevři Spendrr.";
  const base = "Mince čekají na obnovu. Otevři Spendrr.";
  const pct = expiryPricePct(baselinePriceUsd, currentPriceUsd);
  if (pct === undefined) return base;
  const formatted = Math.abs(pct).toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `BTC mezitím ${pct > 0 ? "vyrostl" : "spadl"} o ${formatted} % ${pct > 0 ? "📈" : "📉"}. ${base}`;
}

// Signed move in percent, 1 decimal, or undefined when a price is missing or
// the move is under 0.1 %. Sent along as data so the device can word the push
// in its own language (public/sw.js); the Czech body above is the fallback.
export function expiryPricePct(baselinePriceUsd: number | undefined, currentPriceUsd: number | undefined): number | undefined {
  if (!baselinePriceUsd || !currentPriceUsd) return undefined;
  const pct = ((currentPriceUsd - baselinePriceUsd) / baselinePriceUsd) * 100;
  if (Math.abs(pct) < 0.1) return undefined;
  return Math.round(pct * 10) / 10;
}

// A push subscription's endpoint is chosen by the *browser's* push service,
// never by this app — so it can be checked against the small, closed set of
// hosts those services actually use. Without this, `https://` was the only
// requirement, which turned this into a request generator aimed wherever the
// caller liked: the expiry-nudge path (checkVtxoExpiry) deliberately needs
// no valid mailboxAuthorization, and a non-2xx response there is treated as
// "retry next check", so one registration with a made-up mailboxId and an
// arbitrary endpoint meant a POST to that URL every 60 seconds for as long
// as the reported blockheight stayed in range.
//
// If a legitimate browser's push endpoint is ever rejected here, push simply
// stops working for it and the console line below says so — this list is the
// first place to look.
const PUSH_ENDPOINT_HOSTS = [
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
  "fcm.googleapis.com", // Chrome/Chromium, current
  "android.googleapis.com", // Chrome, legacy GCM endpoint
  "notify.windows.com", // Edge (*.notify.windows.com)
  "push.apple.com", // Safari/iOS (web.push.apple.com)
];

export function isKnownPushEndpoint(endpoint: string): boolean {
  // The Android app's FCM registration (see fcm.ts): not a URL at all, only
  // ever sent to fcm.googleapis.com with this Worker's own credentials.
  if (isFcmEndpoint(endpoint)) return true;
  let host: string;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    host = url.hostname;
  } catch {
    return false;
  }
  return PUSH_ENDPOINT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// Confirms `mailboxAuthorization` is actually accepted by the real Ark
// server for this mailboxId before a MailboxWatcher DO (mailboxWatcher.ts)
// trusts it enough to create or overwrite a push subscription. Before this
// existed, neither value was ever checked against anything beyond a regex —
// and mailboxId is explicitly documented (see ARCHITECTURE.md) as safe to hand to
// a third party for *reading*, i.e. not secret. That combination meant
// anyone who merely knew a victim's mailboxId could silently hijack or break
// their push subscription with a fabricated authorization, and anyone at all
// could mint unlimited syntactically-valid-but-fake mailboxes for free —
// each one a real Durable Object entry that then spent a real subrequest
// against this Ark server every minute for up to 24h. See
// mailboxWatcher.ts's SHARD_TARGET_MAX_MAILBOXES for the other half of that
// fix (bounding how many mailboxes — valid or not — one shard will ever
// carry).
//
// CORRECTION 2026-09-21: the first version of this check called readMailbox()
// and counted any non-null result as "authorized". That never rejected
// anything: the Ark server reports a refused request as HTTP 200 with an empty
// body and `grpc-status: 3` in the headers, which readMailbox() reads as "no
// messages". Garbage ids and authorizations, forged signatures and an
// authorization for another mailbox all passed (probed live). It now goes
// through probeMailboxAuthorization() (worker/mailbox.ts), which reads that
// status and never downloads the mailbox body, so it also no longer needs a
// checkpoint. Confirmed in both directions on 2026-09-21: garbage refused, and
// a real authorization from a real wallet accepted (the @handle registration
// uses the same probe).
export async function verifyMailboxAuthorization(
  mailboxId: string,
  mailboxAuthorization: string,
): Promise<boolean> {
  // The cheap local checks first: same mailbox in both, not expired. They also
  // spare the Ark server a call for input that could never be valid.
  if (mailboxAuthorizationProblem(mailboxId, mailboxAuthorization, Date.now() / 1000) !== null) return false;
  return probeMailboxAuthorization(ARK_SERVER, mailboxId, mailboxAuthorization);
}

// FCM (Android app) payloads are readable by Google, unlike Web Push, so they
// say that a payment arrived and nothing about how much. See fcm.ts.
const FCM_PAYMENT_BODY = "Přijatá platba";

// One send, either transport, picked by the stored endpoint (fcm.ts).
async function sendPush(
  env: Env,
  subscription: PushSubscriptionRecord["subscription"],
  msg: PushMessage,
): Promise<{ ok: boolean; status: number; shouldDeleteSubscription: boolean }> {
  // A transport that throws (timeout, connection reset, bad key material) is
  // a failed send, not a reason to abandon the rest of this mailbox's events:
  // the checkpoint is already persisted, so an exception here used to drop
  // every remaining push of the batch for good.
  try {
    return await sendPushOnce(env, subscription, msg);
  } catch (e) {
    console.error("push transport threw", e instanceof Error ? e.message : e);
    return { ok: false, status: 0, shouldDeleteSubscription: false };
  }
}

async function sendPushOnce(
  env: Env,
  subscription: PushSubscriptionRecord["subscription"],
  msg: PushMessage,
): Promise<{ ok: boolean; status: number; shouldDeleteSubscription: boolean }> {
  if (isFcmEndpoint(subscription.endpoint)) {
    return sendFcm(env.FCM_SERVICE_ACCOUNT, subscription.endpoint, msg);
  }
  if (!env.VAPID_PRIVATE_KEY) return { ok: false, status: 0, shouldDeleteSubscription: false };
  const keys: PushSubscriptionKeys = {
    endpoint: subscription.endpoint,
    p256dhBase64Url: subscription.keys.p256dh,
    authBase64Url: subscription.keys.auth,
  };
  const payload = new TextEncoder().encode(JSON.stringify(msg));
  // Without "high" an Android phone in Doze holds the push until it wakes
  // (seen live: the payment push showed up only when the app was opened).
  // FCM above sends priority HIGH for the same reason. An expiry nudge can wait.
  return sendWebPush(keys, payload, env.VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT, {
    urgency: msg.type === "expiry" ? "normal" : "high",
  });
}

function describeEvent(event: MailboxReceiveEvent): string {
  // Protocol (Lightning vs. Ark) is an implementation detail the recipient
  // has no use for, so it's deliberately left out of the copy here.
  if (event.kind === "lightning") {
    const sats = Math.floor(event.amountMsat / 1000);
    return `Přijatá platba ${sats.toLocaleString("cs-CZ")} sats`;
  }
  // amountSat is a best-effort hand-parse of the raw VTXO's fixed-offset
  // amount field (see mailbox.ts's readVtxoAmountSat) — 0 means parsing
  // found nothing usable (unexpected wire shape), fall back to no amount
  // rather than showing "0 sats".
  if (event.amountSat > 0) {
    return `Přijatá platba ${event.amountSat.toLocaleString("cs-CZ")} sats`;
  }
  return "Přijatá platba";
}

// Reads new mailbox events and sends payment pushes for them. Returns true if
// the push subscription was deleted along the way (404/410 from the push
// service) — the caller must not touch `record`/`store` for this mailboxId
// again after that. Only the payment-mailbox read needs a live
// mailboxAuthorization — the expiry-nudge check (checkVtxoExpiry) needs none
// of it (it never touches the Ark mailbox at all), so callers must not gate
// that behind this. Getting this wrong was a real bug: a 24 h authorization
// lifetime and EXPIRY_NUDGE_THRESHOLD_BLOCKS (144 blocks, also ~24h) are close
// enough in magnitude that for exactly the target scenario — app opened
// once, then left closed for most of a VTXO's ~28-day lifetime —
// authExpiresAt had always already lapsed by the time the nudge window
// opened, so the nudge could never fire for the users who most need it (see
// mailboxWatcher.ts's alarm() for the actual caller and this gating).
export async function checkMailboxForPayments(
  env: Env,
  mailboxId: string,
  record: PushSubscriptionRecord,
  store: RecordStore,
): Promise<boolean> {
  const startingCheckpoint = BigInt(record.checkpoint);
  // checkpoint 0 means "never read this mailbox before" — the very first
  // read for a wallet returns its *entire* history (every payment it ever
  // received), not just what's new. `backfilling` marks a first read that has
  // been spread over several ticks (below): the checkpoint is then how far it
  // got, not "up to date".
  const isFirstEverRead = startingCheckpoint === 0n || record.backfilling === true;

  let events: MailboxReceiveEvent[] = [];
  let newCheckpoint = startingCheckpoint;

  if (isFirstEverRead) {
    // Drains the backlog without notifying for any of it. A paginated response
    // returns it across several ReadMailbox calls, and persisting a plain
    // checkpoint after only some pages would make the next check read the rest
    // as fresh activity and push years-old payments; that is what the
    // `backfilling` flag prevents while progress is kept between ticks.
    //
    // At most MAX_BACKLOG_PAGES_PER_TICK pages per check. Every page is one
    // subrequest, a Workers Free invocation allows 50, and this loop had no
    // bound: a wallet with a long history (a year of daily use) never finished
    // its first read, spent the shard's whole budget on every tick, and starved
    // every other mailbox in the shard. Progress is now committed after each
    // tick's pages and the read resumes on the next one.
    let cursor = startingCheckpoint;
    let drained = false;
    let pages = 0;
    while (pages < MAX_BACKLOG_PAGES_PER_TICK) {
      const page = await readMailbox(ARK_SERVER, mailboxId, record.mailboxAuthorization, cursor);
      pages++;
      // A failed page keeps what earlier pages of this tick achieved.
      if (!page) break;
      // The checkpoint must strictly advance on every page. A page that
      // claims haveMore but doesn't move the cursor forward (an empty page,
      // or one whose messages all carry checkpoint <= cursor) would otherwise
      // repeat forever. Treat a non-advancing page as "backlog drained" and
      // let the next check start from the same cursor.
      if (page.nextCheckpoint <= cursor) {
        drained = true;
        break;
      }
      cursor = page.nextCheckpoint;
      if (!page.haveMore) {
        drained = true;
        break;
      }
    }
    if (cursor !== startingCheckpoint || (drained && record.backfilling)) {
      record.checkpoint = cursor.toString();
      if (drained) delete record.backfilling;
      else record.backfilling = true;
      await store.put(record);
    }
    return false; // Never notifies for backlog.
  } else {
    const result = await readMailbox(ARK_SERVER, mailboxId, record.mailboxAuthorization, startingCheckpoint);
    if (!result) return false; // Network hiccup or unexpected response — retry next time.
    if (result.nextCheckpoint > startingCheckpoint) newCheckpoint = result.nextCheckpoint;
    events = result.events;
  }

  const changed = newCheckpoint !== startingCheckpoint;
  if (changed) {
    record.checkpoint = newCheckpoint.toString();
    // Persisted *before* sending any push below — sendWebPush calls happen
    // one at a time and the Worker can be killed mid-loop (CPU limit,
    // waitUntil expiry); persisting first means that costs at most one
    // missed push per event (the in-app watcher is the real source of
    // truth for a payment landing) rather than re-sending the same push
    // again next time once the checkpoint before them was never saved.
    await store.put(record);
  }

  // Whether a foreground tab already showed this in-app is now decided
  // client-side, in real time, by the Service Worker's push handler
  // (public/sw.js) — it can check actual current visibility/focus, unlike
  // this Worker which only ever knows a stale "last seen" timestamp from
  // whenever /api/push/subscribe was last posted (i.e. last app open, not
  // "still open now"). That mismatch used to silently drop pushes for up to
  // 90s after every app open/close. Always send; the client decides whether
  // to actually surface it.
  // One line per read that moved the checkpoint, success included: without it
  // a push that never left looks the same as one the phone never showed.
  if (changed) console.log("mailbox read", mailboxId.slice(0, 10), `payments ${events.length}`);
  if (events.length > 0) {
    const fcm = isFcmEndpoint(record.subscription.endpoint);
    for (const event of events) {
      const body = fcm ? FCM_PAYMENT_BODY : describeEvent(event);
      const sendResult = await sendPush(env, record.subscription, { title: "Spendrr", body });
      console.log("push sent", mailboxId.slice(0, 10), sendResult.status, new URL(record.subscription.endpoint).host);
      if (!sendResult.ok) {
        console.error("push send failed", mailboxId, sendResult.status);
      }
      if (sendResult.shouldDeleteSubscription) {
        // Gone (404/410 from the push service) — this mailbox's Durable
        // Object sees an empty store on its next alarm() and simply doesn't
        // reschedule itself, so nothing extra needs cleaning up here beyond
        // the record itself.
        await store.delete();
        return true;
      }
    }
  }
  return false;
}

// At most 3 pushes per watched blockheight: a calm nudge once the refresh
// engine could run, a calm reminder ~24 h before expiry, and a last one close
// to actual expiry. A stage already past when a check first sees the coin
// (a late subscribe, a lagging sweep) sends only the current stage, and marks
// every earlier one as sent so they don't follow back to back. Once the client
// reports a new (later) firstExpiringVtxoBlockheight, all markers stop
// matching and this starts over for free (see index.ts's handlePushSubscribe).
//
// The record is re-read after every await that lets a subscribe land (the tip
// fetch, the push itself) and only the markers are written into the fresh copy:
// writing back the object loaded before them used to put an older watched
// height or checkpoint back.
export async function checkVtxoExpiry(
  env: Env,
  mailboxId: string,
  record: PushSubscriptionRecord,
  getTipHeight: () => Promise<number | undefined>,
  getCurrentPriceUsd: () => Promise<number | undefined>,
  store: RecordStore,
): Promise<void> {
  // Cheap/sync check first: only calls the (cached) tip height fetch for a
  // mailbox that actually has something to watch.
  if (record.firstExpiringVtxoBlockheight === undefined) return;
  const tipHeight = await getTipHeight();
  if (tipHeight === undefined) return;

  // Out of range on what was loaded: the common case, no extra storage read.
  const loadedRemaining = record.firstExpiringVtxoBlockheight - tipHeight;
  if (loadedRemaining <= 0 || loadedRemaining > EXPIRY_NUDGE_THRESHOLD_BLOCKS) return;

  const current = await store.get();
  if (!current || current.firstExpiringVtxoBlockheight === undefined) return;
  const watchedHeight = current.firstExpiringVtxoBlockheight;

  const remaining = watchedHeight - tipHeight;
  if (remaining <= 0 || remaining > EXPIRY_NUDGE_THRESHOLD_BLOCKS) return;

  const stage = expiryStage(remaining);
  const sent = {
    first: current.expiryNotifiedForHeight === watchedHeight,
    reminder: current.expiryReminderNotifiedForHeight === watchedHeight,
    urgent: current.expiryUrgentNotifiedForHeight === watchedHeight,
  };
  if (sent[stage]) return;

  // Only fetched now that we know we're actually about to send: a
  // mailbox that's within threshold but already deduped never spends this.
  const currentPriceUsd = await getCurrentPriceUsd();
  const body = describeExpiryNudge(stage, current.lastKnownPriceUsd, currentPriceUsd);
  // The language is the device's business: the stage and the price move go
  // along as data and sw.js words them from the app's own copy, the Czech body
  // is what an older worker or an app without the copy shows.
  const pct = stage === "first" ? expiryPricePct(current.lastKnownPriceUsd, currentPriceUsd) : undefined;
  const sendResult = await sendPush(env, current.subscription, {
    title: "Spendrr",
    body,
    type: "expiry",
    data: { stage, ...(pct !== undefined ? { pct: String(pct) } : {}) },
  });
  if (!sendResult.ok) {
    console.error("push send (expiry) failed", mailboxId, sendResult.status);
    return; // Don't mark as sent, retry next time.
  }

  if (sendResult.shouldDeleteSubscription) {
    // Gone (404/410 from the push service): no point writing the dedup
    // markers first just to delete the whole record immediately after.
    await store.delete();
    return;
  }

  const fresh = await store.get();
  // Gone, or the client moved the watch while the push was in flight: the new
  // height gets its own nudges.
  if (!fresh || fresh.firstExpiringVtxoBlockheight !== watchedHeight) return;
  fresh.expiryNotifiedForHeight = watchedHeight;
  if (stage !== "first") fresh.expiryReminderNotifiedForHeight = watchedHeight;
  if (stage === "urgent") fresh.expiryUrgentNotifiedForHeight = watchedHeight;
  await store.put(fresh);
}

export function expiryStage(remaining: number): "first" | "reminder" | "urgent" {
  if (remaining <= EXPIRY_URGENT_THRESHOLD_BLOCKS) return "urgent";
  if (remaining <= EXPIRY_REMINDER_THRESHOLD_BLOCKS) return "reminder";
  return "first";
}
