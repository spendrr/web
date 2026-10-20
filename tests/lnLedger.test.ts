import { describe, expect, it } from "vitest";
import { decodeBolt11Expiry } from "../src/lib/send/destination";
import {
  classifyBarkdStatus,
  MAX_OPEN_GLOBAL,
  MAX_OPEN_PER_NAME,
  MAX_OPEN_PER_SOURCE_PER_NAME,
  OPEN_SLOT_MS,
} from "../worker/lnurl";
import {
  INVOICES_FAILING_STREAK,
  INVOICES_FAILING_WINDOW_MS,
  invoiceExpiresAt,
  LnLedgerCore,
  NODE_DOWN_AUTO_KILL_MS,
  VERIFY_CHECK_GAP_MS,
  VERIFY_CHECKS_PER_MINUTE,
  type LedgerStorage,
  type ReceiveRecord,
} from "../worker/lnLedger";

class MemoryStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options: {
    prefix: string;
    limit?: number;
    startAfter?: string;
    reverse?: boolean;
  }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix) && (options.startAfter === undefined || k > options.startAfter))
      .sort();
    if (options.reverse) keys.reverse();
    const out = new Map<string, T>();
    for (const k of keys.slice(0, options.limit ?? keys.length)) out.set(k, this.data.get(k) as T);
    return out;
  }
}

