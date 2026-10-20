// On-chain send from the Ark balance (offboard): 50 000 sats without a
// password, then 100 000 sats (the threshold) which needs one. The coins are
// checked on the chain and the sender's balance, not only on screen.
import assert from "node:assert/strict";
import {
  launch, newWallet, fundAndBoard, control, mine, triggerRound, onchainUtxoSats, startSend,
  balanceText, balanceSats, waitForText, waitForBalanceBetween, failOnPageProblems, debugDump, PASSWORD,
} from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// An offboard rides a round: keep mining and triggering until the chain shows it.
async function untilOnChain(address, sats, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await onchainUtxoSats(address)) >= sats) return;
    await triggerRound();
    await mine(1);
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`${address} never got ${sats} sats on chain (has ${await onchainUtxoSats(address)})`);
}

try {
  const w = await newWallet(browser, "W");
  const p = (current = w.page);
  await fundAndBoard(p, 200_000);
  step("boarded 199 888 sats");
  const dest = (await control("/get_new_address")).trim();

  await startSend(p, dest, 50_000);
  assert.match(await balanceText(p), /Typ On-chain/, "must be classified as an on-chain send");
  assert.doesNotMatch(await balanceText(p), /Potvrď heslo/, "50 000 sats is below the password threshold");
  await p.getByRole("button", { name: /Potvrdit a odeslat/ }).click();
  await untilOnChain(dest, 50_000);
  assert.equal(await onchainUtxoSats(dest), 50_000);
  await p.getByRole("button", { name: /^Zpět$/ }).first().click().catch(() => {});
  // The sender pays the fee on top: 199 888 - 50 000 - fee.
  const afterFirst = await waitForBalanceBetween(p, 147_000, 149_887);
  step(`50 000 sats on chain without a password, sender left with ${afterFirst}`);

  await startSend(p, dest, 100_000);
  assert.match(await balanceText(p), /Potvrď heslo pro odeslání velké částky/, "100 000 sats must ask for the password");
  const pay = p.getByRole("button", { name: /Potvrdit a odeslat/ });
  await p.locator("input[type=password]").first().fill("wrong-password-123");
  await pay.click();
  await waitForText(p, /Nesprávné heslo/, 30_000);
  // An offboard only shows on the chain once a round has run and blocks are
  // mined, so drive both before asserting that nothing was sent.
  for (let i = 0; i < 4; i++) {
    await triggerRound();
    await mine(1);
    await p.waitForTimeout(700);
  }
  assert.equal(await onchainUtxoSats(dest), 50_000, "a wrong password must not move funds");
  assert.equal(await balanceSats(p), afterFirst, "a wrong password must not change the balance");
  step("100 000 sats refused with a wrong password, nothing left the wallet");

  await p.locator("input[type=password]").first().fill(PASSWORD);
  await pay.click();
  await untilOnChain(dest, 150_000);
  assert.equal(await onchainUtxoSats(dest), 150_000);
  await p.getByRole("button", { name: /^Zpět$/ }).first().click().catch(() => {});
  // 199 888 - 150 000 - fees
  const left = await waitForBalanceBetween(p, 45_000, 49_887);
  step(`150 000 sats on chain in total, sender left with ${left}`);
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
