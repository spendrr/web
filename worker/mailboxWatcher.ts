// Sharded Durable Object replacing both the old global per-minute cron
// (checkAllMailboxes/checkOneMailbox, see git history — shared ONE
// Cloudflare per-invocation subrequest budget across every subscriber,
// capping the app at ~40 push subscribers on the free plan) and a brief
// one-DO-per-mailbox design (see git history again — solved the subrequest
// problem but ran into a *different* free-tier cap: Durable Objects get
// ~3M requests/month, and a request-per-mailbox-per-minute schedule burns
// that budget at ~69 subscribers, since every alarm firing is one request
// regardless of how much work it does inside).
//
// The fix: a fixed, small number of shards (SHARD_COUNT), each a Durable
// Object holding many mailboxes (see shardIdFor in index.ts for how a
// mailboxId maps to one). One shard's alarm firing is still just one
// request against the 3M/month budget, but it batches ~SHARD_COUNT-th of
// all subscribers through it — so the DO request budget stops scaling with
// subscriber count at all past the point where mailboxes start sharing
// shards, while the actual network calls inside one alarm or poke (bounded
// by CHECKS_PER_INVOCATION: an alarm sweeps a rotating slice) stay under
// Cloudflare's *separate* per-invocation external-subrequest cap (50 on the
// free plan). SHARD_COUNT x SHARD_TARGET_MAX_MAILBOXES is the subscriber
// ceiling; the slice size sets how long a full sweep takes.
//
// The actual payment/expiry-check logic (checkMailboxForPayments,
// checkVtxoExpiry) is unchanged and lives in mailboxShared.ts, parameterized
// over a RecordStore (see index.ts) — this file only supplies one backed by
// this shard's own storage, keyed per mailboxId instead of a single record.

import {
  checkMailboxForPayments,
  checkVtxoExpiry,
  fetchCurrentBtcPriceUsd,
  fetchTipHeightCached,
  SUBSCRIPTION_TTL_SECONDS,
  pushAuthExpiry,
  isKnownPushEndpoint,
  MAX_BACKLOG_PAGES_PER_TICK,
  MAX_PLAUSIBLE_BLOCKHEIGHT,
  verifyMailboxAuthorization,
} from "./mailboxShared";
import type { Env, PushSubscriptionRecord, RecordStore } from "./index";
import { applyHeightUpdate } from "./pushHeight";
import { relayConfigured, relayRegister, relayUnregister, SWEEP_INTERVAL_MS } from "./pushRelay";

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  id: { name?: string; toString(): string };
  storage: DurableObjectStorage;
}

// How often a shard sweeps its mailboxes is SWEEP_INTERVAL_MS (pushRelay.ts),
// 15 minutes: the push relay streams them and pokes this shard the moment a
// payment lands (handlePoke). Each firing is one Durable Object request.
// A brand-new subscribe gets checked almost immediately rather than waiting
// a full interval for its first alarm — better first-run experience, and
// costs nothing extra since a shard's alarm already fires
// on its own schedule regardless of how many mailboxes it is carrying.
const FIRST_ALARM_DELAY_MS = 2_000;

// The per-alarm batch size within one shard — same reasoning as the old
// cron's MAILBOX_BATCH_SIZE (see git history): bounds concurrent in-flight
// work per firing. Unlike the old cron, this never needs to be larger than
// one shard's own mailbox count, since a shard is sized (via SHARD_COUNT in
// index.ts) to stay well under the external-subrequest-per-invocation cap on
// its own — see this file's own top comment.
const BATCH_SIZE = 20;

// How many mailbox reads one invocation (an alarm or a poke) spends. A check is
// one read, or up to MAX_BACKLOG_PAGES_PER_TICK while a mailbox's first read is
// still draining its history (readCost), and every read is a subrequest. The
// Free plan allows 50 per invocation; the rest is headroom for the tip-height
// and price fetches checkVtxoExpiry shares, a push sent for a payment, and the
// relay calls.
// Once the budget is spent, every later fetch in the same invocation fails
// too (each treated as "a hiccup, retry next tick"), so an invocation that
// tried to check every mailbox of a large shard would silently check none of
// the last ones.
export const CHECKS_PER_INVOCATION = 30;

