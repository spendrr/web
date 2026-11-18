// Writes that must wait for the transaction to COMMIT, not just for the request to succeed. A fake IndexedDB whose
// transactions end in `abort` without ever firing `error` (what a failed commit looks like: full storage, disk
// error) must make putGift and restoreDatabase reject instead of reporting success or hanging.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { putGift, deleteGift, listGifts, type OutgoingGift } from "../src/lib/gift/giftStore";
import { restoreDatabase, type SerializedDb } from "../src/lib/backup/backupStore";

type Outcome = "complete" | "abort";
let outcome: Outcome = "complete";
let txOptions: unknown[] = [];

class FakeTx {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: DOMException | null = null;
  constructor(private stores: string[]) {
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => this.finish())));
  }
  private finish() {
    if (outcome === "complete") this.oncomplete?.();
    else {
      this.error = new DOMException("quota", "QuotaExceededError");
      this.onabort?.();
    }
  }
  objectStore(name: string) {
    if (!this.stores.includes(name)) throw new Error("no store " + name);
    const done = (result?: unknown) => {
      const req: { result: unknown; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
        result,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    return { keyPath: null, put: () => done(), delete: () => done(), clear: () => done(), getAll: () => done([]), get: () => done(undefined) };
  }
}

function fakeDb(stores: string[]) {
  return {
    version: 1,
    objectStoreNames: { contains: (n: string) => stores.includes(n) },
    transaction: (names: string | string[], _mode: string, options?: unknown) => {
      if (options !== undefined) txOptions.push(options);
      return new FakeTx(Array.isArray(names) ? names : [names]);
    },
    close() {},
    createObjectStore() {},
  };
}

beforeEach(() => {
  outcome = "complete";
  txOptions = [];
  vi.stubGlobal("indexedDB", {
    databases: async () => [],
    open: () => {
      const req: { result: unknown; error: null; onsuccess: (() => void) | null; [k: string]: unknown } = {
        result: fakeDb(["gifts", "s"]),
        error: null,
        onsuccess: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  });
});

const gift = {
  id: "g1",
  createdAt: 1,
  expiresAt: 2,
  amountSats: 1000,
  state: "creating",
  mnemonicCipher: { iv: "00", ct: "AA==" },
} as unknown as OutgoingGift;

describe("gift store waits for the commit", () => {
  it("putGift resolves after the transaction completes, with strict durability", async () => {
    await expect(putGift(gift)).resolves.toBeUndefined();
    expect(txOptions).toContainEqual({ durability: "strict" });
  });

  it("putGift and deleteGift reject when the transaction aborts without an error event", async () => {
    outcome = "abort";
    await expect(putGift(gift)).rejects.toThrow();
    await expect(deleteGift("g1")).rejects.toThrow();
  });

  it("a read still works and is not forced strict", async () => {
    await expect(listGifts()).resolves.toEqual([]);
    expect(txOptions).toEqual([]);
  });
});

describe("restoreDatabase", () => {
  const dump: SerializedDb = {
    name: "db",
    version: 1,
    stores: { s: { keyPath: null, indexes: [], records: [{ key: "k", value: 1 }] } },
  };

  it("resolves when the restore transaction completes", async () => {
    await expect(restoreDatabase("db", dump)).resolves.toBeUndefined();
  });

  it("rejects, instead of waiting forever, when the commit aborts", async () => {
    outcome = "abort";
    await expect(restoreDatabase("db", dump)).rejects.toThrow();
  });
});
