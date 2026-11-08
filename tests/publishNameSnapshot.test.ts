// publishNameSnapshot copies the registry's snapshot to the public bucket for the
// app, behind a tag, and never writes a bad or empty copy over a good one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishNameSnapshot, publishPublicNames } from "../worker/index";
import { NAME_SNAPSHOT_CONTENT_TYPE, NAME_SNAPSHOT_TAKEN_HEADER } from "../worker/nameSnapshot";
import { encodeNameSnapshot, unwrapNameFile } from "../src/lib/names/nameHashSet";

type Put = { key: string; value: ArrayBuffer; options: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> } };

// A bucket that keeps one object and honours the etag conditions publishNameSnapshot sends.
function fakeBucket() {
  const puts: Put[] = [];
  let etag = 0;
  let stored: { etag: string; customMetadata?: Record<string, string> } | null = null;
  return {
    puts,
    bucket: {
      async head() {
        return stored;
      },
      async put(key: string, value: ArrayBuffer, options: Put["options"] & { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
        const c = options.onlyIf;
        if (c?.etagMatches !== undefined && stored?.etag !== c.etagMatches) return null;
        if (c?.etagDoesNotMatch === "*" && stored) return null;
        puts.push({ key, value, options });
        stored = { etag: String(++etag), customMetadata: options.customMetadata };
        return stored;
      },
    },
  };
}

let nextTaken = 1000;
function setup(registry: () => Promise<Response>, bucket = true) {
  const fake = fakeBucket();
  const env = {
    NAME_REGISTRY: { idFromName: () => "global", get: () => ({ fetch: registry }) },
    PRICE_PUBLIC: bucket ? fake.bucket : undefined,
  };
  return { env: env as never, puts: fake.puts };
}

const snapshotResponse = (names: string[], taken = nextTaken++) =>
  new Response(encodeNameSnapshot(names).buffer as ArrayBuffer, {
    headers: { "content-type": NAME_SNAPSHOT_CONTENT_TYPE, [NAME_SNAPSHOT_TAKEN_HEADER]: String(taken) },
  });

describe("publishNameSnapshot", () => {
  it("writes names.bin, readable by the app, with a short cache time", async () => {
    const { env, puts } = setup(async () => snapshotResponse(["alice", "goat"]));
    await publishNameSnapshot(env);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("names.bin");
    expect(puts[0].options.httpMetadata?.cacheControl).toBe("public, max-age=60");
    const snapshot = unwrapNameFile(new Uint8Array(puts[0].value));
    expect(snapshot?.has("goat")).toBe(true);
    expect(snapshot?.has("nobody")).toBe(false);
  });

  it("writes nothing when the registry fails, answers something else, or has no names", async () => {
    for (const registry of [
      async () => new Response("x", { status: 500 }),
      async () => new Response(new Uint8Array(8).buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } }),
      async () => snapshotResponse([]),
      async () => {
        throw new Error("DO down");
      },
    ]) {
      const { env, puts } = setup(registry);
      await publishNameSnapshot(env);
      expect(puts).toHaveLength(0);
    }
  });

  it("does nothing, and does not throw, without the public bucket", async () => {
    const { env } = setup(async () => snapshotResponse(["alice"]), false);
    await expect(publishNameSnapshot(env)).resolves.toBeUndefined();
  });

  it("a failing write is swallowed (the write that triggered it must not fail)", async () => {
    const env = {
      NAME_REGISTRY: { idFromName: () => "global", get: () => ({ fetch: async () => snapshotResponse(["alice"]) }) },
      PRICE_PUBLIC: { head: async () => null, put: async () => Promise.reject(new Error("R2 down")) },
    };
    await expect(publishNameSnapshot(env as never)).resolves.toBeUndefined();
  });
});

describe("publishNameSnapshot ordering and time limit", () => {
  afterEach(() => vi.useRealTimers());

  it("an older copy finishing late never replaces a newer one", async () => {
    const fake = fakeBucket();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowOld = async () => {
      await gate;
      return snapshotResponse(["alice"], 100);
    };
    const mk = (registry: () => Promise<Response>) =>
      ({ NAME_REGISTRY: { idFromName: () => "global", get: () => ({ fetch: registry }) }, PRICE_PUBLIC: fake.bucket }) as never;
    const old = publishNameSnapshot(mk(slowOld));
    await publishNameSnapshot(mk(async () => snapshotResponse(["alice", "newname"], 200)));
    release();
    await old;
    expect(fake.puts).toHaveLength(1);
    expect(unwrapNameFile(new Uint8Array(fake.puts[0].value))?.has("newname")).toBe(true);
  });

  it("writes a newer copy over an older one", async () => {
    const fake = fakeBucket();
    const mk = (taken: number, names: string[]) =>
      ({ NAME_REGISTRY: { idFromName: () => "global", get: () => ({ fetch: async () => snapshotResponse(names, taken) }) }, PRICE_PUBLIC: fake.bucket }) as never;
    await publishNameSnapshot(mk(100, ["alice"]));
    await publishNameSnapshot(mk(200, ["alice", "bob"]));
    expect(fake.puts).toHaveLength(2);
    expect(unwrapNameFile(new Uint8Array(fake.puts[1].value))?.has("bob")).toBe(true);
  });

  it("retries when another write lands between the look and the put", async () => {
    const fake = fakeBucket();
    let first = true;
    const racing = {
      head: fake.bucket.head,
      async put(key: string, value: ArrayBuffer, options: never) {
        if (first) {
          first = false;
          await fake.bucket.put(key, value, { customMetadata: { taken: "150" } } as never);
        }
        return fake.bucket.put(key, value, options);
      },
    };
    const env = { NAME_REGISTRY: { idFromName: () => "global", get: () => ({ fetch: async () => snapshotResponse(["alice", "bob"], 300) }) }, PRICE_PUBLIC: racing } as never;
    await publishNameSnapshot(env);
    expect(fake.puts.at(-1)?.options.customMetadata?.taken).toBe("300");
  });

  it("writes nothing from a registry that gives no time stamp", async () => {
    const { env, puts } = setup(async () => new Response(encodeNameSnapshot(["alice"]).buffer as ArrayBuffer, { headers: { "content-type": NAME_SNAPSHOT_CONTENT_TYPE } }));
    await publishNameSnapshot(env);
    expect(puts).toHaveLength(0);
  });

  it("stops waiting for a stalled registry, so a name write is not held up", async () => {
    vi.useFakeTimers();
    const { env, puts } = setup(() => new Promise<Response>(() => {}));
    const done = publishNameSnapshot(env);
    await vi.advanceTimersByTimeAsync(4001);
    await expect(done).resolves.toBeUndefined();
    expect(puts).toHaveLength(0);
  });
});

describe("publishPublicNames (the cron)", () => {
  const at = (minute: number) => Date.UTC(2026, 10, 8, 12, minute, 0);
  it("runs at minute 3 and 33 of the hour only", async () => {
    const ran: number[] = [];
    for (const m of [0, 2, 3, 4, 30, 33, 34]) {
      const { env, puts } = setup(async () => snapshotResponse(["alice"]));
      await publishPublicNames(env, at(m));
      if (puts.length) ran.push(m);
    }
    expect(ran).toEqual([3, 33]);
  });
});