// Caps how many mailboxes one shard will ever carry, valid or not: anyone can
// pick a mailboxId that lands in a given shard. Since the sweep checks a slice
// worth CHECKS_PER_INVOCATION reads per alarm (see runChecks), this no longer
// has to fit one invocation's subrequest budget; it sets how long a full pass
// takes, ceil(200 / 30) alarms of SWEEP_INTERVAL_MS, about 1 h 45 min for a
// full shard of mailboxes past their first read. For payments that pass is the
// safety net while the relay is down; with the relay up, a payment is read the
// moment the relay pokes. The VTXO expiry nudge and the exit wake-up come only
// from this pass, relay or not, so in a full shard they can be that late. 64 shards x 200 = 12,800
// push subscribers.
export const SHARD_TARGET_MAX_MAILBOXES = 200;

// Where the next sweep slice starts (an index into `ids`), and ids a poke
// could not check in its own invocation (see handlePoke).
const CURSOR_KEY = "cursor";
const POKE_QUEUE_KEY = "pokeQueue";
// How soon an alarm drains what a poke left over.
const POKE_OVERFLOW_DELAY_MS = 1_000;

const IDS_KEY = "ids";
// This shard's own name (index.ts sends it with every subscribe), for the push relay.
const SHARD_KEY = "shard";
function recordKey(mailboxId: string): string {
  return `record:${mailboxId}`;
}

interface SubscribeBody {
  mailboxId: string;
  mailboxAuthorization: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  // Presence-vs-absence matters, not just the value — see index.ts's
  // handlePushSubscribe (the tri-state comment there) for why a bare
  // `undefined` (omitted key) must be treated differently than an explicit
  // `null`. JSON can express exactly that distinction (an omitted key vs. a
  // present `null`), which is why this is forwarded as-is rather than
  // pre-resolved into the final "effective" value on the Worker side.
  firstExpiringVtxoBlockheight?: number | null;
  priceUsd?: number;
  // SHA-256 of the client's height token (pushHeight.ts); index.ts hashes it.
  heightTokenHash?: string;
  shard?: string;
}

// Runs `fn` at most once and hands every caller the same promise.
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => (promise ??= fn());
}

export class MailboxWatcher {
  private state: DurableObjectState;
  private env: Env;
  // One payment check per mailbox at a time. A poke and the sweep can arrive
  // together (a Durable Object interleaves requests at every await), and two
  // reads from the same checkpoint would push the same payment twice.
  private chains = new Map<string, Promise<unknown>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private serialize<T>(mailboxId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(mailboxId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.catch(() => {});
    this.chains.set(mailboxId, settled);
    void settled.then(() => {
      if (this.chains.get(mailboxId) === settled) this.chains.delete(mailboxId);
    });
    return next;
  }

  // Reads the record inside the queue, so a check that waited behind another
  // starts from the checkpoint that one left.
  private checkPayments(mailboxId: string, now: number): Promise<boolean> {
    return this.serialize(mailboxId, async () => {
      const store = this.recordStoreFor(mailboxId);
      const record = await store.get();
      if (!record || record.authExpiresAt <= now) return false;
      return checkMailboxForPayments(this.env, mailboxId, record, store).catch((e) => {
        console.error("checkMailboxForPayments failed", mailboxId, e instanceof Error ? e.stack : e);
        return false;
      });
    });
  }

  private async removeId(mailboxId: string): Promise<void> {
    const ids = await this.readIds();
    const idx = ids.indexOf(mailboxId);
    if (idx !== -1) {
      ids.splice(idx, 1);
      await this.writeIds(ids);
    }
  }

  private recordStoreFor(mailboxId: string): RecordStore {
    const key = recordKey(mailboxId);
    return {
      get: async () => (await this.state.storage.get<PushSubscriptionRecord>(key)) ?? null,
      put: (record) => this.state.storage.put(key, record),
      delete: async () => {
        await this.state.storage.delete(key);
      },
    };
  }

  private async shardName(): Promise<string | undefined> {
    return this.state.storage.get<string>(SHARD_KEY);
  }

  private async readIds(): Promise<string[]> {
    return (await this.state.storage.get<string[]>(IDS_KEY)) ?? [];
  }

  private async writeIds(ids: string[]): Promise<void> {
    await this.state.storage.put(IDS_KEY, ids);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/subscribe") {
      return this.handleSubscribe(request);
    }
    if (request.method === "POST" && url.pathname === "/unsubscribe") {
      return this.handleUnsubscribe(request);
    }
    if (request.method === "POST" && url.pathname === "/has") {
      return this.handleHas(request);
    }
    if (request.method === "POST" && url.pathname === "/height") {
      return this.handleHeight(request);
    }
    if (request.method === "POST" && url.pathname === "/poke") {
      return this.handlePoke(request);
    }
    return new Response("Not found", { status: 404 });
  }

