// Helpers for the regtest E2E (see e2e/README.md). Drives the real UI of a
// `vite --mode regtest` build against the local Ark server + esplora started
// by the harness; nothing here talks to mainnet.
import { execSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { chromium } from "playwright";

export const BASE = process.env.WALLET_URL ?? "https://localhost:5190";
export const CONTROL = process.env.ARK_CONTROL_URL ?? "http://127.0.0.1:23782";
export const PASSWORD = "E2e-Test-Password-1!";

// Uncaught page errors and WASM panics must fail a test even when the UI still
// ends up showing the right number. Network noise (a 404 from the signet/regtest
// API stub, an unreachable server) is console output, not a pageerror, and is ignored.
const problems = [];
const PANIC = /memory access out of bounds|unreachable|RuntimeError|panicked at|out of bounds/i;
function watchPage(page, label) {
  page.on("pageerror", (e) => {
    problems.push(`[${label}] pageerror: ${String(e).slice(0, 300)}`);
    console.log(`[${label} pageerror]`, String(e).slice(0, 300));
  });
  page.on("console", (m) => {
    if (m.type() === "error" && PANIC.test(m.text())) problems.push(`[${label}] console: ${m.text().slice(0, 300)}`);
  });
}

export function failOnPageProblems() {
  if (problems.length) throw new Error(`page problems:\n${problems.join("\n")}`);
}

export async function launch() {
  return chromium.launch();
}

export async function newWallet(browser, label = "wallet", { v2 = false } = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "cs-CZ",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // The beta gate (refresh engine, ...) reads this at open, so it has to be set before the page runs.
  if (v2) await context.addInitScript(() => localStorage.setItem("btc-wallet-design-version", "v2"));
  const page = await context.newPage();
  watchPage(page, label);
  await page.goto(BASE);
  await page.getByRole("button", { name: /^Vytvořit peněženku/i }).click();
  const written = page.getByRole("button", { name: /Zapsal jsem si to/i });
  for (let i = 0; i < 6 && !(await written.isEnabled()); i++) {
    await page.getByRole("button", { name: /Zobrazit další/i }).click();
    await page.waitForTimeout(300);
  }
  const mnemonic = await readMnemonic(page);
  await written.click();
  await page.getByPlaceholder("Heslo", { exact: true }).fill(PASSWORD);
  await page.getByPlaceholder("Heslo znovu").fill(PASSWORD);
  await page.getByRole("button", { name: /^Vytvořit peněženku/i }).click();
  await page.getByRole("button", { name: /^Odeslat$/ }).waitFor({ timeout: 90_000 });
  await page.getByRole("button", { name: /^Rozumím$/ }).click({ timeout: 5_000 }).catch(() => {});
  return { context, page, mnemonic };
}

// The seed screen renders "1 word 2 word ..." once every word is revealed.
async function readMnemonic(page) {
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const seq = Array.from({ length: 12 }, (_, i) => `${i + 1} ([a-z]{3,8})`).join(" ");
  const words = (text.match(new RegExp(`(?:^| )${seq}(?= |$)`)) ?? []).slice(1);
  if (words.length !== 12) throw new Error(`could not read the 12 seed words: ${text.slice(0, 200)}`);
  return words;
}

export async function restoreWallet(browser, mnemonic, label = "restored") {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "cs-CZ",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  watchPage(page, label);
  await page.goto(BASE);
  await page.getByRole("button", { name: /^Mám seed phrase/i }).click();
  for (let i = 0; i < mnemonic.length; i++) await page.getByLabel(`Slovo ${i + 1}`, { exact: true }).fill(mnemonic[i]);
  await page.getByRole("button", { name: /^Pokračovat$/ }).click();
  await page.getByPlaceholder("Heslo", { exact: true }).fill(PASSWORD);
  await page.getByPlaceholder("Heslo znovu").fill(PASSWORD);
  await page.getByRole("button", { name: /^Vytvořit peněženku/i }).click();
  await page.getByRole("button", { name: /^Odeslat$/ }).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: /^Rozumím$/ }).click({ timeout: 5_000 }).catch(() => {});
  return { context, page };
}

// v2 hides the header lock button; the on-demand lock is a double tap on the
// area below the history card (Dashboard.tsx, handleLockGestureClick).
export async function lockWallet(page) {
  await page.locator(".lock-gesture-area").dblclick();
}

export async function control(path) {
  const res = await fetch(`${CONTROL}${path}`);
  if (!res.ok) throw new Error(`control ${path}: ${res.status}`);
  return res.text();
}

export const mine = (n = 1) => control(`/generate_blocks?n=${n}`);
export const triggerRound = () => control("/trigger_round");

