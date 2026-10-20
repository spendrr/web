// Fuzz tests for src/lib/send/destination.ts — the Send form's synchronous
// classification of pasted/scanned text and BIP21/ark: URI parsing. This is
// the first thing arbitrary, attacker-controlled QR content touches, so it
// should never throw regardless of input.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyStatic, isArkAddressShape, parseScannedPayload } from "../src/lib/send/destinationCheck";
import { decodeBolt11Amount, decodeBolt11Expiry, normalizeDestination } from "../src/lib/send/destination";
import { encodeLnurl } from "../src/lib/send/lnurl";

describe("classifyStatic", () => {
  it("never throws for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (input) => {
        expect(() => classifyStatic(input)).not.toThrow();
      }),
    );
  });

  it("never calls an ln-prefixed string an invoice without a valid checksum", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("lnbc", "lntb", "lntbs", "LNBC", "LnBc"),
        fc.string({ maxLength: 50 }).filter((s) => !s.includes("@")),
        (prefix, suffix) => {
          expect(classifyStatic(`  ${prefix}${suffix}  `)).toBe("invalid");
        },
      ),
    );
  });

  it("classifies BOLT12 offers (lno1 + bech32 alphabet) regardless of case or surrounding whitespace", () => {
    const body = fc
      .array(fc.constantFrom(..."qpzry9x8gf2tvdw0s3jn54khce6mua7l"), { minLength: 20, maxLength: 80 })
      .map((chars) => chars.join(""));
    fc.assert(
      fc.property(fc.constantFrom("lno1", "LNO1"), body, (prefix, rest) => {
        const value = prefix === "LNO1" ? `${prefix}${rest}`.toUpperCase() : `${prefix}${rest}`;
        expect(classifyStatic(`  ${value}  `)).toBe("lightning-offer");
      }),
    );
  });

  it("rejects an lno1 string that leaves the bech32 alphabet or is too short", () => {
    expect(classifyStatic("lno1")).toBe("invalid");
    expect(classifyStatic("lno1qqqq")).toBe("invalid");
    expect(classifyStatic(`lno1${"q".repeat(30)}b`)).toBe("invalid");
    expect(classifyStatic(`lno1${"q".repeat(30)}Q`)).toBe("invalid");
  });

  it("classifies anything shaped like an email as a lightning-address", () => {
    const alnum = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), { minLength: 1, maxLength: 20 })
      .map((chars) => chars.join(""));
    const alpha = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 20 })
      .map((chars) => chars.join(""));
    fc.assert(
      fc.property(alnum, alpha, fc.constantFrom("com", "cz", "org"), (user, domain, tld) => {
        expect(classifyStatic(`${user}@${domain}.${tld}`)).toBe("lightning-address");
      }),
    );
  });

  it("never classifies a bitcoin: URI as a Lightning kind", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (rest) => {
        expect(classifyStatic(`bitcoin:${rest}`)).toBeNull();
      }),
    );
  });
});

describe("parseScannedPayload", () => {
  it("never throws for arbitrary scanned text, including malformed URIs", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (raw) => {
        expect(() => parseScannedPayload(raw)).not.toThrow();
      }),
    );
  });

  it("strips the bitcoin: scheme and never produces a negative or non-finite amount", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.oneof(fc.double(), fc.string({ maxLength: 20 })),
        (address, amount) => {
          const raw = `bitcoin:${address}?amount=${amount}`;
          const result = parseScannedPayload(raw);
          expect(result.destination).not.toMatch(/^bitcoin:/i);
          if (result.amountSats !== undefined) {
            expect(Number.isFinite(result.amountSats)).toBe(true);
            expect(result.amountSats).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it("strips the ark: scheme and only ever returns an integer amount", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), fc.string({ maxLength: 20 }), (address, amount) => {
        const raw = `ark:${address}?amount=${amount}`;
        const result = parseScannedPayload(raw);
        expect(result.destination).not.toMatch(/^ark:/i);
        if (result.amountSats !== undefined) {
          expect(Number.isInteger(result.amountSats)).toBe(true);
          expect(result.amountSats).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("passes through arbitrary text unchanged when it has no recognized scheme", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 200 })
          .filter((s) => !/^(bitcoin|lightning|ark):/i.test(s.trim())),
        (raw) => {
          expect(parseScannedPayload(raw).destination).toBe(raw.trim());
        },
      ),
    );
  });
});

