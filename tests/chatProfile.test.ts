import { describe, expect, it } from "vitest";
import { MAX_PROFILE_CHARS, cleanProfileName, profileNameFrom } from "../src/lib/chat/profile";

describe("cleanProfileName", () => {
  it("keeps an ordinary name, trimmed", () => {
    expect(cleanProfileName("  Alice  ")).toBe("Alice");
    expect(cleanProfileName("Jiří Novák")).toBe("Jiří Novák");
  });
  it("drops a leading @ or ~ so it cannot pass for a Spendrr name", () => {
    expect(cleanProfileName("@petr")).toBe("petr");
    expect(cleanProfileName("~@~ petr")).toBe("petr");
  });
  it("removes control, zero-width and bidi characters", () => {
    expect(cleanProfileName("pe‮tr​")).toBe("pe tr");
    expect(cleanProfileName("a\nb\tc")).toBe("a b c");
    expect(cleanProfileName("​‮ㅤ")).toBeUndefined();
  });
  it("cuts a long name by characters, not code units", () => {
    const out = cleanProfileName("😀".repeat(100));
    expect([...(out ?? "")].length).toBe(MAX_PROFILE_CHARS);
  });
  it("refuses what is not a string or is empty", () => {
    expect(cleanProfileName(42)).toBeUndefined();
    expect(cleanProfileName("   ")).toBeUndefined();
    expect(cleanProfileName("@")).toBeUndefined();
  });
});

describe("profileNameFrom", () => {
  it("prefers display_name, falls back to name", () => {
    expect(profileNameFrom(JSON.stringify({ name: "al", display_name: "Alice" }))).toBe("Alice");
    expect(profileNameFrom(JSON.stringify({ name: "al", display_name: "  " }))).toBe("al");
  });
  it("is undefined for anything unusable", () => {
    expect(profileNameFrom("not json")).toBeUndefined();
    expect(profileNameFrom("[]")).toBeUndefined();
    expect(profileNameFrom(JSON.stringify({ picture: "https://x" }))).toBeUndefined();
    expect(profileNameFrom(null)).toBeUndefined();
    expect(profileNameFrom(JSON.stringify({ name: "x".repeat(30_000) }))).toBeUndefined();
  });
});
