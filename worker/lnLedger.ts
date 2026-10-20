// LnLedger: one global Durable Object tracking every open/settled/expired
// Lightning-address invoice (docs/ln-address-plan.md section 4.2). Same shape
// as NameRegistry (names.ts): a tiny storage-backed core (LnLedgerCore, unit
// tested in memory) plus a thin DO shell that only parses requests.
//
// Why a DO and not KV: reserving against MAX_OPEN_PER_NAME/MAX_OPEN_GLOBAL is
// a check-then-write that must not race (two callbacks for the same name at
// once must not both see 19-of-20 and both get in at 21). A DO serializes
// every request onto itself for free; KV has no compare-and-swap.
//
// Two separate lifetimes, on purpose (see OPEN_SLOT_MS in lnurl.ts):
// tracking a payment lasts until the invoice itself expires, while the slot
// it takes against the open-invoice caps lasts at most OPEN_SLOT_MS.
//
// Storage layout:
//   r:<hash>        ReceiveRecord   the invoice, whatever its current state
//   p:<hash>        { name }        present only while state is "pending":
//                                    the cron's worklist, so it never has to
//                                    scan the full (unbounded) history
//   o:<name>:<hash> OpenSlot        the invoice's slot against the caps;
//                                    counts only while younger than
//                                    OPEN_SLOT_MS, deleted on settle/expire,
//                                    stale ones pruned by reserve and the cron
//   w:<mailboxId>:<createdAt>:<hash> 1   permanent receipts index, by the
//                                    name's owner at issue time (not by name:
//                                    a name can change hands, and its next
//                                    holder must not see these); createdAt is
//                                    zero-padded so key order is time order.
//                                    Records from before this index (n:<name>:
//                                    keys) have no owner and are in no one's
//                                    receipts.
//   g:openCount     number          number of o: keys, kept in lockstep by
//                                    every writer (stale-but-unpruned ones
//                                    included, so it can lag by one cron tick)
//   s:kill          boolean         manual kill switch (admin): refuse new
//                                    reserves until an admin lifts it
//   s:autoKill      boolean         automatic kill switch: set after the node
//                                    has been down NODE_DOWN_AUTO_KILL_MS,
//                                    lifted by the first healthy check
//   s:health        HealthState     last-known reachability of the node
//   s:invoices      InvoiceOutcomes how real invoice requests to the node
//                                    ended lately (status page)
import { decodeBolt11Expiry } from "../src/lib/send/destination";
import { MAX_OPEN_GLOBAL, MAX_OPEN_PER_NAME, MAX_OPEN_PER_SOURCE_PER_NAME, OPEN_SLOT_MS } from "./lnurl";

export interface LedgerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number; startAfter?: string; reverse?: boolean }): Promise<Map<string, T>>;
}

export type ReceiveState = "pending" | "settled" | "expired";

export interface ReceiveRecord {
  hash: string;
  name: string;
  // The name's owner (mailbox id) when the invoice was issued. Absent on
  // records from before it was stored.
  mailboxId?: string;
  address: string;
  amountSats: number;
  comment: string | null;
  createdAt: number;
  state: ReceiveState;
  settledAt?: number;
  preimage?: string;
  // The BOLT11 invoice string, kept so /verify can echo `pr` per LUD-21
  // without a second round trip to the node.
  pr: string;
  // When the invoice stops being payable (its own timestamp + `x`). Absent on
  // records from before this field existed; see invoiceExpiresAt.
  expiresAt?: number;
  // Legacy: the payer's network in the clear (bumpRateLimitKey), stored on
  // records made before 2026-09-29. Never written now (a keyed hash goes on the
  // OpenSlot instead) and scrubbed from old records by scrubLegacySources; it
  // must never leave the ledger (receipts and status strip it).
  source?: string;
  // The cron skips this record until then (see nextCheckDelayMs).
  nextCheckAt?: number;
  // When a /verify poll last asked the node about this invoice (see
  // claimVerifyCheck).
  verifyCheckedAt?: number;
}

export interface OpenSlot {
  createdAt: number;
  // sourceKey(): a keyed hash of the payer's network, only ever compared.
  source: string;
}

export interface PendingItem {
  hash: string;
  name: string;
  pr: string;
  createdAt: number;
  expiresAt: number;
}

export type BudgetError = "killed" | "name-limit" | "source-limit" | "global-limit";

