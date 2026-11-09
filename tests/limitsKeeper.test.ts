import { describe, expect, it } from "vitest";
import { SpendLimitsKeeper, type LimitsLoad, type LimitsStore } from "../src/lib/wallet/limitsKeeper";
import { encodeRecord, decodeRecord, type LimitsRecord } from "../src/lib/wallet/spendLimits";

const NOW = 1_700_000_000_000;

function memStore(initial: LimitsLoad = { kind: "none" }) {
  let load = initial;
  const saves: LimitsRecord[] = [];
  let failSave = false;
  const store: LimitsStore = {
    async load() {
      return load;
    },
    async save(r) {
      if (failSave) throw new Error("disk");
      // through the real text, so a record the codec would refuse cannot pass here
      const back = decodeRecord(encodeRecord(r));
      if (!back) throw new Error("codec");
      saves.push(back);
      load = { kind: "ok", record: back };
    },
  };
  return { store, saves, failSave: (v: boolean) => (failSave = v) };
}

describe("SpendLimitsKeeper", () => {
  it("nothing stored reads as the defaults", async () => {
    const k = new SpendLimitsKeeper();
    await k.open(memStore().store);
    const s = await k.exclusive(async () => k.status(NOW));
    expect(s).toEqual({ limits: { noPasswordSats: 100_000, hardSats: null, pending: null }, hardRemainingSats: null, oldestAt: null, unreadable: false });
  });

  it("no store or an unreadable one is the strict setting, not no limits", async () => {
    for (const store of [null, memStore({ kind: "unreadable" }).store]) {
      const k = new SpendLimitsKeeper();
      await k.open(store);
      const s = await k.exclusive(async () => k.status(NOW));
      expect(s.limits.noPasswordSats).toBe(0);
      expect(s.unreadable).toBe(true);
    }
  });

  it("a session without a store is open, strict, and cannot save, never closed", async () => {
    const k = new SpendLimitsKeeper();
    expect(k.isOpen).toBe(false);
    await k.open(null);
    expect(k.isOpen).toBe(true);
    expect(await k.exclusive(async () => k.limits(NOW))).toMatchObject({ noPasswordSats: 0 });
    await expect(k.exclusive(async () => k.charge(5, NOW))).rejects.toThrow();
    await k.close();
    expect(k.isOpen).toBe(false);
  });

  it("a store that throws on load is the strict setting too", async () => {
    const k = new SpendLimitsKeeper();
    await k.open({ load: async () => Promise.reject(new Error("idb")), save: async () => undefined });
    expect((await k.exclusive(async () => k.status(NOW))).limits.noPasswordSats).toBe(0);
  });

  it("a failed save changes nothing, a good one is adopted", async () => {
    const m = memStore();
    const k = new SpendLimitsKeeper();
    await k.open(m.store);
    m.failSave(true);
    await expect(k.exclusive(async () => k.commitLimits({ noPasswordSats: 5, hardSats: null, pending: null }, NOW))).rejects.toThrow();
    expect((await k.exclusive(async () => k.limits(NOW))).noPasswordSats).toBe(100_000);
    m.failSave(false);
    await k.exclusive(async () => k.commitLimits({ noPasswordSats: 5, hardSats: null, pending: null }, NOW));
    expect((await k.exclusive(async () => k.limits(NOW))).noPasswordSats).toBe(5);
  });

  it("charges the hard ledger, persists it, and refuses what no longer fits", async () => {
    const m = memStore();
    const k = new SpendLimitsKeeper();
    await k.open(m.store);
    await k.exclusive(async () => k.commitLimits({ noPasswordSats: 1000, hardSats: 1000, pending: null }, NOW));
    await k.exclusive(async () => k.charge(700, NOW));
    expect(m.saves.at(-1)?.ledger).toEqual([{ at: NOW, sats: 700 }]);
    expect(await k.exclusive(async () => k.checkHard(400, NOW + 1))).toEqual({ ok: false, remainingSats: 300 });
    expect(await k.exclusive(async () => k.checkHard(300, NOW + 1))).toEqual({ ok: true, charge: 300 });
  });

  it("survives a reopen, and a closed keeper cannot save", async () => {
    const m = memStore();
    const k = new SpendLimitsKeeper();
    await k.open(m.store);
    await k.exclusive(async () => k.commitLimits({ noPasswordSats: 42, hardSats: null, pending: null }, NOW));
    await k.close();
    await expect(k.exclusive(async () => k.charge(1, NOW))).rejects.toThrow();
    await k.open(m.store);
    expect((await k.exclusive(async () => k.limits(NOW))).noPasswordSats).toBe(42);
  });

  it("serializes: a slow operation finishes before the next starts", async () => {
    const k = new SpendLimitsKeeper();
    const order: string[] = [];
    const a = k.exclusive(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
    });
    const b = k.exclusive(async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });
});
