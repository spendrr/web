import { describe, expect, it } from "vitest";
import { ALL_CHAT_RELAYS, CHAT_INDEX_RELAYS, CHAT_RELAYS, dmRelaysFromTags, knownRelay } from "../src/lib/chat/relays";
import { readFileSync } from "node:fs";

describe("knownRelay", () => {
  it("maps a spelling variant of a known relay to ours", () => {
    expect(knownRelay("wss://NOS.lol")).toBe("wss://nos.lol");
    expect(knownRelay("wss://nos.lol/")).toBe("wss://nos.lol");
    expect(knownRelay(" wss://purplepag.es ")).toBe("wss://purplepag.es");
  });
  it("refuses everything else", () => {
    expect(knownRelay("wss://evil.example")).toBeNull();
    expect(knownRelay("ws://nos.lol")).toBeNull();
    expect(knownRelay("wss://nos.lol/x")).toBeNull();
    expect(knownRelay("wss://nos.lol?a=1")).toBeNull();
    expect(knownRelay("wss://user:pw@nos.lol")).toBeNull();
    expect(knownRelay("wss://nos.lol.evil.example")).toBeNull();
    expect(knownRelay("wss://" + "a".repeat(300))).toBeNull();
    expect(knownRelay(42)).toBeNull();
  });
});

describe("dmRelaysFromTags", () => {
  it("keeps known relays once, in order, and ignores other tags", () => {
    const tags = [
      ["relay", "wss://nostr.wine"],
      ["relay", "wss://unknown.example"],
      ["p", "x"],
      ["relay", "wss://nostr.wine/"],
      ["relay", "wss://relay.damus.io"],
      ["relay"],
    ];
    expect(dmRelaysFromTags(tags)).toEqual(["wss://nostr.wine", "wss://relay.damus.io"]);
    expect(dmRelaysFromTags("nope")).toEqual([]);
  });
});

describe("relay lists", () => {
  it("indexers are known relays", () => {
    for (const r of CHAT_INDEX_RELAYS) expect(ALL_CHAT_RELAYS).toContain(r);
  });
  it("CSP connect-src names every chat relay", () => {
    const csp = readFileSync("public/_headers", "utf8");
    for (const r of ALL_CHAT_RELAYS) expect(csp).toContain(r);
  });
  it("chat relays come first and are not repeated", () => {
    expect(ALL_CHAT_RELAYS.slice(0, CHAT_RELAYS.length)).toEqual([...CHAT_RELAYS]);
    expect(new Set(ALL_CHAT_RELAYS).size).toBe(ALL_CHAT_RELAYS.length);
  });
});