// Regression: classifyStatic() strips a "lightning:" URI scheme internally,
// but decodeBolt11Amount()'s anchored /^ln.../ regex did not — so a pasted
// "lightning:lnbc10m1…" classified as an invoice while decoding to null.
// That fed straight into SendPanel's large-send password re-check
// (PASSWORD_REQUIRED_THRESHOLD_SATS) and its confirm-screen amount row,
// both of which key off the decoded amount: a 1,000,000-sat payment went
// through with no password prompt and no amount shown. Both functions now
// go through normalizeDestination().
describe("lightning: URI scheme prefix", () => {
  const AMOUNTED_INVOICE = "lnbc10m1pexamplerestofinvoice";

  it("decodes the same amount with and without the scheme prefix", () => {
    const bare = decodeBolt11Amount(AMOUNTED_INVOICE);
    expect(bare).toBe(1_000_000);
    for (const prefix of ["lightning:", "LIGHTNING:", "Lightning:"]) {
      expect(decodeBolt11Amount(`${prefix}${AMOUNTED_INVOICE}`)).toBe(bare);
      expect(decodeBolt11Amount(`  ${prefix}${AMOUNTED_INVOICE}  `)).toBe(bare);
    }
  });

  it("classifies identically with and without the prefix", () => {
    expect(classifyStatic(`lightning:${AMOUNTED_INVOICE}`)).toBe(classifyStatic(AMOUNTED_INVOICE));
  });

  it("normalizeDestination is idempotent and never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (input) => {
        const once = normalizeDestination(input);
        expect(normalizeDestination(once)).toBe(once);
      }),
    );
  });

  it("strips only a leading scheme, not an occurrence further in", () => {
    expect(normalizeDestination("lnbc1lightning:xyz")).toBe("lnbc1lightning:xyz");
  });
});

// --- decodeBolt11Expiry ------------------------------------------------------
//
// What these prove and what they don't: the round-trip cases below encode an
// invoice *body* with the same bech32 field layout the decoder reads, so they
// pin the decoder's arithmetic and its skip-by-length walk, not the claim
// that this layout is what BOLT11 really specifies (no real signed mainnet
// invoice is checked in here to compare against). That is a deliberate
// limit, and it is survivable for the reason the function's own comment
// gives: a wrong answer only mislabels a Lightning fallback on a payment
// request page, the payer's wallet decides for itself, and the Ark address
// on the same page is unaffected either way. The "never throws" property is
// the load-bearing one — this runs on an untrusted pasted URL.
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function encodeInvoice(timestampSecs: number, expirySecs: number | null): string {
  const values: number[] = [];
  for (let i = 6; i >= 0; i--) values.push((Math.floor(timestampSecs / 32 ** i) % 32) | 0);
  // One field the decoder must skip by length without understanding it.
  values.push(B32.indexOf("d"), 0, 3, 1, 2, 3);
  if (expirySecs !== null) {
    const digits: number[] = [];
    let rest = expirySecs;
    do {
      digits.unshift(rest % 32);
      rest = Math.floor(rest / 32);
    } while (rest > 0);
    values.push(B32.indexOf("x"), 0, digits.length, ...digits);
  }
  const body = values.map((v) => B32[v]).join("");
  // 104 characters of "signature" + 6 of "checksum", which the decoder only
  // ever skips.
  return "lnbc2500u1" + body + "q".repeat(104) + "qqqqqq";
}

