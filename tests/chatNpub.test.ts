import { describe, expect, it } from "vitest";
import { looksLikeNostrKey, parseNostrPubkey } from "../src/lib/chat/npub";

// NIP-19 test vector (npub of the key in the spec's example).
const HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
const NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";

describe("parseNostrPubkey", () => {
  it("decodes an npub, with or without nostr:", () => {
    expect(parseNostrPubkey(NPUB)).toBe(HEX);
    expect(parseNostrPubkey(`  nostr:${NPUB} `)).toBe(HEX);
  });
  it("takes the hex key", () => {
    expect(parseNostrPubkey(HEX)).toBe(HEX);
  });
  it("rejects a bad checksum, another hrp and junk", () => {
    expect(parseNostrPubkey(NPUB.slice(0, -1) + "q")).toBeNull();
    expect(parseNostrPubkey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")).toBeNull();
    expect(parseNostrPubkey("petr")).toBeNull();
    expect(parseNostrPubkey("")).toBeNull();
  });
});

describe("looksLikeNostrKey", () => {
  it("tells keys from names", () => {
    expect(looksLikeNostrKey(NPUB)).toBe(true);
    expect(looksLikeNostrKey(HEX)).toBe(true);
    expect(looksLikeNostrKey("petr")).toBe(false);
    expect(looksLikeNostrKey("npubfan")).toBe(false);
  });
});
