// The rolling no-password budget (UNAUTHORIZED_SPEND_CAP_SATS, 100 000 sats per
// 24 h): sends under the 100 000 threshold go through without a password until
// their sum would pass the cap. The next one is refused by the worker, the UI
// asks for the password, and only the right password sends it.
import assert from "node:assert/strict";
import {
  launch, newWallet, fundAndBoard, arkAddress, startSend, waitForSendDone, waitForBalance, waitForText, balanceText,
  assertStays, failOnPageProblems, debugDump, PASSWORD,
} from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
  const a = await newWallet(browser, "A");
  const b = await newWallet(browser, "B");
  const p = (current = a.page);
  await fundAndBoard(p, 200_000);
  const bAddr = await arkAddress(b.page);
  step("A boarded 199 888 sats");

  for (const [i, total] of [[1, 40_000], [2, 80_000]]) {
    await startSend(p, bAddr, 40_000);
    assert.doesNotMatch(await balanceText(p), /Potvrď heslo/, `send ${i} is under the cap, no password`);
    await p.getByRole("button", { name: /Potvrdit a odeslat/ }).click();
    await waitForBalance(b.page, new RegExp(`Spendrr ${total.toLocaleString("cs-CZ").replace(/[\s ]/g, " ")} sats`));
    await waitForSendDone(p);
  }
  step("two sends of 40 000 sats without a password (80 000 of the budget)");

  // 80 000 + 40 000 would pass the 100 000 cap: the worker refuses it.
  await startSend(p, bAddr, 40_000);
  await p.getByRole("button", { name: /Potvrdit a odeslat/ }).click();
  await waitForText(p, /Denní limit plateb bez hesla je vyčerpaný/, 30_000);
  await assertStays(b.page, /Spendrr 80 000 sats/, 5_000);
  step("third send refused: the daily no-password limit is used up");

  // Now it needs the password; a wrong one still sends nothing.
  const pay = p.getByRole("button", { name: /Potvrdit a odeslat/ });
  await p.locator("input[type=password]").first().fill("wrong-password-123");
  await pay.click();
  await waitForText(p, /Nesprávné heslo/, 30_000);
  await assertStays(b.page, /Spendrr 80 000 sats/, 5_000);
  step("wrong password: still nothing sent");

  await p.locator("input[type=password]").first().fill(PASSWORD);
  await pay.click();
  await waitForBalance(b.page, /Spendrr 120 000 sats/);
  await p.getByRole("button", { name: /^Zpět$/ }).first().click().catch(() => {});
  await waitForBalance(p, /Spendrr 79 888 sats/);
  step("with the password the third send went through");
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
