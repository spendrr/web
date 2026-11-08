// publishNameSnapshot copies the registry's snapshot to the public bucket for the
// app, behind a tag, and never writes a bad or empty copy over a good one.
import { describe, expect, it } from "vitest";
import { publishNameSnapshot, publishPublicNames } from "../worker/index";
import { NAME_SNAPSHOT_CONTENT_TYPE } from "../worker/nameSnapshot";
import { encodeNameSnapshot, unwrapNameFile } from "../src/lib/names/nameHashSet";

function setup(registry: () => Promise<Response>, bucket = true) {
  const puts: { key: string; value: ArrayBuffer; options: { httpMetadata?: { contentType?: string; cacheControl?: string } } }[] = [];
  const env = {
    NAME_REGISTRY: { idFromName: () => "global", get: () => ({ fetch: registry }) },
    PRICE_PUBLIC: bucket
      ? {
          async put(key: string, value: ArrayBuffer, options: never) {
            puts.push({ key, value, options });
          },
        }
      : undefined,
  };
  return { env: env as never, puts };
}

const snapshotResponse = (names: string[]) =>
  new Response(encodeNameSnapshot(names).buffer as ArrayBuffer, { headers: { "content-type": NAME_SNAPSHOT_CONTENT_TYPE } });

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
      PRICE_PUBLIC: { put: async () => Promise.reject(new Error("R2 down")) },
    };
    await expect(publishNameSnapshot(env as never)).resolves.toBeUndefined();
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
