// performUpload's side of the lost-commit-reply fix (src/lib/backup/backup.ts,
// adoptOwnLostCommit): a device whose previous commit reached the server but
// whose reply got lost must adopt that version on the next upload instead of
// latching uploads off as a conflict.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Meta reports the given server state; the rest of the upload succeeds. The
// read-back hash comes from the same mocked sha256Hex, so it always verifies.
function server(version: number, sha256: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/api/backup/meta") return Response.json({ version, sha256 });
      if (path === "/api/backup/fetch-tmp") return Response.json({ iv: "00", ciphertext: "AA==" });
      if (path === "/api/backup/commit") return Response.json({ version: (body.baseVersion as number) + 1 });
      return new Response(null, { status: 204 });
    }),
  );
  return calls;
}

async function upload() {
  uploadBackupNow(keys);
  await vi.waitFor(() => expect(localStorage.getItem("btc-wallet-backup-last-attempt-at")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 20));
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
    expect(calls.map((c) => c.path)).toEqual(["/api/backup/meta"]);
    expect(localStorage.getItem(knownKey)).toBe("86");
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("adopts its own commit and commits newer state on top of it", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify({ base: 85, sha256: "older" }));
    const calls = server(86, "older");
    await upload();
    expect(calls.find((c) => c.path === "/api/backup/commit")?.body.baseVersion).toBe(86);
    expect(localStorage.getItem(knownKey)).toBe("87");
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("latches when the next version holds bytes this device never sent", async () => {
    localStorage.setItem(knownKey, "85");
    localStorage.setItem(pendingKey, JSON.stringify({ base: 85, sha256: "older" }));
    const calls = server(86, "someone-else");
    await upload();
    expect(calls.map((c) => c.path)).toEqual(["/api/backup/meta"]);
    expect(localStorage.getItem(knownKey)).toBe("85");
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("leaves the marker when the commit reply fails", async () => {
    localStorage.setItem(knownKey, "85");
    const calls = server(85, "older");
    const realFetch = globalThis.fetch as unknown as (p: string, i: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      if (path === "/api/backup/commit") throw new TypeError("Failed to fetch");
      return realFetch(path, init);
    });
    await upload();
    expect(calls.some((c) => c.path === "/api/backup/upload-tmp")).toBe(true);
    expect(JSON.parse(localStorage.getItem(pendingKey) ?? "null")).toEqual({ base: 85, sha256: "local" });
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
