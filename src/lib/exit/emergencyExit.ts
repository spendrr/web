// What this app persists about a unilateral exit itself. Everything about the
// exit's progress comes from bark (getExitVtxos / listClaimableExits) through
// exitModel.ts; only what bark cannot know lives here:
//   - where the claimed funds should go (the destination and its tag),
//   - which claim transactions this app signed and sent (bark only learns of
//     one on its next progressExits(), see exitModel.ts's CLAIM_GRACE_MS),
//   - that an exit finished, because bark forgets finished exits on reopen.
import type { ExitClaimRecord, ExitCoinView } from "./exitModel";
import { writeExitNotificationHint } from "./exitNudge";
import { clearProgressGuard } from "./exitProgressGuard";
import { rekeyDestinationTag, type RekeyDecision } from "./exitDestinationTag";
import type { EncryptedVault } from "../vault/vaultCrypto";

const DESTINATION_KEY = "btc-wallet-exit-destination-address";

export function getExitDestinationAddress(): string | null {
  return localStorage.getItem(DESTINATION_KEY);
}

export function setExitDestinationAddress(address: string): void {
  localStorage.setItem(DESTINATION_KEY, address);
}

export function clearExitDestinationAddress(): void {
  localStorage.removeItem(DESTINATION_KEY);
  localStorage.removeItem(DESTINATION_TAG_KEY);
}

// Authentication tag over the address above, keyed by the user's password
// (see computeValueTag in crypto.ts). Anything with script access to this
// origin can rewrite the address; it cannot write a matching tag without the
// password. It can DELETE the tag, though, so a missing tag is not "old
// entry, trust it" any more: exitActions.ts refuses to claim to an address
// without one and the UI asks for it to be set again (audit 2026-09-27).
const DESTINATION_TAG_KEY = "btc-wallet-exit-destination-tag";

export function getExitDestinationTag(): string | null {
  return localStorage.getItem(DESTINATION_TAG_KEY);
}

export function setExitDestinationTag(tag: string): void {
  localStorage.setItem(DESTINATION_TAG_KEY, tag);
}

export function clearExitDestinationTag(): void {
  localStorage.removeItem(DESTINATION_TAG_KEY);
}

// Recomputes the tag after a password change or vault rehash, or drops the
// address when the old tag doesn't vouch for it (exitDestinationTag.ts).
// Returns what it did, for the caller's log.
export async function rekeyStoredExitDestination(
  previous: { password: string; vault: EncryptedVault },
  next: { password: string; vault: EncryptedVault },
): Promise<RekeyDecision["kind"]> {
  const decision = await rekeyDestinationTag(
    { address: getExitDestinationAddress(), tag: getExitDestinationTag() },
    previous,
    next,
  );
  if (decision.kind === "retag") setExitDestinationTag(decision.tag);
  else if (decision.kind === "clear") clearExitDestinationAddress();
  return decision.kind;
}

// --- claim records -----------------------------------------------------------

const CLAIMS_KEY = "btc-wallet-exit-claims";

// Keys of the model this replaced. Read once for migration, then removed.
const LEGACY_BROADCAST_KEY = "btc-wallet-exit-broadcast-record";
const LEGACY_ATTEMPT_KEY = "btc-wallet-exit-broadcast-attempt";
const LEGACY_CPFP_BASELINE_KEY = "btc-wallet-exit-cpfp-baseline";

function isRecord(value: unknown): value is ExitClaimRecord {
  const r = value as ExitClaimRecord;
  return (
    typeof r === "object" &&
    r !== null &&
    Array.isArray(r.vtxoIds) &&
    r.vtxoIds.every((id) => typeof id === "string") &&
    typeof r.address === "string" &&
    typeof r.amountSats === "number" &&
    (r.feeSats === null || typeof r.feeSats === "number") &&
    (r.txid === null || typeof r.txid === "string") &&
    typeof r.attemptedAt === "number" &&
    (r.sentAt === null || typeof r.sentAt === "number")
  );
}