// The receive sheet re-renders while the wallet syncs, which can detach a
// button mid-click; retry the whole sequence from the home screen.
async function copyAddress(page, tab) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.getByRole("button", { name: /^Přijmout$/ }).first().click({ timeout: 10_000 });
      if (tab) await page.getByRole("button", { name: tab }).click({ timeout: 10_000 });
      await page.getByRole("button", { name: /Kopírovat adresu/ }).first().click({ timeout: 10_000 });
      const addr = await page.evaluate(() => navigator.clipboard.readText());
      await page.getByRole("button", { name: /^Zpět$/ }).click({ timeout: 10_000 });
      return addr;
    } catch (e) {
      lastError = e;
      await page.getByRole("button", { name: /^Zpět$/ }).click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
  throw lastError;
}

export const onchainAddress = (page) => copyAddress(page, /^On-chain$/);
export const arkAddress = (page) => copyAddress(page, /^Ark adresa$/);

export async function balanceText(page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

export async function waitForText(page, re, timeout = 60_000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText.replace(/\s+/g, " ")), re.source, { timeout });
}

// Fund the wallet on-chain, accept the incoming deposit and settle the board.
const T0 = Date.now();
const trace = (m) => { if (process.env.E2E_TRACE) console.log(`  trace +${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`); };

export async function fundAndBoard(page, sats) {
  trace("fundAndBoard start");
  const addr = await onchainAddress(page);
  trace("got address");
  await control(`/fund_address?address=${addr}&sats=${sats}`);
  trace("funded");
  const refresh = () => page.getByRole("button", { name: /^Obnovit$/ }).click().catch(() => {});
  const incomingBy = Date.now() + 45_000;
  while (Date.now() < incomingBy) {
    await refresh();
    if (await page.getByText(/Příchozí onchain platba/).count()) break;
    await page.waitForTimeout(500);
  }
  trace("incoming seen");
  await page.getByRole("button", { name: /^Přijmout$/ }).first().click();
  await page.getByRole("button", { name: /Potvrdit a přijmout/ }).click();
  trace("accepted");
  // The board transaction is broadcast asynchronously: mining before it
  // reached the mempool confirms nothing, so wait for it to show up first.
  await waitForText(page, /Vklad na Ark/, 60_000);
  trace("board tx visible");
  const boardedBy = Date.now() + 60_000;
  for (let i = 0; Date.now() < boardedBy; i++) {
    await mine(i === 0 ? 3 : 1);
    await triggerRound();
    await refresh();
    await page.waitForTimeout(600);
    trace(`board poll ${i}`);
    if (/Potvrzeno/.test(await balanceText(page))) {
      trace("confirmed");
      await page.getByRole("button", { name: /^Rozumím$/ }).click({ timeout: 3_000 }).catch(() => {});
      return;
    }
  }
  throw new Error("board did not confirm");
}

// On failure: what the page actually shows, so a copy or layout change is diagnosable.
export async function debugDump(page, label = "page") {
  try {
    const info = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => {
        const hidden = b.closest("[aria-hidden=true], [inert]") ? "HIDDEN " : "";
        return `${hidden}${b.getAttribute("aria-label") ?? b.innerText.trim().slice(0, 40)}`;
      }),
    );
    console.log(`[${label}] buttons:`, JSON.stringify(info));
    const lock = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Zamknout"]');
      if (!el) return "no lock el";
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return JSON.stringify({ rect: [r.x, r.y, r.width, r.height], display: cs.display, vis: cs.visibility, op: cs.opacity, pe: cs.pointerEvents, topEl: top && (top.tagName + "." + top.className) });
    });
    console.log(`[${label}] lock:`, lock);
    console.log(`[${label}] text:`, (await balanceText(page)).slice(0, 300));
    await page.screenshot({ path: `/tmp/e2e-${label}.png` });
  } catch (e) {
    console.log(`[${label}] dump failed`, String(e).slice(0, 100));
  }
}

// Fill the send form for an Ark address and stop on the confirmation screen.
export async function startSend(page, address, sats) {
  await page.getByRole("button", { name: /^Odeslat$/ }).click();
  await page.getByPlaceholder(/ark1/).fill(address);
  await page.locator("input[type=number]").fill(String(sats));
  await page.getByRole("button", { name: /^Odeslat$/ }).click();
  await page.getByRole("button", { name: /Potvrdit a odeslat|Odemknout a zaplatit/ }).first().waitFor({ timeout: 15_000 });
}

// A successful send closes the send sheet (onSendComplete); the island toast
// is the only success note, and it goes away by itself.
export async function waitForSendDone(page, timeout = 30_000) {
  await page.getByRole("button", { name: /Potvrdit a odeslat/ }).waitFor({ state: "detached", timeout });
}

