// Whether <name>@spendrr.app can take payments right now (worker/lnAddrHealth.ts),
// read from a public file the Worker's cron keeps (no Worker request).
// Remembered for a few minutes so opening the receive screen again costs no
// request. Anything but a clear "no" counts as up: a flaky request must not
// take the address off the screen, and a payer who hits a real outage gets
// the callback's own error, nothing is lost.

import { LNADDR_MAX_AGE_MS, PUBLIC_LNADDR_URL, readPublicCopy } from "../publicData";

const REMEMBER_MS = 5 * 60 * 1000;

let remembered: { at: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

export function lnAddressServiceOk(now: number = Date.now()): Promise<boolean> {
  if (remembered && now - remembered.at < REMEMBER_MS) return Promise.resolve(remembered.ok);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // The public copy (no Worker request, worker/index.ts publishes it). Missing
      // or old counts as up, like any other doubt: the payer's own callback
      // error is the fallback.
      const data = await readPublicCopy(PUBLIC_LNADDR_URL, LNADDR_MAX_AGE_MS);
      const ok = data === null ? true : data.ok !== false;
      remembered = { at: Date.now(), ok };
      return ok;
    } catch {
      return true;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// The last answer, for a first render that should not wait for the request.
export function lastLnAddressServiceOk(): boolean {
  return remembered?.ok ?? true;
}
