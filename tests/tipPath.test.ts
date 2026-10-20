import { describe, expect, it } from "vitest";
import { payName, tipNameFromPath } from "../src/tip/path";

describe("tipNameFromPath", () => {
  it("reads the name", () => {
    expect(tipNameFromPath("/tip/Pavel")).toBe("pavel");
    expect(tipNameFromPath("/tip/pavel/")).toBe("pavel");
    expect(tipNameFromPath("/tip/%40pavel")).toBe("pavel");
  });
  it("reads /donate as the donate name", () => {
    expect(tipNameFromPath("/donate")).toBe("donate");
    expect(tipNameFromPath("/donate/")).toBe("donate");
  });
  it("takes the invoice for donate from lubos, anything else from itself", () => {
    expect(payName("donate")).toBe("lubos");
    expect(payName("lubos")).toBe("lubos");
    expect(payName("pavel")).toBe("pavel");
    expect(payName("constructor")).toBe("constructor");
  });
  it("is empty for anything else or a bad escape", () => {
    for (const p of ["/tip", "/tip/", "/tip/a/b", "/tip/%E0%A4%A", "/"]) expect(tipNameFromPath(p)).toBe("");
  });
});
