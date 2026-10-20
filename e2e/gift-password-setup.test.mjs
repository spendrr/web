// A password-protected gift wallet must have a confirmed password before funds
// arrive. Locked wallets must never disclose a legacy cached password.
import assert from "node:assert/strict";
import { launch, newWallet, fundAndBoard, lockWallet, waitForText, failOnPageProblems, debugDump, BASE } from "./lib.mjs";

const browser = await launch();
const PASSWORD = "kV7#mQ2$xL9!pR4zWn8@";
const PENDING_KEY = "btc-wallet-gift-pending-pw";
let current;

try {
  const sender = await newWallet(browser, "sender", { v2: true });
  current = sender.page;
  await fundAndBoard(sender.page, 200_000);
  await waitForText(sender.page, /Spendrr 199 888 sats/);
  await sender.page.getByRole("button", { name: /^Odeslat$/ }).first().click({ button: "right" });
  await sender.page.getByRole("menuitem", { name: /Poslat dárkem/ }).click();
  await sender.page.locator(".sht-amount-input").fill("3000");
  await sender.page.getByRole("button", { name: /^Vytvořit odkaz$/ }).click();
  await sender.page.getByRole("button", { name: /^Potvrdit$/ }).click();
  await waitForText(sender.page, /Dárek je připravený/, 120_000);
  await sender.page.locator(".shl-qr").click();
  const link = new URL(await sender.page.evaluate(() => navigator.clipboard.readText()));
  // Exercise the password-protected format used by older senders.
  const fragment = new URLSearchParams(link.hash.slice(1));
  fragment.delete("n");
  const giftUrl = `${BASE}/g#${fragment}`;

  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "cs-CZ" });
  const page = await context.newPage();
  current = page;
  await page.goto(giftUrl);
  await waitForText(page, /Nastav heslo/);
  const create = page.getByRole("button", { name: /^Vytvořit peněženku$/ });
  const password = page.getByPlaceholder("Heslo", { exact: true });
  const confirm = page.getByPlaceholder("Heslo znovu");
  assert.equal(await create.isEnabled(), false);
  await password.fill("password");
  await confirm.fill("password");
  assert.equal(await create.isEnabled(), false, "weak passwords cannot create the vault");
  await password.fill(PASSWORD);
  assert.equal(await create.isEnabled(), false, "both entries must match");
  assert.equal(await page.evaluate(() => localStorage.getItem("btc-wallet-vault")), null);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY), null);

  // A reload during setup has not created an inaccessible wallet or claimed the gift.
  await page.reload();
  await page.goto(giftUrl);
  await waitForText(page, /Nastav heslo/);
  assert.equal(await page.evaluate(() => localStorage.getItem("btc-wallet-vault")), null);
  await password.fill(PASSWORD);
  assert.equal(await create.isEnabled(), false, "confirmation cannot be empty");
  await confirm.fill(PASSWORD);
  await create.click();
  await waitForText(page, /Je tvůj/, 120_000);
  await page.getByRole("button", { name: /^Přijmout dárek$/ }).click();
  await waitForText(page, /Spendrr 3 000 sats/);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY), null);

  await lockWallet(page);
  await waitForText(page, /Odemknout/);
  assert.equal(await page.locator(".gpw-backdrop").count(), 0);
  const vault = await page.evaluate(() => localStorage.getItem("btc-wallet-vault"));
  // Simulate upgrading a wallet left by the old gift flow.
  await page.evaluate(({ key, password }) => localStorage.setItem(key, password), { key: PENDING_KEY, password: PASSWORD });
  await page.reload();
  await waitForText(page, /Odemknout/);
  assert.equal(await page.locator(".gpw-backdrop").count(), 0);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("btc-wallet-vault")), vault);
  await password.fill("wrong-password");
  await page.getByRole("button", { name: /^Odemknout$/ }).click();
  await waitForText(page, /Nesprávné heslo/);
  await password.fill(PASSWORD);
  await page.getByRole("button", { name: /^Odemknout$/ }).click();
  await waitForText(page, /Spendrr 3 000 sats/);
  failOnPageProblems();
} catch (e) {
  if (current) await debugDump(current);
  throw e;
} finally {
  await browser.close();
}
