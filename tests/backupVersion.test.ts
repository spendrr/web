// Regression coverage for worker/backupVersion.ts's optimistic-concurrency
// arithmetic — the fix for a real design gap in the cloud backup feature: a
// second device/session with stale local wallet state could silently
// overwrite a newer backup, since the only prior integrity check (a sha256
// of the tmp object) verifies a blob is internally consistent, not that
// it's actually newer than what's already committed. See
// worker/index.ts's handleBackupCommit and ARCHITECTURE.md's backup section.
import { describe, expect, it } from "vitest";
import { parseVersion, resolveCommitVersion } from "../worker/backupVersion";

describe("parseVersion", () => {
  it("reads a valid non-negative integer string", () => {
    expect(parseVersion("5")).toBe(5);
    expect(parseVersion("0")).toBe(0);
    expect(parseVersion("42")).toBe(42);
  });

  it("treats missing, invalid, negative, or non-integer values as 0", () => {
    expect(parseVersion(undefined)).toBe(0);
    expect(parseVersion(null)).toBe(0);
    expect(parseVersion("")).toBe(0);
    expect(parseVersion("not-a-number")).toBe(0);
    expect(parseVersion("-3")).toBe(0);
    expect(parseVersion("3.5")).toBe(0);
    expect(parseVersion("NaN")).toBe(0);
    expect(parseVersion("Infinity")).toBe(0);
  });
});

describe("resolveCommitVersion", () => {
  it("always allows the first-ever commit (server at version 0)", () => {
    // Both the legitimate "no backup yet" case and the one-time migration
    // window for a backup committed before versioning existed — see the
    // function's own comment. A client with no known version (0) can
    // bootstrap either way.
    expect(resolveCommitVersion(0, 0)).toBe(1);
    // A corrupted/confused client claiming some other base still succeeds
    // here — the currentVersion===0 exception is unconditional by design,
    // since there is nothing yet to compare against.
    expect(resolveCommitVersion(0, 7)).toBe(1);
  });

  it("allows a commit whose baseVersion matches the real current version", () => {
    expect(resolveCommitVersion(5, 5)).toBe(6);
    expect(resolveCommitVersion(1, 1)).toBe(2);
    expect(resolveCommitVersion(999, 999)).toBe(1000);
  });

  it("rejects a stale commit — the exact overwrite bug this exists to close", () => {
    // A device whose local state is based on an older server version than
    // what is actually there now (another device/session committed since).
    expect(resolveCommitVersion(12, 5)).toBe("conflict");
    // A device that has never recorded a known version (0) but the server
    // already has real committed history — must not be treated as
    // "unknown, so allow it".
    expect(resolveCommitVersion(2, 0)).toBe("conflict");
  });

  it("rejects a commit claiming to be ahead of the real current version", () => {
    // Shouldn't happen from a correct client, but a bogus/tampered
    // baseVersion must not be allowed to skip the check either.
    expect(resolveCommitVersion(3, 99)).toBe("conflict");
  });

  it("never returns a version lower than currentVersion + 1 on success", () => {
    for (const [current, base] of [
      [0, 0],
      [1, 1],
      [50, 50],
    ] as const) {
      const result = resolveCommitVersion(current, base);
      expect(result).not.toBe("conflict");
      expect(result).toBe(current + 1);
    }
  });
});