// Poll B until its balance text matches, refreshing as the app would.
export async function waitForBalance(page, re, timeout = 60_000) {
  const end = Date.now() + timeout;
  let text = "";
  while (Date.now() < end) {
    await page.getByRole("button", { name: /^Obnovit$/ }).click().catch(() => {});
    text = await balanceText(page);
    if (re.test(text)) return text;
    await page.waitForTimeout(700);
  }
  throw new Error(`balance never matched ${re}: ${text.slice(0, 200)}`);
}

// Mine one block at a time until the page shows `re` (the app only moves an
// exit forward when it sees a new block or its own timer ticks).
export async function mineUntil(page, re, { max = 80, settleMs = 1_000, poke, mineFn = mine } = {}) {
  let text = "";
  for (let i = 0; i < max; i++) {
    text = await balanceText(page);
    if (re.test(text)) return text;
    await mineFn(1);
    if (poke) await poke();
    await page.waitForTimeout(settleMs);
  }
  text = await balanceText(page);
  if (re.test(text)) return text;
  throw new Error(`never saw ${re} after ${max} blocks: ${text.slice(-300)}`);
}

export async function onchainUtxoSats(address) {
  const utxos = JSON.parse(await control(`/esplora/address/${address}/utxo`));
  return utxos.reduce((sum, u) => sum + u.value, 0);
}

// The number in the headline ("Spendrr 74 888 sats").
export async function balanceSats(page) {
  const m = (await balanceText(page)).match(/Spendrr ([\d ]+) sats/);
  return m ? Number(m[1].replace(/\s/g, "")) : null;
}

export async function waitForBalanceBetween(page, lo, hi, timeout = 60_000) {
  const end = Date.now() + timeout;
  let sats = null;
  while (Date.now() < end) {
    await page.getByRole("button", { name: /^Obnovit$/ }).click().catch(() => {});
    sats = await balanceSats(page);
    if (sats !== null && sats >= lo && sats <= hi) return sats;
    await page.waitForTimeout(700);
  }
  throw new Error(`balance ${sats} never reached ${lo}..${hi}`);
}

// A negative check: for `ms` the page (refreshing as the app would) must keep
// showing `re`. A single read right after the event proves nothing, because the
// page may simply not have noticed the change yet.
export async function assertStays(page, re, ms = 4_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.getByRole("button", { name: /^Obnovit$/ }).click().catch(() => {});
    const text = await balanceText(page);
    if (!re.test(text)) throw new Error(`expected ${re} to hold for ${ms} ms, but the page shows: ${text.slice(0, 200)}`);
    await page.waitForTimeout(700);
  }
}

// Direct access to the central bitcoind. The control server's /generate_blocks
// waits for the Ark server, so it hangs once that is stopped (and is slower).
let btcCli;
// run.sh exports E2E_WORK (this environment's temp dir, part of every daemon's
// command line), so several environments can run side by side. Only its unique
// last component is used: the daemons report the resolved path (/private/var/...)
// while mktemp returns /var/....
const scope = () => (process.env.E2E_WORK ? basename(process.env.E2E_WORK) : "");
function bitcoinCli() {
  if (btcCli) return btcCli;
  const line = execSync(`ps -ax -o args= | grep 'disablewallet=0' | grep -F -- '${scope()}' | grep -o 'rpcport=[0-9][0-9]*' | head -1`).toString().trim();
  const port = line.split("=")[1];
  if (!port) throw new Error("central bitcoind not found");
  const dir = process.env.BITCOIND_EXEC ? dirname(process.env.BITCOIND_EXEC) : "/opt/homebrew/bin";
  btcCli = `${dir}/bitcoin-cli -regtest -rpcport=${port} -rpcuser=test -rpcpassword=test -rpcwallet=central`;
  return btcCli;
}

export async function mineDirect(n = 1) {
  const address = execSync(`${bitcoinCli()} getnewaddress`).toString().trim();
  execSync(`${bitcoinCli()} generatetoaddress ${n} ${address}`);
}

// Stops the Ark server for good (the harness owns it; run.sh starts a fresh
// environment per test file) and checks that it really is unreachable.
export async function killArkServer() {
  // Only this environment's server: its command line carries the work dir.
  const pattern = `captaind start --config .*${scope()}`;
  const alive = () => execSync(`pgrep -f -- '${pattern}' || true`).toString().trim();
  if (!scope()) throw new Error("E2E_WORK is not set; run through e2e/run.sh");
  execSync(`pkill -f -- '${pattern}' || true`);
  for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive()) throw new Error("captaind is still running");
  if (process.env.REGTEST_ARK_URL) {
    const reachable = await fetch(`${process.env.REGTEST_ARK_URL}/bark_server.ArkService/GetArkInfo`, {
      method: "POST",
      headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1" },
      body: new Uint8Array(5),
      signal: AbortSignal.timeout(3_000),
    }).then(() => true, () => false);
    if (reachable) throw new Error("the Ark server still answers after it was stopped");
  }
}
