// Re-captures the real-DNS fixtures used by bip353.verify.test.ts. Skipped
// unless BIP353_CAPTURE=1 (it needs the network and rewrites files):
//   BIP353_CAPTURE=1 npx vitest run tests/bip353.capture.test.ts
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectProof } from "../src/lib/bip353/proofCollector";
import { parseHumanName } from "../src/lib/bip353/name";

const NAMES = ["matt@mattcorallo.com"];
const run = process.env.BIP353_CAPTURE === "1";

describe.skipIf(!run)("bip353 fixture capture", () => {
  for (const name of NAMES) {
    it(`captures ${name}`, async () => {
      const { dnsName } = parseHumanName(name);
      // Sequential: a dozen parallel connections time out in some sandboxes.
      let chain: Promise<unknown> = Promise.resolve();
      const proof = await collectProof(dnsName, (q) => {
        const p = chain.then(async () => {
          const res = await fetch("https://cloudflare-dns.com/dns-query", { method: "POST", headers: { "content-type": "application/dns-message", accept: "application/dns-message" }, body: q as BodyInit });
          expect(res.status).toBe(200);
          return new Uint8Array(await res.arrayBuffer());
        });
        chain = p.catch(() => {});
        return p;
      });
      const file = `tests/fixtures/bip353/${name.replace(/[^a-z0-9]+/gi, "_")}.json`;
      writeFileSync(file, JSON.stringify({ name, dnsName, capturedAt: Math.floor(Date.now() / 1000), proofB64: Buffer.from(proof).toString("base64") }, null, 2) + "\n");
    });
  }
});
