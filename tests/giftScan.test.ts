import { describe, expect, it } from "vitest";
import {
  AUTO_SCANS_PER_OPEN,
  SCAN_TTL_MS,
  canTakeBackScan,
  classifyGiftScan,
  needsScan,
  scanExpiry,
  scanIds,
  scanStatus,
  type GiftScanEntry,
} from "../src/lib/gift/giftScan";
import type { OutgoingGift } from "../src/lib/gift/giftStore";

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
const entry = (hint: GiftScanEntry["hint"], ageMs = 0): GiftScanEntry => ({ hint, at: NOW - ageMs });

const bucket = (n: number) => ({ vtxoIds: Array.from({ length: n }, (_, i) => `id${i}:0`), totalSats: n * 500 });
const report = (o: Partial<Record<string, number>> = {}, isComplete = true) => ({
  type: "completed",
  report: {
    recovered: bucket(o.recovered ?? 0),
    skipped: bucket(o.skipped ?? 0),
    foreign: bucket(o.foreign ?? 0),
    failed: bucket(o.failed ?? 0),
    exited: bucket(o.exited ?? 0),
    isComplete,
  },
});

describe("classifyGiftScan", () => {
  it("nothing registered: waiting", () => expect(classifyGiftScan(report())).toBe("waiting"));
  it("spent: claimed", () => expect(classifyGiftScan(report({ skipped: 1 }))).toBe("claimed"));
  it("exited: claimed", () => expect(classifyGiftScan(report({ exited: 1 }))).toBe("claimed"));
  it("still spendable: opened", () => expect(classifyGiftScan(report({ recovered: 1 }))).toBe("opened"));
  it("spendable wins over spent (a half done claim)", () => {
    expect(classifyGiftScan(report({ recovered: 1, skipped: 1 }))).toBe("opened");
  });
  it("anything undecided is unknown, never a claim", () => {
    expect(classifyGiftScan(report({ skipped: 1, failed: 1 }))).toBe("unknown");
    expect(classifyGiftScan(report({ skipped: 1, foreign: 1 }))).toBe("unknown");
    expect(classifyGiftScan(report({ skipped: 1 }, false))).toBe("unknown");
    expect(classifyGiftScan({ type: "failed", message: "x" })).toBe("unknown");
    expect(classifyGiftScan({ type: "not-run" })).toBe("unknown");
  });
  it("garbage is unknown", () => {
    for (const v of [null, undefined, 3, "x", [], {}, { type: "completed" }, { type: "completed", report: {} }]) {
      expect(classifyGiftScan(v)).toBe("unknown");
    }
    expect(classifyGiftScan({ type: "completed", report: { ...report().report, skipped: { vtxoIds: "nope" } } })).toBe("unknown");
  });
});

describe("scanStatus", () => {
  it("stored terminal states win", () => {
    expect(scanStatus(gift({ state: "reclaimed" }), entry("waiting"))).toBe("reclaimed");
    expect(scanStatus(gift({ state: "creating" }), entry("claimed"))).toBe("creating");
    expect(scanStatus(gift({ state: "claimed" }), undefined)).toBe("claimed");
  });
  it("a claim guessed from timeouts is re-read from the last scan, and shown as waiting until one says otherwise", () => {
    const assumed = gift({ state: "claimed", failedChecks: 3 });
    expect(scanStatus(assumed, undefined)).toBe("waiting");
    expect(scanStatus(assumed, entry("claimed"))).toBe("claimed");
  });
  it("an unclaimed gift follows its last scan", () => {
    expect(scanStatus(gift(), undefined)).toBe("waiting");
    expect(scanStatus(gift(), entry("waiting"))).toBe("waiting");
    expect(scanStatus(gift(), entry("opened"))).toBe("opened");
    expect(scanStatus(gift(), entry("claimed"))).toBe("claimed");
  });
});

describe("needsScan / scanIds", () => {
  it("looks only at gifts a look means something for", () => {
    for (const state of ["creating", "reclaimed", "claimed"] as const) expect(needsScan(gift({ state }), undefined, NOW)).toBe(false);
    expect(needsScan(gift({ state: "claimed", failedChecks: 3 }), undefined, NOW)).toBe(true);
    expect(needsScan(gift(), undefined, NOW)).toBe(true);
  });
  it("a definite claim is final, the rest ages out", () => {
    expect(needsScan(gift(), entry("claimed", 400 * 86_400_000), NOW)).toBe(false);
    expect(needsScan(gift(), entry("waiting", SCAN_TTL_MS - 1), NOW)).toBe(false);
    expect(needsScan(gift(), entry("waiting", SCAN_TTL_MS), NOW)).toBe(true);
    expect(needsScan(gift(), entry("opened", SCAN_TTL_MS), NOW)).toBe(true);
  });
  it("newest first, capped", () => {
    const many = Array.from({ length: AUTO_SCANS_PER_OPEN + 5 }, (_, i) => gift({ id: `g${i}`, createdAt: NOW - i * 1000 }));
    const ids = scanIds(many, {}, NOW);
    expect(ids).toHaveLength(AUTO_SCANS_PER_OPEN);
    expect(ids[0]).toBe("g0");
  });
});

describe("canTakeBackScan / scanExpiry", () => {
  it("take back wherever the gift may still be here", () => {
    expect(canTakeBackScan(gift(), "waiting")).toBe(true);
    expect(canTakeBackScan(gift(), "opened")).toBe(true);
    expect(canTakeBackScan(gift({ state: "creating" }), "creating")).toBe(true);
    expect(canTakeBackScan(gift({ state: "claimed", failedChecks: 3 }), "waiting")).toBe(true);
  });
  it("not for a finished gift", () => {
    expect(canTakeBackScan(gift({ state: "claimed" }), "claimed")).toBe(false);
    expect(canTakeBackScan(gift({ state: "claimed", failedChecks: 3 }), "claimed")).toBe(false);
    expect(canTakeBackScan(gift({ state: "reclaimed" }), "reclaimed")).toBe(false);
  });
  it("expiry only for gifts the auto-return acts on", () => {
    expect(scanExpiry(gift(), "waiting", NOW)).toEqual({ kind: "in", ms: 86_400_000 });
    expect(scanExpiry(gift({ expiresAt: NOW - 1 }), "waiting", NOW)).toEqual({ kind: "due" });
    expect(scanExpiry(gift(), "claimed", NOW)).toBeNull();
    expect(scanExpiry(gift({ state: "creating" }), "creating", NOW)).toBeNull();
  });
});
