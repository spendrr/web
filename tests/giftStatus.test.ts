import { describe, expect, it } from "vitest";
import {
  AUTO_LOOKS_PER_OPEN,
  PEEK_TTL_LIKELY_CLAIMED_MS,
  PEEK_TTL_UNCLAIMED_MS,
  autoLookIds,
  canTakeBack,
  expiryInfo,
  giftStatus,
  needsLook,
} from "../src/lib/gift/giftStatus";
import type { GiftPeekEntry, OutgoingGift } from "../src/lib/gift/giftStore";

const NOW = 1_800_000_000_000;
const gift = (over: Partial<OutgoingGift> = {}): OutgoingGift => ({
  id: "g",
  createdAt: NOW - 1000,
  expiresAt: NOW + 86_400_000,
  amountSats: 1000,
  state: "unclaimed",
  mnemonicCipher: { ivB64: "", cipherB64: "" },
  ...over,
});
const entry = (hint: GiftPeekEntry["hint"], ageMs = 0): GiftPeekEntry => ({ hint, at: NOW - ageMs });

describe("giftStatus", () => {
  it("reads stored terminal states first", () => {
    expect(giftStatus(gift({ state: "reclaimed" }), entry("unclaimed"))).toBe("reclaimed");
    expect(giftStatus(gift({ state: "creating" }), undefined)).toBe("creating");
    expect(giftStatus(gift({ state: "claimed" }), undefined)).toBe("claimed");
  });
  it("a claim inferred from timeouts stays a guess", () => {
    expect(giftStatus(gift({ state: "claimed", failedChecks: 3 }), undefined)).toBe("likely-claimed");
  });
  it("uses the last look for a gift stored as unclaimed", () => {
    expect(giftStatus(gift(), undefined)).toBe("unverified");
    expect(giftStatus(gift(), entry("unclaimed"))).toBe("waiting");
    expect(giftStatus(gift(), entry("likely-claimed"))).toBe("likely-claimed");
    expect(giftStatus(gift(), entry("claimed"))).toBe("claimed");
  });
});

describe("needsLook", () => {
  it("never looks into anything but a gift stored as unclaimed", () => {
    for (const state of ["creating", "claimed", "reclaimed"] as const) expect(needsLook(gift({ state }), undefined, NOW)).toBe(false);
  });
  it("looks at a gift never looked at", () => {
    expect(needsLook(gift(), undefined, NOW)).toBe(true);
  });
  it("a definite claim is final", () => {
    expect(needsLook(gift(), entry("claimed", 365 * 86_400_000), NOW)).toBe(false);
  });
  it("waiting gifts again after 10 minutes, slow ones after a day", () => {
    expect(needsLook(gift(), entry("unclaimed", PEEK_TTL_UNCLAIMED_MS - 1), NOW)).toBe(false);
    expect(needsLook(gift(), entry("unclaimed", PEEK_TTL_UNCLAIMED_MS), NOW)).toBe(true);
    expect(needsLook(gift(), entry("likely-claimed", PEEK_TTL_LIKELY_CLAIMED_MS - 1), NOW)).toBe(false);
    expect(needsLook(gift(), entry("likely-claimed", PEEK_TTL_LIKELY_CLAIMED_MS), NOW)).toBe(true);
  });
});

describe("autoLookIds", () => {
  it("takes the newest that need it, capped", () => {
    const gifts = Array.from({ length: 10 }, (_, i) => gift({ id: `g${i}`, createdAt: NOW - i * 1000 }));
    const ids = autoLookIds(gifts, {}, NOW);
    expect(ids).toHaveLength(AUTO_LOOKS_PER_OPEN);
    expect(ids[0]).toBe("g0");
  });
  it("skips the ones with a fresh answer", () => {
    const gifts = [gift({ id: "a", createdAt: NOW }), gift({ id: "b", createdAt: NOW - 1 })];
    expect(autoLookIds(gifts, { a: entry("claimed") }, NOW)).toEqual(["b"]);
  });
});

describe("canTakeBack", () => {
  it("is kept for anything that might still hold the gift", () => {
    expect(canTakeBack(gift(), "unverified")).toBe(true);
    expect(canTakeBack(gift(), "waiting")).toBe(true);
    expect(canTakeBack(gift(), "likely-claimed")).toBe(true);
    expect(canTakeBack(gift({ state: "creating" }), "creating")).toBe(true);
    expect(canTakeBack(gift({ state: "claimed", failedChecks: 3 }), "likely-claimed")).toBe(true);
  });
  it("is gone for a definite claim and for a reclaimed gift", () => {
    expect(canTakeBack(gift(), "claimed")).toBe(false);
    expect(canTakeBack(gift({ state: "reclaimed" }), "reclaimed")).toBe(false);
  });
});

describe("expiryInfo", () => {
  it("counts down, then says it is due", () => {
    expect(expiryInfo(gift(), "waiting", NOW)).toEqual({ kind: "in", ms: 86_400_000 });
    expect(expiryInfo(gift({ expiresAt: NOW - 1 }), "waiting", NOW)).toEqual({ kind: "due" });
  });
  it("says nothing about finished gifts or unfinished ones", () => {
    expect(expiryInfo(gift(), "claimed", NOW)).toBeNull();
    expect(expiryInfo(gift({ state: "creating" }), "creating", NOW)).toBeNull();
  });
});