export type ReserveResult = { ok: true; record: ReceiveRecord } | { ok: false; error: BudgetError | "exists" };

export interface HealthState {
  // Last time the node answered anything at all (a reserve, a sweep check).
  // 0 if it never has since this field existed.
  lastOkAt: number;
  // Start of the current outage: the first failed check after the last good
  // one. Measuring from here, not from lastOkAt, is what keeps a ledger that
  // has never seen the node healthy from tripping on its very first failure.
  downSince?: number;
  // When the current outage tripped the automatic kill switch.
  autoKilledAt?: number;
}

// How long the node must stay unreachable before new invoices are refused.
// Invoices issued meanwhile fail at the node anyway ("Dočasně nedostupné");
// the switch mainly stops each payer's callback from waiting out the 8s
// timeout, and is what the LN healthcheck alert keys on.
export const NODE_DOWN_AUTO_KILL_MS = 3 * 60 * 1000;

export type UnreachableReport = { downForMs: number; autoKilled: boolean; justTripped: boolean };

// How the last real invoice requests ended, for the status page: a node that
// answers health checks can still fail every invoice (the Ark server's
// Lightning side down, for one). A single failure can be the payer's own
// target address, so it takes INVOICES_FAILING_STREAK in a row, the last one
// recent, to call it failing.
export interface InvoiceOutcomes {
  lastOkAt?: number;
  lastFailAt?: number;
  failStreak: number;
}
export const INVOICES_FAILING_STREAK = 3;
export const INVOICES_FAILING_WINDOW_MS = 30 * 60 * 1000;

export function invoicesFailing(o: InvoiceOutcomes | null, now: number): boolean {
  return o !== null && o.failStreak >= INVOICES_FAILING_STREAK && o.lastFailAt !== undefined && now - o.lastFailAt <= INVOICES_FAILING_WINDOW_MS;
}

// Used only when a stored invoice can't be decoded, which a barkd-issued one
// always can. Long rather than short: tracking a dead invoice a while longer
// costs a few polls, dropping a live one mislabels a real payment.
const FALLBACK_INVOICE_LIFETIME_MS = 48 * 60 * 60 * 1000;
// Floor on tracking, whatever the invoice says. Expiring drops the record from
// the cron's worklist for good, so a misread expiry must err late: a payment
// that lands after the ledger gave up would never be recorded.
const MIN_TRACKING_MS = 60 * 60 * 1000;

export function invoiceExpiresAt(record: Pick<ReceiveRecord, "expiresAt" | "pr" | "createdAt">): number {
  if (record.expiresAt !== undefined) return record.expiresAt;
  const decoded = decodeBolt11Expiry(record.pr) ?? record.createdAt + FALLBACK_INVOICE_LIFETIME_MS;
  return Math.max(decoded, record.createdAt + MIN_TRACKING_MS);
}

// How long the cron waits before asking about an unpaid invoice again. A payer
// almost always pays within minutes; checking a 40-hour-old invoice every
// minute would only spend the cron's per-invocation subrequest budget.
// A /verify poll may ask the node about a pending invoice (instead of waiting
// for the minute cron), but never one invoice more than once in
// VERIFY_CHECK_GAP_MS, and never more than VERIFY_CHECKS_PER_MINUTE times for
// all invoices together. Both are decided here, in the one place every poll
// passes through, so they hold across colos and isolates. A poll over the
// budget just reads the ledger, as it always did, and the cron settles it.
export const VERIFY_CHECK_GAP_MS = 5_000;
export const VERIFY_CHECKS_PER_MINUTE = 20;

export function nextCheckDelayMs(ageMs: number): number {
  if (ageMs < 15 * 60 * 1000) return 0;
  if (ageMs < 2 * 60 * 60 * 1000) return 5 * 60 * 1000;
  return 30 * 60 * 1000;
}

const recordKey = (hash: string) => `r:${hash}`;
const pendingKey = (hash: string) => `p:${hash}`;
const openByNameKey = (name: string, hash: string) => `o:${name}:${hash}`;
const receiptKey = (mailboxId: string, createdAt: number, hash: string) =>
  `w:${mailboxId}:${String(createdAt).padStart(15, "0")}:${hash}`;
