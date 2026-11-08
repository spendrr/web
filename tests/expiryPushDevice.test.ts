// The "Bitcoin moved since your last look" percentage of the expiry nudge is
// counted on the device, from the price at its own last look, when it has one:
// the Worker's figure counts from the price sent with the last subscribe, which
// is now up to a week old.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

async function showExpiry(payload: unknown, copy: unknown) {
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
    open: async (name: string) => ({
      match: async () => (name === "spendrr-expiry-copy" && copy ? { json: async () => copy } : undefined),
    }),
  };
  new Function("self", "caches", "importScripts", code)(self, caches, () => {});
  let pending: Promise<unknown> = Promise.resolve();
  handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
  return shown;
}

const copy = {
  lang: "en-US",
  first: "Coins await renewal. Open Spendrr.",
  up: "BTC rose {pct} % 📈.",
  down: "BTC fell {pct} % 📉.",
};
const push = (data: Record<string, string>) => ({ title: "Spendrr", body: "Mince čekají na obnovu.", type: "expiry", data: { stage: "first", ...data } });

describe("expiry nudge price move on the device", () => {
  it("counts it from the price at the device's last look", async () => {
    const shown = await showExpiry(push({ price: "105000", pct: "1.0" }), { ...copy, baselinePriceUsd: 100000 });
    expect(shown[0].body).toBe("BTC rose 5.0 % 📈. Coins await renewal. Open Spendrr.");
  });

  it("says fell for a drop, and nothing for a move under 0.1 %", async () => {
    expect((await showExpiry(push({ price: "95000" }), { ...copy, baselinePriceUsd: 100000 }))[0].body).toContain("BTC fell 5.0 % 📉.");
    expect((await showExpiry(push({ price: "100050", pct: "9.9" }), { ...copy, baselinePriceUsd: 100000 }))[0].body).toBe("Coins await renewal. Open Spendrr.");
  });

  it("uses the Worker's percentage when the device holds no price", async () => {
    const shown = await showExpiry(push({ price: "105000", pct: "2.5" }), copy);
    expect(shown[0].body).toBe("BTC rose 2.5 % 📈. Coins await renewal. Open Spendrr.");
  });
});
