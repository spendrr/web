// Compression of the backup blob (src/lib/backup/backupCompress.ts), first as a unit
// and then end to end: real key derivation and AES-GCM, real gzip, a fake
// in-memory server behind the real upload/verify/commit/fetch code in backup.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compressBackup, decompressBackup, isGzip } from "../src/lib/backup/backupCompress";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("compressBackup / decompressBackup", () => {
  it("round-trips JSON and shrinks it", async () => {
    const json = enc(JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, hash: "ab".repeat(32) })) }));
    const packed = await compressBackup(json);
    expect(isGzip(packed)).toBe(true);
    expect(packed.length).toBeLessThan(json.length / 4);
    expect(dec(await decompressBackup(packed))).toBe(dec(json));
  });

  it("leaves data alone when gzip would not shrink it", async () => {
    const tiny = enc("{}");
    expect(await compressBackup(tiny)).toBe(tiny);
  });

  it("reads a backup from before compression existed as it always was", async () => {
    const legacy = enc('{"ark":null,"onchain":null}');
    expect(isGzip(legacy)).toBe(false);
    expect(await decompressBackup(legacy)).toBe(legacy);
  });

  it("never mistakes JSON for gzip: JSON starts with '{'", () => {
    expect(isGzip(enc("{}"))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f, 0x8b]))).toBe(true);
  });

  it("round-trips random inputs of every shape", async () => {
    for (let n = 0; n < 60; n++) {
      const len = Math.floor(Math.random() * 20000);
      const bytes = new Uint8Array(len);
      const mode = n % 3; // random, repetitive, ascii
      for (let i = 0; i < len; i++) bytes[i] = mode === 0 ? Math.random() * 256 : mode === 1 ? i % 7 : 97 + (i % 26);
      // a payload that starts with the gzip magic but is not gzip must not be
      // passed to compress as "already compressed": compress always re-wraps
      const packed = await compressBackup(bytes);
      expect(Array.from(await decompressBackup(packed))).toEqual(Array.from(bytes));
    }
  });

  it("rejects a corrupted gzip stream", async () => {
    const packed = await compressBackup(enc("x".repeat(5000)));
    packed[packed.length - 6] ^= 0xff;
    await expect(decompressBackup(packed)).rejects.toThrow();
  });

  it("refuses a stream that inflates past the limit", async () => {
    const bomb = await compressBackup(new Uint8Array(3 * 1024 * 1024)); // compresses to a few KB
    await expect(decompressBackup(bomb, 1024 * 1024)).rejects.toThrow(/size limit/);
    expect((await decompressBackup(bomb, 4 * 1024 * 1024)).length).toBe(3 * 1024 * 1024);
  });
});

// ---- end to end -----------------------------------------------------------

vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: vi.fn() }));
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({ isMaintenanceSuppressed: () => false }));

let localDbs: Record<string, unknown> = {};
vi.mock("../src/lib/backup/backupStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/backup/backupStore")>()),
  ARK_DB_NAME: "ark",
  ONCHAIN_DB_NAME: "onchain",
  dumpDatabase: async (name: string) => (localDbs[name] as unknown) ?? null,
  hasAnyLocalWalletData: async () => true,
  restoreDatabase: vi.fn(),
}));

const { deriveBackupKeys, encryptBackupBlob } = await import("../src/lib/backup/backupCrypto");
const { tagValue } = await import("../src/lib/backup/backupStore");
const { uploadBackupNow, fetchAndDecryptBackup } = await import("../src/lib/backup/backup");

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Records shaped like real ones: tagged binary values (base64 inside JSON)
// plus structured metadata, in several stores.
function realisticDb(name: string, rows: number) {
  const bytes = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7) & 0xff);
  const records = Array.from({ length: rows }, (_, i) => ({
    key: i,
    value: {
      id: `vtxo-${i}`,
      amount: 1000 + i,
      expiry: 900000 + i,
      state: "Spendable",
      tx: tagValue(bytes(180, i % 5)),
      script: tagValue(bytes(34, 3)),
    },
  }));
  return { name, version: 1, stores: { movements: { keyPath: null, indexes: [], records }, meta: { keyPath: null, indexes: [], records: [{ key: "k", value: "v" }] } } };
}

