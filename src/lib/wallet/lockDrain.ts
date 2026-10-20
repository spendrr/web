// Decides whether a lock may terminate the wallet worker right away or must let the queue drain first.
// Terminating drops everything queued behind a slow sync, which is what keeps the next unlock from waiting on it; it is
// only allowed while everything queued or running is safe to kill halfway.
//
// Not the spend policy's read sets: those mean "no money leaves to a third party", and several of their methods still
// write state that a kill mid-call can leave half done. maintenanceDelegated can submit a round participation and die
// before storing its round state (an orphan the wallet cannot claim), progressExits signs and broadcasts CPFPs,
// syncExitLocks changes locks, newAddress stores a key index.
//
// Pure, no imports of the SDK: tests/lockDrain.test.ts runs it directly.

// Request types that carry no funds-moving work. An unknown type is NOT here, so a new kind of request falls back to
// the slow, safe path until someone classifies it.
const CUTTABLE_TYPES: ReadonlySet<string> = new Set(["ensureWasm", "chatKey", "close", "prepareSession", "openHeld"]);

// Calls a kill can cut at any point. Pure reads and estimates, plus sync: bark's mailbox processing stores a message's
// result before advancing its checkpoint, and a stored send is resumed by the next sync.
export const CUTTABLE_WALLET_METHODS: ReadonlySet<string> = new Set([
  "sync",
  "balance",
  "history",
  "allVtxos",
  "vtxos",
  "peekAddress",
  "validateArkoorAddress",
  "estimateArkoorPaymentFee",
  "estimateSendOnchainFee",
  "estimateLightningSendFee",
  "estimateBoardFee",
  "estimateRefreshFee",
  "estimateEmergencyExitFee",
  "pendingRoundStates",
  "pendingRoundInputVtxos",
  "nextRoundStartTime",
  "arkInfo",
  "getExitVtxos",
  "listClaimableExits",
  "hasPendingExits",
  "pendingExitsTotalSats",
  "mailboxIdentifier",
  "mailboxAuthorization",
  "getFirstExpiringVtxoBlockheight",
]);

// The onchain wallet's reads; a cut sync or scan just runs again (the scan's done flag is only set on success).
export const CUTTABLE_ONCHAIN_METHODS: ReadonlySet<string> = new Set([
  "balance",
  "sync",
  "initialScan",
  "transactions",
  "tipHeight",
  "utxos",
  "feeRates",
]);

export function mustFinishBeforeLock(payload: { type?: unknown; target?: unknown; method?: unknown }): boolean {
  if (typeof payload.type === "string" && CUTTABLE_TYPES.has(payload.type)) return false;
  if (payload.type !== "call" || typeof payload.method !== "string") return true;
  if (payload.target === "wallet") return !CUTTABLE_WALLET_METHODS.has(payload.method);
  if (payload.target === "onchain") return !CUTTABLE_ONCHAIN_METHODS.has(payload.method);
  return true;
}

export function canTerminateOnLock(pending: Iterable<{ payload: { type?: unknown; target?: unknown; method?: unknown } }>): boolean {
  for (const p of pending) if (mustFinishBeforeLock(p.payload)) return false;
  return true;
}