const OPEN_COUNT_KEY = "g:openCount";
const VERIFY_BUDGET_KEY = "g:verifyChecks";
const SALT_KEY = "s:salt";
const SCRUB_DONE_KEY = "s:scrubbedSources";
const SCRUB_CURSOR_KEY = "s:scrubCursor";
const SCRUB_PAGE = 100;
const KILL_KEY = "s:kill";
const AUTO_KILL_KEY = "s:autoKill";
const HEALTH_KEY = "s:health";
const INVOICES_KEY = "s:invoices";

// A slot written before OpenSlot existed was the bare number 1; it carries no
// age, so it counts as stale and is pruned like one.
function isFreshSlot(value: unknown, now: number): value is OpenSlot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OpenSlot).createdAt === "number" &&
    (value as OpenSlot).createdAt > now - OPEN_SLOT_MS
  );
}

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

// A record as it may leave the ledger: without the legacy payer network.
function withoutSource<T extends { source?: string }>(record: T): Omit<T, "source"> {
  const { source: _source, ...rest } = record;
  return rest;
}

export class LnLedgerCore {
  private readonly storage: LedgerStorage;
  private readonly now: () => number;
  private saltPromise: Promise<Uint8Array> | undefined;

  constructor(storage: LedgerStorage, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
  }

  // Either switch refuses new invoices; the two are kept apart so that the
  // node coming back lifts only what the outage set, never an admin's own.
  async isKilled(): Promise<boolean> {
    return (await this.isManuallyKilled()) || (await this.isAutoKilled());
  }

  async isManuallyKilled(): Promise<boolean> {
    return (await this.storage.get<boolean>(KILL_KEY)) === true;
  }

  async isAutoKilled(): Promise<boolean> {
    return (await this.storage.get<boolean>(AUTO_KILL_KEY)) === true;
  }

  // Admin. Unkilling clears the automatic switch too (an explicit override);
  // if the node is still down it trips again on the next failed check, since
  // the outage's downSince is kept.
  async setKilled(killed: boolean): Promise<void> {
    await this.storage.put(KILL_KEY, killed);
    if (!killed) await this.storage.delete(AUTO_KILL_KEY);
  }

  // A random salt that lives only in this object's storage and is never sent
  // anywhere. The payer's address is hashed with it before it is kept: an
  // unsalted hash of an IPv4 address is undone in minutes by trying them all.
  // Created by the first write that needs it; a read-only check (precheck) never
  // creates it, and without one no stored source can match anyway (null).
  private async salt(create: boolean): Promise<Uint8Array | null> {
    if (this.saltPromise) return this.saltPromise;
    const stored = await this.storage.get<string>(SALT_KEY);
    if (!stored && !create) return null;
    this.saltPromise ??= (async () => {
      if (stored) return fromHex(stored);
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      await this.storage.put(SALT_KEY, toHex(bytes));
      return bytes;
    })().catch((e) => {
      this.saltPromise = undefined;
      throw e;
    });
    return this.saltPromise;
  }

