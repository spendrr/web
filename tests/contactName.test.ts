import { describe, expect, it } from "vitest";
import { displayName, originalName, shortNpub } from "../src/lib/chat/contactName";

const pk = "ab".repeat(32);

describe("contact names", () => {
  it("a bare key shows the short npub, not hex", () => {
    const s = shortNpub(pk);
    expect(s).toMatch(/^npub1[a-z0-9]{5}…[a-z0-9]{4}$/);
    expect(displayName(undefined, pk)).toBe(s);
    expect(displayName({ pubkey: pk, accepted: true }, pk)).toBe(s);
  });
  it("own name beats @name beats profile name", () => {
    const c = { pubkey: pk, accepted: true, name: "petr", profileName: "Petr N", nickname: "Táta" };
    expect(displayName(c, pk)).toBe("Táta");
    expect(displayName({ ...c, nickname: undefined }, pk)).toBe("@petr");
    expect(displayName({ ...c, nickname: undefined, name: undefined }, pk)).toBe("Petr N");
  });
  it("under an own name sits who they otherwise are", () => {
    const c = { pubkey: pk, accepted: true, nickname: "Táta" };
    expect(originalName({ ...c, name: "petr" }, pk)).toBe("@petr");
    expect(originalName({ ...c, profileName: "Petr N" }, pk)).toBe("Petr N");
    expect(originalName(c, pk)).toBe(shortNpub(pk));
    expect(originalName({ pubkey: pk, accepted: true }, pk)).toBeUndefined();
  });
});
