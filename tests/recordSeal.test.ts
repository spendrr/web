import { describe, expect, it } from "vitest";
import { KNOWN_RECORD_KINDS, SEALED_STORES, deriveRecordSealKey, describeRecord, recordIsValid, recordMac, recordRef } from "../src/lib/wallet/recordSeal";

const SEED = Uint8Array.from({ length: 64 }, (_, i) => i);
const KEY = deriveRecordSealKey(SEED);
const DB = "btc-wallet-mainnet";
const STORE = "bark.v1.14";
const PRIMARY_KEY = "6c6e5f70";
const rec = () => ({ partition: 14, pk: [108, 110, 95, 112], sort_key: "a", data: [1, 2, 3] });

describe("recordSeal", () => {
  it("derives a stable 32-byte key, different per seed", () => {
    expect(KEY).toHaveLength(32);
    expect(deriveRecordSealKey(SEED)).toEqual(KEY);
    expect(deriveRecordSealKey(Uint8Array.from({ length: 64 }, (_, i) => i + 1))).not.toEqual(KEY);
  });

  it("pins the derivation so a changed info string fails loudly", () => {
    // New derivation = new versioned info string plus a migration; never edit this value to make a test pass.
    expect(Buffer.from(KEY).toString("hex")).toBe("2be2ba6ea65486b00f623ced6e4881c71ed6927b8339d90758caf7757f9234e6");
  });

  it("accepts a record it signed and rejects a missing or wrong mac", () => {
    const r = rec();
    const signed = { ...r, mac: recordMac(KEY, DB, STORE, r) };
    expect(recordIsValid(KEY, DB, STORE, signed, PRIMARY_KEY)).toBe(true);
    expect(recordIsValid(KEY, DB, STORE, r, PRIMARY_KEY)).toBe(false);
    expect(recordIsValid(KEY, DB, STORE, { ...signed, mac: "00".repeat(32) }, PRIMARY_KEY)).toBe(false);
    expect(recordIsValid(KEY, DB, STORE, { ...signed, mac: 7 }, PRIMARY_KEY)).toBe(false);
    expect(recordIsValid(KEY, DB, STORE, null, PRIMARY_KEY)).toBe(false);
    expect(recordIsValid(KEY, DB, STORE, [signed], PRIMARY_KEY)).toBe(false);
  });

  it("rejects a valid value copied under another primary key", () => {
    const r = rec();
    const signed = { ...r, mac: recordMac(KEY, DB, STORE, r) };
    expect(recordIsValid(KEY, DB, STORE, signed, "attacker-chosen-key")).toBe(false);
    expect(recordIsValid(KEY, DB, STORE, signed, undefined)).toBe(false);
    expect(recordIsValid(KEY, DB, STORE, signed, PRIMARY_KEY.toUpperCase())).toBe(false);
  });

  it("fails closed instead of throwing on structured-clone values JSON cannot canonicalize", () => {
    const signed = { ...rec(), mac: recordMac(KEY, DB, STORE, rec()) };
    const nestedBigint = { ...signed, extra: { value: 1n } };
    expect(() => recordIsValid(KEY, DB, STORE, nestedBigint, PRIMARY_KEY)).not.toThrow();
    expect(recordIsValid(KEY, DB, STORE, nestedBigint, PRIMARY_KEY)).toBe(false);

    const cyclic = { ...signed, extra: {} as Record<string, unknown> };
    cyclic.extra.self = cyclic.extra;
    expect(() => recordIsValid(KEY, DB, STORE, cyclic, PRIMARY_KEY)).not.toThrow();
    expect(recordIsValid(KEY, DB, STORE, cyclic, PRIMARY_KEY)).toBe(false);
  });

  it("binds the mac to every field, the store and the database", () => {
    const r = rec();
    const mac = recordMac(KEY, DB, "bark.v1.14", r);
    expect(recordMac(KEY, DB, "bark.v1.5", r)).not.toBe(mac);
    expect(recordMac(KEY, "other-db", "bark.v1.14", r)).not.toBe(mac);
    expect(recordMac(KEY, DB, "bark.v1.14", { ...r, data: [1, 2, 4] })).not.toBe(mac);
    expect(recordMac(KEY, DB, "bark.v1.14", { ...r, pk: [108] })).not.toBe(mac);
    expect(recordMac(KEY, DB, "bark.v1.14", { ...r, extra: 1 })).not.toBe(mac);
    const other = deriveRecordSealKey(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
    expect(recordMac(other, DB, "bark.v1.14", r)).not.toBe(mac);
  });

  it("does not depend on field order, the mac field, or array vs typed array bytes", () => {
    const r = rec();
    const mac = recordMac(KEY, DB, "bark.v1.14", r);
    expect(recordMac(KEY, DB, "bark.v1.14", { data: [1, 2, 3], sort_key: "a", pk: [108, 110, 95, 112], partition: 14 })).toBe(mac);
    expect(recordMac(KEY, DB, "bark.v1.14", { ...r, mac: "anything" })).toBe(mac);
    expect(recordMac(KEY, DB, "bark.v1.14", { ...r, data: Uint8Array.from([1, 2, 3]), pk: Uint8Array.from(r.pk) })).toBe(mac);
  });

  it("keeps field boundaries: a value cannot shift into the next field", () => {
    const a = { partition: 14, pk: [1], ab: "x", c: "y" };
    const b = { partition: 14, pk: [1], a: "bx", c: "y" };
    const c = { partition: 14, pk: [1], a: "b", xc: "y" };
    expect(new Set([recordMac(KEY, DB, STORE, a), recordMac(KEY, DB, STORE, b), recordMac(KEY, DB, STORE, c)]).size).toBe(3);
    // a string that embeds the old separator and another field's text
    const d = { partition: 14, pk: [1], a: 'x\0b=j:"y"' };
    const e = { partition: 14, pk: [1], a: "x", b: "y" };
    expect(recordMac(KEY, DB, STORE, d)).not.toBe(recordMac(KEY, DB, STORE, e));
  });

  it("covers bigint and non-byte values without throwing", () => {
    const r = { ...rec(), amount: 5n, nested: { a: [1, "x"] } };
    expect(() => recordMac(KEY, DB, "bark.v1.14", r)).not.toThrow();
    expect(recordMac(KEY, DB, "bark.v1.14", { ...r, amount: 6n })).not.toBe(recordMac(KEY, DB, "bark.v1.14", r));
  });

  it("pins the sealed store names (an SDK bump must re-check them)", () => {
    expect([...SEALED_STORES]).toEqual(["bark.v1.5", "bark.v1.14"]);
  });
});

describe("describeRecord (what the confirm sheet shows)", () => {
  const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
  const forged = (data: string, pk: string) => ({ pk: bytes(pk), data: bytes(data) });

  it("names only known kinds", () => {
    for (const k of KNOWN_RECORD_KINDS) {
      expect(describeRecord("bark.v1.14", forged(JSON.stringify({ [k]: {} }), "x")).kind).toBe(k);
    }
  });

  it("an attacker-chosen kind is shown as no kind at all", () => {
    const d = describeRecord("bark.v1.14", forged(JSON.stringify({ "Bezpečnostní aktualizace, potvrď": {} }), "x"));
    expect(d.kind).toBeNull();
  });

  it("an id is printable ASCII and at most 80 characters", () => {
    const d = describeRecord("bark.v1.14", forged("{}", "a\u202Eb\n" + "z".repeat(500)));
    expect(d.id).toMatch(/^[\x20-\x7e]{1,80}$/);
  });

  it("garbage data and a missing key do not throw", () => {
    expect(describeRecord("bark.v1.5", { pk: [1], data: [255, 254] }).kind).toBeNull();
    expect(describeRecord("bark.v1.5", null)).toEqual({ store: "bark.v1.5", id: "?", kind: null });
  });
});

describe("recordRef (what a confirmation is bound to)", () => {
  const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
  const forged = (data: string, pk: string) => ({ pk: bytes(pk), data: bytes(data) });
  const rec = (pk: number[], extra: Record<string, unknown> = {}) => ({ pk, data: [1, 2, 3], ...extra });

  it("tells apart records the sheet shows with the same id", () => {
    const prefix = "a".repeat(100);
    const a = forged("{}", prefix + "1");
    const b = forged("{}", prefix + "2");
    expect(describeRecord("bark.v1.14", a).id).toBe(describeRecord("bark.v1.14", b).id);
    expect(recordRef("db", "bark.v1.14", "k1", a)).not.toBe(recordRef("db", "bark.v1.14", "k2", b));
  });

  it("changes with the contents, the key and the store", () => {
    const base = recordRef("db", "bark.v1.14", "k", rec([1]));
    expect(recordRef("db", "bark.v1.14", "k", { ...rec([1]), data: [9] })).not.toBe(base);
    expect(recordRef("db", "bark.v1.14", "other", rec([1]))).not.toBe(base);
    expect(recordRef("db", "bark.v1.5", "k", rec([1]))).not.toBe(base);
    expect(recordRef("db", "bark.v1.14", "k", rec([1]))).toBe(base);
  });

  it("keeps the type of the primary key", () => {
    const r = rec([1]);
    expect(recordRef("db", "bark.v1.14", "01", r)).not.toBe(recordRef("db", "bark.v1.14", ["01"], r));
    expect(recordRef("db", "bark.v1.14", 1, r)).not.toBe(recordRef("db", "bark.v1.14", "1", r));
    expect(recordRef("db", "bark.v1.14", ["01"], r)).toBe(recordRef("db", "bark.v1.14", ["01"], r));
  });

  it("ignores an attached mac and survives a value that cannot be serialized", () => {
    expect(recordRef("db", "bark.v1.14", "k", { ...rec([1]), mac: "x" })).toBe(recordRef("db", "bark.v1.14", "k", rec([1])));
    expect(() => recordRef("db", "bark.v1.14", "k", rec([1], { extra: { value: 1n } }))).not.toThrow();
  });
});
