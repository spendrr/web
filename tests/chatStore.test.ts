import { describe, expect, it } from "vitest";
import { isSealed, open, seal } from "../src/lib/chat/chatStore";
import { safetyCode } from "../src/lib/chat/safety";

function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

describe("sealed chat storage", () => {
  it("opens what it sealed and keeps nothing readable", async () => {
    const k = await key();
    const value = { text: "tajná zpráva", sats: 5000 };
    const s = await seal(k, "msg:1", value);
    expect(isSealed(s)).toBe(true);
    expect(JSON.stringify(s)).not.toContain("tajn");
    expect(await open(k, "msg:1", s)).toEqual(value);
  });

  it("does not open in another slot, under another key, or damaged", async () => {
    const k = await key();
    const s = await seal(k, "msg:1", { a: 1 });
    expect(await open(k, "msg:2", s)).toBeNull();
    expect(await open(await key(), "msg:1", s)).toBeNull();
    expect(await open(k, "msg:1", { ...s, ct: s.ct.slice(0, -4) + "AAAA" })).toBeNull();
    expect(await open(k, "msg:1", { iv: "!", ct: "!" })).toBeNull();
  });

  it("uses a fresh nonce every time", async () => {
    const k = await key();
    const a = await seal(k, "contacts", { x: 1 });
    const b = await seal(k, "contacts", { x: 1 });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("seals a large record", async () => {
    const k = await key();
    const big = { text: "x".repeat(300_000) };
    expect(await open(k, "big", await seal(k, "big", big))).toEqual(big);
  });

  it("tells a sealed record from a plaintext one", () => {
    expect(isSealed({ iv: "a", ct: "b" })).toBe(true);
    expect(isSealed({ id: "x", text: "ahoj", peer: "p" })).toBe(false);
    expect(isSealed(null)).toBe(false);
  });
});

describe("safety code", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);

  it("is the same on both phones", async () => {
    expect(await safetyCode(a, b)).toEqual(await safetyCode(b, a));
  });

  it("is eight groups of five digits", async () => {
    const code = await safetyCode(a, b);
    expect(code).toHaveLength(8);
    for (const g of code) expect(g).toMatch(/^\d{5}$/);
  });

  it("changes with either key", async () => {
    const base = (await safetyCode(a, b)).join("");
    expect((await safetyCode(a, "c".repeat(64))).join("")).not.toBe(base);
    expect((await safetyCode("c".repeat(64), b)).join("")).not.toBe(base);
  });
});
