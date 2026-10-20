// Gift sender (V2 beta): "Zrušit dárek" right after creating one takes it back, and when the recipient already
// claimed it the cancel says so (the recovery scan settles it, no mailbox pull).
import assert from "node:assert/strict";
import { launch, newWallet, fundAndBoard, waitForBalance, waitForText, balanceText, failOnPageProblems, debugDump, BASE } from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// Hold menu of the Odeslat button: a right click opens it (ActionMenu.tsx).
async function createGift(page, sats) {
  await page.getByRole("button", { name: /^Odeslat$/ }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Poslat dárkem/ }).click();
  await page.locator(".sht-amount-input").fill(String(sats));
  await page.getByRole("button", { name: /^Vytvořit odkaz$/ }).click();
  await page.getByRole("button", { name: /^Potvrdit$/ }).click();
  await waitForText(page, /Dárek je připravený/, 120_000);
}

try {
  const a = await newWallet(browser, "A", { v2: true });
  current = a.page;
  await fundAndBoard(a.page, 200_000);
  await waitForText(a.page, /Spendrr 199 888 sats/);
  step("A boarded 199 888 sats");

  // 1. Create and cancel.
  await createGift(a.page, 2_000);
  step("gift 1 created");
  assert.equal(await a.page.getByRole("button", { name: /^Kopírovat$/ }).count(), 0, "one share button, no Kopírovat");
  await a.page.getByRole("button", { name: /^Zrušit dárek$/ }).click();
  await waitForText(a.page, /Dárek se vrátí na tvůj zůstatek/);
  await a.page.getByRole("button", { name: /^Ano, zrušit$/ }).click();
  await waitForText(a.page, /Dárek je zpět/, 120_000);
  step("gift 1 cancelled");
  await a.page.getByRole("button", { name: /^Hotovo$/ }).click();
  await waitForBalance(a.page, /Spendrr 199 888 sats/, 90_000);
  step("A balance is back to 199 888");

  // 2. Create, let B claim, then cancel.
  await createGift(a.page, 3_000);
  await a.page.locator(".shl-qr").click();
  const link = await a.page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /\/g#v=1&g=/, "the QR copies the gift link");
  step("gift 2 created, link copied");
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "cs-CZ" });
  const bp = await ctx.newPage();
  await bp.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  current = bp;
  await bp.getByRole("button", { name: /^Přijmout dárek$/ }).click();
  // Tapping before the claim ends dismisses the screen as soon as it does, so the proof is the received 3 000 sats.
  await waitForText(bp, /\+3 000 sats/, 120_000);
  current = a.page;
  step("B claimed gift 2");
  await a.page.getByRole("button", { name: /^Zrušit dárek$/ }).click();
  await a.page.getByRole("button", { name: /^Ano, zrušit$/ }).click();
  await waitForText(a.page, /Tenhle dárek už je vyzvednutý/, 120_000);
  step("cancel on a claimed gift says so");
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
