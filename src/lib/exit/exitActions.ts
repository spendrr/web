// The three things a user does with a unilateral exit — start it, set where
// the money goes, and claim it — with their safety checks in one place.
// Security-sensitive: this is the path that finally moves exited funds to an
// address, and that address lives in plain localStorage for the weeks an exit
// takes.
import { pendingRoundInputIds } from "../wallet/roundInputs";
import type { ExitCancelFailure } from "@secondts/bark";
import { extractTxFromPsbt, pushWorkerWatchdogOverride, type WalletClient } from "../wallet/bark";
import { computeValueTag, loadVault, verifyValueTag, verifyVaultPassword } from "../vault/crypto";
import { loadVaultOrPrompt } from "../vault/vaultAccess";
import {
  getExitDestinationAddress,
  getExitDestinationTag,
  removeExitClaim,
  setExitDestinationAddress,
  setExitDestinationTag,
  clearExitDestinationAddress,
  clearExitDestinationTag,
  upsertExitClaim,
} from "./emergencyExit";
import { classifyBroadcastError, type ExitClaimRecord } from "./exitModel";
import { EXIT_ROUND_INPUTS_UNKNOWN, planExitStart, type ExitStartPlan, type ExitStartResult } from "./exitLocks";
import { releaseEngineBatchesFor } from "../refreshEngine/runner";
import { SEND_WATCHDOG_MS, TIMEOUT_MESSAGE, WALLET_CALL_TIMEOUT_MS, withTimeout } from "../wallet/walletCall";
import { SPEND_AUTH_FAILED, SPEND_AUTH_REQUIRED } from "../wallet/walletSession";

export type ExitActionErrorCode =
  | "no-vault"
  | "wrong-password"
  | "no-address"
  // The stored address has no tag: it may have been rewritten and the tag
  // deleted. Set it again (password-gated) before claiming.
  | "unverified-address"
  // The stored address doesn't match its tag: rewritten outside the app.
  | "address-mismatch"
  | "tag-failed"
  | "nothing-to-claim"
  // Couldn't read which coins are inputs of a pending round.
  | "round-inputs-unknown";

export class ExitActionError extends Error {
  readonly code: ExitActionErrorCode;
  constructor(code: ExitActionErrorCode) {
    super(code);
    this.code = code;
  }
}

function isAuthError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m === SPEND_AUTH_FAILED || m === SPEND_AUTH_REQUIRED;
}

async function requirePassword(password: string) {
  const vault = loadVaultOrPrompt();
  if (!vault) throw new ExitActionError("no-vault");
  if (!(await verifyVaultPassword(vault, password))) throw new ExitActionError("wrong-password");
  return vault;
}

// Stores the destination together with a tag over it. Unlike before, a tag
// that can't be computed is an error: an untagged address can't be claimed to.
export async function saveExitDestination(address: string, password: string): Promise<void> {
  const vault = await requirePassword(password);
  let tag: string;
  try {
    tag = await computeValueTag(address, password, vault);
  } catch {
    throw new ExitActionError("tag-failed");
  }
  clearExitDestinationTag();
  setExitDestinationAddress(address);
  setExitDestinationTag(tag);
}

export type DestinationCheck =
  | { kind: "ok"; address: string }
  | { kind: "no-address" }
  | { kind: "unverified" }
  | { kind: "mismatch" };

// Whether the stored address is the one the user set. Needs the password
// (the tag is keyed by it); call only after requirePassword succeeded.
// Returns the address it verified: the claim must pay exactly that string,
// not a second read of localStorage after the (slow) PBKDF2 check, which
// anything writing there in between could swap (external audit
// 2026-09-27, M2).
async function checkDestination(
  password: string,
  vault: NonNullable<ReturnType<typeof loadVault>>,
): Promise<DestinationCheck> {
  const address = getExitDestinationAddress();
  if (!address) return { kind: "no-address" };
  const tag = getExitDestinationTag();
  if (!tag) return { kind: "unverified" };
  return (await verifyValueTag(address, tag, password, vault)) ? { kind: "ok", address } : { kind: "mismatch" };
}

export interface ExitStartOutcome {
  plan: ExitStartPlan;
  result: ExitStartResult;
}

