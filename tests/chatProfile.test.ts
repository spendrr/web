import { describe, expect, it } from "vitest";
import { MAX_PROFILE_CHARS, cleanProfileName, ownProfileContent, profileNameFrom } from "../src/lib/chat/profile";

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

describe("ownProfileContent", () => {
  it("names the @name, its NIP-05 address and, when on, the Lightning address", () => {
    expect(JSON.parse(ownProfileContent("petr", true))).toEqual({ name: "petr", nip05: "petr@spendrr.app", lud16: "petr@spendrr.app" });
    expect(JSON.parse(ownProfileContent("petr", false))).toEqual({ name: "petr", nip05: "petr@spendrr.app" });
  });
  it("carries no picture", () => {
    expect(ownProfileContent("petr", true)).not.toContain("picture");
  });
  it("is the same string for the same input, so the app can compare it", () => {
    expect(ownProfileContent("petr", true)).toBe(ownProfileContent("petr", true));
  });
  it("is empty for a released name", () => {
    expect(ownProfileContent(null, true)).toBe("{}");
    expect(profileNameFrom(ownProfileContent(null, false))).toBeUndefined();
  });
  it("reads back as the name in our own profile parser", () => {
    expect(profileNameFrom(ownProfileContent("petr", false))).toBe("petr");
  });
});

describe("ownProfileContent picture", () => {
  const url = "https://data.spendrr.app/avatar/v4/0123456789abcdef0123456789abcdef.png";
  it("adds the picture last when given", () => {
    expect(Object.keys(JSON.parse(ownProfileContent("petr", true, url)))).toEqual(["name", "nip05", "lud16", "picture"]);
    expect(JSON.parse(ownProfileContent("petr", false, url)).picture).toBe(url);
  });
  it("a released name stays an empty profile whatever the picture", () => {
    expect(ownProfileContent(null, true, url)).toBe("{}");
  });
});
