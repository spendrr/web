// Live on-chain fee estimates for Settings' "Poplatky v síti" widget.
// Best-effort only, same spirit as price.ts — a failed fetch just leaves the
// widget showing its error state, nothing else in the app depends on this.
//
// Deliberately independent of wallet.onchainWallet.feeRates(): that call
// goes through the wallet Worker's single FIFO queue (see ARCHITECTURE.md), which
// Dashboard's own background refresh cycle (8s Ark watch, 30s onchain poll)
// keeps busy even while Settings is open — a fee lookup queued behind those
// can lose the race against its own timeout even though the upstream API
// itself answers instantly. Fetching straight from the same-origin proxy
// below never touches that queue at all.
const FEES_URL = "/api/fees/recommended";
const CACHE_MS = 15_000;
// Last successful result, kept across widget remounts *and* full reloads so
// the Settings widget can render real numbers immediately instead of a "…"
// placeholder that then pops. Fee estimates are public, non-sensitive data.
const LAST_KNOWN_KEY = "btc-wallet-fees-last";

export interface OnchainFees {
  low: number;
  medium: number;
  high: number;
}

let cached: { fees: OnchainFees; at: number } | null = null;
let inFlight: Promise<OnchainFees> | null = null;

function isOnchainFees(v: unknown): v is OnchainFees {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return typeof f.low === "number" && typeof f.medium === "number" && typeof f.high === "number";
}

// Best-effort persisted snapshot of the most recent successful fetch — never
// expires (unlike `cached`'s 15s TTL); it's only a seed for the first paint,
// replaced by a live value moments later. Reads defensively: private-mode /
// cleared storage / a stale shape all just yield null.
export function getLastKnownFees(): OnchainFees | null {
  if (cached) return cached.fees;
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_KNOWN_KEY) ?? "null");
    return isOnchainFees(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchOnchainFees(): Promise<OnchainFees> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.fees;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(FEES_URL);
      if (!res.ok) throw new Error("Poplatky se nepodařilo načíst.");
      const data = (await res.json()) as {
        fastestFee?: number;
        halfHourFee?: number;
        economyFee?: number;
      };
      const { fastestFee, halfHourFee, economyFee } = data;
      if (typeof fastestFee !== "number" || typeof halfHourFee !== "number" || typeof economyFee !== "number") {
        throw new Error("Neplatná odpověď poplatků.");
      }
      const fees: OnchainFees = { low: economyFee, medium: halfHourFee, high: fastestFee };
      cached = { fees, at: Date.now() };
      try {
        localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(fees));
      } catch {
        // storage unavailable (private mode, quota) — in-memory cache still works
      }
      return fees;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Last mined block, for the v2 widget's "last block" column. Same caching and
// last-known seeding as the fees above; /api/fees/tip (worker/index.ts) trims
// the upstream esplora list down to these four fields.
const TIP_URL = "/api/fees/tip";
const LAST_KNOWN_TIP_KEY = "btc-wallet-tip-block-last";

export interface TipBlock {
  height: number;
  // Block header time, unix seconds.
  timestamp: number;
  txCount: number;
  weight: number;
}

let tipCached: { tip: TipBlock; at: number } | null = null;
let tipInFlight: Promise<TipBlock> | null = null;

function isTipBlock(v: unknown): v is TipBlock {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.height === "number" &&
    typeof b.timestamp === "number" &&
    typeof b.txCount === "number" &&
    typeof b.weight === "number"
  );
}

export function getLastKnownTipBlock(): TipBlock | null {
  if (tipCached) return tipCached.tip;
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_KNOWN_TIP_KEY) ?? "null");
    return isTipBlock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchTipBlock(): Promise<TipBlock> {
  if (tipCached && Date.now() - tipCached.at < CACHE_MS) return tipCached.tip;
  if (tipInFlight) return tipInFlight;
  tipInFlight = (async () => {
    try {
      const res = await fetch(TIP_URL);
      if (!res.ok) throw new Error("Poslední blok se nepodařilo načíst.");
      const data = (await res.json()) as { height?: unknown; timestamp?: unknown; tx_count?: unknown; weight?: unknown };
      const tip = { height: data.height, timestamp: data.timestamp, txCount: data.tx_count, weight: data.weight };
      if (!isTipBlock(tip)) throw new Error("Neplatná odpověď bloku.");
      tipCached = { tip, at: Date.now() };
      try {
        localStorage.setItem(LAST_KNOWN_TIP_KEY, JSON.stringify(tip));
      } catch {
        // storage unavailable, in-memory cache still works
      }
      return tip;
    } finally {
      tipInFlight = null;
    }
  })();
  return tipInFlight;
}