// In-memory stand-in for the Worker's backup endpoints; keeps what a real R2
// would keep, so tests can look at the stored bytes.
function fakeServer() {
  const state = { tmp: null as null | { iv: string; ciphertext: string; sha256: string }, committed: null as null | { iv: string; ciphertext: string; sha256: string; version: number } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, string | number>;
      if (path === "/api/backup/meta") return Response.json({ version: state.committed?.version ?? 0, sha256: state.committed?.sha256 ?? null });
      if (path === "/api/backup/upload-tmp") {
        state.tmp = { iv: body.iv as string, ciphertext: body.ciphertext as string, sha256: body.sha256 as string };
        return new Response(null, { status: 204 });
      }
      if (path === "/api/backup/fetch-tmp") return state.tmp ? Response.json({ iv: state.tmp.iv, ciphertext: state.tmp.ciphertext }) : new Response(null, { status: 404 });
      if (path === "/api/backup/commit") {
        if (!state.tmp || state.tmp.sha256 !== body.sha256) return new Response(null, { status: 409 });
        state.committed = { ...state.tmp, version: ((state.committed?.version ?? 0) as number) + 1 };
        return Response.json({ version: state.committed.version });
      }
      if (path === "/api/backup/fetch")
        return state.committed ? Response.json({ iv: state.committed.iv, ciphertext: state.committed.ciphertext, version: state.committed.version }) : new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    }),
  );
  return state;
}

async function uploadAndWait(keys: Awaited<ReturnType<typeof deriveBackupKeys>>) {
  uploadBackupNow(keys);
  await vi.waitFor(() => expect(localStorage.getItem("btc-wallet-backup-last-success-at") ?? localStorage.getItem("btc-wallet-backup-last-attempt-at")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 150));
}

describe("compressed backup, end to end", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uploads compressed, verifies, commits and restores the identical dump", async () => {
    const keys = await deriveBackupKeys(MNEMONIC);
    localDbs = { ark: realisticDb("ark", 400), onchain: realisticDb("onchain", 200), gifts: null, vouchers: null };
    const server = fakeServer();
    await uploadAndWait(keys);

    expect(server.committed).not.toBeNull();
    expect(server.committed!.version).toBe(1);

    const uncompressedJson = JSON.stringify({ ark: localDbs.ark, onchain: localDbs.onchain, gifts: null, vouchers: null });
    // ciphertext is base64 of gzip+AES; must be far smaller than the plain JSON
    expect(server.committed!.ciphertext.length).toBeLessThan(uncompressedJson.length / 3);

    const fetched = await fetchAndDecryptBackup(keys);
    expect(fetched).not.toBeNull();
    expect(JSON.parse(JSON.stringify(fetched!.dump))).toEqual(JSON.parse(uncompressedJson));
  });

  it("the committed hash is the hash of the uncompressed JSON (lost-commit logic depends on it)", async () => {
    const keys = await deriveBackupKeys(MNEMONIC);
    localDbs = { ark: realisticDb("ark", 50), onchain: null, gifts: null, vouchers: null };
    const server = fakeServer();
    await uploadAndWait(keys);
    const json = JSON.stringify({ ark: localDbs.ark, onchain: null, gifts: null, vouchers: null });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(server.committed!.sha256).toBe(hex);
  });

  it("restores a legacy backup that was never compressed", async () => {
    const keys = await deriveBackupKeys(MNEMONIC);
    const dump = { ark: realisticDb("ark", 20), onchain: null, gifts: null, vouchers: null };
    const legacy = await encryptBackupBlob(keys.encryptionKey, new TextEncoder().encode(JSON.stringify(dump)));
    const server = fakeServer();
    server.committed = { iv: legacy.ivHex, ciphertext: legacy.cipherB64, sha256: "x", version: 7 };
    const fetched = await fetchAndDecryptBackup(keys);
    expect(localStorage.getItem(`btc-wallet-backup-known-version:${keys.lookupKey}`)).toBe("7");
    expect(JSON.parse(JSON.stringify(fetched!.dump))).toEqual(JSON.parse(JSON.stringify(dump)));
  });

  it("a wrong key still fails to open a compressed backup", async () => {
    const keys = await deriveBackupKeys(MNEMONIC);
    localDbs = { ark: realisticDb("ark", 30), onchain: null, gifts: null, vouchers: null };
    const server = fakeServer();
    await uploadAndWait(keys);
    const other = await deriveBackupKeys(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    );
    const state = server.committed!;
    // same server object, other wallet's key
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ iv: state.iv, ciphertext: state.ciphertext, version: 1 })));
    await expect(fetchAndDecryptBackup(other)).rejects.toThrow();
  });
});