describe("decodeBolt11Expiry", () => {
  it("never throws for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (input) => {
        expect(() => decodeBolt11Expiry(input)).not.toThrow();
      }),
    );
  });

  it("returns timestamp + expiry when the invoice carries an x field", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (ts, expiry) => {
          expect(decodeBolt11Expiry(encodeInvoice(ts, expiry))).toBe((ts + expiry) * 1000);
        },
      ),
    );
  });

  it("falls back to BOLT11's own 3600s default when there is no x field", () => {
    expect(decodeBolt11Expiry(encodeInvoice(1_700_000_000, null))).toBe((1_700_000_000 + 3600) * 1000);
  });

  it("strips a lightning: prefix like every other decoder here", () => {
    const invoice = encodeInvoice(1_700_000_000, 600);
    expect(decodeBolt11Expiry("lightning:" + invoice)).toBe(decodeBolt11Expiry(invoice));
  });

  it("returns null rather than a number for strings that are too short to be an invoice", () => {
    for (const s of ["", "lnbc", "lnbc1", "lnbc1qqqq", "not an invoice at all"]) {
      expect(decodeBolt11Expiry(s)).toBeNull();
    }
  });

  it("returns null when the body holds characters outside bech32's alphabet", () => {
    // "b", "i", "o" and "1" are the four excluded characters.
    expect(decodeBolt11Expiry("lnbc2500u1" + "bio".repeat(3) + "q".repeat(104) + "qqqqqq")).toBeNull();
  });
});


// Real vectors: the two mainnet invoices from the BOLT11 specification (their
// checksums verify) and two generated Ark-shaped addresses (bech32m,
// hrp "ark", 130 characters, valid checksum, not anyone's wallet). A typo in any of them has to be caught locally.
const SPEC_INVOICE_2500U =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const SPEC_INVOICE_ANY =
  "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w";
const ARK_ADDRESS =
  "ark1pu6h30w3zqqpk0f9l08vzl6taah7ra05zyxxwfa2rruq8t9usel94389c7nvdv2npd4p76zufehl2vw07emn92rq0vur4mtx55wnug2mveqwhtht8egmqtfeahugfk";
const ARK_ADDRESS_2 =
  "ark1pu6h30w3zqqpkhe3x8w4mq9pjhsaw9kzj3a74ynsm64nvcsll3qrpqmql9r5emnxkhlj3n2ch0x0kwqzg7l77vfs6ulu50kn5lx2qq8u5ecdtpu0re4wnre4sy9w5r";
const ONCHAIN = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

// Flips one data character to another valid bech32 one.
function typo(s: string, at: number): string {
  const c = s[at];
  return s.slice(0, at) + (c === "q" ? "p" : "q") + s.slice(at + 1);
}

