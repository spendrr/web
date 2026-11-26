import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeKey, encodeNpubBytes, encodeNsecBytes } from "../src/lib/chat/nostrBech32";

// NIP-19's own examples.
const SECRET_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const PUBLIC_HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
const NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";

const bytes = (hex: string) => hex.match(/../g)!.map((h) => parseInt(h, 16));

describe("nostrBech32", () => {
  it("encodes the NIP-19 nsec vector", () => expect(encodeNsecBytes(bytes(SECRET_HEX))).toBe(NSEC));
  it("encodes the NIP-19 npub vector", () => expect(encodeNpubBytes(bytes(PUBLIC_HEX))).toBe(NPUB));
  it("refuses anything but 32 bytes", () => {
    expect(encodeKey("nsec", bytes(SECRET_HEX).slice(1))).toBeNull();
    expect(encodeKey("nsec", [...bytes(SECRET_HEX), 0])).toBeNull();
  });
  it("has no imports, so the wallet worker can use it", () => {
    expect(readFileSync("src/lib/chat/nostrBech32.ts", "utf8").match(/^\s*import\s/gm)).toBeNull();
  });
});
