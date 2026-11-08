import { beforeEach, describe, expect, it, vi } from "vitest";
import { LN_COMMENTS_KEY, LN_COMMENTS_MAX, cachedLnComment, loadLnComment } from "../src/lib/names/lnComments";

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const h = (i: number) => i.toString(16).padStart(64, "0");

describe("loadLnComment", () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
  });

  it("asks once and never again for the same payment", async () => {
    const fetcher = vi.fn().mockResolvedValue({ found: true, comment: "díky" });
    expect(await loadLnComment(h(1), fetcher, storage)).toBe("díky");
    expect(await loadLnComment(h(1), fetcher, storage)).toBe("díky");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("remembers that there is no comment, and that the payment is unknown", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ found: true, comment: null }).mockResolvedValueOnce({ found: false, comment: null });
    expect(await loadLnComment(h(1), fetcher, storage)).toBeNull();
    expect(await loadLnComment(h(2), fetcher, storage)).toBeNull();
    expect(await loadLnComment(h(1), fetcher, storage)).toBeNull();
    expect(await loadLnComment(h(2), fetcher, storage)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cachedLnComment(h(1), storage)).toBeNull();
    expect(cachedLnComment(h(3), storage)).toBeUndefined();
  });

  it("does not remember a failed ask", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce({ found: true, comment: "ok" });
    await expect(loadLnComment(h(1), fetcher, storage)).rejects.toThrow("net");
    expect(cachedLnComment(h(1), storage)).toBeUndefined();
    expect(await loadLnComment(h(1), fetcher, storage)).toBe("ok");
  });

  it("shares one request between simultaneous callers", async () => {
    let resolve!: (v: { found: boolean; comment: string | null }) => void;
    const fetcher = vi.fn(() => new Promise<{ found: boolean; comment: string | null }>((r) => (resolve = r)));
    const a = loadLnComment(h(1), fetcher, storage);
    const b = loadLnComment(h(1), fetcher, storage);
    resolve({ found: true, comment: "x" });
    expect(await a).toBe("x");
    expect(await b).toBe("x");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps at most the newest entries", async () => {
    const fetcher = vi.fn().mockResolvedValue({ found: true, comment: "c" });
    for (let i = 0; i < LN_COMMENTS_MAX + 5; i++) await loadLnComment(h(i), fetcher, storage);
    expect(Object.keys(JSON.parse(storage.getItem(LN_COMMENTS_KEY)!))).toHaveLength(LN_COMMENTS_MAX);
    expect(cachedLnComment(h(0), storage)).toBeUndefined();
    expect(cachedLnComment(h(LN_COMMENTS_MAX + 4), storage)).toBe("c");
  });

  it("survives a corrupt store", async () => {
    storage.setItem(LN_COMMENTS_KEY, "{not json");
    const fetcher = vi.fn().mockResolvedValue({ found: true, comment: "a" });
    expect(await loadLnComment(h(1), fetcher, storage)).toBe("a");
  });
});
