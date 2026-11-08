import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LN_COMMENTS_KEY,
  LN_COMMENTS_MAX,
  LN_MATCH_WINDOW_MS,
  cachedLnComment,
  loadLnComment,
  matchLnComments,
  resetLnCommentList,
} from "../src/lib/names/lnComments";
import type { LnReceipt } from "../src/lib/names/names";

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

const T = 1_800_000_000_000;
const MIN = 60_000;
const mv = (id: number, sats: number, atMs: number) => ({ id, sats, atMs });
const rc = (sats: number, settledAt: number, comment: string | null): LnReceipt => ({ amountSats: sats, settledAt, comment });

describe("matchLnComments", () => {
  it("ties a receipt to the movement with the same amount shortly after it", () => {
    const m = matchLnComments([mv(1, 1000, T + 2 * MIN)], [rc(1000, T, "díky za oběd")]);
    expect(m.get(1)).toBe("díky za oběd");
  });

  it("does not tie different amounts, a movement before the payment, or one a day later", () => {
    expect(matchLnComments([mv(1, 999, T)], [rc(1000, T, "x")]).size).toBe(0);
    expect(matchLnComments([mv(1, 1000, T - 10 * MIN)], [rc(1000, T, "x")]).size).toBe(0);
    expect(matchLnComments([mv(1, 1000, T + LN_MATCH_WINDOW_MS + MIN)], [rc(1000, T, "x")]).size).toBe(0);
  });

  it("keeps two payments of one amount apart, closest first", () => {
    const m = matchLnComments([mv(1, 1000, T + MIN), mv(2, 1000, T + 60 * MIN)], [rc(1000, T, "první"), rc(1000, T + 59 * MIN, "druhá")]);
    expect(m.get(1)).toBe("první");
    expect(m.get(2)).toBe("druhá");
  });

  it("leaves a movement without a message when a closer payment fits another movement better", () => {
    // One receipt, two same-amount movements (a friend sent the second over Ark): only the closer one is the Lightning payment.
    const m = matchLnComments([mv(1, 500, T + MIN), mv(2, 500, T + 90 * MIN)], [rc(500, T, "ahoj")]);
    expect(m.get(1)).toBe("ahoj");
    expect(m.has(2)).toBe(false);
  });

  it("a receipt without a comment still takes its movement", () => {
    const m = matchLnComments([mv(1, 500, T + MIN), mv(2, 500, T + 11 * MIN)], [rc(500, T, null), rc(500, T + 10 * MIN, "zpráva")]);
    expect(m.get(1)).toBeNull();
    expect(m.get(2)).toBe("zpráva");
  });
});

describe("loadLnComment", () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
    resetLnCommentList();
  });

  it("asks once and never again for the same movement", async () => {
    const fetcher = vi.fn().mockResolvedValue([rc(1000, T, "díky")]);
    const target = mv(1, 1000, T + MIN);
    expect(await loadLnComment(target, [target], fetcher, storage)).toBe("díky");
    resetLnCommentList();
    expect(await loadLnComment(target, [target], fetcher, storage)).toBe("díky");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("remembers that there is no message for the opened movement", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const target = mv(1, 1000, T);
    expect(await loadLnComment(target, [target], fetcher, storage)).toBeNull();
    expect(cachedLnComment(1, storage)).toBeNull();
    resetLnCommentList();
    await loadLnComment(target, [target], fetcher, storage);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("remembers every movement the answer matched, so the others cost nothing", async () => {
    const fetcher = vi.fn().mockResolvedValue([rc(1000, T, "a"), rc(2000, T + 5 * MIN, "b")]);
    const a = mv(1, 1000, T + MIN);
    const b = mv(2, 2000, T + 6 * MIN);
    await loadLnComment(a, [a, b], fetcher, storage);
    expect(cachedLnComment(2, storage)).toBe("b");
    expect(await loadLnComment(b, [a, b], fetcher, storage)).toBe("b");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a movement without a receipt is not marked as none unless it is the one opened", async () => {
    const fetcher = vi.fn().mockResolvedValue([rc(1000, T, "a")]);
    const a = mv(1, 1000, T + MIN);
    const old = mv(2, 777, T - 30 * 24 * 60 * MIN);
    await loadLnComment(a, [a, old], fetcher, storage);
    expect(cachedLnComment(2, storage)).toBeUndefined();
  });

  it("does not remember a failed ask", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce([rc(1000, T, "ok")]);
    const target = mv(1, 1000, T + MIN);
    await expect(loadLnComment(target, [target], fetcher, storage)).rejects.toThrow("net");
    expect(cachedLnComment(1, storage)).toBeUndefined();
    expect(await loadLnComment(target, [target], fetcher, storage)).toBe("ok");
  });

  it("shares one request between movements asking together", async () => {
    let resolve!: (v: LnReceipt[]) => void;
    const fetcher = vi.fn(() => new Promise<LnReceipt[]>((r) => (resolve = r)));
    const a = mv(1, 1000, T + MIN);
    const b = mv(2, 2000, T + 6 * MIN);
    const pa = loadLnComment(a, [a, b], fetcher, storage);
    const pb = loadLnComment(b, [a, b], fetcher, storage);
    resolve([rc(1000, T, "a"), rc(2000, T + 5 * MIN, "b")]);
    expect(await pa).toBe("a");
    expect(await pb).toBe("b");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps at most the newest entries", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    for (let i = 0; i < LN_COMMENTS_MAX + 5; i++) {
      resetLnCommentList();
      const t = mv(i, 1, T);
      await loadLnComment(t, [t], fetcher, storage);
    }
    expect(Object.keys(JSON.parse(storage.getItem(LN_COMMENTS_KEY)!))).toHaveLength(LN_COMMENTS_MAX);
    expect(cachedLnComment(0, storage)).toBeUndefined();
    expect(cachedLnComment(LN_COMMENTS_MAX + 4, storage)).toBeNull();
  });

  it("survives a corrupt store", async () => {
    storage.setItem(LN_COMMENTS_KEY, "{not json");
    const fetcher = vi.fn().mockResolvedValue([rc(1000, T, "a")]);
    const target = mv(1, 1000, T + MIN);
    expect(await loadLnComment(target, [target], fetcher, storage)).toBe("a");
  });
});
