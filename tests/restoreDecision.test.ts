import { describe, expect, it, vi } from "vitest";
import { restoreIntentForOnboarding, shouldAttemptRestore } from "../src/lib/backup/restoreDecision";

const data = (present: boolean) => vi.fn(async () => present);

describe("shouldAttemptRestore", () => {
  it("import always looks, without asking the local check", async () => {
    const check = data(true);
    expect(await shouldAttemptRestore({ tryRestoreBackup: true, freshSeed: false }, check)).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("a freshly generated seed never looks", async () => {
    const check = data(false);
    expect(await shouldAttemptRestore({ tryRestoreBackup: false, freshSeed: true }, check)).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("a plain unlock looks only when local data is gone", async () => {
    expect(await shouldAttemptRestore({ tryRestoreBackup: false, freshSeed: false }, data(false))).toBe(true);
    expect(await shouldAttemptRestore({ tryRestoreBackup: false, freshSeed: false }, data(true))).toBe(false);
  });

  it("a failing local check counts as data present", async () => {
    const failing = async () => {
      throw new Error("idb");
    };
    expect(await shouldAttemptRestore({ tryRestoreBackup: false, freshSeed: false }, failing)).toBe(false);
  });
});

describe("restoreIntentForOnboarding", () => {
  it("an import looks for its backup and is not a fresh seed", () => {
    expect(restoreIntentForOnboarding(true)).toEqual({ tryRestoreBackup: true, freshSeed: false });
  });

  it("a generated seed never looks and is a fresh seed", () => {
    expect(restoreIntentForOnboarding(false)).toEqual({ tryRestoreBackup: false, freshSeed: true });
  });
});
