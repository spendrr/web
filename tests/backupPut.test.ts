// POST /api/backup/put is the single-request upload (validate, authorize,
// version-check, write). It replaces upload-tmp + fetch-tmp + commit, so what
// those guaranteed must hold here: no write without the token, no write on a
// stale base, a lost swap is a 409 and writes nothing, and a truncated body
// never reaches storage.
import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { hashWriteToken } from "../worker/backupAuth";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const LOOKUP = "a".repeat(64);
const TOKEN = "b".repeat(64);
const SHA = "c".repeat(64);
const IV = "0".repeat(24);
const CSHA = "f0".repeat(32);

interface Put {
  key: string;
  value: unknown;
  options: { onlyIf?: unknown; sha256?: unknown; customMetadata?: Record<string, string> };
}

type Committed = { etag: string; version: string; sha256?: string; token?: string };
async function setup(opts: { committed?: Committed; afterPut?: Committed; putResult?: unknown; putThrows?: boolean }) {
  const tokenHash = await hashWriteToken(opts.committed?.token ?? TOKEN);
  const afterTokenHash = await hashWriteToken(opts.afterPut?.token ?? opts.committed?.token ?? TOKEN);
  const puts: Put[] = [];
  const bucket = {
    async get() {
      return { body: new ReadableStream(), customMetadata: { iv: IV, version: opts.committed?.version ?? "0" } };
    },
    async head() {
      // After a put attempt, another device's object if the test names one (the winner of a lost swap).
      const after = puts.length > 0 && opts.afterPut !== undefined;
      const c = after ? opts.afterPut : opts.committed;
      return c
        ? {
            etag: c.etag,
            customMetadata: { writeTokenHash: after ? afterTokenHash : tokenHash, version: c.version, sha256: c.sha256 ?? "d".repeat(64) },
          }
        : null;
    },
    async put(key: string, value: unknown, options: Put["options"]) {
      puts.push({ key, value, options });
      if (opts.putThrows) throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      return "putResult" in opts ? opts.putResult : {};
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
  const env = {
    WALLET_BACKUPS: bucket,
    BACKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    PUSH_SUBSCRIPTIONS: { get: async () => null, put: async () => {}, getWithMetadata: async () => ({ value: null, metadata: null }) },
  };
  return { env, puts };
}

function put(env: unknown, fields: Record<string, unknown> = {}, rawBody?: string) {
  const req = new Request("https://spendrr.app/api/backup/put", {
    method: "POST",
    headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.9" },
    body:
      rawBody ??
      JSON.stringify({ lookupKey: LOOKUP, writeToken: TOKEN, iv: IV, ciphertext: "AAAA", sha256: SHA, cipherSha256: CSHA, baseVersion: 7, ...fields }),
  });
  return worker.fetch(req, env as never, ctx);
}

describe("POST /api/backup/put", () => {
  it("writes with a compare-and-swap on the etag it read and returns the next version", async () => {
    const { env, puts } = await setup({ committed: { etag: "etag-7", version: "7" } });
    const res = await put(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 8 });
    const main = puts.find((p) => p.key === LOOKUP)!;
    expect(main.options.onlyIf).toEqual({ etagMatches: "etag-7" });
    expect(main.options.customMetadata).toMatchObject({ version: "8", sha256: SHA, iv: IV });
    // R2 checks the body against the hash of the exact text the client verified.
    expect(main.options.sha256).toBe(CSHA);
  });

  it("a body R2 refuses (checksum mismatch) is a 503, never a success", async () => {
    const { env } = await setup({ committed: { etag: "etag-7", version: "7" }, putThrows: true });
    const res = await put(env);
    expect(res.status).toBe(503);
  });

  it("requires the ciphertext hash", async () => {
    const { env, puts } = await setup({ committed: { etag: "e", version: "7" } });
    expect((await put(env, { cipherSha256: undefined })).status).toBe(400);
    expect((await put(env, { cipherSha256: "AB".repeat(32) })).status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it("a lost swap is a 409 that carries the winner's state, not the stale one read before the put", async () => {
    const { env } = await setup({
      committed: { etag: "etag-7", version: "7", sha256: "e".repeat(64) },
      afterPut: { etag: "etag-8", version: "8", sha256: "9".repeat(64) },
      putResult: null,
    });
    const res = await put(env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ version: 8, sha256: "9".repeat(64) });
  });

  it("a lost swap to a winner with a write token this caller does not hold discloses nothing", async () => {
    // The object read first predates write tokens, so any token passes; the winner then set one.
    const { env } = await setup({
      committed: { etag: "etag-7", version: "7", sha256: "e".repeat(64), token: TOKEN },
      afterPut: { etag: "etag-8", version: "8", sha256: "9".repeat(64), token: "f".repeat(64) },
      putResult: null,
    });
    const res = await put(env);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("version");
    expect(text).not.toContain("9".repeat(64));
  });

  it("a stale base is a 409 and nothing is written", async () => {
    const { env, puts } = await setup({ committed: { etag: "etag-9", version: "9", sha256: "e".repeat(64) } });
    const res = await put(env, { baseVersion: 7 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ version: 9, sha256: "e".repeat(64) });
    expect(puts).toHaveLength(0);
  });

  it("a first backup is written unconditionally at version 1", async () => {
    const { env, puts } = await setup({});
    const res = await put(env, { baseVersion: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });
    expect(puts).toHaveLength(1);
    expect(puts[0].options.onlyIf).toBeUndefined();
  });

  it("refuses another wallet's write token and leaks nothing about the stored backup", async () => {
    const { env, puts } = await setup({ committed: { etag: "e", version: "7", token: "f".repeat(64) } });
    const res = await put(env);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("version");
    expect(puts).toHaveLength(0);
  });

  it("writes exactly one object: no copy of the replaced backup is kept", async () => {
    const { env, puts } = await setup({ committed: { etag: "etag-7", version: "7" } });
    await put(env);
    expect(puts.map((p) => p.key)).toEqual([LOOKUP]);
  });

  it("a truncated body is rejected before anything is stored", async () => {
    const { env, puts } = await setup({ committed: { etag: "e", version: "7" } });
    const full = JSON.stringify({ lookupKey: LOOKUP, writeToken: TOKEN, iv: IV, ciphertext: "AAAA", sha256: SHA, baseVersion: 7 });
    const res = await put(env, {}, full.slice(0, full.length - 10));
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it("rejects a ciphertext that is not canonical base64, and a bad baseVersion", async () => {
    const { env, puts } = await setup({ committed: { etag: "e", version: "7" } });
    expect((await put(env, { ciphertext: "AA=A" })).status).toBe(400);
    expect((await put(env, { baseVersion: -1 })).status).toBe(400);
    expect((await put(env, { baseVersion: "7" })).status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it("refuses a body over the size ceiling before parsing it", async () => {
    const { env, puts } = await setup({ committed: { etag: "e", version: "7" } });
    const res = await put(env, {}, "x".repeat(11 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(puts).toHaveLength(0);
  });
});
