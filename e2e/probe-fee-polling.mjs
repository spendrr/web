// Diagnostic: how often the Settings fee widget calls the Worker. The regtest
// build has no Worker, so /api/fees/* is answered here and counted.
//   sh e2e/run.sh e2e/probe-fee-polling.mjs
import { launch, newWallet } from "./lib.mjs";

const browser = await launch();
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
let fees = 0;
let tip = 0;
try {
  const w = await newWallet(browser, "W", { v2: true });
  const p = w.page;
  await w.context.route("**/api/fees/recommended", (r) => (fees++, r.fulfill({ json: { fastestFee: 3, halfHourFee: 2, economyFee: 1 } })));
  await w.context.route("**/api/fees/tip", (r) => (tip++, r.fulfill({ json: { height: 100, timestamp: Math.floor(Date.now() / 1000), tx_count: 10, weight: 1000 } })));
  await p.getByRole("button", { name: /^Nastavení$/ }).click();
  await p.getByText("Poplatky v síti").first().waitFor({ timeout: 15_000 });
  await p.waitForTimeout(2_000);
  log(`opened: fees ${fees}, tip ${tip} (expect 1, 1)`);
  await p.waitForTimeout(40_000);
  log(`+40 s: fees ${fees}, tip ${tip} (old code: 3+; new: 1)`);
  await p.waitForTimeout(25_000);
  log(`+65 s: fees ${fees}, tip ${tip} (new: 2)`);
  await p.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenBase = fees;
  await p.waitForTimeout(65_000);
  log(`hidden 65 s: fees +${fees - hiddenBase} (expect 0)`);
  await p.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await p.waitForTimeout(2_000);
  log(`visible again: fees +${fees - hiddenBase} (expect 1)`);
} catch (e) {
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