function setup() {
  let t = 1_000_000;
  const storage = new MemoryStorage();
  const core = new LnLedgerCore(storage, () => t);
  return { core, storage, advance: (ms: number) => (t += ms), now: () => t };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const hashOf = (i: number) => i.toString(16).padStart(64, "0");

// Every call from a different source unless one is given, so the per-name cap
// can be exercised without tripping the per-source one first.
let sourceCounter = 0;
const invoice = (hash: string, name = "pavel", source = `10.0.0.${sourceCounter++}`, mailboxId = `mb-${name}`) => ({
  hash,
  name,
  mailboxId,
  address: "ark1" + "q".repeat(60),
  amountSats: 1000,
  comment: null,
  pr: `lnbc-${hash}`,
  source,
});

// BOLT11 spec example ("within one minute"): timestamp 1496314658, `x` = 60.
// A real signed invoice, so this checks decodeBolt11Expiry against the actual
// format and not only against its own round trip.
const SPEC_INVOICE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

describe("LnLedgerCore.reserve", () => {
  it("creates a pending record", async () => {
    const { core } = setup();
    const result = await core.reserve(invoice("a".repeat(64)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.state).toBe("pending");
      expect(result.record.amountSats).toBe(1000);
    }
  });

  it("refuses a duplicate hash", async () => {
    const { core } = setup();
    await core.reserve(invoice("a".repeat(64)));
    const again = await core.reserve(invoice("a".repeat(64)));
    expect(again).toEqual({ ok: false, error: "exists" });
  });

  it("enforces the per-name open cap", async () => {
    const { core } = setup();
    for (let i = 0; i < MAX_OPEN_PER_NAME; i++) {
      const result = await core.reserve(invoice(hashOf(i)));
      expect(result.ok).toBe(true);
    }
    const overLimit = await core.reserve(invoice(hashOf(0xff)));
    expect(overLimit).toEqual({ ok: false, error: "name-limit" });

    // A different name is unaffected by pavel's cap.
    const other = await core.reserve(invoice(hashOf(0xfe), "jana"));
    expect(other.ok).toBe(true);
  });

  it("caps one source per name, without touching other sources or names", async () => {
    const { core } = setup();
    for (let i = 0; i < MAX_OPEN_PER_SOURCE_PER_NAME; i++) {
      expect((await core.reserve(invoice(hashOf(i), "pavel", "1.2.3.4"))).ok).toBe(true);
    }
    expect(await core.reserve(invoice(hashOf(0x50), "pavel", "1.2.3.4"))).toEqual({ ok: false, error: "source-limit" });
    expect((await core.reserve(invoice(hashOf(0x51), "pavel", "5.6.7.8"))).ok).toBe(true);
    expect((await core.reserve(invoice(hashOf(0x52), "jana", "1.2.3.4"))).ok).toBe(true);
  });

  it("a slot stops counting after OPEN_SLOT_MS even though the invoice is still pending", async () => {
    const { core, advance } = setup();
    for (let i = 0; i < MAX_OPEN_PER_NAME; i++) await core.reserve(invoice(hashOf(i)));
    expect(await core.precheck("pavel", "9.9.9.9")).toEqual({ ok: false, error: "name-limit" });

    advance(OPEN_SLOT_MS + 1);
    expect(await core.precheck("pavel", "9.9.9.9")).toEqual({ ok: true });
    expect((await core.reserve(invoice(hashOf(0xff)))).ok).toBe(true);
    // Tracking is untouched: every one of them is still waiting for payment.
    expect((await core.status(hashOf(0)))?.state).toBe("pending");
  });

  it("refuses new reserves once killed, and lets them through again once unkilled", async () => {
    const { core } = setup();
    await core.setKilled(true);
    expect(await core.reserve(invoice("a".repeat(64)))).toEqual({ ok: false, error: "killed" });
    await core.setKilled(false);
    expect((await core.reserve(invoice("a".repeat(64)))).ok).toBe(true);
  });

  it("stores the invoice's own expiry", async () => {
    const { core } = setup();
    const result = await core.reserve({ ...invoice("a".repeat(64)), pr: SPEC_INVOICE });
    // The test clock sits in 1970, so the invoice's 2017 expiry is past the floor.
    expect(result.ok && result.record.expiresAt).toBe((1496314658 + 60) * 1000);
  });
});

describe("invoiceExpiresAt", () => {
  it("reads a real BOLT11 invoice's timestamp + x field", () => {
    expect(decodeBolt11Expiry(SPEC_INVOICE)).toBe((1496314658 + 60) * 1000);
  });

  it("uses the decoded expiry when it is past the tracking floor", () => {
    const createdAt = (1496314658 - 2 * 3600) * 1000;
    expect(invoiceExpiresAt({ pr: SPEC_INVOICE, createdAt })).toBe((1496314658 + 60) * 1000);
  });

  it("never ends tracking earlier than an hour after creation", () => {
    expect(invoiceExpiresAt({ pr: SPEC_INVOICE, createdAt: 5_000_000_000_000 })).toBe(5_000_000_000_000 + HOUR);
  });

  it("falls back to 48h for an undecodable invoice", () => {
    expect(invoiceExpiresAt({ pr: "garbage", createdAt: 0 })).toBe(48 * HOUR);
  });

  it("prefers a stored expiresAt", () => {
    expect(invoiceExpiresAt({ pr: SPEC_INVOICE, createdAt: 0, expiresAt: 42 })).toBe(42);
  });
});

describe("LnLedgerCore.precheck", () => {
  it("mirrors reserve's checks without writing anything", async () => {
    const { core, storage } = setup();
    const before = storage.data.size;
    const result = await core.precheck("pavel", "1.2.3.4");
    expect(result).toEqual({ ok: true });
    expect(storage.data.size).toBe(before);
  });

  it("reports the same limit a real reserve would hit", async () => {
    const { core } = setup();
    for (let i = 0; i < MAX_OPEN_PER_NAME; i++) await core.reserve(invoice(hashOf(i)));
    expect(await core.precheck("pavel", "1.2.3.4")).toEqual({ ok: false, error: "name-limit" });
  });
});

describe("LnLedgerCore.settle / expire", () => {
  it("settling frees the open-name slot", async () => {
    const { core } = setup();
    for (let i = 0; i < MAX_OPEN_PER_NAME; i++) await core.reserve(invoice(hashOf(i)));
    const settled = await core.settle(hashOf(0), "preimage".padEnd(64, "0"));
    expect(settled?.state).toBe("settled");
    expect(await core.precheck("pavel", "1.2.3.4")).toEqual({ ok: true });
  });

  it("settling twice is a no-op success (idempotent)", async () => {
    const { core } = setup();
    const hash = "a".repeat(64);
    await core.reserve(invoice(hash));
    const first = await core.settle(hash, "p1".padEnd(64, "0"));
    const second = await core.settle(hash, "p2".padEnd(64, "0"));
    expect(second?.preimage).toBe(first?.preimage); // second call did not overwrite
  });

  it("a late payment settles an invoice the ledger already expired", async () => {
    const { core } = setup();
    const hash = "a".repeat(64);
    await core.reserve(invoice(hash));
    await core.expire(hash);
    const settled = await core.settle(hash, "p".padEnd(64, "0"));
    expect(settled?.state).toBe("settled");
  });

  it("cannot settle or expire a hash that was never reserved", async () => {
    const { core } = setup();
    expect(await core.settle("f".repeat(64), "p".padEnd(64, "0"))).toBeNull();
    expect(await core.expire("f".repeat(64))).toBeNull();
  });
});

describe("global open count", () => {
  const count = (storage: MemoryStorage) => (storage.data.get("g:openCount") as number | undefined) ?? 0;

  it("stays equal to the number of slot keys through every path", async () => {
    const { core, storage, advance } = setup();
    const slots = () => [...storage.data.keys()].filter((k) => k.startsWith("o:")).length;
    for (let i = 0; i < 6; i++) await core.reserve(invoice(hashOf(i)));
    expect(count(storage)).toBe(6);

    await core.settle(hashOf(0), "p".padEnd(64, "0"));
    await core.expire(hashOf(1));
    expect(count(storage)).toBe(4);
    expect(slots()).toBe(4);

    advance(OPEN_SLOT_MS + 1);
    expect(await core.pruneSlots()).toBe(4);
    expect(count(storage)).toBe(0);
    expect(slots()).toBe(0);

    // Closing a record whose slot was already pruned must not go negative or
    // double count, including an expired record that later settles.
    await core.expire(hashOf(2));
    await core.settle(hashOf(1), "p".padEnd(64, "0"));
    expect(count(storage)).toBe(0);

    await core.reserve(invoice(hashOf(0x40)));
    expect(count(storage)).toBe(1);
    expect(slots()).toBe(1);
  });

  it("a pre-OpenSlot slot (the bare number 1) is treated as stale and pruned", async () => {
    const { core, storage } = setup();
    await storage.put("o:pavel:" + hashOf(1), 1);
    await storage.put("g:openCount", 1);
    expect(await core.pruneSlots()).toBe(1);
    expect(count(storage)).toBe(0);
  });
});

describe("LnLedgerCore.listPending", () => {
  it("only lists pending invoices older than the given age", async () => {
    const { core, advance } = setup();
    await core.reserve(invoice("a".repeat(64)));
    advance(20_000);
    await core.reserve(invoice("b".repeat(64)));
    advance(20_000); // "a" is now 40s old, "b" is 20s old

    const pending = await core.listPending(30_000);
    expect(pending.map((p) => p.hash)).toEqual(["a".repeat(64)]);
  });

  it("excludes settled and expired invoices", async () => {
    const { core, advance } = setup();
    await core.reserve(invoice("a".repeat(64)));
    await core.settle("a".repeat(64), "p".padEnd(64, "0"));
    advance(60_000);
    expect(await core.listPending(0)).toEqual([]);
  });

  it("returns at most `limit`, least recently checked first, and checked ones rotate to the back", async () => {
    const { core, advance } = setup();
    for (let i = 0; i < 5; i++) {
      await core.reserve(invoice(hashOf(5 - i))); // hash order is the reverse of age
      advance(1000);
    }
    const first = await core.listPending(0, 2);
    expect(first.map((p) => p.hash)).toEqual([hashOf(5), hashOf(4)]);

    await core.markChecked(first.map((p) => p.hash));
    advance(1000);
    const second = await core.listPending(0, 3);
    expect(second.map((p) => p.hash)).toEqual([hashOf(3), hashOf(2), hashOf(1)]);
  });

  it("backs off on old unpaid invoices", async () => {
    const { core, advance } = setup();
    const hash = "a".repeat(64);
    await core.reserve(invoice(hash));
    advance(20 * MIN);
    await core.markChecked([hash]);
    advance(MIN);
    expect(await core.listPending(0)).toEqual([]);
    advance(5 * MIN);
    expect((await core.listPending(0)).map((p) => p.hash)).toEqual([hash]);

    advance(3 * HOUR);
    await core.markChecked([hash]);
    advance(20 * MIN);
    expect(await core.listPending(0)).toEqual([]);
    advance(11 * MIN);
    expect((await core.listPending(0)).map((p) => p.hash)).toEqual([hash]);
  });

  it("carries each invoice's expiry, including for a record from before the field existed", async () => {
    const { core, storage } = setup();
    const hash = "a".repeat(64);
    await core.reserve(invoice(hash));
    const record = storage.data.get(`r:${hash}`) as ReceiveRecord;
    delete record.expiresAt;
    storage.data.set(`r:${hash}`, record);
    const [item] = await core.listPending(0);
    // "lnbc-<hash>" doesn't decode: the 48h fallback.
    expect(item.expiresAt).toBe(record.createdAt + 48 * HOUR);
  });
});

describe("LnLedgerCore.receiptsForMailbox", () => {
  it("keeps a record findable after it settles", async () => {
    const { core } = setup();
    const hash = "a".repeat(64);
    await core.reserve(invoice(hash));
    await core.settle(hash, "p".padEnd(64, "0"));
    const receipts = await core.receiptsForMailbox("mb-pavel");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].hash).toBe(hash);
    expect(receipts[0].state).toBe("settled");
  });

  it("never returns another owner's invoices", async () => {
    const { core } = setup();
    await core.reserve(invoice("a".repeat(64), "pavel"));
    await core.reserve(invoice("b".repeat(64), "jana"));
    const receipts = await core.receiptsForMailbox("mb-pavel");
    expect(receipts.map((r: ReceiveRecord) => r.name)).toEqual(["pavel"]);
  });

  it("stays with the owner when the name changes hands", async () => {
    // "pavel" belonged to mb-old, then (released, or taken over after
    // inactivity) to mb-new: each sees only what was paid to them.
    const { core, advance } = setup();
    await core.reserve(invoice(hashOf(1), "pavel", "1.1.1.1", "mb-old"));
    advance(MIN);
    await core.reserve(invoice(hashOf(2), "pavel", "1.1.1.1", "mb-new"));
    expect((await core.receiptsForMailbox("mb-old")).map((r) => r.hash)).toEqual([hashOf(1)]);
    expect((await core.receiptsForMailbox("mb-new")).map((r) => r.hash)).toEqual([hashOf(2)]);
  });

  it("follows the owner across a rename", async () => {
    const { core, advance } = setup();
    await core.reserve(invoice(hashOf(1), "pavel", "1.1.1.1", "mb-1"));
    advance(MIN);
    await core.reserve(invoice(hashOf(2), "pavel2", "1.1.1.1", "mb-1"));
    expect((await core.receiptsForMailbox("mb-1")).map((r) => r.name)).toEqual(["pavel2", "pavel"]);
  });

  it("is newest first and honours the limit, regardless of hash order", async () => {
    const { core, advance } = setup();
    for (let i = 0; i < 5; i++) {
      await core.reserve(invoice(hashOf(9 - i), "pavel", `2.2.2.${i}`)); // hashes descend as time ascends
      advance(1000);
    }
    const receipts = await core.receiptsForMailbox("mb-pavel", 3);
    expect(receipts.map((r) => r.hash)).toEqual([hashOf(5), hashOf(6), hashOf(7)]);
  });

  it("a record from before owners were stored is in no one's receipts", async () => {
    const { core, storage } = setup();
    await storage.put(`r:${hashOf(1)}`, { hash: hashOf(1), name: "pavel", state: "settled" });
    await storage.put(`n:pavel:${hashOf(1)}`, 1);
    expect(await core.receiptsForMailbox("mb-pavel")).toEqual([]);
  });
});

