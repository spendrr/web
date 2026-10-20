// handleBackupCommit must promote the tmp object with a compare-and-swap on the
// committed object's etag. head() and put() are two calls; without the
// precondition two devices committing from the same base version both passed
// the version check and the later put silently replaced the earlier backup.
import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { hashWriteToken } from "../worker/backupAuth";

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const LOOKUP = "a".repeat(64);
const TOKEN = "b".repeat(64);
const SHA = "c".repeat(64);

async function setup(opts: { committed?: { etag: string; version: string }; putResult: unknown }) {
  const tokenHash = await hashWriteToken(TOKEN);
  const puts: { key: string; options: { onlyIf?: unknown } }[] = [];
  const bucket = {
    async get() {
      return { body: new ReadableStream(), customMetadata: { sha256: SHA, writeTokenHash: tokenHash, iv: "0".repeat(24) } };
    },
    async head() {
      return opts.committed
        ? { etag: opts.committed.etag, customMetadata: { writeTokenHash: tokenHash, version: opts.committed.version } }
        : null;
    },
    async put(key: string, _value: unknown, options: { onlyIf?: unknown }) {
      puts.push({ key, options });
      return opts.putResult;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
  const env = { WALLET_BACKUPS: bucket, BACKUP_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  return { env, puts };
}

function commit(env: unknown, baseVersion: number) {
  const req = new Request("https://spendrr.app/api/backup/commit", {
    method: "POST",
    headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.9" },
    body: JSON.stringify({ lookupKey: LOOKUP, writeToken: TOKEN, sha256: SHA, baseVersion }),
  });
  return worker.fetch(req, env as never, ctx);
}

describe("POST /api/backup/commit compare-and-swap", () => {
  it("swaps only against the etag it read, and answers 409 when the swap loses", async () => {
    const { env, puts } = await setup({ committed: { etag: "etag-7", version: "7" }, putResult: null });
    const res = await commit(env, 7);
    expect(res.status).toBe(409);
    expect(puts[0].options.onlyIf).toEqual({ etagMatches: "etag-7" });
  });

  it("succeeds when the swap wins", async () => {
    const { env } = await setup({ committed: { etag: "etag-7", version: "7" }, putResult: {} });
    const res = await commit(env, 7);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 8 });
  });

  it("a first backup has nothing to compare against and is written as before", async () => {
    const { env, puts } = await setup({ putResult: {} });
    const res = await commit(env, 0);
    expect(res.status).toBe(200);
    expect(puts[0].options.onlyIf).toBeUndefined();
  });
});

// A lookupKey is public by design. The per-wallet write limiter must not be
// keyed by it alone, or anyone who knows a victim's key can keep the victim's
// uploads at 429 with well-formed requests carrying a made-up token.
describe("backup per-wallet limiter bucket", () => {
  async function keysFor(token: string) {
    const { env } = await setup({ committed: { etag: "e", version: "1" }, putResult: {} });
    const keys: string[] = [];
    (env as unknown as { BACKUP_RATE_LIMITER: { limit: (o: { key: string }) => Promise<{ success: boolean }> } }).BACKUP_RATE_LIMITER.limit =
      async ({ key }) => {
        keys.push(key);
        return { success: true };
      };
    const req = new Request("https://spendrr.app/api/backup/commit", {
      method: "POST",
      headers: { Origin: "https://spendrr.app", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ lookupKey: LOOKUP, writeToken: token, sha256: SHA, baseVersion: 1 }),
    });
    await worker.fetch(req, env as never, ctx);
    return keys;
  }

  it("is not the bare lookupKey, and differs per write token", async () => {
    const mine = await keysFor(TOKEN);
    const theirs = await keysFor("d".repeat(64));
    const perWallet = (k: string[]) => k.find((x) => x.startsWith("k:"));
    expect(mine).not.toContain(LOOKUP);
    expect(perWallet(mine)).toBeDefined();
    expect(perWallet(theirs)).toBeDefined();
    expect(perWallet(mine)).not.toBe(perWallet(theirs));
    expect(perWallet(mine)).not.toContain(TOKEN);
  });
});
