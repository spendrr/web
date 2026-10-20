// The browser side of tipping a Lightning address: the same two same-origin
// calls any LNURL wallet makes (callback, then LUD-21 verify), driven from the
// public profile page so a visitor without a Lightning wallet at hand can still
// get an invoice for a chosen amount. Nothing here spends anything.

export const TIP_MIN_SATS = 100; // mirrors MIN_SENDABLE_MSAT in worker/lnurl.ts
export const TIP_MAX_SATS = 1_000_000; // mirrors MAX_SENDABLE_MSAT

export type TipInvoice = { pr: string; verify: string | null };
export type TipResult = { ok: true; invoice: TipInvoice } | { ok: false; reason: string | null };

/** A whole number of sats within what the callback accepts, else null. */
export function parseTipAmount(raw: string): number | null {
  const digits = raw.replace(/[\s ]/g, "");
  if (!/^[0-9]{1,7}$/.test(digits)) return null;
  const sats = Number(digits);
  return sats >= TIP_MIN_SATS && sats <= TIP_MAX_SATS ? sats : null;
}

/** Sats for a typed fiat amount ("5", "2,50") at a BTC price, or null when it is not a plain amount or lands outside the bounds. */
export function satsForFiat(raw: string, btcRate: number): number | null {
  const text = raw.replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!/^[0-9]{1,6}(\.[0-9]{1,2})?$/.test(text) || !(btcRate > 0)) return null;
  const sats = Math.round((Number(text) / btcRate) * 100_000_000);
  return sats >= TIP_MIN_SATS && sats <= TIP_MAX_SATS ? sats : null;
}

// The callback answers 200 with either {pr, verify} or {status:"ERROR", reason}.
// `reason` is the Worker's own Czech text, safe to show; anything else is null.
export function readTipResponse(json: unknown, origin: string): TipResult {
  if (typeof json !== "object" || json === null) return { ok: false, reason: null };
  const body = json as Record<string, unknown>;
  if (body.status === "ERROR") {
    return { ok: false, reason: typeof body.reason === "string" ? body.reason.slice(0, 120) : null };
  }
  const pr = body.pr;
  if (typeof pr !== "string" || !/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(pr)) return { ok: false, reason: null };
  // The verify URL is followed by polling, so only our own origin is accepted.
  let verify: string | null = null;
  if (typeof body.verify === "string") {
    try {
      const u = new URL(body.verify);
      if (u.origin === origin && u.pathname.startsWith("/api/lnurlp/verify/")) verify = u.toString();
    } catch {
      verify = null;
    }
  }
  return { ok: true, invoice: { pr, verify } };
}

export async function requestTipInvoice(name: string, sats: number, signal?: AbortSignal): Promise<TipResult> {
  try {
    const res = await fetch(`/api/lnurlp/${encodeURIComponent(name)}/cb?amount=${sats * 1000}`, { signal });
    return readTipResponse(await res.json(), window.location.origin);
  } catch {
    return { ok: false, reason: null };
  }
}

/** true = settled, false = not yet or unknown (a failed poll is just "not yet"). */
export async function tipSettled(verify: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(verify, { signal });
    const json = (await res.json()) as { settled?: unknown };
    return json.settled === true;
  } catch {
    return false;
  }
}
