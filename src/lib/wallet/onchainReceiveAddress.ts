// Keeps the onchain receive address stable across restarts until it's
// actually been paid, instead of Dashboard.tsx's ReceivePanel deriving a
// brand new one every time its `onchainAddress` state happens to be null
// (which used to include every app restart, since that state lived only in
// memory). `OnchainWallet.newAddress()` has no "peek" or "is this used yet"
// counterpart (unlike the Ark side's `peekAddress(0)`), so there's no way to
// ask the SDK "give me the address you'd give me again, if it's still
// unused" — this module makes that guarantee itself, entirely client-side.
//
// The approach: whenever a fresh address is handed out, snapshot every
// onchain UTXO outpoint the wallet already knows about ("baseline") and
// persist both alongside the address. From then on, an address is "used" the
// moment any outpoint shows up that wasn't in that baseline — which is true
// regardless of amount, and regardless of *other* onchain activity (e.g. a
// send's own change output creates a new outpoint too, and would trigger an
// early rotation here) — a false positive here only means handing out a new
// address a bit sooner than strictly necessary, never treating a paid
// address as still fresh, and never any risk to funds either way: an old,
// no-longer-displayed address stays fully spendable by this same wallet
// forever, so a late payment to it is never lost.
import type { OnchainUtxo } from "@secondts/bark";

const STORAGE_KEY = "btc-wallet-onchain-receive-address";
// Same literal App.tsx sets once its background initialScan() (run once per
// wallet, to discover onchain history from before this browser instance
// existed) resolves — duplicated rather than imported, matching this
// codebase's existing pattern for small shared storage keys (see
// LAST_SEEN_MOVEMENT_KEY in Dashboard.tsx/resetLocalState.ts).
const ONCHAIN_SCANNED_KEY = "btc-wallet-onchain-scanned";

// False for the (at most once per wallet) window between unlock and that
// scan completing. During that window, any pre-existing onchain UTXO it
// discovers would look identical to hasNewOutpoint() as a brand new payment
// — see evaluateReceiveAddressUsage() for how that's avoided.
export function isInitialOnchainScanDone(): boolean {
  try {
    return localStorage.getItem(ONCHAIN_SCANNED_KEY) === "1";
  } catch {
    // Inaccessible storage: same conservative fallback as everywhere else
    // here (nothing cached), so a caller doesn't rotate a fresh address for
    // no reason.
    return true;
  }
}

// What Dashboard.tsx's onchain poll should do with a freshly-fetched
// `utxos`, given the `baseline` currently on file for the cached receive
// address: rotate it (`rotate: true`), or keep it — either way, persist the
// returned `baseline` for next time.
//
// While the wallet's one-time initialScan() hasn't finished yet (see
// isInitialOnchainScanDone()), this never rotates and instead keeps widening
// the baseline to whatever `utxos` currently is — a historical UTXO that
// scan is still in the middle of discovering is otherwise indistinguishable
// from a brand new payment to hasNewOutpoint(), which would otherwise rotate
// a receive address the user may have just shared, moments after handing it
// out, for having "received" a payment from years before this browser ever
// saw the wallet. Once the scan is done, this defers to hasNewOutpoint() as
// documented there.
export function evaluateReceiveAddressUsage(
  utxos: OnchainUtxo[],
  baseline: string[],
): { rotate: boolean; baseline: string[] } {
  if (!isInitialOnchainScanDone()) {
    return { rotate: false, baseline: snapshotOutpoints(utxos) };
  }
  return { rotate: hasNewOutpoint(utxos, baseline), baseline };
}

interface StoredReceiveAddress {
  address: string;
  baseline: string[];
}

function outpointKey(utxo: OnchainUtxo): string | null {
  return utxo.type === "local" ? `${utxo.outpoint.txid}:${utxo.outpoint.vout}` : null;
}

export function snapshotOutpoints(utxos: OnchainUtxo[]): string[] {
  const keys: string[] = [];
  for (const utxo of utxos) {
    const key = outpointKey(utxo);
    if (key !== null) keys.push(key);
  }
  return keys;
}

// True once any outpoint in `utxos` is absent from `baseline` — see the
// module comment above for why that's the right definition of "used".
export function hasNewOutpoint(utxos: OnchainUtxo[], baseline: string[]): boolean {
  const known = new Set(baseline);
  for (const utxo of utxos) {
    const key = outpointKey(utxo);
    if (key !== null && !known.has(key)) return true;
  }
  return false;
}

export function loadStoredReceiveAddress(): StoredReceiveAddress | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { address?: unknown }).address === "string" &&
      Array.isArray((parsed as { baseline?: unknown }).baseline) &&
      (parsed as { baseline: unknown[] }).baseline.every((k) => typeof k === "string")
    ) {
      return parsed as StoredReceiveAddress;
    }
    return null;
  } catch {
    // Corrupt or inaccessible (private-mode storage, quota) — treat as if
    // nothing were cached, same as a first-ever open.
    return null;
  }
}

export function saveReceiveAddress(address: string, baseline: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ address, baseline } satisfies StoredReceiveAddress));
  } catch {
    // Best-effort — worst case this address just isn't remembered across a
    // restart and a fresh one gets derived next time, same as before this
    // module existed.
  }
}

export function clearStoredReceiveAddress(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignored — see saveReceiveAddress.
  }
}
