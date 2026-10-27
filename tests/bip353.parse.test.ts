import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildQuery, decodeProof, encodeProof, normalizeName, parseResponse, readName, TYPE_TXT } from "../src/lib/bip353/dnsWire";
import { verifyTxtProof } from "../src/lib/bip353/dnssec";
import { Bip353Error } from "../src/lib/bip353/errors";
import { parseBtcAmount, parsePaymentInstruction } from "../src/lib/bip353/instruction";
import { parseHumanName } from "../src/lib/bip353/name";

function throwsCode(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof Bip353Error ? e.code : `other:${String(e)}`;
  }
}

describe("parseHumanName", () => {
  it("builds the BIP 353 DNS name", () => {
    expect(parseHumanName("Alice@Example.com").dnsName).toBe("alice.user._bitcoin-payment.example.com.");
    expect(parseHumanName("₿alice@example.com").user).toBe("alice");
  });
  it("punycodes an IDN domain", () => {
    expect(parseHumanName("a@bücher.example").dnsName).toBe("a.user._bitcoin-payment.xn--bcher-kva.example.");
  });
  it("refuses anything that is not a plain user@host", () => {
    for (const bad of ["", "alice", "@example.com", "a@b@example.com", "a@localhost", "a@example.com/x", "a@example.com:80", "a@example.com?x", "a b@example.com", "a..b@example.com", ".a@example.com", "a@exa mple.com", "a@-.com", `${"a".repeat(65)}@example.com`]) {
      expect(throwsCode(() => parseHumanName(bad)), bad).toBe("malformed");
    }
  });
});

describe("dnsWire", () => {
  it("round-trips a query's name", () => {
    const q = buildQuery("a.example.com.", TYPE_TXT);
    expect(readName(q, 12).name).toBe("a.example.com.");
  });
  it("refuses forward and self pointers and over-long names", () => {
    const self = Uint8Array.from([0xc0, 0x00]);
    expect(throwsCode(() => readName(self, 0))).toBe("malformed");
    const fwd = Uint8Array.from([0xc0, 0x02, 0, 0]);
    expect(throwsCode(() => readName(fwd, 0))).toBe("malformed");
    expect(throwsCode(() => normalizeName(`${"a".repeat(64)}.com`))).toBe("malformed");
    expect(throwsCode(() => normalizeName(Array(130).fill("ab").join(".")))).toBe("malformed");
  });
  it("refuses a response that is a query or has absurd counts", () => {
    expect(throwsCode(() => parseResponse(buildQuery("a.com.", TYPE_TXT)))).toBe("malformed");
    const r = new Uint8Array(12);
    r[2] = 0x80;
    r[6] = 0xff;
    r[7] = 0xff;
    expect(throwsCode(() => parseResponse(r))).toBe("malformed");
  });
  it("proof encode/decode round-trips", () => {
    const fx = JSON.parse(readFileSync(new URL("./fixtures/bip353/matt_mattcorallo_com.json", import.meta.url), "utf8")) as { proofB64: string };
    const bytes = new Uint8Array(Buffer.from(fx.proofB64, "base64"));
    expect(Buffer.from(encodeProof(decodeProof(bytes)))).toEqual(Buffer.from(bytes));
  });
});

describe("fuzz: nothing but Bip353Error escapes", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/bip353/matt_mattcorallo_com.json", import.meta.url), "utf8")) as { dnsName: string; capturedAt: number; proofB64: string };
  const base = new Uint8Array(Buffer.from(fx.proofB64, "base64"));
  it("random mutations and truncations of the real proof", async () => {
    let seed = 0x9e3779b9;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 400; n++) {
      const p = base.slice(0, rnd() < 0.2 ? Math.floor(rnd() * base.length) : base.length);
      const flips = 1 + Math.floor(rnd() * 4);
      for (let f = 0; f < flips && p.length; f++) p[Math.floor(rnd() * p.length)] = Math.floor(rnd() * 256);
      try {
        await verifyTxtProof(p, fx.dnsName, { nowSeconds: fx.capturedAt });
      } catch (e) {
        expect(e instanceof Bip353Error, String(e)).toBe(true);
      }
    }
  });
});

describe("parsePaymentInstruction", () => {
  it("reads offer, address, ark and amount", () => {
    const r = parsePaymentInstruction(["something else", "bitcoin:bc1qxyz?lno=lno1abc&ark=ark1def&amount=0.001&label=Hi%20there"]);
    expect(r).toEqual({ onchain: "bc1qxyz", offer: "lno1abc", ark: "ark1def", amountSats: 100_000, label: "Hi there" });
  });
  it("accepts an offer-only record and is case-insensitive on scheme and keys", () => {
    expect(parsePaymentInstruction(["BITCOIN:?LNO=lno1abc"])).toEqual({ offer: "lno1abc" });
  });
  it("ignores unknown optional parameters and unsupported methods", () => {
    expect(parsePaymentInstruction(["bitcoin:?lno=lno1abc&sp=sp1xyz&foo=bar"])).toEqual({ offer: "lno1abc" });
  });
  it("fails closed", () => {
    expect(throwsCode(() => parsePaymentInstruction([]))).toBe("no_record");
    expect(throwsCode(() => parsePaymentInstruction(["hello"]))).toBe("no_record");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?lno=a", "bitcoin:?lno=b"]))).toBe("ambiguous");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?lno=a&lno=b"]))).toBe("ambiguous");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?lno=a&LNO=b"]))).toBe("ambiguous");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?req-foo=1&lno=a"]))).toBe("unsupported");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?lno=a%20b"]))).toBe("malformed");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?lno"]))).toBe("malformed");
    expect(throwsCode(() => parsePaymentInstruction(["bitcoin:?lno=%zz"]))).toBe("malformed");
    expect(throwsCode(() => parsePaymentInstruction([`bitcoin:?lno=${"a".repeat(9000)}`]))).toBe("malformed");
  });
});

describe("parseBtcAmount", () => {
  it("is exact", () => {
    expect(parseBtcAmount("0.00000001")).toBe(1);
    expect(parseBtcAmount("1")).toBe(100_000_000);
    expect(parseBtcAmount("0.1")).toBe(10_000_000);
    expect(parseBtcAmount("20999999.9769")).toBe(2_099_999_997_690_000);
  });
  it("refuses signs, exponents, extra decimals, zero, over supply", () => {
    for (const bad of ["", "-1", "+1", "1e3", "0.000000001", "0", "0.0", "21000001", ".5", "1.", "0x10"]) {
      expect(throwsCode(() => parseBtcAmount(bad)), bad).toBe("malformed");
    }
  });
});