// Starts (or extends) an exit for every coin that can exit, except inputs of
// a pending round unless `includeInRound` (exitLocks.ts, planExitStart). The
// worker starts them one by one and locks them in the same call. `address`
// is set first when given, so a start that times out on this side but
// succeeded in the worker never leaves a running exit without a destination.
export async function startExit(
  wallet: WalletClient,
  password: string,
  address: string | null,
  // `addressFromStorage`: the field still holds the address the screen
  // prefilled from localStorage, not one the user typed. That one is only
  // accepted if its stored tag verifies with this password: otherwise a
  // value planted in localStorage (with its tag deleted or faked) would get a
  // valid tag from this very start (external audit 2026-09-27, N2).
  opts: { includeInRound: boolean; addressFromStorage?: boolean },
): Promise<ExitStartOutcome> {
  const vault = await requirePassword(password);
  if (address !== null && opts.addressFromStorage) {
    const check = await checkDestination(password, vault);
    if (check.kind !== "ok" || check.address !== address) {
      clearExitDestinationAddress();
      throw new ExitActionError(check.kind === "unverified" ? "unverified-address" : "address-mismatch");
    }
  } else if (address !== null) {
    await saveExitDestination(address, password);
  }
  const vtxos = await withTimeout(wallet.allVtxos(), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
  // Unknown: planExitStart still holds back every locked coin.
  const roundInputs = await withTimeout(pendingRoundInputIds(wallet), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE).catch(() => null);
  // A delegated round leaves its inputs Spendable: without the list, a start
  // would take them (external audit 2026-09-27, L1). The worker checks the
  // same thing again.
  if (roundInputs === null && !opts.includeInRound) throw new ExitActionError("round-inputs-unknown");
  const plan = planExitStart(vtxos, roundInputs, opts.includeInRound);
  if (opts.includeInRound && plan.inRoundIds.length > 0) {
    // Our refresh's lock would keep the exit from locking them.
    await releaseEngineBatchesFor(wallet, plan.inRoundIds).catch((e) => console.warn("releaseEngineBatchesFor failed", e));
  }
  if (plan.ids.length === 0) return { plan, result: { started: [], skipped: [] } };
  // Signing exit transactions for a large wallet can outlast the default
  // worker watchdog.
  const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
  try {
    const result = await withTimeout(
      wallet.withAuth({ vault, password }).startExitForCoins(plan.ids, opts.includeInRound),
      SEND_WATCHDOG_MS,
      TIMEOUT_MESSAGE,
    );
    return { plan, result };
  } catch (e) {
    if (isAuthError(e)) throw new ExitActionError("wrong-password");
    if (e instanceof Error && e.message.startsWith(EXIT_ROUND_INPUTS_UNKNOWN)) {
      throw new ExitActionError("round-inputs-unknown");
    }
    throw e;
  } finally {
    popWatchdog();
  }
}

// Cancels the exit of each coin, one call per coin (bark's cancel_exit takes
// one). Needs the password: cancelExit is in WALLET_ALWAYS_AUTH_METHODS
// (external audit 2026-09-27, H2). A coin bark won't cancel comes back in
// `failed` with its reason; a thrown call with the error text.
export async function cancelExits(
  wallet: WalletClient,
  password: string,
  vtxoIds: readonly string[],
): Promise<{ failed: { id: string; reason: ExitCancelFailure | string }[] }> {
  const vault = await requirePassword(password);
  const canceler = wallet.withAuth({ vault, password });
  const failed: { id: string; reason: ExitCancelFailure | string }[] = [];
  for (const id of vtxoIds) {
    try {
      const r = await withTimeout(canceler.cancelExit(id), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
      if (!r.canceled && r.reason) failed.push({ id, reason: r.reason });
    } catch (e) {
      if (isAuthError(e)) throw new ExitActionError("wrong-password");
      failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { failed };
}

export type ClaimOutcome =
  | { kind: "sent"; txid: string | null; record: ExitClaimRecord }
  // Handed to the network, answer never came back. The coins show as "claim
  // sent" for CLAIM_GRACE_MS; if bark still calls them claimable after that,
  // the transaction isn't out there and a new claim is offered.
  | { kind: "unknown"; record: ExitClaimRecord }
  // A node refused it. Nothing went out; the coins can be claimed again.
  | { kind: "rejected"; message: string };

// Builds, signs and broadcasts one claim of `vtxoIds` to the stored address.
export async function claimExits(
  wallet: WalletClient,
  password: string,
  vtxoIds: readonly string[],
  amountSats: number,
): Promise<ClaimOutcome> {
  // Nothing to claim (bark-ffi refuses an empty list too).
  if (vtxoIds.length === 0) throw new ExitActionError("nothing-to-claim");
  const vault = await requirePassword(password);
  const check = await checkDestination(password, vault);
  if (check.kind === "no-address") throw new ExitActionError("no-address");
  if (check.kind === "unverified") throw new ExitActionError("unverified-address");
  if (check.kind === "mismatch") throw new ExitActionError("address-mismatch");
  const address = check.address;

  const claimer = wallet.withAuth({ vault, password });
  const popWatchdog = pushWorkerWatchdogOverride(SEND_WATCHDOG_MS);
  try {
    let signedPsbt: string;
    let feeSats: number;
    try {
      const drain = await withTimeout(claimer.drainExits({ vtxoIds: [...vtxoIds], address }), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
      feeSats = drain.feeSats;
      // drainExits already signs (bark's drain_exits); this is a no-op kept
      // so a wrapper that stops doing that doesn't produce an unsigned tx.
      signedPsbt = await withTimeout(claimer.signExitClaimInputs(drain.psbtBase64), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
    } catch (e) {
      if (isAuthError(e)) throw new ExitActionError("wrong-password");
      throw e;
    }
    const txHex = await withTimeout(extractTxFromPsbt(signedPsbt), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
    // Written before the broadcast: from here on the app knows a claim may
    // be out there even if it never hears back.
    const record: ExitClaimRecord = {
      vtxoIds: [...vtxoIds],
      address,
      amountSats,
      feeSats,
      txid: null,
      attemptedAt: Date.now(),
      sentAt: null,
    };
    upsertExitClaim(record);
    try {
      const txid = await withTimeout(claimer.broadcastTx(txHex), WALLET_CALL_TIMEOUT_MS, TIMEOUT_MESSAGE);
      const sent = { ...record, txid, sentAt: Date.now() };
      upsertExitClaim(sent);
      return { kind: "sent", txid, record: sent };
    } catch (e) {
      if (isAuthError(e)) {
        removeExitClaim(record.attemptedAt);
        throw new ExitActionError("wrong-password");
      }
      const message = e instanceof Error ? e.message : String(e);
      switch (classifyBroadcastError(message)) {
        case "already-sent": {
          const sent = { ...record, sentAt: Date.now() };
          upsertExitClaim(sent);
          return { kind: "sent", txid: null, record: sent };
        }
        case "rejected":
          removeExitClaim(record.attemptedAt);
          return { kind: "rejected", message };
        default:
          return { kind: "unknown", record };
      }
    }
  } finally {
    popWatchdog();
  }
}