  // Cheap existence probe used only by index.ts's shard allocator, to decide
  // whether a mailboxId with no shard-assignment KV entry is a genuinely new
  // subscriber (route it through bin-packing) or a pre-allocator subscriber
  // still living in its original hash(mailboxId) % SHARD_COUNT shard (must
  // keep going back there, not get bin-packed into a different shard —
  // otherwise its old record here would go stale rather than update, and for
  // the rest of SUBSCRIPTION_TTL_SECONDS both this shard and the new one
  // would independently poll the same mailbox and could each fire the same
  // push). One storage read, no side effects.
  private async handleHas(request: Request): Promise<Response> {
    const { mailboxId } = (await request.json()) as { mailboxId?: unknown };
    const exists = typeof mailboxId === "string" && (await this.recordStoreFor(mailboxId).get()) !== null;
    return new Response(JSON.stringify({ exists }), { status: 200 });
  }

  // Mirrors the merge logic that used to live directly in
  // handlePushSubscribe against a KV record — same field-by-field
  // reasoning, just reading "existing" from this shard's own storage,
  // keyed per mailboxId, instead of a shared KV entry. index.ts still does
  // all the wire-format validation (mailboxId shape, mailboxAuthorization
  // shape, blockheight sanity, known-push-endpoint check) before ever
  // reaching this DO; this trusts the body it's given the same way the old
  // code trusted an already-validated record.
  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as SubscribeBody;
    const { mailboxId, mailboxAuthorization } = body;
    const { endpoint, keys } = body.subscription;
    if (!isKnownPushEndpoint(endpoint)) {
      // Defense in depth — index.ts already checks this, but a DO is
      // reachable only via the Worker's own binding, never directly, so this
      // is just cheap insurance against a future caller skipping that check.
      return new Response(JSON.stringify({ error: "Unrecognized push endpoint." }), { status: 400 });
    }

    const store = this.recordStoreFor(mailboxId);
    const existing = await store.get();

    // Only a genuinely new mailboxId can hit this — see
    // SHARD_TARGET_MAX_MAILBOXES's own comment. Checked before the
    // Ark-server round trip below so a flood aimed at one shard fails fast
    // rather than also paying for a network call per rejected attempt.
    // Reading `ids` then deciding is safe from a concurrent-subscribe race
    // without extra locking: a Durable Object processes its own requests one
    // at a time, so no other `fetch()` call on this same instance can be
    // interleaved between this read and the `ids.push` below.
    if (!existing) {
      const ids = await this.readIds();
      if (ids.length >= SHARD_TARGET_MAX_MAILBOXES) {
        return new Response(JSON.stringify({ error: "Shard capacity reached." }), { status: 429 });
      }
    }

    // Watched until its own expiry; one longer than the app ever signs is
    // refused before the Ark server is asked (pushAuthExpiry).
    const authExpiresAt = pushAuthExpiry(mailboxAuthorization, Math.floor(Date.now() / 1000));
    if (authExpiresAt === null) {
      return new Response(JSON.stringify({ error: "Invalid mailbox authorization." }), { status: 403 });
    }

