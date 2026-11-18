// A gift link read by the in-app scanner: decided by giftFromScannedUrl, so the app opens the claim sheet itself.
import { describe, expect, it } from "vitest";
import { buildGiftUrl, giftFromScannedUrl, type GiftLinkParams } from "../src/lib/gift/giftLink";

const ORIGIN = "https://spendrr.app";
const gift: GiftLinkParams = {
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  amountSats: 21000,
  id: "a1b2c3",
  message: "Ahoj",
};

describe("giftFromScannedUrl", () => {
  it("decodes a valid gift link of this origin", () => {
    const r = giftFromScannedUrl(buildGiftUrl(ORIGIN, gift), ORIGIN);
    expect(r).toEqual({ ok: true, gift: expect.objectContaining({ id: "a1b2c3", amountSats: 21000, mnemonic: gift.mnemonic }) });
  });

  it("a gift link with a trailing slash path still counts", () => {
    const url = buildGiftUrl(ORIGIN, gift).replace("/g#", "/g/#");
    expect(giftFromScannedUrl(url, ORIGIN)?.ok).toBe(true);
  });

  it("reports a wrong version and a damaged link instead of throwing", () => {
    const url = buildGiftUrl(ORIGIN, gift);
    expect(giftFromScannedUrl(url.replace("v=1", "v=99"), ORIGIN)).toEqual({ ok: false, reason: "bad-version" });
    expect(giftFromScannedUrl(ORIGIN + "/g#v=1&g=%%%", ORIGIN)?.ok).toBe(false);
    expect(giftFromScannedUrl(ORIGIN + "/g", ORIGIN)).toEqual({ ok: false, reason: "not-a-gift-link" });
    expect(giftFromScannedUrl(ORIGIN + "/g#v=1&g=AAAA", ORIGIN)).toEqual({ ok: false, reason: "malformed" });
  });

  it("is null for anything that is not a gift link of this origin", () => {
    const url = buildGiftUrl(ORIGIN, gift);
    expect(giftFromScannedUrl(url, "https://preprod.example")).toBeNull();
    expect(giftFromScannedUrl(url.replace("/g#", "/r#"), ORIGIN)).toBeNull();
    for (const raw of ["bitcoin:bc1qxyz?amount=0.001", "lnbc1...", "ark1xyz", "", "not a url", `${ORIGIN}/@pavel`]) {
      expect(giftFromScannedUrl(raw, ORIGIN), raw).toBeNull();
    }
  });
});