describe("LnLedgerCore health and kill switches", () => {
  it("reports and reads back a health timestamp", async () => {
    const { core } = setup();
    expect(await core.getHealth()).toBeNull();
    await core.reportHealthy();
    expect(await core.getHealth()).toEqual({ lastOkAt: 1_000_000 });
  });

  it("counts an outage from its first failed check, not from the last good one", async () => {
    // A ledger that has never seen the node healthy (lastOkAt 0) must not trip
    // on its very first failure.
    const { core, advance } = setup();
    const first = await core.reportUnreachable();
    expect(first).toEqual({ downForMs: 0, autoKilled: false, justTripped: false });
    expect(await core.isKilled()).toBe(false);

    advance(NODE_DOWN_AUTO_KILL_MS - 1);
    expect((await core.reportUnreachable()).autoKilled).toBe(false);

    advance(1);
    expect(await core.reportUnreachable()).toEqual({
      downForMs: NODE_DOWN_AUTO_KILL_MS,
      autoKilled: true,
      justTripped: true,
    });
    expect(await core.isKilled()).toBe(true);
    expect(await core.reserve(invoice("a".repeat(64)))).toEqual({ ok: false, error: "killed" });

    advance(MIN);
    expect((await core.reportUnreachable()).justTripped).toBe(false); // trips once per outage
  });

  it("the first healthy check lifts the automatic switch and ends the outage", async () => {
    const { core, advance } = setup();
    await core.reportUnreachable();
    advance(NODE_DOWN_AUTO_KILL_MS);
    await core.reportUnreachable();
    expect(await core.isAutoKilled()).toBe(true);

    expect(await core.reportHealthy()).toEqual({ lifted: true });
    expect(await core.isKilled()).toBe(false);
    expect((await core.reserve(invoice("a".repeat(64)))).ok).toBe(true);
    expect(await core.reportHealthy()).toEqual({ lifted: false });

    // A new outage starts from zero again.
    advance(MIN);
    expect((await core.reportUnreachable()).downForMs).toBe(0);
  });

  it("the node coming back never lifts an admin's manual switch", async () => {
    const { core } = setup();
    await core.setKilled(true);
    await core.reportHealthy();
    expect(await core.isManuallyKilled()).toBe(true);
    expect(await core.isKilled()).toBe(true);
  });

  it("an admin unkill also clears the automatic switch, which re-trips if the node is still down", async () => {
    const { core, advance } = setup();
    await core.reportUnreachable();
    advance(NODE_DOWN_AUTO_KILL_MS);
    await core.reportUnreachable();
    await core.setKilled(false);
    expect(await core.isKilled()).toBe(false);

    advance(MIN);
    expect((await core.reportUnreachable()).justTripped).toBe(true);
  });
});

