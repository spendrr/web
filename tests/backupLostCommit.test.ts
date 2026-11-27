// performUpload's side of the lost-commit-reply fix (src/lib/backup/backup.ts,
// adoptOwnLostCommit): a device whose previous commit reached the server but
// whose reply got lost must adopt that version on the next upload instead of
// latching uploads off as a conflict.
import { beforeEach, describe, expect, it, vi } from "vitest";
// The single-request upload (put) is the beta (V2) path; the V1 flow is in tests/backupLostCommit.v1.test.ts.
vi.mock("../src/lib/ui/designVersion", () => ({ getDesignVersion: () => "v2" }));

vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: vi.fn() }));
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({ isMaintenanceSuppressed: () => false }));
type Stores = Record<string, { keyPath: null; indexes: []; records: { key: unknown; value: unknown }[] }>;
const store = (...keys: string[]) => ({ keyPath: null, indexes: [] as [], records: keys.map((key) => ({ key, value: 1 })) });
let localArk: Stores = {};
let serverPlaintext = "{}";
vi.mock("../src/lib/backup/backupStore", () => ({
  ARK_DB_NAME: "ark",
  ONCHAIN_DB_NAME: "onchain",
  dumpDatabase: async (name: string) => (name === "ark" ? { name, version: 1, stores: localArk } : null),
  hasAnyLocalWalletData: async () => true,
  restoreDatabase: vi.fn(),
}));
let localHash = "local";
vi.mock("../src/lib/backup/backupCrypto", () => ({
  sha256Hex: async () => localHash,
  encryptBackupBlob: async () => ({ ivHex: "00", cipherB64: "AA==" }),
  decryptBackupBlob: async () => new TextEncoder().encode(serverPlaintext),
}));

const { uploadBackupNow, isRestoreFailureLatched, findMissingLocally, liftConflictLatchIfCovered, getLastBackupStatus } =
  await import("../src/lib/backup/backup");

const LOOKUP = "abc123";
const keys = { lookupKey: LOOKUP, writeToken: "b".repeat(64), encryptionKey: {} as CryptoKey };
const knownKey = `btc-wallet-backup-known-version:${LOOKUP}`;
const pendingKey = `btc-wallet-backup-pending-commit:${LOOKUP}`;

