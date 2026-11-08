// The first read after the dashboard mounts is not a change, so it must not arm
// the cloud-backup upload (the one-shot upload after unlock already covers it).
import { describe, expect, it } from "vitest";
import { shouldTriggerBackup } from "../src/lib/backup/backupTrigger";

describe("shouldTriggerBackup", () => {
  it("does not fire on the first load, whatever it reads as", () => {
    expect(shouldTriggerBackup({ firstLoad: true, balanceChanged: true, historyChanged: true })).toBe(false);
    expect(shouldTriggerBackup({ firstLoad: true, balanceChanged: true, historyChanged: false })).toBe(false);
  });

  it("fires on a real change afterwards, balance or history", () => {
    expect(shouldTriggerBackup({ firstLoad: false, balanceChanged: true, historyChanged: false })).toBe(true);
    expect(shouldTriggerBackup({ firstLoad: false, balanceChanged: false, historyChanged: true })).toBe(true);
    expect(shouldTriggerBackup({ firstLoad: false, balanceChanged: true, historyChanged: true })).toBe(true);
  });

  it("stays quiet when nothing changed", () => {
    expect(shouldTriggerBackup({ firstLoad: false, balanceChanged: false, historyChanged: false })).toBe(false);
  });
});