describe("classifyBarkdStatus", () => {
  it("only tunnel/origin errors mean the node is down", () => {
    for (const status of [502, 503, 504, 520, 522, 524, 530]) expect(classifyBarkdStatus(status)).toBe("unreachable");
  });

  it("Access redirects and auth failures are denied", () => {
    for (const status of [301, 302, 303, 307, 401, 403]) expect(classifyBarkdStatus(status)).toBe("denied");
  });

  it("anything else is the node answering with an error", () => {
    for (const status of [400, 404, 409, 422, 429, 500]) expect(classifyBarkdStatus(status)).toBe("http-error");
  });
});

// Sanity check the global cap exists and is far above the per-name one, so a
// single popular name can never alone exhaust the account-wide budget.
describe("caps", () => {
  it("the global cap is comfortably above one name's own cap", () => {
    expect(MAX_OPEN_GLOBAL).toBeGreaterThan(MAX_OPEN_PER_NAME * 10);
  });

  it("one source alone can't fill a name", () => {
    expect(MAX_OPEN_PER_SOURCE_PER_NAME).toBeLessThan(MAX_OPEN_PER_NAME);
  });
});

// The payer's network (the callback's IP, or its IPv6 /64) is only needed to
// count how many open invoices one source holds for OPEN_SLOT_MS. It used to be
// stored in the clear on every record, for good, and the owner's receipts
// endpoint returned whole records, i.e. handed each payer's address to the
// person paid.
describe("the payer's network is not kept", () => {
  const RAW = "203.0.113.77";
  const legacy = (hash: string, mailboxId = "mb-pavel"): ReceiveRecord => ({
    hash,
    name: "pavel",
    mailboxId,
    address: "ark1" + "q".repeat(60),
    amountSats: 1000,
    comment: null,
    createdAt: 1_000_000,
    state: "pending",
    pr: `lnbc-${hash}`,
    source: "198.51.100.4",
  });
  const seedLegacy = (storage: MemoryStorage, i: number) => {
    const hash = hashOf(0x1000 + i);
    storage.data.set(`r:${hash}`, legacy(hash));
    storage.data.set(`w:mb-pavel:${String(1_000_000 + i).padStart(15, "0")}:${hash}`, 1);
    return hash;
  };

  it("no stored value contains the address", async () => {
    const { core, storage } = setup();
    await core.reserve(invoice(hashOf(1), "pavel", RAW));
    expect(JSON.stringify([...storage.data.entries()])).not.toContain(RAW);
  });

  it("the record has no source field", async () => {
    const { core, storage } = setup();
    const result = await core.reserve(invoice(hashOf(1), "pavel", RAW));
    expect(result.ok && "source" in result.record).toBe(false);
    expect("source" in (storage.data.get(`r:${hashOf(1)}`) as object)).toBe(false);
  });

  it("the per-source cap still holds, also after a restart of the object", async () => {
    const { core, storage } = setup();
    for (let i = 0; i < MAX_OPEN_PER_SOURCE_PER_NAME; i++) {
      expect((await core.reserve(invoice(hashOf(i), "pavel", RAW))).ok).toBe(true);
    }
    const restarted = new LnLedgerCore(storage, () => 1_000_000);
    expect(await restarted.precheck("pavel", RAW)).toEqual({ ok: false, error: "source-limit" });
    expect(await restarted.precheck("pavel", "203.0.113.78")).toEqual({ ok: true });
  });

  it("two ledgers keep the same address as different values (a private random salt)", async () => {
    const a = setup();
    const b = setup();
    await a.core.reserve(invoice(hashOf(1), "pavel", RAW));
    await b.core.reserve(invoice(hashOf(1), "pavel", RAW));
    const slot = (s: MemoryStorage) => (s.data.get(`o:pavel:${hashOf(1)}`) as { source: string }).source;
    expect(slot(a.storage)).not.toBe(slot(b.storage));
    expect(slot(a.storage)).not.toBe(RAW);
  });

  it("the receipts endpoint does not return a legacy record's source", async () => {
    const { core, storage } = setup();
    seedLegacy(storage, 1);
    const receipts = await core.receiptsForMailbox("mb-pavel");
    expect(receipts).toHaveLength(1);
    expect("source" in receipts[0]).toBe(false);
    expect(JSON.stringify(receipts)).not.toContain("198.51.100.4");
  });

  it("status() does not return it either", async () => {
    const { core, storage } = setup();
    const hash = seedLegacy(storage, 1);
    const record = await core.status(hash);
    expect(record && "source" in record).toBe(false);
  });

  it("legacy records are scrubbed a page at a time and the work then stops", async () => {
    const { core, storage } = setup();
    for (let i = 0; i < 250; i++) seedLegacy(storage, i);
    let calls = 0;
    const list = storage.list.bind(storage);
    storage.list = (async (o: Parameters<typeof list>[0]) => {
      if (o.prefix === "r:") calls++;
      return list(o);
    }) as typeof storage.list;

    let total = 0;
    for (let i = 0; i < 10; i++) total += await core.scrubLegacySources();
    expect(total).toBe(250);
    expect(JSON.stringify([...storage.data.entries()])).not.toContain("198.51.100.4");
    // 250 records at 100 a page: three pages, then the done marker, no more scans
    expect(calls).toBe(3);
    // the records are otherwise untouched
    expect((storage.data.get(`r:${hashOf(0x1000)}`) as ReceiveRecord).amountSats).toBe(1000);
  });
});

