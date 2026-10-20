// Payments from a wallet restored out of its seed: small (no password), large
// (password required by the spend policy, wrong password refused).
import assert from "node:assert/strict";
import {
  launch, newWallet, restoreWallet, fundAndBoard, arkAddress, startSend, waitForSendDone, waitForBalance,
  waitForText, balanceText, assertStays, failOnPageProblems, debugDump, PASSWORD,
} from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
  const a = await newWallet(browser, "A");
  const b = await newWallet(browser, "B");
  await fundAndBoard(a.page, 200_000);
  const bAddr = await arkAddress(b.page);
  step("A boarded 199 888 sats");

  // From here on only the restored wallet spends. A is closed first: two live
  // instances of one seed never happen (one open wallet per profile) and A's
  // own background work could interfere.
  await a.context.close();
  const r = await restoreWallet(browser, a.mnemonic, "R");
  current = r.page;
  await waitForBalance(r.page, /Spendrr 199 888 sats/);
  step("R restored");

  // Small send: below the threshold, no password.
  await startSend(r.page, bAddr, 5_000);
  await r.page.getByRole("button", { name: /Potvrdit a odeslat/ }).click();
  await waitForBalance(b.page, /Spendrr 5 000 sats/);
  await waitForSendDone(r.page);
  await waitForBalance(r.page, /Spendrr 194 888 sats/);
  step("R sent 5 000 sats without a password");

  // Large send: at or above 100 000 sats a password is required.
  await startSend(r.page, bAddr, 120_000);
  assert.match(await balanceText(r.page), /Potvrď heslo pro odeslání velké částky/, "large send must ask for the password");
  const pay = r.page.getByRole("button", { name: /Potvrdit a odeslat/ });
  await r.page.locator("input[type=password]").first().fill("wrong-password-123");
  await pay.click();
  await waitForText(r.page, /Nesprávné heslo/, 30_000);
  // An Ark payment settles in a second, so give B (and R) time to show it
  // if it had gone out; a single read right after the error proves nothing.
  await assertStays(b.page, /Spendrr 5 000 sats/, 5_000);
  await assertStays(r.page, /Spendrr 194 888 sats/, 1_500);
  step("large send refused with a wrong password");

  await r.page.locator("input[type=password]").first().fill(PASSWORD);
  await pay.click();
  await waitForBalance(b.page, /Spendrr 125 000 sats/);
  await waitForBalance(r.page, /Spendrr 74 888 sats/);
  step("large send went through with the password");
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