describe("classifyStatic: checksums and network", () => {
  it("accepts real BOLT11 invoices, in any of the spellings a user or a QR produces", () => {
    for (const inv of [SPEC_INVOICE_2500U, SPEC_INVOICE_ANY]) {
      expect(classifyStatic(inv)).toBe("lightning-invoice");
      expect(classifyStatic(`lightning:${inv}`)).toBe("lightning-invoice");
      expect(classifyStatic(`  ${inv.toUpperCase()}  `)).toBe("lightning-invoice");
      expect(classifyStatic(`LIGHTNING:${inv.toUpperCase()}`)).toBe("lightning-invoice");
    }
  });

  it("rejects an invoice with any single-character typo, and one with mixed case", () => {
    for (const at of [10, 40, 100, 200, SPEC_INVOICE_2500U.length - 3]) {
      expect(classifyStatic(typo(SPEC_INVOICE_2500U, at))).toBe("invalid");
    }
    expect(classifyStatic(SPEC_INVOICE_2500U.slice(0, 50) + SPEC_INVOICE_2500U.slice(50).toUpperCase())).toBe("invalid");
  });

  it("rejects a truncated invoice", () => {
    expect(classifyStatic(SPEC_INVOICE_2500U.slice(0, SPEC_INVOICE_2500U.length - 10))).toBe("invalid");
  });

  it("rejects a valid-checksum invoice of another network on a mainnet build", () => {
    const words = [...SPEC_INVOICE_2500U.slice(SPEC_INVOICE_2500U.indexOf("1") + 1, -6)].map((c) => B32.indexOf(c));
    for (const hrp of ["lntb2500u", "lntbs2500u", "lnbcrt2500u"]) {
      expect(classifyStatic(bech32Encode(hrp, words))).toBe("invalid");
    }
    expect(classifyStatic(bech32Encode("lnbc2500u", words))).toBe("lightning-invoice");
  });

  it("accepts an LNURL that decodes and rejects one that does not", () => {
    const lnurl = encodeLnurl("https://example.com/.well-known/lnurlp/user");
    expect(classifyStatic(lnurl)).toBe("lnurl");
    expect(classifyStatic(lnurl.toUpperCase())).toBe("lnurl");
    expect(classifyStatic(typo(lnurl, 20))).toBe("invalid");
    expect(classifyStatic("lnurlfoo")).toBe("invalid");
    expect(classifyStatic("lnurlp://example.com/x")).toBe("invalid");
  });

  it("holds a Lightning address to DNS shape, and drops a leading BIP 353 sign", () => {
    expect(classifyStatic("user@example.com")).toBe("lightning-address");
    expect(classifyStatic("\u20bfuser@Example.COM")).toBe("lightning-address");
    expect(normalizeDestination("\u20bfuser@example.com")).toBe("user@example.com");
    for (const bad of ["a@b..c", "user@-x.com", "user@x-.com", "user@example", "user@1.2", "@example.com", "a b@x.com", "a@b@c.com"]) {
      expect(classifyStatic(bad)).toBe("invalid");
    }
  });
});

describe("isArkAddressShape", () => {
  it("accepts real Ark addresses, upper case too", () => {
    expect(isArkAddressShape(ARK_ADDRESS)).toBe(true);
    expect(isArkAddressShape(ARK_ADDRESS_2)).toBe(true);
    expect(isArkAddressShape(ARK_ADDRESS.toUpperCase())).toBe(true);
    expect(isArkAddressShape(`  ${ARK_ADDRESS}  `)).toBe(true);
  });

  it("rejects a typo anywhere, a truncation, other hrps and non-Ark strings", () => {
    for (const at of [5, 30, 70, 120, ARK_ADDRESS.length - 2]) {
      expect(isArkAddressShape(typo(ARK_ADDRESS, at))).toBe(false);
    }
    expect(isArkAddressShape(ARK_ADDRESS.slice(0, -4))).toBe(false);
    expect(isArkAddressShape(ONCHAIN)).toBe(false);
    expect(isArkAddressShape(SPEC_INVOICE_ANY)).toBe(false);
    expect(isArkAddressShape("")).toBe(false);
    expect(isArkAddressShape("ark1")).toBe(false);
  });

  it("is never a Lightning kind", () => {
    expect(classifyStatic(ARK_ADDRESS)).toBeNull();
  });
});