describe("LnLedgerCore status summary", () => {
  it("reports a reachable node, no kill switch, invoices fine", async () => {
    const { core } = setup();
    expect(await core.statusSummary()).toEqual({ lnNode: false, lnRefusing: false, lnInvoicesFailing: false });
    await core.reportHealthy();
    expect((await core.statusSummary()).lnNode).toBe(true);
    await core.reportUnreachable();
    expect((await core.statusSummary()).lnNode).toBe(false);
    await core.setKilled(true);
    expect((await core.statusSummary()).lnRefusing).toBe(true);
  });

  it("calls invoices failing only after a recent streak, and one success clears it", async () => {
    const { core, advance } = setup();
    for (let i = 0; i < INVOICES_FAILING_STREAK - 1; i++) await core.recordInvoice(false);
    expect((await core.statusSummary()).lnInvoicesFailing).toBe(false);
    await core.recordInvoice(false);
    expect((await core.statusSummary()).lnInvoicesFailing).toBe(true);
    advance(INVOICES_FAILING_WINDOW_MS + MIN);
    expect((await core.statusSummary()).lnInvoicesFailing).toBe(false);
    for (let i = 0; i < INVOICES_FAILING_STREAK; i++) await core.recordInvoice(false);
    await core.recordInvoice(true);
    expect((await core.statusSummary()).lnInvoicesFailing).toBe(false);
  });
});