// The server holds the given version and plaintext hash; a put on any other base
// is refused with 409 carrying that state, as handleBackupPut does.
function server(version: number, sha256: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/api/backup/put") {
        if (version !== 0 && body.baseVersion !== version) return Response.json({ version, sha256 }, { status: 409 });
        return Response.json({ version: (body.baseVersion as number) + 1 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}

// Resolves when the cycle has finished: a success, a recorded error, or the
// restore-failure latch (a conflict).
async function upload() {
  await uploadBackupNow(keys);
}

beforeEach(() => {
  localStorage.clear();
  localHash = "local";
  localArk = {};
  serverPlaintext = "{}";
});

describe("performUpload after a lost commit reply", () => {
  it("adopts its own commit and uploads nothing when local state is unchanged", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify({ base: 85, sha256: "local" }));
    const calls = server(86, "local");
    await upload();
    expect(calls.map((c) => c.path)).toEqual(["/api/backup/put"]);
    expect(localStorage.getItem(knownKey)).toBe("86");
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("adopts its own commit and commits newer state on top of it", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify({ base: 85, sha256: "older" }));
    const calls = server(86, "older");
    await upload();
    expect(calls.map((c) => c.body.baseVersion)).toEqual([85, 86]);
    expect(localStorage.getItem(knownKey)).toBe("87");
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("latches when the next version holds bytes this device never sent", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify({ base: 85, sha256: "older" }));
    const calls = server(86, "someone-else");
    await upload();
    expect(calls.map((c) => c.path)).toEqual(["/api/backup/put"]);
    expect(localStorage.getItem(knownKey)).toBe("85");
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("leaves the marker when the commit reply fails", async () => {
    localStorage.setItem(knownKey, "85");
    const calls = server(85, "older");
    const realFetch = globalThis.fetch as unknown as (p: string, i: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      if (path === "/api/backup/put") throw new TypeError("Failed to fetch");
      return realFetch(path, init);
    });
    await upload();
    expect(calls).toHaveLength(0); // the stubbed fetch threw before the recording one ran
    expect(JSON.parse(localStorage.getItem(pendingKey) ?? "null")).toEqual([{ base: 85, sha256: "local" }]);
    expect(isRestoreFailureLatched()).toBe(false);
  });
});

const db = (stores: Stores) => ({ name: "ark", version: 1, stores });

describe("findMissingLocally", () => {
  it("is null when local holds every server record, plus more", () => {
    expect(findMissingLocally({ ark: db({ v: store("a") }), onchain: null }, { ark: db({ v: store("a", "b") }), onchain: null })).toBeNull();
  });
  it("names the store and count of records only the server has", () => {
    expect(findMissingLocally({ ark: db({ v: store("a", "b", "c") }), onchain: null }, { ark: db({ v: store("a") }), onchain: null })).toBe(
      "ark/v (2)",
    );
  });
  it("counts a store or database missing locally", () => {
    expect(findMissingLocally({ ark: db({ v: store() }), onchain: null }, { ark: db({}), onchain: null })).toBe("ark/v");
    expect(findMissingLocally({ ark: null, onchain: null, gifts: db({}) }, { ark: null, onchain: null })).toBe("gifts");
  });
});

describe("liftConflictLatchIfCovered", () => {
  function latch() {
    localStorage.setItem("btc-wallet-backup-restore-failed", "BackupVersionConflictError: refusing to upload");
    localStorage.setItem("btc-wallet-backup-conflict-latched", "1");
    localStorage.setItem(knownKey, "85");
  }
  function serverHolds(stores: Stores) {
    serverPlaintext = JSON.stringify({ ark: db(stores), onchain: null });
    vi.stubGlobal("fetch", async () => Response.json({ iv: "00", ciphertext: "AA==", version: 86 }));
  }

  it("lifts the latch and adopts the version when nothing is missing locally", async () => {
    latch();
    serverHolds({ v: store("a") });
    localArk = { v: store("a", "b") };
    expect(await liftConflictLatchIfCovered(keys)).toBe(true);
    expect(isRestoreFailureLatched()).toBe(false);
    expect(localStorage.getItem(knownKey)).toBe("86");
  });

  it("keeps the latch and says what is missing", async () => {
    latch();
    serverHolds({ v: store("a", "z") });
    localArk = { v: store("a") };
    expect(await liftConflictLatchIfCovered(keys)).toBe(false);
    expect(localStorage.getItem(knownKey)).toBe("85");
    expect(getLastBackupStatus().restoreError).toBe(
      "BackupVersionConflictError: refusing to upload | missing locally: ark/v (1)",
    );
  });

  function restoreLatch() {
    localStorage.removeItem("btc-wallet-backup-conflict-latched");
    localStorage.setItem("btc-wallet-backup-restore-failed", "Error: backup fetch failed: 500");
  }

  it("lifts a failed-restore latch when nothing on the server is missing locally", async () => {
    restoreLatch();
    serverHolds({ v: store("a") });
    localArk = { v: store("a", "b") };
    expect(await liftConflictLatchIfCovered(keys)).toBe(true);
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("keeps a failed-restore latch while the server holds records this device lacks", async () => {
    restoreLatch();
    serverHolds({ v: store("a", "z") });
    localArk = { v: store("a") };
    expect(await liftConflictLatchIfCovered(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("lifts a failed-restore latch when the server has no backup at all, but not a conflict latch", async () => {
    restoreLatch();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    expect(await liftConflictLatchIfCovered(keys)).toBe(true);
    latch();
    expect(await liftConflictLatchIfCovered(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("keeps a failed-restore latch when the fetch itself fails", async () => {
    restoreLatch();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    expect(await liftConflictLatchIfCovered(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
  });
});

describe("performUpload without a server round trip", () => {
  it("sends nothing when the blob does not decrypt back to the hash it was made from", async () => {
    // The old fetch-tmp read-back proved this against the server; it is local now.
    serverPlaintext = "something else";
    localHash = "local";
    const sha = vi.fn(async (data: Uint8Array) => (new TextDecoder().decode(data) === "something else" ? "other" : "local"));
    vi.doMock("../src/lib/backup/backupCrypto", () => ({
      sha256Hex: sha,
      encryptBackupBlob: async () => ({ ivHex: "00", cipherB64: "AA==" }),
      decryptBackupBlob: async () => new TextEncoder().encode(serverPlaintext),
    }));
    vi.resetModules();
    const fresh = await import("../src/lib/backup/backup");
    localArk = { v: store("a") };
    const calls = server(0, "x");
    await fresh.uploadBackupNow(keys);
    expect(calls).toHaveLength(0);
    expect(localStorage.getItem("btc-wallet-backup-last-error")).toContain("hash mismatch");
    vi.doUnmock("../src/lib/backup/backupCrypto");
  });

  it("adopts a lost commit recorded by an earlier attempt, not only the latest one", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify([{ base: 84, sha256: "older" }]));
    const calls = server(85, "older");
    await upload();
    // The bare-object marker format of earlier builds is read too (list of one);
    // here the older attempt (84 -> 85) is adopted, then this state goes on top.
    expect(calls.map((c) => c.body.baseVersion)).toEqual([85]);
    expect(localStorage.getItem(knownKey)).toBe("86");
  });

  it("still recognises a lost commit after later attempts on the same base failed before reaching the server", async () => {
    // h1 committed 85 -> 86 but its reply was lost; h2 and h3 then never reached the server.
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify([{ base: 85, sha256: "h1" }]));
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    for (const h of ["h2", "h3"]) {
      localHash = h;
      expect(await uploadBackupNow(keys)).toBe(false);
    }
    localHash = "h4";
    const calls = server(86, "h1");
    await upload();
    expect(isRestoreFailureLatched()).toBe(false);
    expect(calls.map((c) => c.body.baseVersion)).toEqual([85, 86]);
    expect(localStorage.getItem(knownKey)).toBe("87");
  });

  it("drops markers of an older base, they can no longer match", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify([{ base: 80, sha256: "old" }]));
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await upload();
    expect(JSON.parse(localStorage.getItem(pendingKey) ?? "[]")).toEqual([{ base: 85, sha256: "local" }]);
  });
});
