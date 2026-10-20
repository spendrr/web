import { describe, expect, it } from "vitest";
import { parseReport, REPORT_MAX_AGE_MS, signReport, verifyReport, type StatusReport } from "../status/report";
import { buildStatusReport } from "../worker/statusReport";

const NOW = Date.UTC(2026, 9, 5, 17, 0);

async function keys() {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return {
    pub: b64(await crypto.subtle.exportKey("raw", publicKey)),
    priv: b64(await crypto.subtle.exportKey("pkcs8", privateKey)),
  };
}

const report = (): StatusReport =>
  buildStatusReport(
    { ledger: { lnNode: true, lnRefusing: false, lnInvoicesFailing: false }, relay: true, pushConfigured: true, names: true, backups: true },
    NOW,
  );

describe("status report", () => {
  it("round-trips through sign and verify", async () => {
    const { pub, priv } = await keys();
    const { body, signature } = await signReport(report(), priv);
    expect(await verifyReport(body, signature, pub, NOW + 1000)).toEqual(report());
  });

  it("rejects another key, a changed body and a stale time", async () => {
    const { priv } = await keys();
    const other = await keys();
    const { body, signature } = await signReport(report(), priv);
    expect(await verifyReport(body, signature, other.pub, NOW)).toBeNull();
    const { pub } = await keys();
    const signed = await signReport(report(), priv);
    expect(await verifyReport(signed.body.replace('"relay":true', '"relay":false'), signed.signature, pub, NOW)).toBeNull();

    const own = await keys();
    const fresh = await signReport(report(), own.priv);
    expect(await verifyReport(fresh.body, fresh.signature, own.pub, NOW + REPORT_MAX_AGE_MS + 1)).toBeNull();
    expect(await verifyReport(fresh.body, "not base64!", own.pub, NOW)).toBeNull();
  });

  it("parses only exactly the expected fields, never text", () => {
    expect(parseReport(report())).not.toBeNull();
    expect(parseReport({ ...report(), note: "move your funds" })).toBeNull();
    expect(parseReport({ ...report(), relay: "yes" })).toBeNull();
    const { relay: _relay, ...missing } = report();
    expect(parseReport(missing)).toBeNull();
    expect(parseReport({ ...report(), v: 2 })).toBeNull();
  });

  it("a ledger that did not answer reads as an unreachable node", () => {
    const r = buildStatusReport({ ledger: null, relay: false, pushConfigured: true, names: true, backups: true }, NOW);
    expect(r.lnNode).toBe(false);
  });
});
