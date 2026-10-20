// Regtest smoke test: two fresh wallets, board, Ark payment A -> B.
// Needs the harness (e2e/README.md) and `vite --mode regtest` running.
import assert from "node:assert/strict";
import { launch, newWallet, fundAndBoard, arkAddress, balanceText, waitForText, failOnPageProblems } from "./lib.mjs";

const SEND = 5000;

const browser = await launch();
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
try {
  const a = await newWallet(browser, "A");
  const b = await newWallet(browser, "B");
  step("wallets created");

  await fundAndBoard(a.page, 200_000);
  await waitForText(a.page, /Spendrr 199 888 sats/);
  step("A boarded 199 888 sats");

  const bAddr = await arkAddress(b.page);
  assert.match(bAddr, /^tark1/);

  const p = a.page;
  await p.getByRole("button", { name: /^Odeslat$/ }).click();
  await p.getByPlaceholder(/ark1/).fill(bAddr);
  await p.locator("input[type=number]").fill(String(SEND));
  await p.getByRole("button", { name: /^Odeslat$/ }).click();
  await p.getByRole("button", { name: /Potvrdit a odeslat/ }).click();
  step("A sent 5 000 sats");

  const back = p.getByRole("button", { name: /^Zpět$/ });
  if (await back.count()) await back.first().click().catch(() => {});

  const refreshB = async () => b.page.getByRole("button", { name: /^Obnovit$/ }).click().catch(() => {});
  let bText = "";
  for (let i = 0; i < 90; i++) {
    await refreshB();
    bText = await balanceText(b.page);
    if (/Spendrr 5 000 sats/.test(bText)) break;
    await b.page.waitForTimeout(700);
  }
  assert.match(bText, /Spendrr 5 000 sats/, `B never saw the payment: ${bText.slice(0, 200)}`);
  step("B received 5 000 sats");

  await waitForText(a.page, /Spendrr 194 888 sats/, 30_000);
  step("A balance reduced by 5 000 sats");
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
