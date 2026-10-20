import { describe, expect, it } from "vitest";
import { decodeLnurlHost, encodeLnurl } from "../src/lib/send/lnurl";

describe("encodeLnurl", () => {
  it("round-trips through decodeLnurlHost", () => {
    const url = "https://spendrr.app/.well-known/lnurlp/pavel";
    const encoded = encodeLnurl(url);
    expect(encoded.toLowerCase().startsWith("lnurl1")).toBe(true);
    expect(decodeLnurlHost(encoded)).toBe("spendrr.app");
  });

  it("produces a consistently-cased string (BIP173)", () => {
    const encoded = encodeLnurl("https://spendrr.app/.well-known/lnurlp/pavel");
    expect(encoded === encoded.toUpperCase() || encoded === encoded.toLowerCase()).toBe(true);
  });

  it("is deterministic", () => {
    const url = "https://spendrr.app/.well-known/lnurlp/pavel";
    expect(encodeLnurl(url)).toBe(encodeLnurl(url));
  });

  it("different names produce different encodings that still decode to the same host", () => {
    const a = encodeLnurl("https://spendrr.app/.well-known/lnurlp/pavel");
    const b = encodeLnurl("https://spendrr.app/.well-known/lnurlp/jana");
    expect(a).not.toBe(b);
    expect(decodeLnurlHost(a)).toBe("spendrr.app");
    expect(decodeLnurlHost(b)).toBe("spendrr.app");
  });
});