function readLegacyRecords(): ExitClaimRecord[] {
  const out: ExitClaimRecord[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_BROADCAST_KEY);
    const r = raw ? (JSON.parse(raw) as { txid?: unknown; broadcastAt?: unknown; vtxoIds?: unknown }) : null;
    // A record without vtxoIds can't be matched to any coin: bark's own view
    // replaces it.
    if (r && Array.isArray(r.vtxoIds) && typeof r.broadcastAt === "number") {
      out.push({
        vtxoIds: r.vtxoIds.filter((id): id is string => typeof id === "string"),
        address: getExitDestinationAddress() ?? "",
        amountSats: 0,
        feeSats: null,
        txid: typeof r.txid === "string" ? r.txid : null,
        attemptedAt: r.broadcastAt,
        sentAt: r.broadcastAt,
      });
    }
  } catch {
    // Corrupted: nothing to carry over.
  }
  try {
    const raw = localStorage.getItem(LEGACY_ATTEMPT_KEY);
    const a = raw ? (JSON.parse(raw) as { attemptedAt?: unknown; address?: unknown; vtxoIds?: unknown }) : null;
    if (a && Array.isArray(a.vtxoIds) && typeof a.attemptedAt === "number" && typeof a.address === "string") {
      out.push({
        vtxoIds: a.vtxoIds.filter((id): id is string => typeof id === "string"),
        address: a.address,
        amountSats: 0,
        feeSats: null,
        txid: null,
        attemptedAt: a.attemptedAt,
        sentAt: null,
      });
    }
  } catch {
    // Same.
  }
  return out;
}

export function getExitClaims(): ExitClaimRecord[] {
  let claims: ExitClaimRecord[] = [];
  try {
    const raw = localStorage.getItem(CLAIMS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) claims = parsed.filter(isRecord);
  } catch {
    claims = [];
  }
  if (localStorage.getItem(LEGACY_BROADCAST_KEY) !== null || localStorage.getItem(LEGACY_ATTEMPT_KEY) !== null) {
    claims = [...claims, ...readLegacyRecords()];
    setExitClaims(claims);
    localStorage.removeItem(LEGACY_BROADCAST_KEY);
    localStorage.removeItem(LEGACY_ATTEMPT_KEY);
  }
  localStorage.removeItem(LEGACY_CPFP_BASELINE_KEY);
  return claims;
}

export function setExitClaims(claims: readonly ExitClaimRecord[]): void {
  if (claims.length === 0) localStorage.removeItem(CLAIMS_KEY);
  else localStorage.setItem(CLAIMS_KEY, JSON.stringify(claims));
}

// Replaces the record with the same attemptedAt, or appends it.
export function upsertExitClaim(record: ExitClaimRecord): void {
  const others = getExitClaims().filter((c) => c.attemptedAt !== record.attemptedAt);
  setExitClaims([...others, record]);
}

export function removeExitClaim(attemptedAt: number): void {
  setExitClaims(getExitClaims().filter((c) => c.attemptedAt !== attemptedAt));
}

// --- completion --------------------------------------------------------------

// bark forgets a claimed exit when the wallet is reopened, so without this an
// exit that finished while the app was closed (or just before a relock) would
// simply vanish, with no "done, here is the transaction" anywhere.
const COMPLETION_KEY = "btc-wallet-exit-completion";

// One claim this device sent, as the "done" screen shows it. Built only from
// this app's own claim records (ExitClaimRecord): bark's list of claimed
// coins is no source for it. After a restore from seed it holds exits of
// months ago, and the arkoor parent of an exited coin shows up "claimed" by
// the very transaction that split it (signet, 2026-10-07).
export interface ExitCompletionClaim {
  txid: string | null;
  address: string;
  vtxoIds: string[];
  // What reached the address: the coins minus the claim fee. null when the
  // record doesn't know the fee (a record from before fees were kept).
  arrivedSats: number | null;
  feeSats: number | null;
}

export interface ExitCompletion {
  // Keyed by the claim record's attemptedAt.
  claims: Record<string, ExitCompletionClaim>;
  // Hidden from the home screen once the user has seen it. A claim that
  // finishes later shows it again.
  dismissed: boolean;
  updatedAt: number;
}

function isCompletionClaim(v: unknown): v is ExitCompletionClaim {
  const c = v as ExitCompletionClaim;
  return (
    typeof c === "object" &&
    c !== null &&
    (c.txid === null || typeof c.txid === "string") &&
    typeof c.address === "string" &&
    Array.isArray(c.vtxoIds) &&
    (c.arrivedSats === null || typeof c.arrivedSats === "number") &&
    (c.feeSats === null || typeof c.feeSats === "number")
  );
}

