import { describe, expect, it } from "vitest";
import { getSliding, putSliding, touchSliding, type SlidingKv } from "../worker/kvSliding";

function fakeKv() {
  const data = new Map<string, { value: string; metadata: unknown }>();
  const puts: string[] = [];
  const kv: SlidingKv = {
    async getWithMetadata(key) {
      const e = data.get(key);
      return e ? { value: e.value, metadata: e.metadata as never } : { value: null, metadata: null };
    },
    async put(key, value, options) {
      puts.push(key);
      data.set(key, { value, metadata: options.metadata });
    },
  };
  return { kv, data, puts };
}

const DAY = 86400;
const TTL = 40 * DAY;
const REFRESH = TTL / 4;
const T0 = 1_800_000_000_000;

describe("kvSliding", () => {
  it("reports a missing entry as null and infinitely old", async () => {
    const { kv } = fakeKv();
    expect(await getSliding(kv, "k", T0)).toEqual({ value: null, ageSeconds: Infinity });
  });

  it("reads the age back from the metadata written by putSliding", async () => {
    const { kv } = fakeKv();
    await putSliding(kv, "k", "v", TTL, T0);
    const r = await getSliding(kv, "k", T0 + 3 * DAY * 1000);
    expect(r.value).toBe("v");
    expect(r.ageSeconds).toBe(3 * DAY);
  });

  it("treats an entry written before ages existed as old, so it is rewritten once", async () => {
    const { kv, data } = fakeKv();
    data.set("k", { value: "v", metadata: null });
    const read = await getSliding(kv, "k", T0);
    expect(read.ageSeconds).toBe(Infinity);
    expect(await touchSliding(kv, "k", "v", read, TTL, REFRESH, T0)).toBe(true);
    const again = await getSliding(kv, "k", T0);
    expect(again.ageSeconds).toBe(0);
    expect(await touchSliding(kv, "k", "v", again, TTL, REFRESH, T0)).toBe(false);
  });

  it("does not write for a fresh, identical entry", async () => {
    const { kv, puts } = fakeKv();
    await putSliding(kv, "k", "v", TTL, T0);
    puts.length = 0;
    for (let d = 0; d < 9; d++) {
      const read = await getSliding(kv, "k", T0 + d * DAY * 1000);
      expect(await touchSliding(kv, "k", "v", read, TTL, REFRESH, T0 + d * DAY * 1000)).toBe(false);
    }
    expect(puts).toEqual([]);
  });

  it("writes once the entry is older than the refresh age, then goes quiet again", async () => {
    const { kv, puts } = fakeKv();
    await putSliding(kv, "k", "v", TTL, T0);
    puts.length = 0;
    const later = T0 + 11 * DAY * 1000;
    expect(await touchSliding(kv, "k", "v", await getSliding(kv, "k", later), TTL, REFRESH, later)).toBe(true);
    expect(puts).toEqual(["k"]);
    expect(await touchSliding(kv, "k", "v", await getSliding(kv, "k", later), TTL, REFRESH, later)).toBe(false);
  });

  it("writes when the value changed, however fresh", async () => {
    const { kv } = fakeKv();
    await putSliding(kv, "k", "old", TTL, T0);
    expect(await touchSliding(kv, "k", "new", await getSliding(kv, "k", T0), TTL, REFRESH, T0)).toBe(true);
    expect((await getSliding(kv, "k", T0)).value).toBe("new");
  });

  it("a subscriber renewing 4 times a day for 100 days writes about once per 10 days", async () => {
    const { kv, puts } = fakeKv();
    for (let step = 0; step < 400; step++) {
      const now = T0 + step * 6 * 3600 * 1000;
      await touchSliding(kv, "k", "v", await getSliding(kv, "k", now), TTL, REFRESH, now);
    }
    expect(puts.length).toBeGreaterThanOrEqual(9);
    expect(puts.length).toBeLessThanOrEqual(12);
  });
});
