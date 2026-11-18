// backupCycle.ts builds the bundle JSON from one serialized string per database. The hash the backup versions
// key on and the stored fingerprints must come out exactly as the single JSON.stringify of the whole bundle
// gave them, so an update does not cost one extra upload and an old backup still verifies.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dumpWithoutChainCheckpoints } from "../src/lib/backup/backupFingerprint";

const dbs: Record<string, unknown> = {};
vi.mock("../src/lib/backup/backupStore", () => ({
  ARK_DB_NAME: "ark",
  ONCHAIN_DB_NAME: "onchain",
  dumpDatabase: async (name: string) => dbs[name] ?? null,
}));
vi.mock("../src/lib/gift/giftStore", () => ({ GIFTS_DB_NAME: "gifts" }));

import { prepareDump, stringifyDump } from "../src/lib/backup/backupCycle";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const oldStringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function onchainRecord(chain: unknown) {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ local_chain: chain, tx_graph: { txs: ["a"] }, keychain: 7 })));
  return { stores: { s: { records: [{ key: 1, value: { data: bytes } }] } } };
}

beforeEach(() => {
  for (const k of Object.keys(dbs)) delete dbs[k];
  dbs.ark = { stores: { v: { records: [{ key: "a", value: { n: 1, s: "x" } }] } } };
  dbs.onchain = onchainRecord({ "1": "aa" });
  dbs.gifts = { stores: {} };
});

describe("prepareDump", () => {
  it("hashes the same bytes as one JSON.stringify of the whole bundle", async () => {
    const dump = { ark: dbs.ark, onchain: dbs.onchain, gifts: dbs.gifts, vouchers: null };
    const r = await prepareDump();
    if (r.kind !== "ready") throw new Error("not ready");
    expect(new TextDecoder().decode(r.prepared.plaintext)).toBe(oldStringify(dump));
    expect(r.prepared.expectedHash).toBe(sha(oldStringify(dump)));
  });

  it("fingerprint equals the hash of the bundle without block checkpoints, as before", async () => {
    const dump = { ark: dbs.ark, onchain: dbs.onchain, gifts: dbs.gifts, vouchers: null };
    const stripped = dumpWithoutChainCheckpoints(dump);
    expect(stripped).not.toBeNull();
    const r = await prepareDump();
    if (r.kind !== "ready") throw new Error("not ready");
    expect(r.prepared.fingerprint).toBe(sha(oldStringify(stripped)));
    expect(r.prepared.fingerprint).not.toBe(r.prepared.expectedHash);
  });

  it("a new block changes the hash but not the fingerprint", async () => {
    const first = await prepareDump();
    dbs.onchain = onchainRecord({ "1": "aa", "2": "bb" });
    const second = await prepareDump();
    if (first.kind !== "ready" || second.kind !== "ready") throw new Error("not ready");
    expect(second.prepared.expectedHash).not.toBe(first.prepared.expectedHash);
    expect(second.prepared.fingerprint).toBe(first.prepared.fingerprint);
  });

  it("without checkpoints the fingerprint is the full hash", async () => {
    dbs.onchain = null;
    const r = await prepareDump();
    if (r.kind !== "ready") throw new Error("not ready");
    expect(r.prepared.fingerprint).toBe(r.prepared.expectedHash);
  });

  it("reports nothing to back up, and an Ark database that dumped empty", async () => {
    dbs.ark = null;
    expect((await prepareDump()).kind).toBe("noArk");
    dbs.onchain = null;
    dbs.gifts = null;
    expect((await prepareDump()).kind).toBe("nothing");
  });
});

describe("stringifyDump", () => {
  it("is plain JSON.stringify when nothing needs the bigint replacer", () => {
    const v = { a: [1, "x", null], b: { c: true } };
    expect(stringifyDump(v)).toBe(JSON.stringify(v));
  });

  it("falls back to strings for a bigint, like the old replacer", () => {
    const v = { a: 5n, b: [{ c: 7n }] };
    expect(stringifyDump(v)).toBe(oldStringify(v));
    expect(stringifyDump(v)).toBe('{"a":"5","b":[{"c":"7"}]}');
  });
});