  // What is kept of the payer's network: enough to tell "the same source" within
  // OPEN_SLOT_MS, nothing that leads back to an address. null: no salt yet.
  private async sourceKey(source: string, create = true): Promise<string | null> {
    const salt = await this.salt(create);
    if (!salt) return null;
    const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(source));
    return toHex(new Uint8Array(mac).slice(0, 12));
  }

  // Cron: removes the payer network that records made before 2026-09-29 still
  // carry, SCRUB_PAGE at a time (the cursor and a done marker are kept, so a
  // finished scrub costs one read per call). Returns how many it changed.
  async scrubLegacySources(): Promise<number> {
    if ((await this.storage.get<boolean>(SCRUB_DONE_KEY)) === true) return 0;
    const after = await this.storage.get<string>(SCRUB_CURSOR_KEY);
    const page = await this.storage.list<ReceiveRecord>({ prefix: "r:", startAfter: after, limit: SCRUB_PAGE });
    let scrubbed = 0;
    let last = after;
    for (const [key, record] of page) {
      last = key;
      if (record && typeof record === "object" && "source" in record) {
        await this.storage.put(key, withoutSource(record));
        scrubbed++;
      }
    }
    if (page.size < SCRUB_PAGE) await this.storage.put(SCRUB_DONE_KEY, true);
    else if (last !== undefined) await this.storage.put(SCRUB_CURSOR_KEY, last);
    return scrubbed;
  }

  // The caps, read-only. Stale slots are skipped here and deleted by reserve.
  private async budgetError(name: string, source: string, create: boolean): Promise<BudgetError | null> {
    if (await this.isKilled()) return "killed";
    const now = this.now();
    const sourceKey = await this.sourceKey(source, create);
    const slots = await this.storage.list<unknown>({ prefix: `o:${name}:`, limit: 1000 });
    let fresh = 0;
    let fromSource = 0;
    for (const value of slots.values()) {
      if (!isFreshSlot(value, now)) continue;
      fresh++;
      if (sourceKey !== null && value.source === sourceKey) fromSource++;
    }
    if (fresh >= MAX_OPEN_PER_NAME) return "name-limit";
    if (fromSource >= MAX_OPEN_PER_SOURCE_PER_NAME) return "source-limit";
    const globalCount = (await this.storage.get<number>(OPEN_COUNT_KEY)) ?? 0;
    if (globalCount >= MAX_OPEN_GLOBAL) return "global-limit";
    return null;
  }

  // Same checks as `reserve`, without writing anything — used BEFORE calling
  // the service node, since the real reservation key (the payment hash) is
  // only known once the node has actually created the invoice. This makes
  // the check-then-create-then-commit sequence a soft cap, not an exact one:
  // concurrent callbacks can both pass precheck and both go on to create an
  // invoice, same acceptable-risk shape as this codebase's other
  // check-then-write cost circuit-breakers (see allowUnderDailyCap in
  // worker/index.ts). Bounded by how many requests can race in practice, not
  // by anything enforced here.
  async precheck(name: string, source: string): Promise<{ ok: true } | { ok: false; error: BudgetError }> {
    const error = await this.budgetError(name, source, false);
    return error === null ? { ok: true } : { ok: false, error };
  }

  async reserve(input: {
    hash: string;
    name: string;
    address: string;
    amountSats: number;
    comment: string | null;
    pr: string;
    source: string;
    mailboxId: string;
  }): Promise<ReserveResult> {
    if (await this.storage.get<ReceiveRecord>(recordKey(input.hash))) return { ok: false, error: "exists" };
    // Crypto awaits do not hold the object's input gate the way storage calls
    // do, so the HMAC is computed up front: between the budget check and the
    // puts only storage operations may remain, or two callbacks can both pass
    // the cap.
    const sourceKey = (await this.sourceKey(input.source)) as string;
    await this.pruneStaleSlots(`o:${input.name}:`);
    const error = await this.budgetError(input.name, input.source, true);
    if (error !== null) return { ok: false, error };

    const now = this.now();
    const record: ReceiveRecord = {
      hash: input.hash,
      name: input.name,
      mailboxId: input.mailboxId,
      address: input.address,
      amountSats: input.amountSats,
      comment: input.comment,
      createdAt: now,
      state: "pending",
      pr: input.pr,
    };
    record.expiresAt = invoiceExpiresAt(record);
    const globalCount = (await this.storage.get<number>(OPEN_COUNT_KEY)) ?? 0;
    await Promise.all([
      this.storage.put(recordKey(input.hash), record),
      this.storage.put(pendingKey(input.hash), { name: input.name }),
      this.storage.put(openByNameKey(input.name, input.hash), {
        createdAt: now,
        source: sourceKey,
      } satisfies OpenSlot),
      this.storage.put(receiptKey(input.mailboxId, now, input.hash), 1),
      this.storage.put(OPEN_COUNT_KEY, globalCount + 1),
    ]);
    return { ok: true, record };
  }

  // Idempotent: settling an already-settled record is a no-op success (the
  // cron and a direct /verify poll can both observe the same transition).
  // An EXPIRED record can still settle: the ledger may have given up on an
  // invoice the payer then paid in its last minutes, and the payment is what
  // is true. Settling a record that doesn't exist is not.
  async settle(hash: string, preimage: string): Promise<ReceiveRecord | null> {
    const record = await this.storage.get<ReceiveRecord>(recordKey(hash));
    if (!record) return null;
    if (record.state === "settled") return record;
    const updated: ReceiveRecord = { ...record, state: "settled", settledAt: this.now(), preimage };
    await this.closeOpenIndexes(record);
    await this.storage.put(recordKey(hash), updated);
    return updated;
  }

  async expire(hash: string): Promise<ReceiveRecord | null> {
    const record = await this.storage.get<ReceiveRecord>(recordKey(hash));
    if (!record || record.state !== "pending") return null;
    const updated: ReceiveRecord = { ...record, state: "expired" };
    await this.closeOpenIndexes(record);
    await this.storage.put(recordKey(hash), updated);
    return updated;
  }

  // Safe to call on a record whose slot is already gone (pruned, or an
  // expired record now settling): the count only moves for a key that existed.
  private async closeOpenIndexes(record: ReceiveRecord): Promise<void> {
    await this.storage.delete(pendingKey(record.hash));
    await this.releaseSlots([openByNameKey(record.name, record.hash)]);
  }

  private async releaseSlots(keys: string[]): Promise<void> {
    let released = 0;
    for (const key of keys) {
      if (await this.storage.delete(key)) released++;
    }
    if (released === 0) return;
    const count = (await this.storage.get<number>(OPEN_COUNT_KEY)) ?? 0;
    await this.storage.put(OPEN_COUNT_KEY, Math.max(0, count - released));
  }

  private async pruneStaleSlots(prefix: string): Promise<number> {
    const now = this.now();
    const slots = await this.storage.list<unknown>({ prefix, limit: 5000 });
    const stale = [...slots].filter(([, value]) => !isFreshSlot(value, now)).map(([key]) => key);
    await this.releaseSlots(stale);
    return stale.length;
  }

  // Cron: frees the global budget held by slots that aged out without their
  // invoice settling or expiring (which, for an unpaid invoice, is the norm).
  async pruneSlots(): Promise<number> {
    return this.pruneStaleSlots("o:");
  }

  async status(hash: string): Promise<ReceiveRecord | null> {
    const record = await this.storage.get<ReceiveRecord>(recordKey(hash));
    return record ? withoutSource(record) : null;
  }

  // A /verify poll: the record, and whether this poll may ask the node about it
  // (true at most once per gap per invoice and per minute-budget overall, and
  // only for a pending invoice that can still be paid). Claiming is the write
  // that spends the allowance, so two polls at once cannot both get it.
  async claimVerifyCheck(hash: string, graceMs: number): Promise<{ record: Omit<ReceiveRecord, "source"> | null; check: boolean }> {
    const record = await this.storage.get<ReceiveRecord>(recordKey(hash));
    if (!record) return { record: null, check: false };
    const out = withoutSource(record);
    if (record.state !== "pending") return { record: out, check: false };
    const now = this.now();
    if (now > invoiceExpiresAt(record) + graceMs) return { record: out, check: false };
    if (now - (record.verifyCheckedAt ?? 0) < VERIFY_CHECK_GAP_MS) return { record: out, check: false };
    const minute = Math.floor(now / 60_000);
    const budget = await this.storage.get<{ minute: number; n: number }>(VERIFY_BUDGET_KEY);
    const used = budget?.minute === minute ? budget.n : 0;
    if (used >= VERIFY_CHECKS_PER_MINUTE) return { record: out, check: false };
    await this.storage.put(VERIFY_BUDGET_KEY, { minute, n: used + 1 });
    await this.storage.put(recordKey(hash), { ...record, verifyCheckedAt: now } satisfies ReceiveRecord);
    return { record: out, check: true };
  }

  // The cron's worklist for this tick: pending invoices older than
  // `olderThanMs` whose next check is due, least recently due first, at most
  // `limit` of them, so a backlog is worked through over several ticks
  // instead of one tick running past its subrequest budget.
  async listPending(olderThanMs: number, limit = 5000): Promise<PendingItem[]> {
    const now = this.now();
    const cutoff = now - olderThanMs;
    const page = await this.storage.list<{ name: string }>({ prefix: "p:", limit: 5000 });
    const due: (PendingItem & { dueAt: number })[] = [];
    for (const [key, value] of page) {
      const hash = key.slice(2);
      const record = await this.storage.get<ReceiveRecord>(recordKey(hash));
      if (!record || record.createdAt > cutoff) continue;
      const dueAt = record.nextCheckAt ?? record.createdAt;
      if (dueAt > now) continue;
      due.push({
        hash,
        name: value.name,
        pr: record.pr,
        createdAt: record.createdAt,
        expiresAt: invoiceExpiresAt(record),
        dueAt,
      });
    }
    due.sort((a, b) => a.dueAt - b.dueAt);
    return due.slice(0, limit).map(({ dueAt: _dueAt, ...item }) => item);
  }

  // Cron: these were looked at and are still unpaid. Pushes each one's next
  // check out by nextCheckDelayMs, and moves it behind never-checked ones.
  async markChecked(hashes: string[]): Promise<void> {
    const now = this.now();
    for (const hash of hashes) {
      const record = await this.storage.get<ReceiveRecord>(recordKey(hash));
      if (!record || record.state !== "pending") continue;
      await this.storage.put(recordKey(hash), {
        ...record,
        nextCheckAt: now + nextCheckDelayMs(now - record.createdAt),
      } satisfies ReceiveRecord);
    }
  }

  // Every invoice (any state) issued while this mailbox owned the name it was
  // paid through, newest first, at most `limit`: the owner-only receipts
  // endpoint. Keyed by owner, never by name, so a name's next holder can't
  // read the previous one's amounts and comments, and a rename keeps them.
  async receiptsForMailbox(mailboxId: string, limit = 200): Promise<ReceiveRecord[]> {
    const page = await this.storage.list<1>({ prefix: `w:${mailboxId}:`, reverse: true, limit });
    const records: ReceiveRecord[] = [];
    for (const key of page.keys()) {
      const record = await this.storage.get<ReceiveRecord>(recordKey(key.slice(key.lastIndexOf(":") + 1)));
      if (record) records.push(withoutSource(record));
    }
    return records;
  }

  async getHealth(): Promise<HealthState | null> {
    return (await this.storage.get<HealthState>(HEALTH_KEY)) ?? null;
  }

  async recordInvoice(ok: boolean): Promise<void> {
    const prev = (await this.storage.get<InvoiceOutcomes>(INVOICES_KEY)) ?? { failStreak: 0 };
    const now = this.now();
    await this.storage.put(
      INVOICES_KEY,
      (ok ? { ...prev, lastOkAt: now, failStreak: 0 } : { ...prev, lastFailAt: now, failStreak: prev.failStreak + 1 }) satisfies InvoiceOutcomes,
    );
  }

  // What the app's status report says about the Lightning address
  // (worker/statusReport.ts). The node counts as reachable while no outage is
  // open and it has answered at least once.
  async statusSummary(): Promise<{ lnNode: boolean; lnRefusing: boolean; lnInvoicesFailing: boolean }> {
    const health = await this.getHealth();
    return {
      lnNode: health !== null && health.lastOkAt > 0 && health.downSince === undefined,
      lnRefusing: await this.isKilled(),
      lnInvoicesFailing: invoicesFailing((await this.storage.get<InvoiceOutcomes>(INVOICES_KEY)) ?? null, this.now()),
    };
  }

  // The node answered. Ends any outage and lifts the automatic kill switch.
  // Returns whether it lifted one.
  async reportHealthy(): Promise<{ lifted: boolean }> {
    await this.storage.put(HEALTH_KEY, { lastOkAt: this.now() } satisfies HealthState);
    return { lifted: await this.storage.delete(AUTO_KILL_KEY) };
  }

  // The node did not answer this check. Starts or extends the outage and,
  // once it has lasted NODE_DOWN_AUTO_KILL_MS, sets the automatic kill switch.
  async reportUnreachable(): Promise<UnreachableReport> {
    const now = this.now();
    const health = (await this.getHealth()) ?? { lastOkAt: 0 };
    const downSince = health.downSince ?? now;
    const downForMs = now - downSince;
    const alreadyKilled = await this.isAutoKilled();
    const justTripped = !alreadyKilled && downForMs >= NODE_DOWN_AUTO_KILL_MS;
    await this.storage.put(HEALTH_KEY, {
      ...health,
      downSince,
      ...(justTripped ? { autoKilledAt: now } : {}),
    } satisfies HealthState);
    if (justTripped) await this.storage.put(AUTO_KILL_KEY, true);
    return { downForMs, autoKilled: alreadyKilled || justTripped, justTripped };
  }
}

