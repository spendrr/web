// Whether <name>@spendrr.app can take payments right now (worker/lnAddrHealth.ts).
// Remembered for a few minutes so opening the receive screen again costs no
// request. Anything but a clear "no" counts as up: a flaky request must not
// take the address off the screen, and a payer who hits a real outage gets
// the callback's own error, nothing is lost.

const REMEMBER_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4000;

let remembered: { at: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

export function lnAddressServiceOk(now: number = Date.now()): Promise<boolean> {
  if (remembered && now - remembered.at < REMEMBER_MS) return Promise.resolve(remembered.ok);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("/api/lnaddr/health", { signal: controller.signal });
      const json = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      const ok = !(res.ok && json?.ok === false);
      remembered = { at: Date.now(), ok };
      return ok;
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();
  return inFlight;
}

// The last answer, for a first render that should not wait for the request.
export function lastLnAddressServiceOk(): boolean {
  return remembered?.ok ?? true;
}
