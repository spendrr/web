// Probe, not a test: does an unlock wait behind wallet calls that were still in flight when the wallet was locked?
// The worker queue is strict FIFO, closeWallet() queues "close" behind every earlier call and prepareSession queues
// behind that. Network requests to the Ark server and esplora are held on a gate to stand in for a slow sync.
//   sh e2e/run.sh e2e/probe-unlock-queue.mjs
import { launch, newWallet, lockWallet, PASSWORD, BASE } from "./lib.mjs";

const HOLD_MS = Number(process.env.PROBE_HOLD_MS ?? 8000);
const browser = await launch();
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

try {
  const { context, page } = await newWallet(browser, "probe");
  const baseOrigin = new URL(BASE).origin;

  // Only requests that go out BEFORE the lock are held: a fresh worker after a lock needs the network to open, and
  // holding that too would measure the gate, not the queue.
  let holding = false;
  let waiters = [];
  let held = 0;
  await context.route(
    (url) => url.origin !== baseOrigin && url.protocol.startsWith("http"),
    async (route) => {
      if (holding) {
        held++;
        await new Promise((r) => waiters.push(r));
      }
      await route.continue().catch(() => {});
    },
  );
  const closeGate = () => { holding = true; };
  const stopHoldingNew = () => { holding = false; };
  const openGate = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };

  const pw = page.locator("input[type=password]").first();
  async function unlockTimed() {
    await pw.fill(PASSWORD);
    const start = Date.now();
    await page.getByRole("button", { name: /^Odemknout$/ }).click();
    await page.getByRole("button", { name: /^Odeslat$/ }).waitFor({ timeout: 120_000 });
    return Date.now() - start;
  }

  for (let i = 1; i <= 2; i++) {
    await lockWallet(page);
    await pw.waitFor({ timeout: 15_000 });
    log(`baseline ${i}: unlock took ${await unlockTimed()} ms (nothing in flight)`);
    await page.getByRole("button", { name: /^Rozumím$/ }).click({ timeout: 2_000 }).catch(() => {});
  }

  // Slow case: a refresh is in flight (its requests are held), the wallet is locked, then unlocked while still held.
  closeGate();
  held = 0;
  await page.getByRole("button", { name: /^Obnovit$/ }).click({ timeout: 5_000 }).catch(() => log("no Obnovit button"));
  await page.waitForTimeout(1500);
  log(`in flight: ${held} request(s) held`);
  await lockWallet(page);
  await pw.waitFor({ timeout: 15_000 });
  stopHoldingNew();
  log("locked while held");
  await pw.fill(PASSWORD);
  const start = Date.now();
  await page.getByRole("button", { name: /^Odemknout$/ }).click();
  setTimeout(openGate, HOLD_MS);
  await page.getByRole("button", { name: /^Odeslat$/ }).waitFor({ timeout: 180_000 });
  const slow = Date.now() - start;
  log(`slow case: unlock took ${slow} ms; the held calls were released after ${HOLD_MS} ms (held ${held} in total)`);
  console.log(slow >= HOLD_MS ? "RESULT: unlock waited for the in-flight calls" : "RESULT: unlock did NOT wait for them");
} catch (e) {
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
