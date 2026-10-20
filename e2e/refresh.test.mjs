// Refresh engine (beta, V2): a coin that falls under 250 blocks to expiry is
// refreshed by itself in a round and gets a full lifetime again; the amount
// is kept. The test server's VTXO lifetime is 432 blocks, so mining 200 puts
// the coin at ~232. The engine ticks about once a minute while the app is open.
import assert from "node:assert/strict";
import {
  launch, newWallet, fundAndBoard, mine, triggerRound, balanceText, waitForText, failOnPageProblems, debugDump,
} from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
  const w = await newWallet(browser, "W", { v2: true });
  const p = (current = w.page);
  await fundAndBoard(p, 200_000);
  step("boarded 199 888 sats");

  await p.getByRole("button", { name: /^Nastavení$/ }).click();
  await p.getByRole("button", { name: /^Peněženka/ }).click();
  await p.getByRole("button", { name: /VTXO mince/ }).first().click();
  await waitForText(p, /Automatická obnova/, 30_000);
  let text = await balanceText(p);
  assert.match(text, /Příští obnova/, "a fresh coin must not be due");
  assert.match(text, /199 888 sats k dispozici · vyprší ~3 dny/);
  step("fresh coin: not due, expires in ~3 days");

  await mine(200);
  // The engine submits on its next tick; the round only runs when we trigger it.
  const submitted = Date.now() + 150_000;
  while (Date.now() < submitted && !/Právě probíhá/.test(await balanceText(p))) {
    await triggerRound().catch(() => {});
    await p.waitForTimeout(2_000);
  }
  text = await balanceText(p);
  assert.match(text, /Právě probíhá/, `engine never started a refresh: ${text.slice(0, 250)}`);
  step("coin under 250 blocks: refresh started");

  // The engine holds no lock after the submit; bark locks the coin itself
  // once the server issues the round (bark 0.7.1). A lock of ours left on it
  // would keep this from ever happening.
  const held = Date.now() + 120_000;
  while (Date.now() < held && !/199 888 sats zamčená|Příští obnova/.test(await balanceText(p))) {
    await triggerRound().catch(() => {});
    await p.waitForTimeout(2_000);
  }
  text = await balanceText(p);
  assert.match(text, /199 888 sats zamčená|Příští obnova/, `bark never took the coin into the round: ${text.slice(0, 250)}`);
  step(/zamčená/.test(text) ? "round issued: bark holds the coin" : "round issued and finished between two looks");

  const done = Date.now() + 120_000;
  while (Date.now() < done && !/Příští obnova/.test(await balanceText(p))) {
    await triggerRound().catch(() => {});
    await p.waitForTimeout(2_000);
  }
  text = await balanceText(p);
  assert.match(text, /Příští obnova/, `refresh never finished: ${text.slice(0, 250)}`);
  assert.match(text, /199 888 sats k dispozici · vyprší ~3 dny/, "amount kept, full lifetime again");
  step("refresh done: same amount, ~3 days again");
  // How the engine read the end: "Dokončeno" only if it saw bark hold the
  // coin first, else "Skončilo bez potvrzení" (both fine, logged for the record).
  step(/Dokončeno/.test(text) ? "engine logged it completed" : /Skončilo bez potvrzení/.test(text) ? "engine logged it ended unconfirmed" : "engine log row not visible");
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
