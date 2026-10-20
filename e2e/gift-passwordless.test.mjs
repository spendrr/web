// Gift made by a V2 sender -> the recipient's new wallet has no password. The next open asks for one and shows the
// seed; afterwards the wallet is an ordinary password wallet. A larger payment (here: the event the spend flows raise)
// asks for the same sheet in the first session.
import assert from "node:assert/strict";
import { launch, newWallet, fundAndBoard, waitForText, balanceText, failOnPageProblems, debugDump, BASE } from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const PW = "kV7#mQ2$xL9!pR4zWn8@";

async function createGiftLink(page, sats) {
  await page.getByRole("button", { name: /^Odeslat$/ }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Poslat dárkem/ }).click();
  await page.locator(".sht-amount-input").fill(String(sats));
  await page.getByRole("button", { name: /^Vytvořit odkaz$/ }).click();
  await page.getByRole("button", { name: /^Potvrdit$/ }).click();
  await waitForText(page, /Dárek je připravený/, 120_000);
  await page.locator(".shl-qr").click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /\/g#v=1&g=.*&n=1/, "a V2 sender's link asks for a passwordless wallet");
  await page.getByRole("button", { name: /^Hotovo$/ }).click();
  return link.replace(/^https?:\/\/[^/]+/, BASE);
}

async function claim(link, label) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "cs-CZ" });
  const page = await ctx.newPage();
  await page.goto(link);
  await page.getByRole("button", { name: /^Přijmout dárek$/ }).click();
  await waitForText(page, /\+3 000 sats/, 120_000);
  step(`${label} claimed`);
  return { ctx, page };
}

try {
  const a = await newWallet(browser, "A", { v2: true });
  current = a.page;
  await fundAndBoard(a.page, 200_000);
  await waitForText(a.page, /Spendrr 199 888 sats/);
  const link1 = await createGiftLink(a.page, 3_000);
  const link2 = await createGiftLink(a.page, 3_000);
  step("two gifts created");

  // 1. Claim, then restart.
  const b = await claim(link1, "B");
  current = b.page;
  const text = await balanceText(b.page);
  assert.doesNotMatch(text, /Ulož si heslo k peněžence/, "no generated password is shown");
  const stored = await b.page.evaluate(() => ({
    pw: localStorage.getItem("btc-wallet-vault"),
    device: localStorage.getItem("btc-wallet-device-vault"),
  }));
  assert.equal(stored.pw, null, "no password vault yet");
  assert.ok(stored.device, "a device vault holds the seed");
  step("B has a passwordless wallet");

  await b.page.reload();
  await waitForText(b.page, /Tahle peněženka vznikla z dárku/, 120_000);
  step("restart opened the wallet by itself and asked for a password");
  await b.page.getByPlaceholder("Heslo (min. 8 znaků)").fill(PW);
  await b.page.getByPlaceholder("Heslo znovu").fill(PW);
  await b.page.getByRole("button", { name: /^Pokračovat$/ }).click();
  await waitForText(b.page, /Zapiš si seed/, 60_000);
  const words = await b.page.locator(".sht-sheet .sht-stack div[style*='display: flex']").allInnerTexts();
  assert.ok(words.length >= 12, `the seed words are shown (${words.length})`);
  await b.page.getByRole("button", { name: /^Hotovo$/ }).click().catch(() => {});
  await b.page.locator(".sht-sheet input[type=checkbox]").check();
  await b.page.getByRole("button", { name: /^Hotovo$/ }).click();
  await waitForText(b.page, /Spendrr 3 000 sats/, 30_000);
  const after = await b.page.evaluate(() => ({
    pw: !!localStorage.getItem("btc-wallet-vault"),
    device: localStorage.getItem("btc-wallet-device-vault"),
  }));
  assert.equal(after.pw, true, "now a password vault");
  assert.equal(after.device, null, "the device vault is gone");
  step("B set a password and saw the seed");

  await b.page.reload();
  await b.page.locator("input[type=password]").first().fill(PW);
  await b.page.getByRole("button", { name: /Odemknout/ }).first().click();
  await waitForText(b.page, /Spendrr 3 000 sats/, 120_000);
  step("B unlocks with the password");

  // 2. First session, a flow that needs a password asks for the sheet.
  const c = await claim(link2, "C");
  current = c.page;
  await c.page.evaluate(() => window.dispatchEvent(new Event("spendrr:password-setup")));
  await waitForText(c.page, /Větší platby se potvrzují heslem/, 30_000);
  step("a spend flow raises the sheet in the first session");

  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
