// src/lib/appErrors.ts: which errors get a Czech sentence, and that only the
// unrecognised ones carry raw text for the toast's copy button.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { describeError } from "../src/lib/appErrors";
import { __I18N_DICT, tf } from "../src/lib/i18n";
import { withTimeout } from "../src/lib/wallet/walletCall";

const t = (cs: string) => cs;
const en = (cs: string) => __I18N_DICT[cs] ?? cs;
const d = (e: unknown) => describeError(e, t, "cs");

describe("describeError", () => {
  it("translates the SDK's insufficient-funds wordings", () => {
    for (const raw of [
      "Insufficient money available. Needed 5000 sat but 1200 sat is available",
      "Insufficient funds: 1 available of 2 needed",
      "bad user input: InsufficientFunds",
    ]) {
      expect(d(new Error(raw))).toEqual({ text: "Nemáš dost prostředků (včetně poplatku).", raw: null });
    }
  });

  it("puts the parsed Lightning limit into the sentence", () => {
    const r = d(new Error("bad user input: lightning receive amount exceeds limit of 0.02750000 BTC"));
    expect(r.raw).toBeNull();
    expect(r.text).toBe(tf("Nad limitem pro Lightning (max {limitSats} sats).", { limitSats: (2_750_000).toLocaleString("cs-CZ") }));
  });

  it("puts the parsed board minimum into the sentence", () => {
    const r = d(new Error("amount 0.0001 BTC is less than minimum board amount required by server (0.0005 BTC)"));
    expect(r.text).toContain((50_000).toLocaleString("cs-CZ"));
    expect(r.raw).toBeNull();
  });

  it("prefers confirmations over the generic insufficient-funds match", () => {
    expect(d(new Error("Insufficient Confirmed Funds: 5000 is needed but only 0")).text).toBe(
      "On-chain prostředky ještě nemají dost potvrzení. Zkus to později.",
    );
  });

  it("recognises an unspendable VTXO", () => {
    expect(d(new Error("bad user input: vtxo abc:0 is not spendable")).raw).toBeNull();
  });

  it("recognises a network failure from fetch", () => {
    expect(d(new TypeError("Failed to fetch")).text).toBe(
      "Nepodařilo se připojit. Zkontroluj internet a zkus to znovu.",
    );
  });

  it("falls back to a generic sentence with the raw text copyable", () => {
    const raw = "code: 'Internal', message: 'round 42 failed: nonce mismatch'";
    expect(d(new Error(raw))).toEqual({ text: "Něco se nepovedlo.", raw });
  });

  it("does not offer an empty copy button", () => {
    expect(d(new Error(""))).toEqual({ text: "Něco se nepovedlo.", raw: null });
    expect(d(undefined).text).toBe("Něco se nepovedlo.");
  });

  it("passes the app's own Czech messages through untouched", () => {
    // Would otherwise match the "insufficient funds" pattern's neighbour
    // wording; our own sentence must win.
    const own = "Zůstatek nepokryje ani poplatek za odeslání.";
    expect(d(new Error(own))).toEqual({ text: own, raw: null });
  });

  it("translates an app message that is a dictionary key", () => {
    const key = "Nesprávné heslo.";
    expect(describeError(new Error(key), en, "en")).toEqual({ text: __I18N_DICT[key], raw: null });
  });

  it("names a wallet-call timeout instead of showing 'Počkej chvíli…'", async () => {
    const e = await withTimeout(new Promise(() => {}), 1, "Počkej chvíli…").catch((x: unknown) => x);
    expect(d(e)).toEqual({ text: "Peněženka neodpovídá. Zkus to za chvíli znovu.", raw: null });
  });

  it("every known sentence has an English translation", () => {
    const samples = [
      "Insufficient funds", "Fee (10) exceeds amount (5)", "Output below the dust limit: 1",
      "Invoice has already been paid", "Payment operation already in progress for this invoice",
      "Cannot pay invoice for 0 sats (0 sat invoices are not any-amount invoices)", "invoice expired",
      "InvoiceAmountMismatch", "Invoice is for wrong network: testnet", "Ark address is for different server",
      "InvalidLightningAddress", "InvalidLnUrl", "InvalidInvoice", "Could not start lightning send",
      "ProtocolVersionMismatch ClientTooOld", "Failed to connect to Ark server",
    ];
    for (const raw of samples) {
      const r = d(new Error(raw));
      expect(r.raw, raw).toBeNull();
      expect(__I18N_DICT[r.text], r.text).toBeTruthy();
    }
  });

  it("never throws and always returns some text", () => {
    fc.assert(
      fc.property(fc.anything(), (e) => {
        const r = d(e);
        expect(typeof r.text).toBe("string");
        expect(r.text.length).toBeGreaterThan(0);
      }),
    );
  });
});