interface LedgerState {
  storage: LedgerStorage;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class LnLedger {
  private readonly core: LnLedgerCore;

  constructor(state: LedgerState) {
    this.core = new LnLedgerCore(state.storage);
  }

  // Internal only: index.ts is the one caller and has already authorized
  // whatever led here (proveNameMailbox for owner routes, NAMES_ADMIN_TOKEN
  // for admin routes, nothing for the public LNURL callback — reserving a
  // hold invoice needs no proof beyond the name existing and being lnAddress-
  // enabled, which index.ts checks against the name registry first).
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null) return json({ error: "Invalid body" }, 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid body" }, 400);
    }
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
    const num = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : null);
    const path = new URL(request.url).pathname;

    if (path === "/precheck") {
      const name = str("name");
      if (name === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.precheck(name, str("source") ?? "unknown"));
    }
    if (path === "/reserve") {
      const hash = str("hash");
      const name = str("name");
      const address = str("address");
      const amountSats = num("amountSats");
      const pr = str("pr");
      if (hash === null || name === null || address === null || amountSats === null || pr === null) {
        return json({ error: "Invalid body" }, 400);
      }
      const mailboxId = str("mailboxId");
      if (mailboxId === null) return json({ error: "Invalid body" }, 400);
      const comment = str("comment");
      const source = str("source") ?? "unknown";
      return json(await this.core.reserve({ hash, name, address, amountSats, comment, pr, source, mailboxId }));
    }
    if (path === "/settle") {
      const hash = str("hash");
      const preimage = str("preimage");
      if (hash === null || preimage === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.settle(hash, preimage));
    }
    if (path === "/expire") {
      const hash = str("hash");
      if (hash === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.expire(hash));
    }
    if (path === "/verify-claim") {
      const hash = str("hash");
      const graceMs = num("graceMs");
      if (hash === null || graceMs === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.claimVerifyCheck(hash, graceMs));
    }
    if (path === "/status") {
      const hash = str("hash");
      if (hash === null) return json({ error: "Invalid body" }, 400);
      return json(await this.core.status(hash));
    }
    // The cron sweep's one request a minute (index.ts's sweepLnLedger), where
    // it used to be three or four: prune the open slots, record the node's
    // health from the probe the sweep made just before, list what is due
    // (nothing while the node is down: every lookup would only time out) and,
    // on a status report tick, the summary for the status page.
    if (path === "/tick") {
      if (body.node !== "ok" && body.node !== "down") return json({ error: "Invalid body" }, 400);
      const pruned = await this.core.pruneSlots();
      await this.core.scrubLegacySources();
      const health = body.node === "ok" ? await this.core.reportHealthy() : await this.core.reportUnreachable();
      const refusing = await this.core.isKilled();
      const pending = body.node === "ok" ? await this.core.listPending(num("olderThanMs") ?? 0, num("limit") ?? undefined) : [];
      const summary = body.summary === true ? await this.core.statusSummary() : undefined;
      return json({ pruned, health: { ...health, refusing }, pending, summary });
    }
    if (path === "/checked") {
      const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h): h is string => typeof h === "string") : null;
      if (hashes === null) return json({ error: "Invalid body" }, 400);
      await this.core.markChecked(hashes);
      return json({ ok: true });
    }
    if (path === "/receipts") {
      const mailboxId = str("mailboxId");
      if (mailboxId === null) return json({ error: "Invalid body" }, 400);
      const limit = num("limit") ?? undefined;
      return json(await this.core.receiptsForMailbox(mailboxId, limit));
    }
    // `refusing` (either switch on) is what the Worker mirrors into KV for
    // the receive screen (lnAddrHealth.ts), so that never costs a request.
    if (path === "/health/report") {
      // A real invoice that came back counts for the status page too, in the
      // same request (no extra Durable Object call per payment).
      if (body.invoice === true) await this.core.recordInvoice(true);
      return json({ ...(await this.core.reportHealthy()), refusing: await this.core.isKilled() });
    }
    if (path === "/invoice/result") {
      if (typeof body.ok !== "boolean") return json({ error: "Invalid body" }, 400);
      await this.core.recordInvoice(body.ok);
      return json({ ok: true });
    }
    if (path === "/health/get") {
      return json(await this.core.getHealth());
    }
    if (path === "/admin/kill") {
      await this.core.setKilled(body.killed !== false);
      return json({ ok: true, killed: body.killed !== false, refusing: await this.core.isKilled() });
    }
    if (path === "/admin/status") {
      return json({
        killed: await this.core.isManuallyKilled(),
        autoKilled: await this.core.isAutoKilled(),
        health: await this.core.getHealth(),
      });
    }
    return json({ error: "Not found" }, 404);
  }
}
