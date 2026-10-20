// The weekly sign of life for a registered @handle.
//
// The registry lets somebody else take over a name whose owner has shown
// nothing for a year (worker/names.ts). "Shown" means an authorized call, and
// a wallet that simply keeps being used but never opens the profile screen
// would never make one. So while a wallet has a name, the app reads it back
// about once a week on its own, which is all the registry needs.
//
// The flag lives in localStorage and is set by the profile screen when a name
// is registered or found. It is per browser, not per wallet: after a wallet
// reset the stale flag costs one extra call that finds no name and clears it.
import type { WalletClient } from "../wallet/bark";
import { fetchMyName } from "./names";

const HAS_KEY = "btc-wallet-has-handle";
const TOUCHED_KEY = "btc-wallet-handle-touched";
const CACHED_KEY = "btc-wallet-my-name";
export const NAME_TOUCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function hasHandleFlag(storage: Storage = localStorage): boolean {
  try {
    return storage.getItem(HAS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHasHandle(has: boolean, storage: Storage = localStorage): void {
  try {
    if (has) storage.setItem(HAS_KEY, "1");
    else {
      storage.removeItem(HAS_KEY);
      storage.removeItem(TOUCHED_KEY);
      storage.removeItem(CACHED_KEY);
    }
  } catch {
    // storage blocked: the weekly touch just won't happen
  }
}

// The last name this wallet was seen to own, so the profile screen can open
// at once instead of waiting for a fresh mailbox proof, which queues behind
// everything the wallet worker does right after an unlock. Nothing in it is
// secret (a name resolves publicly to its address). It only changes when the
// user acts (the profile screen writes the server's answer back) or from
// another device / moderation, which the weekly touch below picks up.
//
// Keyed by the wallet's own Ark address, because the flag above is per
// browser: after a wallet reset a record for the old wallet must not show up.
export interface CachedName {
  name: string;
  address: string;
  lnAddress: boolean;
}

export function getCachedName(walletAddress: string, storage: Storage = localStorage): CachedName | null {
  try {
    const raw = storage.getItem(CACHED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { wallet?: unknown; name?: unknown; address?: unknown; lnAddress?: unknown };
    if (v.wallet !== walletAddress || typeof v.name !== "string" || typeof v.address !== "string") return null;
    return { name: v.name, address: v.address, lnAddress: v.lnAddress === true };
  } catch {
    return null;
  }
}

export function setCachedName(walletAddress: string, mine: CachedName | null, storage: Storage = localStorage): void {
  try {
    if (mine) storage.setItem(CACHED_KEY, JSON.stringify({ wallet: walletAddress, ...mine }));
    else storage.removeItem(CACHED_KEY);
  } catch {
    // storage blocked: the profile screen just asks the server every time
  }
}

// The weekly touch has no wallet address at hand, so it only refreshes a
// record that is already there, under the wallet it was stored for.
function refreshCachedName(mine: CachedName, storage: Storage): void {
  try {
    const raw = storage.getItem(CACHED_KEY);
    if (!raw) return;
    const wallet = (JSON.parse(raw) as { wallet?: unknown }).wallet;
    if (typeof wallet === "string") setCachedName(wallet, mine, storage);
  } catch {
    // ignore, see setCachedName
  }
}

// Best effort by design: a failure (offline, server down) is retried at the
// next unlock, and nothing here may ever surface as an error.
export async function maybeTouchName(
  wallet: WalletClient,
  storage: Storage = localStorage,
  now: number = Date.now(),
): Promise<void> {
  try {
    if (storage.getItem(HAS_KEY) !== "1") return;
    const last = Number(storage.getItem(TOUCHED_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < NAME_TOUCH_INTERVAL_MS) return;
    const mine = await fetchMyName(wallet);
    if (mine === null) {
      setHasHandle(false, storage);
      return;
    }
    refreshCachedName(mine, storage);
    storage.setItem(TOUCHED_KEY, String(now));
  } catch {
    // try again next time
  }
}
