import { describe, expect, it } from "vitest";
import { formatCallLogHeader } from "../src/lib/wallet/callLogHeader";

const base = {
  version: "12.72",
  commit: "5431df56696dd8af87dbc9274951361c13818800",
  network: "bitcoin",
  design: "v1",
  userAgent: "Mozilla/5.0 (Linux; Android 10)",
  language: "cs-CZ",
  timeZone: "Europe/Prague",
  online: true,
  visibility: "visible",
  exportedAt: Date.UTC(2026, 9, 18, 17, 0, 0),
  firstAt: Date.UTC(2026, 9, 17, 8, 0, 0),
  lastAt: Date.UTC(2026, 9, 18, 16, 59, 0),
  count: 1200,
  errors: 3,
};

describe("formatCallLogHeader", () => {
  it("names the build, device and range", () => {
    const text = formatCallLogHeader(base);
    expect(text).toContain("app: 12.72 (5431df5)");
    expect(text).toContain("network: bitcoin, design: v1");
    expect(text).toContain("entries: 1200 (errors 3), 2026-10-17T08:00:00.000Z to 2026-10-18T16:59:00.000Z");
    expect(text).toContain("device: Mozilla/5.0 (Linux; Android 10)");
    expect(text.endsWith("---")).toBe(true);
  });

  it("copes with an empty log and an unknown online state", () => {
    const text = formatCallLogHeader({ ...base, count: 0, errors: 0, firstAt: null, lastAt: null, online: null });
    expect(text).toContain("entries: 0 (errors 0), - to -");
    expect(text).toContain("online: ?");
  });
});
