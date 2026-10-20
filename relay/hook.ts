// Pokes the Worker (POST /api/push/hook, worker/pushRelay.ts) with the
// mailboxes where a payment just landed, grouped by shard: collected for a
// moment, so a burst is one request, and signed with the shared secret.
//
// Every poke costs the Cloudflare account one Worker request plus one Durable
// Object request per shard in it, out of 100k a day each for everything. Two
// budgets keep that bounded whatever the Ark server streams at us:
// - per mailbox: a short burst, then one poke a minute. A mailbox that is
//   over gets its poke later, never lost (and the shard sweep reads it anyway).
// - overall, in request units: when spent, pokes wait and merge into bigger
//   batches. Busy hours cost latency, not the account's daily quota.
import { createHmac } from "node:crypto";

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export type Poster = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

export interface HookOptions {
  url: string;
  secret: string;
  // How long ids gather before a send, and the most in one send (the Worker
  // takes up to 500).
  delayMs?: number;
  maxIds?: number;
  mailboxBurst?: number;
  mailboxRefillMs?: number;
  // Request units: one per send plus one per shard in it.
  budgetBurst?: number;
  budgetPerSecond?: number;
  post?: Poster;
  now?: () => number;
  log?: (msg: string) => void;
}

// After a failed delivery with no success since, the relay reports itself
// unhealthy for this long: pokes may be going nowhere.
const UNHEALTHY_AFTER_FAILURE_MS = 15 * 60_000;
const RETRY_BASE_MS = 2000;
const RETRIES = 3;

type Bucket = { tokens: number; at: number };

export class HookBatcher {
  // mailboxId -> shard, in arrival order.
  private pending = new Map<string, string>();
  // Over their own budget: sent once a token is back.
  private owed = new Map<string, string>();
  private buckets = new Map<string, Bucket>();
  private budget: Bucket;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private readonly delayMs: number;
  private readonly maxIds: number;
  private readonly mailboxBurst: number;
  private readonly mailboxRefillMs: number;
  private readonly budgetBurst: number;
  private readonly budgetPerMs: number;
  private readonly post: Poster;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly opts: HookOptions;
  private draining = false;
  private lastSuccess = 0;
  private lastFailure = 0;
  sent = 0;
  failed = 0;
  deferred = 0;

  constructor(opts: HookOptions) {
    this.opts = opts;
    this.delayMs = opts.delayMs ?? 1000;
    this.maxIds = opts.maxIds ?? 500;
    this.mailboxBurst = opts.mailboxBurst ?? 5;
    this.mailboxRefillMs = opts.mailboxRefillMs ?? 60_000;
    this.budgetBurst = opts.budgetBurst ?? 120;
    // ~21,600 units a day at most.
    this.budgetPerMs = (opts.budgetPerSecond ?? 0.25) / 1000;
    this.post = opts.post ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.budget = { tokens: this.budgetBurst, at: this.now() };
  }

  // False while a delivery failed recently and none has worked since.
  get healthy(): boolean {
    return !(this.lastFailure > this.lastSuccess && this.now() - this.lastFailure < UNHEALTHY_AFTER_FAILURE_MS);
  }

  get waiting(): number {
    return this.pending.size + this.owed.size;
  }

  add(mailboxId: string, shard: string): void {
    if (this.pending.has(mailboxId) || this.owed.has(mailboxId)) return;
    if (this.takeMailboxToken(mailboxId)) this.pending.set(mailboxId, shard);
    else {
      this.owed.set(mailboxId, shard);
      this.deferred++;
    }
    this.schedule(this.delayMs);
  }

  // Sends everything that is due now, within the budgets.
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.releaseOwed();
    if (this.pending.size === 0) {
      if (this.owed.size > 0) this.schedule(this.nextOwedMs());
      this.forgetFullBuckets();
      return;
    }
    const batch = new Map<string, string[]>();
    let ids = 0;
    for (const [id, shard] of this.pending) {
      if (ids >= this.maxIds) break;
      const list = batch.get(shard);
      if (list) list.push(id);
      else batch.set(shard, [id]);
      ids++;
    }
    const cost = 1 + batch.size;
    this.refill(this.budget, this.budgetPerMs, this.budgetBurst);
    if (!this.draining && this.budget.tokens < cost) {
      this.schedule(Math.ceil((cost - this.budget.tokens) / this.budgetPerMs));
      return;
    }
    this.budget.tokens = Math.max(0, this.budget.tokens - cost);
    for (const list of batch.values()) for (const id of list) this.pending.delete(id);
    if (this.pending.size > 0 || this.owed.size > 0) this.schedule(this.pending.size > 0 ? 0 : this.nextOwedMs());
    await this.send(Object.fromEntries(batch), ids);
  }

  private schedule(ms: number): void {
    const at = this.now() + ms;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  private refill(b: Bucket, perMs: number, cap: number): void {
    const t = this.now();
    b.tokens = Math.min(cap, b.tokens + (t - b.at) * perMs);
    b.at = t;
  }

  private takeMailboxToken(mailboxId: string): boolean {
    let b = this.buckets.get(mailboxId);
    if (!b) {
      b = { tokens: this.mailboxBurst, at: this.now() };
      this.buckets.set(mailboxId, b);
    }
    this.refill(b, 1 / this.mailboxRefillMs, this.mailboxBurst);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private releaseOwed(): void {
    for (const [id, shard] of this.owed) {
      if (this.pending.has(id)) {
        this.owed.delete(id);
        continue;
      }
      if (this.takeMailboxToken(id)) {
        this.owed.delete(id);
        this.pending.set(id, shard);
      }
    }
  }

  private nextOwedMs(): number {
    let soonest = this.mailboxRefillMs;
    for (const id of this.owed.keys()) {
      const b = this.buckets.get(id);
      if (b) soonest = Math.min(soonest, Math.max(0, Math.ceil((1 - b.tokens) * this.mailboxRefillMs - (this.now() - b.at))));
    }
    return soonest;
  }

  // A bucket back at full burst says nothing a fresh one would not.
  private forgetFullBuckets(): void {
    for (const [id, b] of this.buckets) {
      if (this.owed.has(id)) continue;
      this.refill(b, 1 / this.mailboxRefillMs, this.mailboxBurst);
      if (b.tokens >= this.mailboxBurst) this.buckets.delete(id);
    }
  }

  // A few retries for a network error or a 5xx; a missed poke is not lost,
  // the shard's own sweep reads the mailbox within a quarter of an hour.
  private async send(shards: Record<string, string[]>, ids: number, attempt = 0): Promise<void> {
    const body = JSON.stringify({ shards });
    const timestamp = String(Math.floor(this.now() / 1000));
    let status = 0;
    try {
      ({ status } = await this.post(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-relay-timestamp": timestamp,
          "x-relay-signature": sign(this.opts.secret, timestamp, body),
        },
        body,
      }));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      this.sent += ids;
      this.lastSuccess = this.now();
      return;
    }
    if ((status === 0 || status >= 500) && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
      return this.send(shards, ids, attempt + 1);
    }
    this.failed += ids;
    this.lastFailure = this.now();
    this.log(`hook: ${ids} pokes not delivered (status ${status})`);
  }

  // Shutdown: whatever is due, ignoring the overall budget.
  async drain(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.releaseOwed();
    this.draining = true;
    while (this.pending.size > 0) await this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
