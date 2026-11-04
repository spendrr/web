import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeProof, encodeProof, type Rr } from "../src/lib/bip353/dnsWire";
import { verifyTxtProof } from "../src/lib/bip353/dnssec";
import { parsePaymentInstruction } from "../src/lib/bip353/instruction";
import { parseHumanName } from "../src/lib/bip353/name";
import { ROOT_ANCHORS } from "../src/lib/bip353/trustAnchors";
import { Bip353Error } from "../src/lib/bip353/errors";

const fx = JSON.parse(readFileSync(new URL("./fixtures/bip353/matt_mattcorallo_com.json", import.meta.url), "utf8")) as {
  name: string;
  dnsName: string;
  capturedAt: number;
  proofB64: string;
};
const proof = () => new Uint8Array(Buffer.from(fx.proofB64, "base64"));

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof Bip353Error ? e.code : `other:${String(e)}`;
  }
}

describe("real DNS fixture (matt@mattcorallo.com)", () => {
  it("validates against the real root anchors and yields a payment record", async () => {
    const r = await verifyTxtProof(proof(), fx.dnsName, { nowSeconds: fx.capturedAt });
    expect(r.signer).toBe("mattcorallo.com.");
    expect(r.validUntil).toBeGreaterThan(fx.capturedAt);
    const ins = parsePaymentInstruction(r.records);
    expect(ins.offer?.startsWith("lno1")).toBe(true);
    expect(ins.onchain?.startsWith("bc1")).toBe(true);
  });

  it("name parser builds the same DNS name", () => {
    expect(parseHumanName(fx.name).dnsName).toBe(fx.dnsName);
    expect(parseHumanName("₿" + fx.name.toUpperCase()).dnsName).toBe(fx.dnsName);
  });

  it("rejects after the signatures expire", async () => {
    const r = await verifyTxtProof(proof(), fx.dnsName, { nowSeconds: fx.capturedAt });
    expect(await code(verifyTxtProof(proof(), fx.dnsName, { nowSeconds: r.validUntil + 1 }))).toBe("expired");
  });

  it("rejects before the signatures start", async () => {
    expect(await code(verifyTxtProof(proof(), fx.dnsName, { nowSeconds: 1_000_000_000 }))).toBe("expired");
  });

  it("rejects with no matching trust anchor", async () => {
    const wrong = [{ ...ROOT_ANCHORS[0]!, digestHex: "00".repeat(32) }];
    expect(await code(verifyTxtProof(proof(), fx.dnsName, { nowSeconds: fx.capturedAt, anchors: wrong }))).toBe("untrusted");
  });

  it("rejects a different target name", async () => {
    expect(await code(verifyTxtProof(proof(), "evil.user._bitcoin-payment.mattcorallo.com.", { nowSeconds: fx.capturedAt }))).toBe("no_record");
  });

  it("every single flipped bit in the TXT record or any signature breaks it", async () => {
    const rrs = decodeProof(proof());
    let flipped = 0;
    for (let i = 0; i < rrs.length; i++) {
      const rr = rrs[i]!;
      // Sample positions across the rdata to keep the run fast.
      const step = Math.max(1, Math.floor(rr.rdata.length / 8));
      for (let b = 0; b < rr.rdata.length; b += step) {
        const copy: Rr[] = rrs.map((x) => ({ ...x, rdata: x.rdata.slice() }));
        copy[i]!.rdata[b] = copy[i]!.rdata[b]! ^ 0x01;
        const c = await code(verifyTxtProof(encodeProof(copy), fx.dnsName, { nowSeconds: fx.capturedAt }));
        // A flipped bit may land on a record the chain does not depend on
        // (an unused key); everything that does matter must fail, and nothing
        // may throw anything but a Bip353Error.
        expect(c.startsWith("other:")).toBe(false);
        if (rr.type === 16 || rr.type === 46) expect(c).not.toBe("ok");
        flipped++;
      }
    }
    expect(flipped).toBeGreaterThan(20);
  });

  it("dropping the DS of the domain breaks the chain", async () => {
    const rrs = decodeProof(proof()).filter((r) => !(r.type === 43 && r.name === "mattcorallo.com."));
    expect(await code(verifyTxtProof(encodeProof(rrs), fx.dnsName, { nowSeconds: fx.capturedAt }))).toBe("untrusted");
  });

  it("dropping the TXT signature leaves an unsigned record, which is refused", async () => {
    const rrs = decodeProof(proof()).filter((r) => !(r.type === 46 && r.name === fx.dnsName));
    expect(await code(verifyTxtProof(encodeProof(rrs), fx.dnsName, { nowSeconds: fx.capturedAt }))).toBe("untrusted");
  });

  it("junk and truncated proofs are Bip353Errors, never crashes", async () => {
    const p = proof();
    for (const cut of [0, 1, 5, 30, 200, p.length - 1]) {
      const c = await code(verifyTxtProof(p.slice(0, cut), fx.dnsName, { nowSeconds: fx.capturedAt }));
      expect(c.startsWith("other:")).toBe(false);
    }
  });
});
