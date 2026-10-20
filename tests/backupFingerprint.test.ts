// The cloud backup skips an upload when nothing but the block checkpoints moved
// (src/lib/backup/backupFingerprint.ts, performUpload in backup.ts).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: vi.fn() }));
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({ isMaintenanceSuppressed: () => false }));

type Records = { key: unknown; value: unknown }[];
const changeset = (blocks: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  partition: 1,
  pk: [],
  data: Array.from(
    new TextEncoder().encode(
      JSON.stringify({
        descriptor: "tr(x)",
        local_chain: { blocks },
        tx_graph: { txs: [], anchors: [] },
        indexer: { last_revealed: { a: 0 } },
        ...extra,
      }),
    ),
  ),
});
const dbOf = (records: Records) => ({ name: "n", version: 1, stores: { s: { keyPath: null, indexes: [], records } } });

let ark = dbOf([{ key: 1, value: "vtxo" }]);
let onchain = dbOf([{ key: "", value: changeset({ "100": "aa" }) }]);
vi.mock("../src/lib/backup/backupStore", () => ({
  ARK_DB_NAME: "ark",
  ONCHAIN_DB_NAME: "onchain",
  dumpDatabase: async (name: string) => (name === "ark" ? ark : name === "onchain" ? onchain : null),
  hasAnyLocalWalletData: async () => true,
  restoreDatabase: vi.fn(),
}));
vi.mock("../src/lib/backup/backupCrypto", () => ({
  sha256Hex: async (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  encryptBackupBlob: async () => ({ ivHex: "00", cipherB64: "AA==" }),
  decryptBackupBlob: async () => new Uint8Array(),
}));
// The read-back check decrypts what the server holds; hand it the last upload.
let lastPlain = new Uint8Array();
vi.mock("../src/lib/backup/backupCompress", () => ({
  compressBackup: async (b: Uint8Array) => {
    lastPlain = b;
    return b;
  },
  decompressBackup: async () => lastPlain,
}));

const { uploadBackupNow } = await import("../src/lib/backup/backup");
const { dumpWithoutChainCheckpoints } = await import("../src/lib/backup/backupFingerprint");

const LOOKUP = "fp";
const keys = { lookupKey: LOOKUP, writeToken: "b".repeat(64), encryptionKey: {} as CryptoKey };

let version = 0;
function server() {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      paths.push(path);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path === "/api/backup/meta") return Response.json({ version, sha256: null });
      if (path === "/api/backup/fetch-tmp") return Response.json({ iv: "00", ciphertext: "AA==" });
      if (path === "/api/backup/commit") {
        version = (body.baseVersion as number) + 1;
        return Response.json({ version });
      }
      return new Response(null, { status: 204 });
    }),
  );
  return paths;
}

async function upload(): Promise<string[]> {
  const paths = server();
  localStorage.removeItem("btc-wallet-backup-last-attempt-at");
  uploadBackupNow(keys);
  await vi.waitFor(() => expect(localStorage.getItem("btc-wallet-backup-last-attempt-at")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 20));
  return paths;
}

beforeEach(() => {
  localStorage.clear();
  version = 0;
  ark = dbOf([{ key: 1, value: "vtxo" }]);
  onchain = dbOf([{ key: "", value: changeset({ "100": "aa" }) }]);
});

describe("dumpWithoutChainCheckpoints", () => {
  it("returns null when there is no changeset to strip", () => {
    expect(dumpWithoutChainCheckpoints({ onchain: dbOf([{ key: 1, value: "x" }]) })).toBeNull();
    expect(dumpWithoutChainCheckpoints({ onchain: null })).toBeNull();
  });

  it("returns null for bytes that are not a changeset", () => {
    const junk = { partition: 1, pk: [], data: [0xff, 0xfe] };
    expect(dumpWithoutChainCheckpoints({ onchain: dbOf([{ key: "", value: junk }]) })).toBeNull();
    const noGraph = { partition: 1, pk: [], data: Array.from(new TextEncoder().encode('{"local_chain":{}}')) };
    expect(dumpWithoutChainCheckpoints({ onchain: dbOf([{ key: "", value: noGraph }]) })).toBeNull();
  });

  it("is equal across checkpoint-only differences and not across anything else", () => {
    const a = dumpWithoutChainCheckpoints({ onchain: dbOf([{ key: "", value: changeset({ "100": "aa" }) }]) });
    const b = dumpWithoutChainCheckpoints({ onchain: dbOf([{ key: "", value: changeset({ "101": "bb", "102": "cc" }) }]) });
    const c = dumpWithoutChainCheckpoints({
      onchain: dbOf([{ key: "", value: changeset({ "100": "aa" }, { indexer: { last_revealed: { a: 1 } } }) }]),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("does not touch its input", () => {
    const input = { onchain: dbOf([{ key: "", value: changeset({ "100": "aa" }) }]) };
    const before = JSON.stringify(input);
    dumpWithoutChainCheckpoints(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("performUpload and block checkpoints", () => {
  it("uploads the first time, then skips when only the checkpoints moved", async () => {
    expect(await upload()).toContain("/api/backup/commit");
    onchain = dbOf([{ key: "", value: changeset({ "101": "bb", "102": "cc" }) }]);
    expect(await upload()).toEqual([]);
  });

  it("uploads when an address was revealed, a transaction arrived, or the Ark database moved", async () => {
    await upload();
    onchain = dbOf([{ key: "", value: changeset({ "100": "aa" }, { indexer: { last_revealed: { a: 1 } } }) }]);
    expect(await upload()).toContain("/api/backup/commit");
    ark = dbOf([{ key: 1, value: "vtxo" }, { key: 2, value: "vtxo2" }]);
    expect(await upload()).toContain("/api/backup/commit");
  });

  it("uploads anyway once the last commit is a day old", async () => {
    await upload();
    const key = `btc-wallet-backup-last-fingerprint:${LOOKUP}`;
    const last = JSON.parse(localStorage.getItem(key) ?? "{}") as { fp: string; at: number };
    localStorage.setItem(key, JSON.stringify({ fp: last.fp, at: Date.now() - 25 * 3600_000 }));
    onchain = dbOf([{ key: "", value: changeset({ "105": "dd" }) }]);
    expect(await upload()).toContain("/api/backup/commit");
  });

  it("a failed upload records no fingerprint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    localStorage.removeItem("btc-wallet-backup-last-attempt-at");
    uploadBackupNow(keys);
    await vi.waitFor(() => expect(localStorage.getItem("btc-wallet-backup-last-attempt-at")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(localStorage.getItem(`btc-wallet-backup-last-fingerprint:${LOOKUP}`)).toBeNull();
  });
});
