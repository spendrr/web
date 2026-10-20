import type { WalletClient } from "../wallet/bark";
import { isWalletCallTimeout } from "../wallet/walletCall";

// The wallet's Ark address at index 0. newAddress() derives and stores a NEW
// key index every call, and every index counts toward the recovery scan's
// key gap limit (bark's default 250), so it is only for a wallet that has no index 0 yet (peekAddress
// fails). A timeout says nothing about that, it is just a busy worker queue:
// rethrow it instead of burning an index on every slow unlock.
export async function stableArkAddress(wallet: Pick<WalletClient, "peekAddress" | "newAddress">): Promise<string> {
  try {
    return await wallet.peekAddress(0);
  } catch (e) {
    if (isWalletCallTimeout(e)) throw e;
    return wallet.newAddress();
  }
}
