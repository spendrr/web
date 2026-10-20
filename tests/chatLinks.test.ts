import { describe, expect, it } from "vitest";
import { parseLinks, shortDestination, splitHost } from "../src/lib/chat/links";
import { buildGiftUrl } from "../src/lib/gift/giftLink";
import { buildRequestUrl } from "../src/lib/send/paymentRequest";

const HOSTS = ["spendrr.app"];
const INVOICE =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp";
const ARK =
  "ark1pu6h30w3zqqpk0f9l08vzl6taah7ra05zyxxwfa2rruq8t9usel94389c7nvdv2npd4p76zufehl2vw07emn92rq0vur4mtx55wnug2mveqwhtht8egmqtfeahugfk";
const BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const kinds = (text: string) => parseLinks(text, HOSTS).map((s) => s.t);

describe("chat links", () => {
  it("keeps plain text as one segment", () => {
    expect(parseLinks("ahoj jak se mas", HOSTS)).toEqual([{ t: "text", text: "ahoj jak se mas" }]);
  });

  it("finds a web link and leaves the sentence punctuation outside it", () => {
    const segs = parseLinks("koukni (https://example.com/a?b=1).", HOSTS);
    expect(segs.map((s) => s.t)).toEqual(["text", "url", "text"]);
    expect(segs[1]).toMatchObject({ t: "url", url: "https://example.com/a?b=1", host: "example.com" });
    expect(segs[2]).toEqual({ t: "text", text: ")." });
  });

  it("makes only http(s) clickable, and not a bare domain", () => {
    expect(kinds("javascript:alert(1)")).toEqual(["text"]);
    expect(kinds("ftp://example.com")).toEqual(["text"]);
    expect(kinds("google.com")).toEqual(["text"]);
    expect(kinds("https://")).toEqual(["text"]);
  });

  it("refuses links that read as one place and go to another", () => {
    expect(kinds("https://bank.cz@evil.example/login")).toEqual(["text"]);
    expect(kinds("https://example.com/‮gnp.exe")).toEqual(["text"]);
    expect(kinds("https://exa​mple.com")).toEqual(["text"]);
  });

  it("shows an IDN host in punycode", () => {
    const seg = parseLinks("https://рaypal.com", HOSTS)[0];
    expect(seg).toMatchObject({ t: "url" });
    expect(seg.t === "url" && seg.host.startsWith("xn--")).toBe(true);
  });

  it("recognises @names that pass the handle rules", () => {
    expect(parseLinks("pošli @Petr-1!", HOSTS)[1]).toEqual({ t: "name", name: "petr-1", raw: "@Petr-1" });
    expect(kinds("email@example.com")).toEqual(["text"]);
  });

  it("recognises destinations, with the invoice amount", () => {
    const inv = parseLinks(`zaplat ${INVOICE}`, HOSTS)[1];
    expect(inv).toMatchObject({ t: "pay", kind: "lightning", destination: INVOICE, amountSats: 250000 });
    expect(parseLinks(`lightning:${INVOICE}`, HOSTS)[0]).toMatchObject({ t: "pay", kind: "lightning", destination: INVOICE });
    expect(parseLinks(ARK, HOSTS)[0]).toMatchObject({ t: "pay", kind: "ark", destination: ARK });
    expect(parseLinks(BTC, HOSTS)[0]).toMatchObject({ t: "pay", kind: "bitcoin", destination: BTC });
    expect(parseLinks(`bitcoin:${BTC}?amount=0.0001`, HOSTS)[0]).toMatchObject({
      t: "pay",
      kind: "bitcoin",
      destination: BTC,
      amountSats: 10000,
    });
  });

  it("ignores broken destinations", () => {
    expect(kinds(BTC.slice(0, -1) + "x")).toEqual(["text"]);
    expect(kinds("lnbc1nonsense")).toEqual(["text"]);
  });

  it("knows our gift and request links only on our own host", () => {
    const gift = buildGiftUrl("https://spendrr.app", { mnemonic: "abandon ".repeat(11) + "about", amountSats: 5000, id: "ab12" });
    expect(parseLinks(gift, HOSTS)[0]).toMatchObject({ t: "gift", gift: { amountSats: 5000 } });
    const fake = gift.replace("https://spendrr.app", "https://spendrr.app.evil.example");
    expect(parseLinks(fake, HOSTS)[0]).toMatchObject({ t: "url", host: "spendrr.app.evil.example" });
    const req = buildRequestUrl("https://spendrr.app", { address: ARK, amountSats: 1200, id: "cd34" });
    expect(parseLinks(req, HOSTS)[0]).toMatchObject({ t: "request", request: { amountSats: 1200, address: ARK } });
  });

  it("bolds the owner of a host", () => {
    expect(splitHost("login.bank.cz.evil.example")).toEqual({ sub: "login.bank.cz.", main: "evil.example" });
    expect(splitHost("www.bbc.co.uk")).toEqual({ sub: "www.", main: "bbc.co.uk" });
    expect(splitHost("example.com")).toEqual({ sub: "", main: "example.com" });
  });

  it("shortens long destinations", () => {
    expect(shortDestination(ARK)).toBe(`${ARK.slice(0, 12)}…${ARK.slice(-6)}`);
    expect(shortDestination("ark1short")).toBe("ark1short");
  });
});