// A stored value in the old per-coin shape (amounts from bark, no fee) can't
// be told apart from a wrong one, so it isn't shown.
export function getExitCompletion(): ExitCompletion | null {
  try {
    const raw = localStorage.getItem(COMPLETION_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ExitCompletion>) : null;
    if (!parsed || typeof parsed.claims !== "object" || parsed.claims === null) return null;
    if (!Object.values(parsed.claims).every(isCompletionClaim)) return null;
    return { claims: parsed.claims, dismissed: parsed.dismissed === true, updatedAt: Number(parsed.updatedAt) || 0 };
  } catch {
    return null;
  }
}

// Total that reached the address, or null when any claim's amount is unknown.
export function completionArrivedSats(c: ExitCompletion): number | null {
  let total = 0;
  for (const claim of Object.values(c.claims)) {
    if (claim.arrivedSats === null) return null;
    total += claim.arrivedSats;
  }
  return total;
}

// Adds the claims of coins bark now reports claimed, for claims this app
// sent. Returns the new value when something changed, null otherwise.
export function recordExitCompletions(
  claimed: readonly ExitCoinView[],
  claims: readonly ExitClaimRecord[],
  now: number,
): ExitCompletion | null {
  const current = getExitCompletion() ?? { claims: {}, dismissed: false, updatedAt: now };
  let changed = false;
  const next: Record<string, ExitCompletionClaim> = { ...current.claims };
  for (const c of claimed) {
    const record = claims.find((r) => r.vtxoIds.includes(c.vtxoId));
    if (!record) continue;
    const key = String(record.attemptedAt);
    const existing = next[key];
    if (existing) {
      if (existing.vtxoIds.includes(c.vtxoId)) continue;
      next[key] = { ...existing, vtxoIds: [...existing.vtxoIds, c.vtxoId], txid: existing.txid ?? c.claimTxid };
    } else {
      next[key] = {
        txid: record.txid ?? c.claimTxid,
        address: record.address,
        vtxoIds: [c.vtxoId],
        // amountSats is what the claim spent (every coin in it), so this is
        // exactly its one output.
        arrivedSats: record.feeSats !== null && record.amountSats > 0 ? record.amountSats - record.feeSats : null,
        feeSats: record.feeSats,
      };
    }
    changed = true;
  }
  if (!changed) return null;
  const value: ExitCompletion = { claims: next, dismissed: false, updatedAt: now };
  localStorage.setItem(COMPLETION_KEY, JSON.stringify(value));
  return value;
}

// A new exit started from scratch: the previous one's summary must not be
// added into its "done" screen (recordExitCompletions only ever merges).
export function clearExitCompletion(): void {
  localStorage.removeItem(COMPLETION_KEY);
}

export function dismissExitCompletion(): void {
  const current = getExitCompletion();
  if (!current) return;
  localStorage.setItem(COMPLETION_KEY, JSON.stringify({ ...current, dismissed: true }));
}

// --- live hint ---------------------------------------------------------------

// Whether the last successful read saw an exit that isn't finished, for the
// wallet-reset warning on the unlock screen, where no wallet is open to ask.
// The destination address alone can't answer that: it stays after an exit
// finished (the next exit reuses it), which made the warning fire forever.
const LIVE_HINT_KEY = "btc-wallet-exit-live";

export function setExitLiveHint(live: boolean): void {
  localStorage.setItem(LIVE_HINT_KEY, live ? "1" : "0");
}

// Never written yet (an exit from before the hint existed, or no unlock since):
// fall back to "an address is set", which errs towards warning.
export function exitMayBeLive(): boolean {
  const hint = localStorage.getItem(LIVE_HINT_KEY);
  if (hint === null) return getExitDestinationAddress() !== null;
  return hint === "1";
}

// Everything this module stores, for a wallet reset and for starting a fresh
// exit after an earlier one finished.
export function clearAllExitState(): void {
  clearExitDestinationAddress();
  localStorage.removeItem(CLAIMS_KEY);
  localStorage.removeItem(COMPLETION_KEY);
  localStorage.removeItem(LIVE_HINT_KEY);
  void writeExitNotificationHint(null);
  clearProgressGuard();
  localStorage.removeItem(LEGACY_BROADCAST_KEY);
  localStorage.removeItem(LEGACY_ATTEMPT_KEY);
  localStorage.removeItem(LEGACY_CPFP_BASELINE_KEY);
}

// States in which an exit still needs the app (for the wallet-reset warning).
export function isLiveExitState(type: string): boolean {
  return type !== "claimed" && type !== "vtxo-already-spent" && type !== "canceled";
}
