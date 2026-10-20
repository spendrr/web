// Regression coverage for src/lib/backup/backupStore.ts's value tagging — the
// bridge between raw IndexedDB record values and the JSON the backup
// actually gets serialized to before encryption. A production wallet's
// first real backup attempt failed silently (attempt recorded, never a
// success) because a bigint value coming out of IndexedDB (a u64
// amount/height crossing the wasm-bindgen boundary) passed through tagValue
// untouched, then JSON.stringify threw "Do not know how to serialize a
// BigInt" one level up in backup.ts — a failure a purely in-memory
// tag/untag round trip would never have caught, since it only breaks at the
// JSON.stringify/parse boundary in between. Every case here round-trips
// through actual JSON, not just tagValue -> untagValue directly, so it
// exercises the exact path that broke.
import { describe, expect, it } from "vitest";
import { chooseRestoreVersion, tagValue, untagValue } from "../src/lib/backup/backupStore";

function roundTrip(value: unknown): unknown {
  return untagValue(JSON.parse(JSON.stringify(tagValue(value))));
}

describe("tagValue / untagValue JSON round trip", () => {
  it("round-trips bigint (the value type that broke production)", () => {
    const values = [0n, 1n, 123456789012345678901234567890n, -42n];
    for (const v of values) {
      expect(roundTrip(v)).toBe(v);
    }
  });

  it("round-trips bigint nested inside objects and arrays", () => {
    const input = { amountSat: 21000000n, nested: { heights: [800000n, 850123n] } };
    const result = roundTrip(input) as typeof input;
    expect(result.amountSat).toBe(21000000n);
    expect(result.nested.heights).toEqual([800000n, 850123n]);
  });

  it("round-trips plain JSON-safe values unchanged", () => {
    for (const v of ["hello", 42, true, false, null, [1, 2, 3], { a: 1, b: "x" }]) {
      expect(roundTrip(v)).toEqual(v);
    }
  });

  it("round-trips ArrayBuffer contents exactly", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]).buffer;
    const result = roundTrip(bytes) as ArrayBuffer;
    expect(new Uint8Array(result)).toEqual(new Uint8Array(bytes));
  });

  it("round-trips typed arrays with the correct constructor", () => {
    const arr = new Uint32Array([1, 2, 3, 4294967295]);
    const result = roundTrip(arr) as Uint32Array;
    expect(result).toBeInstanceOf(Uint32Array);
    expect(Array.from(result)).toEqual(Array.from(arr));
  });

  it("round-trips DataView", () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 123456789);
    const result = roundTrip(new DataView(buf)) as DataView;
    expect(result).toBeInstanceOf(DataView);
    expect(result.getUint32(0)).toBe(123456789);
  });

  it("round-trips Date", () => {
    const d = new Date("2026-01-15T10:30:00.000Z");
    const result = roundTrip(d) as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(d.getTime());
  });

  it("round-trips Map and Set, including ones keyed/valued by bigint", () => {
    const m = new Map<unknown, unknown>([
      ["a", 1n],
      [2n, "b"],
    ]);
    const s = new Set([1n, 2n, 3n]);
    const resultMap = roundTrip(m) as Map<unknown, unknown>;
    const resultSet = roundTrip(s) as Set<unknown>;
    expect(resultMap).toBeInstanceOf(Map);
    expect(resultMap.get("a")).toBe(1n);
    expect(resultMap.get(2n)).toBe("b");
    expect(resultSet).toBeInstanceOf(Set);
    expect(Array.from(resultSet)).toEqual([1n, 2n, 3n]);
  });
});

// Regression coverage for the restore-target version rule
// (chooseRestoreVersion). The bug: when the local database already sat at a
// version >= the backup's, restoreDatabase opened it at exactly that version,
// no onupgradeneeded fired, and any object store the dump had but the
// database lacked was then quietly filtered out of the write — a restore that
// reported success while dropping records. Reachable because the SDK creates
// some stores lazily on first real use, so a never-used database can legit-
// imately sit at a newer schema version with *fewer* stores than the backup,
// and "no records anywhere" is exactly what triggers an unlock-time restore.
describe("chooseRestoreVersion", () => {
  const stores = (...names: string[]) => async () => new Set(names);

  it("uses the dump's version when it is newer — the upgrade fires on its own", async () => {
    // Store list must not even be consulted here (it costs a DB open).
    const probe = async () => {
      throw new Error("should not read the store list");
    };
    expect(await chooseRestoreVersion(3, 5, probe, ["a", "b"])).toBe(5);
  });

  it("keeps the existing version when it already has every store the dump has", async () => {
    expect(await chooseRestoreVersion(5, 3, stores("a", "b", "c"), ["a", "b"])).toBe(5);
    expect(await chooseRestoreVersion(5, 5, stores("a", "b"), ["a", "b"])).toBe(5);
  });

  it("bumps past the existing version when a dump store is missing (the silent-loss case)", async () => {
    // v5 database, v3 backup, and the backup carries a store the database
    // doesn't have — the exact shape that used to drop records silently.
    expect(await chooseRestoreVersion(5, 3, stores("a"), ["a", "movements"])).toBe(6);
    // Equal versions, same gap.
    expect(await chooseRestoreVersion(5, 5, stores("a"), ["a", "movements"])).toBe(6);
    // Nothing present at all.
    expect(await chooseRestoreVersion(2, 1, stores(), ["a"])).toBe(3);
  });

  it("never returns a version below the existing one (plain open would throw VersionError)", async () => {
    for (const [existing, dumpVersion] of [
      [5, 1],
      [5, 3],
      [5, 5],
      [1, 1],
    ] as const) {
      const chosen = await chooseRestoreVersion(existing, dumpVersion, stores("a"), ["a", "b"]);
      expect(chosen).toBeGreaterThanOrEqual(existing);
    }
  });
});