    // See verifyMailboxAuthorization's own comment: this used to accept any
    // input, and is now a real check.
    const authorized = await verifyMailboxAuthorization(mailboxId, mailboxAuthorization);
    if (!authorized) {
      return new Response(JSON.stringify({ error: "Invalid mailbox authorization." }), { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);

    const hasHeightField = Object.prototype.hasOwnProperty.call(body, "firstExpiringVtxoBlockheight");
    const rawHeight = body.firstExpiringVtxoBlockheight;
    const validHeight: number | null | undefined = !hasHeightField
      ? undefined
      : rawHeight === null
        ? null
        : typeof rawHeight === "number" &&
            Number.isInteger(rawHeight) &&
            rawHeight > 0 &&
            rawHeight <= MAX_PLAUSIBLE_BLOCKHEIGHT
          ? rawHeight
          : undefined;
    const validPriceUsd =
      typeof body.priceUsd === "number" && Number.isFinite(body.priceUsd) && body.priceUsd > 0
        ? body.priceUsd
        : undefined;

    const record: PushSubscriptionRecord = {
      mailboxAuthorization: body.mailboxAuthorization,
      authExpiresAt,
      subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      checkpoint: existing?.checkpoint ?? "0",
      // A renewal in the middle of a spread-out first read must not forget it
      // is one (see PushSubscriptionRecord.backfilling).
      ...(existing?.backfilling ? { backfilling: true } : {}),
      lastSeenAt: now,
      lastKnownPriceUsd: validPriceUsd ?? existing?.lastKnownPriceUsd,
      // Only set here, after verifyMailboxAuthorization passed: the one
      // proof /height accepts later without the Ark server (pushHeight.ts).
      heightTokenHash: body.heightTokenHash ?? existing?.heightTokenHash,
    };
    const effectiveHeight = validHeight === null ? undefined : (validHeight ?? existing?.firstExpiringVtxoBlockheight);
    record.firstExpiringVtxoBlockheight = effectiveHeight;
    if (existing?.firstExpiringVtxoBlockheight === effectiveHeight) {
      record.expiryNotifiedForHeight = existing?.expiryNotifiedForHeight;
      record.expiryReminderNotifiedForHeight = existing?.expiryReminderNotifiedForHeight;
      record.expiryUrgentNotifiedForHeight = existing?.expiryUrgentNotifiedForHeight;
    }
    await store.put(record);

    // Only a genuinely new mailboxId needs adding to this shard's list — a
    // re-subscribe (the daily refresh, or the same device re-enabling) is
    // already in it from the first time.
    if (!existing) {
      const ids = await this.readIds();
      if (!ids.includes(mailboxId)) {
        ids.push(mailboxId);
        await this.writeIds(ids);
      }
    }

    // Only schedule if nothing is pending yet — a re-subscribe (the daily
    // auth refresh) must not push the next check further away than it
    // already was, and a shard already carrying other mailboxes already has
    // one running.
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + FIRST_ALARM_DELAY_MS);
    }
    // The relay starts streaming from this shard's own checkpoint, so it
    // pokes only for what this shard has not read yet. 202 when a configured
    // relay did not take the registration: stored, but only the sweep watches
    // it, so the app must not count this subscribe as done (notifications.ts
    // sends the next one at its next trigger instead of hours later).
    if (typeof body.shard === "string") {
      if ((await this.shardName()) !== body.shard) await this.state.storage.put(SHARD_KEY, body.shard);
      const registered = await relayRegister(this.env, mailboxId, mailboxAuthorization, record.checkpoint, body.shard);
      if (!registered && relayConfigured(this.env)) return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 204 });
  }

  // The push relay saw a payment arrive in these mailboxes (index.ts checked
  // its signature). Only ids this shard carries; each is read here, from its
  // own checkpoint, exactly as the sweep would.
  private async handlePoke(request: Request): Promise<Response> {
    const { ids } = (await request.json()) as { ids?: unknown };
    if (!Array.isArray(ids)) return new Response(null, { status: 400 });
    const mine = new Set(await this.readIds());
    const now = Math.floor(Date.now() / 1000);
    const targets = [...new Set(ids.filter((id): id is string => typeof id === "string" && mine.has(id)))];
    console.log("poke", `${targets.length}/${ids.length} carried here`);
    // More than one invocation can check: the rest waits for an alarm a
    // second from now, ahead of the sweep (see runChecks).
    const { taken: first } = await this.takeWithin(targets, CHECKS_PER_INVOCATION, true);
    const later = targets.slice(first.length);
    if (later.length > 0) {
      const queued = (await this.state.storage.get<string[]>(POKE_QUEUE_KEY)) ?? [];
      await this.state.storage.put(POKE_QUEUE_KEY, [...new Set([...queued, ...later])]);
      await this.state.storage.setAlarm(Date.now() + POKE_OVERFLOW_DELAY_MS);
    }
    await this.checkPaymentsAndForget(first, now);
    return new Response(null, { status: 204 });
  }

  // Mailbox reads one check of this mailbox can make (see CHECKS_PER_INVOCATION).
  // An unreadable record counts as one: its check fails on the same read.
  private async readCost(mailboxId: string): Promise<number> {
    try {
      const record = await this.recordStoreFor(mailboxId).get();
      return record && (record.checkpoint === "0" || record.backfilling) ? MAX_BACKLOG_PAGES_PER_TICK : 1;
    } catch {
      return 1;
    }
  }

  // The longest prefix of `ids` whose reads fit `budget`. With `atLeastOne`, a
  // mailbox costing more than the whole budget is still taken on its own, or
  // it would never be checked.
  private async takeWithin(ids: string[], budget: number, atLeastOne: boolean): Promise<{ taken: string[]; spent: number }> {
    const taken: string[] = [];
    let spent = 0;
    for (const id of ids) {
      const cost = await this.readCost(id);
      if (spent + cost > budget && !(atLeastOne && taken.length === 0)) break;
      taken.push(id);
      spent += cost;
    }
    return { taken, spent };
  }

  private async checkPaymentsAndForget(targets: string[], now: number): Promise<void> {
    const results = await Promise.allSettled(targets.map((id) => this.checkPayments(id, now)));
    await Promise.all(
      results.map(async (r, i) => {
        if (r.status === "fulfilled" && r.value) {
          await this.removeId(targets[i]);
          await relayUnregister(this.env, targets[i], await this.shardName());
        }
      }),
    );
  }

  // Same guard the old code applied inline (checkMailboxForPayments's
  // "shouldDeleteSubscription" branches, and the pre-DO handlePushUnsubscribe's
  // own per-record check): only ever remove a subscription whose *currently
  // stored* endpoint matches the one being unsubscribed. Without it, a stale
  // unsubscribe request from an old browser session (the client only learns
  // its own endpoint, never this mailbox's id, at disable time — see
  // notifications.ts) could wipe out a newer, still-active subscription that
  // re-enabled from a different device/browser under the same mailboxId.
  // Moves only the watched height of an existing record, no Ark server
  // round trip: authorized by the height token a verified subscribe stored
  // (pushHeight.ts, external audit 2026-09-27, N1).
  private async handleHeight(request: Request): Promise<Response> {
    const { mailboxId, heightTokenHash, height } = (await request.json()) as {
      mailboxId?: unknown;
      heightTokenHash?: unknown;
      height?: unknown;
    };
    if (typeof mailboxId !== "string" || typeof heightTokenHash !== "string") return new Response(null, { status: 400 });
    if (height !== null && !(typeof height === "number" && Number.isInteger(height) && height > 0 && height <= MAX_PLAUSIBLE_BLOCKHEIGHT)) {
      return new Response(null, { status: 400 });
    }
    const store = this.recordStoreFor(mailboxId);
    const existing = await store.get();
    if (!existing) return new Response(null, { status: 404 });
    const next = applyHeightUpdate(existing, heightTokenHash, height, Math.floor(Date.now() / 1000));
    if (!next) return new Response(null, { status: 403 });
    await store.put(next);
    return new Response(null, { status: 204 });
  }

  private async handleUnsubscribe(request: Request): Promise<Response> {
    const { mailboxId, endpoint } = (await request.json()) as { mailboxId?: unknown; endpoint?: unknown };
    if (typeof mailboxId !== "string") return new Response(null, { status: 204 });
    const store = this.recordStoreFor(mailboxId);
    const existing = await store.get();
    if (existing && typeof endpoint === "string" && existing.subscription.endpoint === endpoint) {
      await store.delete();
      await this.removeId(mailboxId);
      await relayUnregister(this.env, mailboxId, await this.shardName());
    }
    return new Response(null, { status: 204 });
  }

  // Batches this shard's mailboxes through the same check logic the old
  // global cron used (checkMailboxForPayments/checkVtxoExpiry, unchanged) —
  // see index.ts's shardIdFor for why a shard only ever carries a bounded
  // slice of all subscribers, keeping this loop's own subrequest count well
  // under Cloudflare's per-invocation cap regardless of total subscriber
  // count.
  //
  // Concurrency within the Promise.all below can race on this shard's own
  // `ids` list when more than one mailbox in the batch needs removing —
  // each removal does its own read-modify-write of the whole list, so two
  // concurrent removals can silently clobber each other (last write wins).
  // This is the same already-accepted, self-healing race the old batched
  // cron had (see git history): the only possible outcome is a stale id
  // lingering in this shard's list one extra alarm before the next one's
  // "record not found" branch cleans it up for free. It can never re-send a
  // payment, lose a real subscription's data, or affect a mailbox that
  // isn't already being deleted anyway. A single Durable Object instance
  // processing its own requests one at a time (guaranteed by the platform)
  // means this is the *only* remaining source of such a race — a subscribe
  // landing concurrently with an alarm on the same shard can no longer
  // interleave the way an HTTP request could with the old shared-KV design.
  async alarm(): Promise<void> {
    // The next tick is scheduled in `finally`, not at the end of the work: this
    // used to reschedule only after every batch had completed, so anything that
    // threw first (a storage error in one mailbox's cleanup, a subrequest cap
    // hit mid-batch) left the shard without an alarm. After the platform's own
    // retries ran out, every mailbox in it stayed silent until some subscribe
    // happened to land on that shard and found getAlarm() null, which for
    // subscribers renewing once a day meant up to a day of missed pushes.
    // Errors are logged and swallowed: our own next tick is the retry.
    try {
      await this.runChecks();
    } catch (e) {
      console.error("mailbox alarm failed", e instanceof Error ? e.stack : e);
    } finally {
      await this.rescheduleAlarm();
    }
  }

  // First whatever a poke could not check itself, then a slice of the sweep:
  // CHECKS_PER_INVOCATION reads in all, the sweep continuing where the last alarm
  // stopped (CURSOR_KEY) and wrapping around, so every mailbox is reached
  // once every ceil(ids / slice) alarms.
  private async runChecks(): Promise<void> {
    const ids = await this.readIds();
    const queue = (await this.state.storage.get<string[]>(POKE_QUEUE_KEY)) ?? [];
    const now = Math.floor(Date.now() / 1000);

    let budget = CHECKS_PER_INVOCATION;
    if (queue.length > 0) {
      const known = new Set(ids);
      const waiting = queue.filter((id) => known.has(id));
      const { taken: drain, spent } = await this.takeWithin(waiting, budget, true);
      const rest = waiting.slice(drain.length);
      if (rest.length > 0) await this.state.storage.put(POKE_QUEUE_KEY, rest);
      else await this.state.storage.delete(POKE_QUEUE_KEY);
      await this.checkPaymentsAndForget(drain, now);
      budget -= spent;
    }
    // A full poke batch is this alarm's whole budget; the sweep slice waits
    // for the next alarm, which comes right away while a queue is left.
    if (ids.length === 0 || budget <= 0) return;

    const start = ((await this.state.storage.get<number>(CURSOR_KEY)) ?? 0) % ids.length;
    const ring = Array.from({ length: ids.length }, (_, k) => ids[(start + k) % ids.length]);
    // Only a sweep that has the whole budget must take a mailbox that alone
    // exceeds it; after a drain it waits for the next alarm's full budget.
    const { taken: slice } = await this.takeWithin(ring, budget, budget === CHECKS_PER_INVOCATION);
    await this.state.storage.put(CURSOR_KEY, (start + slice.length) % ids.length);

    // One lookup per alarm, shared by every mailbox in it. Each mailbox with a
    // watched VTXO height asked for the tip on its own, and the first batch of 20
    // ran concurrently, so all of them missed the edge cache together (and a
    // Durable Object may not have a working Cache API at all): up to 20
    // external fetches per tick out of the invocation's 50 subrequests, for a
    // number that is the same for everyone.
    const getTipHeight = once(() => fetchTipHeightCached());
    const getCurrentPriceUsd = once(() => fetchCurrentBtcPriceUsd(this.env));

    for (let i = 0; i < slice.length; i += BATCH_SIZE) {
      const batch = slice.slice(i, i + BATCH_SIZE);
      // allSettled: one mailbox whose own storage call throws must not stop the
      // rest of its batch, nor the batches after it.
      const results = await Promise.allSettled(
        batch.map((mailboxId) => this.checkOneMailbox(mailboxId, now, getTipHeight, getCurrentPriceUsd)),
      );
      results.forEach((r, j) => {
        if (r.status === "rejected") {
          console.error("mailbox check failed", batch[j], r.reason instanceof Error ? r.reason.stack : r.reason);
        }
      });
    }
  }

  // Re-reads the list rather than trusting anything computed above:
  // checkOneMailbox can delete a mailbox (expiry, 404/410, TTL) concurrently
  // with others in the same batch. Only reschedule while this shard still has
  // at least one mailbox worth checking. If the list itself cannot be read,
  // schedule anyway: an alarm that finds nothing is harmless, a shard with no
  // alarm is silent.
  private async rescheduleAlarm(): Promise<void> {
    let remaining = 1;
    try {
      remaining = (await this.readIds()).length;
    } catch (e) {
      console.error("mailbox alarm: could not read ids, scheduling anyway", e instanceof Error ? e.message : e);
    }
    if (remaining > 0) {
      let queued = false;
      try {
        queued = ((await this.state.storage.get<string[]>(POKE_QUEUE_KEY)) ?? []).length > 0;
      } catch {
        // Unreadable: the sweep reaches those mailboxes anyway.
      }
      await this.state.storage.setAlarm(Date.now() + (queued ? POKE_OVERFLOW_DELAY_MS : SWEEP_INTERVAL_MS));
    }
  }

  private async checkOneMailbox(
    mailboxId: string,
    now: number,
    getTipHeight: () => Promise<number | undefined>,
    getCurrentPriceUsd: () => Promise<number | undefined>,
  ): Promise<void> {
    const store = this.recordStoreFor(mailboxId);
    const record = await store.get();
    if (!record) {
      // Gone (already deleted by a concurrent removal in this same batch,
      // or a previous alarm that crashed after deleting the record but
      // before updating `ids`) — self-heal the list the same way the old
      // cron's checkOneMailbox did.
      const ids = await this.readIds();
      const idx = ids.indexOf(mailboxId);
      if (idx !== -1) {
        ids.splice(idx, 1);
        await this.writeIds(ids);
      }
      return;
    }

    // Same abuse/abandonment bound the old KV expirationTtl gave for free —
    // a shard's alarm actively keeps firing (and spending real subrequests)
    // forever unless something stops it, unlike a passive KV entry just
    // sitting there, so this check matters more here than it did before.
    if (now - record.lastSeenAt > SUBSCRIPTION_TTL_SECONDS) {
      await store.delete();
      await this.removeId(mailboxId);
      await relayUnregister(this.env, mailboxId, await this.shardName());
      return;
    }

    const deleted = await this.checkPayments(mailboxId, now);
    if (deleted) await relayUnregister(this.env, mailboxId, await this.shardName());
    if (!deleted) {
      try {
        await checkVtxoExpiry(this.env, mailboxId, record, getTipHeight, getCurrentPriceUsd, store);
      } catch (e) {
        console.error("checkVtxoExpiry failed", mailboxId, e instanceof Error ? e.stack : e);
      }
    }
  }
}