describe("LnLedgerCore.claimVerifyCheck", () => {
  const GRACE = 2 * MIN;

  it("says nothing is there for an unknown hash", async () => {
    const { core } = setup();
    expect(await core.claimVerifyCheck(hashOf(1), GRACE)).toEqual({ record: null, check: false });
  });

  it("lets a pending invoice be checked, then not again within the gap", async () => {
    const { core, advance } = setup();
    await core.reserve(invoice(hashOf(1)));
    const first = await core.claimVerifyCheck(hashOf(1), GRACE);
    expect(first.check).toBe(true);
    expect(first.record?.state).toBe("pending");
    advance(VERIFY_CHECK_GAP_MS - 1);
    expect((await core.claimVerifyCheck(hashOf(1), GRACE)).check).toBe(false);
    advance(1);
    expect((await core.claimVerifyCheck(hashOf(1), GRACE)).check).toBe(true);
  });

  it("does not check a settled or expired invoice", async () => {
    const { core } = setup();
    await core.reserve(invoice(hashOf(1)));
    await core.reserve(invoice(hashOf(2)));
    await core.settle(hashOf(1), "p".padEnd(64, "0"));
    await core.expire(hashOf(2));
    const settled = await core.claimVerifyCheck(hashOf(1), GRACE);
    expect(settled.check).toBe(false);
    expect(settled.record?.state).toBe("settled");
    expect((await core.claimVerifyCheck(hashOf(2), GRACE)).check).toBe(false);
  });

  it("does not check an invoice that can no longer be paid", async () => {
    const { core, advance } = setup();
    await core.reserve({ ...invoice(hashOf(1)), pr: SPEC_INVOICE });
    const record = await core.status(hashOf(1));
    advance(Math.max(0, (record?.expiresAt ?? 0) - 1_000_000) + GRACE + 1);
    expect((await core.claimVerifyCheck(hashOf(1), GRACE)).check).toBe(false);
  });

  it("caps the checks of all invoices together per minute, and resets the next minute", async () => {
    const { core, advance, now } = setup();
    const total = VERIFY_CHECKS_PER_MINUTE + 5;
    for (let i = 0; i < total; i++) await core.reserve(invoice(hashOf(i), `name${i}`));
    // Land inside one clock minute.
    advance(60_000 - (now() % 60_000) + 1_000);
    let allowed = 0;
    for (let i = 0; i < total; i++) if ((await core.claimVerifyCheck(hashOf(i), GRACE)).check) allowed++;
    expect(allowed).toBe(VERIFY_CHECKS_PER_MINUTE);
    advance(60_000);
    expect((await core.claimVerifyCheck(hashOf(total - 1), GRACE)).check).toBe(true);
  });

  it("never hands out the payer's network", async () => {
    const { core, storage } = setup();
    await core.reserve(invoice(hashOf(1)));
    const legacy = storage.data.get(`r:${hashOf(1)}`) as Record<string, unknown>;
    storage.data.set(`r:${hashOf(1)}`, { ...legacy, source: "203.0.113.7" });
    const { record } = await core.claimVerifyCheck(hashOf(1), GRACE);
    expect(JSON.stringify(record)).not.toContain("203.0.113.7");
  });
});
