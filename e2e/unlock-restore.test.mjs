// Lock, wrong and right password, reload, then restore the same seed in a clean browser.
import assert from "node:assert/strict";
import { launch, newWallet, restoreWallet, fundAndBoard, balanceText, waitForText, debugDump, lockWallet, failOnPageProblems, PASSWORD } from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

async function unlock(page, password) {
  await page.locator("input[type=password]").first().fill(password);
  await page.getByRole("button", { name: /^Odemknout$/ }).click();
}

try {
  const a = await newWallet(browser, "A");
  current = a.page;
  await fundAndBoard(a.page, 200_000);
  await waitForText(a.page, /Spendrr 199 888 sats/);
  step("A boarded");

  await lockWallet(a.page);
  await a.page.locator("input[type=password]").first().waitFor({ timeout: 15_000 });
  step("locked");

  await unlock(a.page, "wrong-password-123");
  await waitForText(a.page, /Nesprávné heslo/, 30_000);
  step("wrong password refused");

  await unlock(a.page, PASSWORD);
  await waitForText(a.page, /Spendrr 199 888 sats/, 60_000);
  step("unlocked, balance intact");

  await a.page.reload();
  await a.page.locator("input[type=password]").first().waitFor({ timeout: 30_000 });
  await unlock(a.page, PASSWORD);
  await waitForText(a.page, /Spendrr 199 888 sats/, 60_000);
  step("reload, unlock, balance intact");

  // One open instance per seed, as in real use.
  await a.context.close();
  const r = await restoreWallet(browser, a.mnemonic);
  step("restored from seed");
  let text = "";
  for (let i = 0; i < 90; i++) {
    await r.page.getByRole("button", { name: /^Obnovit$/ }).click().catch(() => {});
    text = await balanceText(r.page);
    if (/Spendrr 199 888 sats/.test(text)) break;
    await r.page.waitForTimeout(700);
  }
  assert.match(text, /Spendrr 199 888 sats/, `restored wallet balance: ${text.slice(0, 200)}`);
  step("restored wallet sees 199 888 sats");
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
