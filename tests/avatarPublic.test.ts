// The public avatar copy: key is a hash of the address (never the address),
// written once, only for a well-formed address, never throws.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ensurePublicAvatar } from "../worker/avatarPublic";
import { avatarAddressHash, avatarObjectKey, avatarPictureUrl } from "../src/lib/names/avatarKey";

const ADDRESS =
  "ark1pu6h30w3zqqpkhe3x8w4mq9pjhsaw9kzj3a74ynsm64nvcsll3qrpqmql9r5emnxkhlj3n2ch0x0kwqzg7l77vfs6ulu50kn5lx2qq8u5ecdtpu0re4wnre4sy9w5r";

function bucket(existing = false) {
  const puts: { key: string; value: ArrayBuffer; options: { httpMetadata?: { contentType?: string; cacheControl?: string } } }[] = [];
  return {
    puts,
    r2: {
      head: vi.fn(async () => (existing ? { etag: "1" } : null)),
      put: vi.fn(async (key: string, value: ArrayBuffer, options: never) => {
        puts.push({ key, value, options });
        return {};
      }),
    },
  };
}

describe("avatar key", () => {
  it("is the first 32 hex chars of sha256 of the address", async () => {
    const want = createHash("sha256").update(ADDRESS).digest("hex").slice(0, 32);
    expect(await avatarAddressHash(ADDRESS)).toBe(want);
  });
  it("carries the engine version and never the address", async () => {
    const hash = await avatarAddressHash(ADDRESS);
    expect(avatarObjectKey(hash)).toBe(`avatar/v4/${hash}.png`);
    expect(avatarPictureUrl(hash)).toBe(`https://data.spendrr.app/avatar/v4/${hash}.png`);
    expect(avatarPictureUrl(hash)).not.toContain(ADDRESS.slice(0, 20));
  });
});

describe("ensurePublicAvatar", () => {
  it("writes an immutable PNG under the hashed key", async () => {
    const b = bucket();
    await ensurePublicAvatar({ PRICE_PUBLIC: b.r2 as never }, ADDRESS);
    expect(b.puts).toHaveLength(1);
    expect(b.puts[0].key).toBe(avatarObjectKey(await avatarAddressHash(ADDRESS)));
    expect(b.puts[0].options.httpMetadata?.contentType).toBe("image/png");
    expect(b.puts[0].options.httpMetadata?.cacheControl).toContain("immutable");
    expect([...new Uint8Array(b.puts[0].value).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("does not render or write when the file is already there", async () => {
    const b = bucket(true);
    await ensurePublicAvatar({ PRICE_PUBLIC: b.r2 as never }, ADDRESS);
    expect(b.puts).toHaveLength(0);
  });
  it("ignores a malformed address and a missing bucket", async () => {
    const b = bucket();
    await ensurePublicAvatar({ PRICE_PUBLIC: b.r2 as never }, "not-an-address");
    await ensurePublicAvatar({}, ADDRESS);
    expect(b.r2.head).not.toHaveBeenCalled();
  });
  it("swallows a bucket failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r2 = { head: async () => { throw new Error("r2 down"); }, put: async () => ({}) };
    await expect(ensurePublicAvatar({ PRICE_PUBLIC: r2 as never }, ADDRESS)).resolves.toBeUndefined();
    err.mockRestore();
  });
});
