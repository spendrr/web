import { describe, expect, it } from "vitest";
import { decodeBolt11Amount, decodeBolt11PaymentHash } from "../src/lib/send/destination";

// BOLT11 spec example ("coffee beans", 2500u).
const INVOICE =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp";

describe("decodeBolt11PaymentHash", () => {
  it("reads the spec example's payment hash", () => {
    expect(decodeBolt11PaymentHash(INVOICE)).toBe("0001020304050607080900010203040506070809000102030405060708090102");
    expect(decodeBolt11Amount(INVOICE)).toBe(250_000);
  });
  it("accepts the lightning: prefix and upper case", () => {
    expect(decodeBolt11PaymentHash(`lightning:${INVOICE.toUpperCase()}`)).toBe(
      "0001020304050607080900010203040506070809000102030405060708090102",
    );
  });
  it("returns null for junk and never throws", () => {
    for (const junk of ["", "lnbc", "lnbc1", "x".repeat(400), INVOICE.slice(0, 60), "lnbc1" + "q".repeat(200)]) {
      expect(decodeBolt11PaymentHash(junk)).toBeNull();
    }
  });
});
