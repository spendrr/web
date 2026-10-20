// Nouzový exit end to end, with the Ark server STOPPED: start (wrong password
// first), every tree level and the timelock run on mined blocks, claim to an
// external address, check the coins on the chain. The point of an emergency
// exit is that it works without the server, so a run against a live one would
// prove nothing. Needs on-chain sats left over for the CPFP fees.
import assert from "node:assert/strict";
import {
  launch, newWallet, fundAndBoard, onchainAddress, control, mineDirect, mineUntil, onchainUtxoSats,
  killArkServer, failOnPageProblems, waitForText, debugDump, PASSWORD,
} from "./lib.mjs";

const browser = await launch();
let current;
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
  const w = await newWallet(browser, "W");
  const p = (current = w.page);
  await fundAndBoard(p, 200_000);
  // Confirmed on-chain sats that stay unboarded: the exit pays its fees from them.
  await control(`/fund_address?address=${await onchainAddress(p)}&sats=60000`);
  step("boarded 199 888 sats, 60 000 on-chain for fees");

  const dest = (await control("/get_new_address")).trim();
  // From here on nothing may need the server; mining goes straight to bitcoind
  // because the control server's /generate_blocks waits for it.
  await killArkServer();
  step("Ark server stopped");
  await p.getByRole("button", { name: /^Nastavení$/ }).click();
  await p.getByRole("button", { name: /Nebezpečná zóna/ }).click();
  await p.getByRole("button", { name: /Nouzový exit z Ark/ }).click();
  const address = p.getByPlaceholder(/bitcoinová adresa/);
  const password = p.locator("input[type=password]").first();
  const start = p.getByRole("button", { name: /Spustit nouzový exit/ });

  await address.fill(dest);
  await password.fill("wrong-password-123");
  await start.click();
  await waitForText(p, /Nesprávné heslo/, 30_000);
  assert.ok(await start.isVisible(), "a wrong password must not start the exit");
  step("wrong password refused, nothing started");

  await password.fill(PASSWORD);
  await start.click();
  // "Zkontrolovat teď" makes the app read the chain now instead of on its own interval.
  const poke = () => p.getByRole("button", { name: /Zkontrolovat teď/ }).click({ timeout: 2_000 }).catch(() => {});
  await waitForText(p, /Posílám na blockchain|Potvrzeno \d+ z \d+ transakc/, 60_000);
  step("exit started");

  // The app only samples the exit between ticks, so an intermediate state
  // (tree level n, timelock) can be skipped; only the end state is asserted.
  await mineUntil(p, /Poslat [\d ]+ sats na moji adresu/, { poke, mineFn: mineDirect });
  step("claimable after the tree and the timelock");
  // The claim spends the exit outputs, so it needs the password like the start does.
  await p.locator("input[type=password]").first().fill(PASSWORD);
  await p.getByRole("button", { name: /Poslat [\d ]+ sats na moji adresu/ }).click();
  await mineUntil(p, /Nouzový exit dokončen/, { max: 15, poke, mineFn: mineDirect });
  step("exit complete in the app");

  const onchain = await onchainUtxoSats(dest);
  assert.ok(onchain > 199_000 && onchain < 199_888, `destination got ${onchain} sats`);
  step(`destination holds ${onchain} sats on chain`);
  failOnPageProblems();
  console.log("PASS");
} catch (e) {
  console.error("FAIL", e);
  if (current) await debugDump(current, "fail");
  process.exitCode = 1;
} finally {
  await browser.close();
}