describe("normalizeDestination", () => {
  it("lowers an all-upper bech32 destination and leaves base58 alone", () => {
    expect(normalizeDestination(ONCHAIN.toUpperCase())).toBe(ONCHAIN);
    expect(normalizeDestination("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toBe("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2");
    expect(normalizeDestination("Bc1Qar")).toBe("Bc1Qar");
  });
});

describe("decodeBolt11Amount rounds up", () => {
  it("prices 1400 msat and 1500 msat as 2 sats, never less than what moves", () => {
    expect(decodeBolt11Amount("lnbc14n1x")).toBe(2);
    expect(decodeBolt11Amount("lnbc15n1x")).toBe(2);
    expect(decodeBolt11Amount("lnbc20n1x")).toBe(2);
    expect(decodeBolt11Amount("lnbc2500u1x")).toBe(250_000);
  });
});

describe("parseScannedPayload: BIP21", () => {
  const T = 1496314658_000 + 1000; // a second after SPEC_INVOICE_2500U was made: not expired

  it("reads amounts as BIP21 defines them", () => {
    const at = (a: string) => parseScannedPayload(`bitcoin:${ONCHAIN}?amount=${a}`, T).amountSats;
    expect(at("0.00000001")).toBe(1);
    expect(at("0.1")).toBe(10_000_000);
    expect(at("21")).toBe(2_100_000_000);
    expect(at(".5")).toBe(50_000_000);
    expect(at("1e-3")).toBeUndefined();
    expect(at("-1")).toBeUndefined();
    expect(at("0.000000001")).toBeUndefined();
    expect(at("0")).toBeUndefined();
  });

  it("prefers Ark, then Lightning, then on-chain from a unified URI", () => {
    const base = `bitcoin:${ONCHAIN}?amount=0.001`;
    expect(parseScannedPayload(`${base}&ark=${ARK_ADDRESS}&lightning=${SPEC_INVOICE_ANY}`, T)).toEqual({
      destination: ARK_ADDRESS,
      amountSats: 100_000,
    });
    expect(parseScannedPayload(`${base}&lightning=${SPEC_INVOICE_ANY}`, T)).toEqual({
      destination: SPEC_INVOICE_ANY,
      amountSats: 100_000,
    });
    expect(parseScannedPayload(base, T)).toEqual({ destination: ONCHAIN, amountSats: 100_000 });
  });

  it("drops the URI's amount when the invoice carries its own", () => {
    const r = parseScannedPayload(`bitcoin:${ONCHAIN}?amount=0.5&lightning=${SPEC_INVOICE_2500U}`, T);
    expect(r).toEqual({ destination: SPEC_INVOICE_2500U, amountSats: undefined });
  });

  it("falls through to the next candidate when one is broken, wrong-network or expired", () => {
    const broken = `bitcoin:${ONCHAIN}?ark=${typo(ARK_ADDRESS, 30)}&lightning=${typo(SPEC_INVOICE_ANY, 60)}`;
    expect(parseScannedPayload(broken, T).destination).toBe(ONCHAIN);
    const expired = `bitcoin:${ONCHAIN}?lightning=${SPEC_INVOICE_2500U}`;
    expect(parseScannedPayload(expired, T + 10 * 3600_000).destination).toBe(ONCHAIN);
  });

  it("works with an empty on-chain part and with upper-case QR text", () => {
    expect(parseScannedPayload(`bitcoin:?ark=${ARK_ADDRESS}`, T).destination).toBe(ARK_ADDRESS);
    const upper = `BITCOIN:${ONCHAIN.toUpperCase()}?AMOUNT=0.01&LIGHTNING=${SPEC_INVOICE_ANY.toUpperCase()}`;
    expect(parseScannedPayload(upper, T).destination).toBe(SPEC_INVOICE_ANY);
  });

  it("refuses a URI with a req- parameter by handing the raw text back", () => {
    const raw = `bitcoin:${ONCHAIN}?req-foo=1&amount=1`;
    expect(parseScannedPayload(raw, T)).toEqual({ destination: raw });
    expect(classifyStatic(raw)).toBeNull();
  });

  it("cuts a query off a lightning: URI", () => {
    expect(parseScannedPayload(`lightning:${SPEC_INVOICE_ANY}?x=1`, T).destination).toBe(SPEC_INVOICE_ANY);
  });
});


// Independent bech32 encoder (checksum constant 1), so a network-swapped
// invoice can be built with a VALID checksum and only the hrp being wrong.
function bech32Encode(hrp: string, words: number[]): string {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values: number[]) => {
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
  };
  const expand = [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(expand.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((p) => (mod >>> (5 * (5 - p))) & 31);
  return `${hrp}1${words.concat(check).map((w) => B32[w]).join("")}`;
}
