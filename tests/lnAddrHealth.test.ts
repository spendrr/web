import { describe, expect, it } from "vitest";
import {
  LNADDR_REFUSING_KEY,
  lnAddrHealthResponse,
  syncLnAddrRefusing,
  type FlagKv,
  type HealthCache,
} from "../worker/lnAddrHealth";

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const ops = { get: 0, put: 0, delete: 0 };
  const kv: FlagKv = {
    async get(key) {
      ops.get++;
      return data.get(key) ?? null;
    },
    async put(key, value) {
      ops.put++;
      data.set(key, value);
    },
    async delete(key) {
      ops.delete++;
      data.delete(key);
    },
  };
  return { kv, data, ops };
}

function memoryCache() {
  const data = new Map<string, Response>();
  const cache: HealthCache = {
    async match(request) {
      return data.get(request.url)?.clone();
    },
    async put(request, response) {
      data.set(request.url, response);
    },
  };
  return { cache, data };
}

describe("syncLnAddrRefusing", () => {
  it("writes only when the state changes", async () => {
    const { kv, data, ops } = memoryKv();
    expect(await syncLnAddrRefusing(kv, false)).toBe("unchanged");
    expect(await syncLnAddrRefusing(kv, true)).toBe("set");
    expect(data.get(LNADDR_REFUSING_KEY)).toBe("1");
    expect(await syncLnAddrRefusing(kv, true)).toBe("unchanged");
    expect(await syncLnAddrRefusing(kv, false)).toBe("cleared");
    expect(data.has(LNADDR_REFUSING_KEY)).toBe(false);
    // A day of healthy minutes after that costs reads, never writes.
    for (let i = 0; i < 1440; i++) await syncLnAddrRefusing(kv, false);
    expect(ops.put + ops.delete).toBe(2);
  });

  it("ignores a reply without a boolean (ledger did not answer)", async () => {
    const { kv, ops } = memoryKv({ [LNADDR_REFUSING_KEY]: "1" });
    expect(await syncLnAddrRefusing(kv, undefined)).toBe("skipped");
    expect(await syncLnAddrRefusing(kv, null)).toBe("skipped");
    expect(ops).toEqual({ get: 0, put: 0, delete: 0 });
  });
});

describe("lnAddrHealthResponse", () => {
  it("answers ok while no switch is on", async () => {
    const { kv } = memoryKv();
    const res = await lnAddrHealthResponse(memoryCache().cache, kv, true);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers not ok while a switch is on, and when the feature is not configured", async () => {
    const { kv } = memoryKv({ [LNADDR_REFUSING_KEY]: "1" });
    expect(await (await lnAddrHealthResponse(memoryCache().cache, kv, true)).json()).toEqual({ ok: false });
    expect(await (await lnAddrHealthResponse(memoryCache().cache, memoryKv().kv, false)).json()).toEqual({ ok: false });
  });

  it("reads KV once per cache lifetime, not per request", async () => {
    const { kv, ops } = memoryKv();
    const { cache } = memoryCache();
    for (let i = 0; i < 50; i++) await lnAddrHealthResponse(cache, kv, true);
    expect(ops.get).toBe(1);
  });

  it("a KV failure answers ok and is not cached", async () => {
    const { cache, data } = memoryCache();
    const broken: FlagKv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {},
      delete: async () => {},
    };
    expect(await (await lnAddrHealthResponse(cache, broken, true)).json()).toEqual({ ok: true });
    expect(data.size).toBe(0);
  });
});
