// A payment push carries the amount as data, so sw.js can word it in the app's
// language; the Czech body stays as the fallback.
import { describe, expect, it } from "vitest";
import { eventSats } from "../worker/mailboxShared";

describe("eventSats", () => {
  it("reads whole sats from a Lightning and an Ark event", () => {
    expect(eventSats({ kind: "lightning", paymentHash: new Uint8Array(32), amountMsat: 1_500_999 })).toBe(1500);
    expect(eventSats({ kind: "arkoor", amountSat: 120 })).toBe(120);
  });

  it("is 0 when an Ark amount could not be read", () => {
    expect(eventSats({ kind: "arkoor", amountSat: 0 })).toBe(0);
  });
});

// public/sw.js run against a fake service worker scope.
async function showPayment(payload: unknown, copy: unknown) {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync("public/sw.js", "utf8");
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; body: string }[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    clients: { matchAll: async () => [] },
    registration: {
      getNotifications: async () => [],
      showNotification: async (title: string, opts: { body: string }) => void shown.push({ title, body: opts.body }),
    },
    navigator: {},
    spendrrChatPush: {},
  };
  const caches = {
    open: async () => ({ match: async () => (copy ? { json: async () => copy } : undefined) }),
  };
  new Function("self", "caches", "importScripts", code)(self, caches, () => {});
  let pending: Promise<unknown> = Promise.resolve();
  handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
  return shown;
}

describe("sw.js payment push", () => {
  const copy = { lang: "en-US", payment: "Payment received {sats} sats", paymentNoAmount: "Payment received" };

  it("words the line in the app's language with the amount from the data", async () => {
    const shown = await showPayment({ title: "Spendrr", body: "Přijatá platba 1 500 sats", type: "payment", data: { sats: "1500" } }, copy);
    expect(shown).toEqual([{ title: "Spendrr", body: "Payment received 1,500 sats" }]);
  });

  it("uses the line without an amount when none came", async () => {
    const shown = await showPayment({ title: "Spendrr", body: "Přijatá platba", type: "payment" }, copy);
    expect(shown[0].body).toBe("Payment received");
  });

  it("keeps the Worker's Czech text when the app left no copy", async () => {
    const shown = await showPayment({ title: "Spendrr", body: "Přijatá platba 1 500 sats", type: "payment", data: { sats: "1500" } }, null);
    expect(shown[0].body).toBe("Přijatá platba 1 500 sats");
  });
});
