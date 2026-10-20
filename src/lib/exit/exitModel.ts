// What a unilateral exit is doing, derived in ONE place from what bark says
// (getExitVtxos / listClaimableExits) plus the only thing bark can't know:
// the claim transactions this app itself signed and sent. Pure (type-only SDK
// import), unit-tested in tests/exitModel.test.ts. Every exit screen, the
// home card and the balance note render from this — nothing re-derives its
// own idea of "sent" or "done" from local flags any more.
//
// It replaced a pile of localStorage flags that drifted away from bark (audit
// 2026-09-27): a "broadcast record" that kept VTXOs out of the claim button
// forever once the claim fell out of the mempool, a retry path that could
// only ever resend the same bytes, a filter that decided what was "still
// active", and a CPFP counter that looked like progress while nothing moved.
//
// Rules the model relies on, read in bark-0.7.0 (exit/progress/states.rs):
// - A claimable coin whose exit output shows up spent (mempool or chain) goes
//   to claim-in-progress, and back to claimable if that transaction drops out
//   of the mempool. bark only notices on its next progressExits(), which the
//   app runs every minute, hence CLAIM_GRACE_MS below.
// - claimed / vtxo-already-spent / canceled are finished. bark keeps them in
//   getExitVtxos() until the wallet is reopened, then forgets them (it only
//   loads live exits), so "done" has to be remembered by the app.
import type { ExitVtxo } from "@secondts/bark";

// After this app hands a claim to the network, bark still calls its coins
// "claimable" until a progressExits() sees the spend (≤ 1 poll, plus however
// long the chain source takes to index it). For this long they are shown as
// "claim sent" instead of offering a second claim. After it, bark's answer
// wins: still claimable means the transaction isn't anywhere bark can see,
// and a new claim is the right move (it can only pay the same wallet owner).
export const CLAIM_GRACE_MS = 15 * 60_000;

// VTXO expiry vs. an exit that isn't on-chain yet (bark-0.7.0, read
// 2026-09-27). Every intermediate output of the exit chain (round tree nodes,
// lib/src/tree/signed.rs cosign_taproot/expiry_clause; the hArk leaf output;
// arkoor checkpoints, vtxo/policy/mod.rs) carries a "server may spend after
// expiry_height" clause, and the server's watchman sweeps exactly those once
// the tip reaches it (server/src/watchman/policy.rs, decide_action_expiry).
// Only the final VTXO output (PubkeyVtxoPolicy) has no such clause. So an
// exit whose chain is still partly off-chain at the VTXO's expiry height
// loses the coin to the server; once the last exit transaction confirmed
// (timelock, claimable) expiry no longer matters. bark's exit code does not
// look at expiry at all, and ExitVtxo doesn't carry it: the tracker joins it
// in from allVtxos().
//
// Below this many blocks to expiry, a coin still getting on-chain is shown as
// at risk: a day to notice, reopen the app and top up fees, plus room for a
// few tree levels confirming one block at a time.
export const EXIT_EXPIRY_WARN_BLOCKS = 288;

// Claim records older than this are dropped even if bark never resolved them.
const CLAIM_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

// A claim transaction this app built. `sentAt === null` means the broadcast
// was attempted but its outcome is unknown (a timeout, a killed worker).
export interface ExitClaimRecord {
  vtxoIds: string[];
  address: string;
  amountSats: number;
  feeSats: number | null;
  txid: string | null;
  attemptedAt: number;
  sentAt: number | null;
}

export type ExitCoinPhase =
  // Exit registered, no exit transaction built yet.
  | "preparing"
  // Exit transactions going out and confirming, one tree level at a time.
  | "broadcasting"
  // Everything confirmed, the protocol timelock (CSV) is running.
  | "timelock"
  // Ready to be sent to the destination address.
  | "claimable"
  // This app sent a claim; bark hasn't seen it yet (within CLAIM_GRACE_MS).
  | "claim-sent"
  // bark sees the claim in the mempool.
  | "claiming"
  // Claim confirmed. Finished.
  | "claimed"
  // The coin was spent some other way before its exit got on-chain. Finished.
  | "aborted"
  // The user canceled it; the coin is back in Ark. Finished.
  | "canceled";

export type ExitWaitReason = "verify" | "previous-step" | "fee" | "confirmation";

export interface ExitCoinView {
  vtxoId: string;
  amountSats: number;
  phase: ExitCoinPhase;
  // broadcasting: how far up the coin's tree the exit got.
  txTotal: number | null;
  txConfirmed: number | null;
  // broadcasting: the coin's exit transactions. Coins from one payment share
  // their ancestors, so these repeat across coins.
  txs: { txid: string; confirmed: boolean }[];
  waitingFor: ExitWaitReason | null;
  currentTxid: string | null;
  // timelock
  blocksLeft: number | null;
  claimableHeight: number | null;
  // claiming / claimed
  claimTxid: string | null;
  claimBlock: number | null;
  // bark's is_cancelable: before the coin's LAST exit transaction went out.
  cancelable: boolean;
  // preparing / broadcasting only: blocks until the VTXO's expiry height,
  // after which the server can sweep the part of the chain already on-chain.
  // null when the expiry isn't known or the coin is past that risk.
  expiresInBlocks: number | null;
}

// The headline, most actionable first.
export type ExitStage = "none" | "ready" | "preparing" | "broadcasting" | "timelock" | "claiming" | "done";

export interface ExitOverview {
  coins: ExitCoinView[];
  stage: ExitStage;
  // Anything not finished (preparing … claiming).
  live: boolean;
  liveSats: number;
  // Still has exit transactions to get on-chain: needs on-chain fee money.
  broadcastingIds: string[];
  broadcastingSats: number;
  timelockSats: number;
  claimableIds: string[];
  claimableSats: number;
  claimingSats: number;
  claimedSats: number;
  abortedSats: number;
  cancelableIds: string[];
  // Blocks until the first / last timelocked coin can be claimed.
  firstReadyInBlocks: number | null;
  lastReadyInBlocks: number | null;
  // Soonest expiry among coins still getting on-chain (see
  // EXIT_EXPIRY_WARN_BLOCKS), and how much is in coins under that threshold.
  firstExpiryInBlocks: number | null;
  expiryRiskSats: number;
  // Coins whose next exit transaction waits for its CPFP: bark skips a CPFP
  // it can't fund from the confirmed on-chain balance without reporting
  // anything (exit/bdk.rs, InsufficientConfirmedFunds -> continue), and the
  // transaction stays in awaiting-cpfp-broadcast. So this is the direct sign
  // the exit is stuck on fees, known without the slow fee estimate.
  feeStalledSats: number;
  // Highest tip bark reported with any exit state; null without exits.
  tipHeight: number | null;
  // Claims sent by this app that aren't finished yet.
  pendingClaims: ExitClaimRecord[];
  // Distinct exit transactions of this exit and how many are confirmed (see
  // mergeExitTxs): only ever goes up.
  txProgress: { confirmed: number; total: number };
}

// Every exit transaction seen during this exit, txid -> confirmed. A coin's
// transactions are only listed while it is broadcasting, so without this its
// share of the count disappeared once it reached the timelock ("9 z 12"
// became "6 z 8"). Confirmed stays confirmed.
export type ExitTxsSeen = Readonly<Record<string, boolean>>;

export function mergeExitTxs(seen: ExitTxsSeen, coins: readonly ExitCoinView[]): Record<string, boolean> {
  const out: Record<string, boolean> = { ...seen };
  for (const c of coins) for (const tx of c.txs) out[tx.txid] = out[tx.txid] === true || tx.confirmed;
  return out;
}

function countTxs(seen: ExitTxsSeen): { confirmed: number; total: number } {
  const values = Object.values(seen);
  return { confirmed: values.filter(Boolean).length, total: values.length };
}

const FINISHED: ReadonlySet<ExitCoinPhase> = new Set(["claimed", "aborted", "canceled"]);

function waitReason(status: string): ExitWaitReason {
  switch (status) {
    case "verify-inputs":
      return "verify";
    case "awaiting-input-confirmation":
      return "previous-step";
    case "awaiting-cpfp-broadcast":
      return "fee";
    default:
      return "confirmation";
  }
}

// Mirrors bark's ExitState::is_cancelable (exit/models/mod.rs:238).
function isCancelable(state: ExitVtxo["state"]): boolean {
  if (state.type === "start") return true;
  if (state.type !== "processing") return false;
  const last = state.transactions.at(-1);
  if (!last) return true;
  return (
    last.status.type === "verify-inputs" ||
    last.status.type === "awaiting-input-confirmation" ||
    last.status.type === "awaiting-cpfp-broadcast"
  );
}

// Whether a claim record still stands in for bark's view of this coin.
function coveredByFreshClaim(vtxoId: string, claims: readonly ExitClaimRecord[], now: number): boolean {
  return claims.some((c) => c.vtxoIds.includes(vtxoId) && now - (c.sentAt ?? c.attemptedAt) < CLAIM_GRACE_MS);
}

export function viewCoin(
  exit: ExitVtxo,
  sdkClaimable: ReadonlySet<string> | null,
  claims: readonly ExitClaimRecord[],
  now: number,
  expiryHeight: number | null = null,
  // The newest tip bark reported for any exit. A coin's own state.tipHeight
  // can be old: a coin stuck in "start" keeps the tip from when it started,
  // which would make its expiry look further away than it is.
  currentTip: number | null = null,
): ExitCoinView {
  const base: ExitCoinView = {
    vtxoId: exit.vtxoId,
    amountSats: exit.amountSats,
    phase: "preparing",
    txTotal: null,
    txConfirmed: null,
    txs: [],
    waitingFor: null,
    currentTxid: null,
    blocksLeft: null,
    claimableHeight: null,
    claimTxid: null,
    claimBlock: null,
    cancelable: isCancelable(exit.state),
    expiresInBlocks: null,
  };
  const s = exit.state;
  const tip = Math.max(s.tipHeight, currentTip ?? 0);
  const expiresInBlocks = expiryHeight !== null ? expiryHeight - tip : null;
  switch (s.type) {
    case "start":
      return { ...base, expiresInBlocks };
    case "processing": {
      const txs = s.transactions;
      const confirmed = txs.filter((tx) => tx.status.type === "confirmed").length;
      // The first transaction that isn't confirmed yet is the one the exit
      // is waiting on; the ones after it can't move before it does.
      const current = txs.find((tx) => tx.status.type !== "confirmed") ?? txs.at(-1);
      return {
        ...base,
        phase: "broadcasting",
        expiresInBlocks,
        txTotal: txs.length,
        txConfirmed: confirmed,
        txs: txs.map((tx) => ({ txid: tx.txid, confirmed: tx.status.type === "confirmed" })),
        waitingFor: current ? waitReason(current.status.type) : null,
        currentTxid:
          current && (current.status.type === "awaiting-confirmation" || current.status.type === "confirmed")
            ? current.txid
            : null,
      };
    }
    case "awaiting-delta":
      return {
        ...base,
        phase: "timelock",
        // Not s.tipHeight: bark leaves it at the confirmation height for as
        // long as the coin waits (seen on signet, 2026-09-28), so the count
        // stood still.
        blocksLeft: Math.max(0, s.claimableHeight - tip),
        claimableHeight: s.claimableHeight,
      };
    case "claimable": {
      // listClaimableExits() is bark's own answer; when it failed, the state
      // itself says the same thing.
      const ready = sdkClaimable === null || sdkClaimable.has(exit.vtxoId);
      if (!ready) return { ...base, phase: "timelock", blocksLeft: 0 };
      return { ...base, phase: coveredByFreshClaim(exit.vtxoId, claims, now) ? "claim-sent" : "claimable" };
    }
    case "claim-in-progress":
      return { ...base, phase: "claiming", claimTxid: s.claimTxid };
    case "claimed":
      return { ...base, phase: "claimed", claimTxid: s.txid, claimBlock: s.block.height };
    case "vtxo-already-spent":
      return { ...base, phase: "aborted" };
    case "canceled":
      return { ...base, phase: "canceled" };
    default:
      // A state this build doesn't know: say "preparing" rather than hide it.
      return base;
  }
}

function sum(coins: readonly ExitCoinView[], phases: readonly ExitCoinPhase[]): number {
  return coins.filter((c) => phases.includes(c.phase)).reduce((acc, c) => acc + c.amountSats, 0);
}

export function buildExitOverview(
  exits: readonly ExitVtxo[],
  // null when listClaimableExits() failed this round.
  sdkClaimableIds: readonly string[] | null,
  claims: readonly ExitClaimRecord[],
  now: number,
  // VTXO id -> expiry height, from allVtxos(). null or a missing id: unknown.
  expiryHeights: ReadonlyMap<string, number> | null = null,
  // The chain tip from the on-chain wallet. bark's per-exit tipHeight can
  // stand still (see viewCoin), so the newer of the two wins.
  chainTip: number | null = null,
  // Exit transactions seen earlier in this exit (mergeExitTxs).
  txsSeen: ExitTxsSeen = {},
): ExitOverview {
  const sdkClaimable = sdkClaimableIds === null ? null : new Set(sdkClaimableIds);
  // Deduped: one entry per VTXO, the SDK list is not guaranteed unique.
  const byId = new Map<string, ExitVtxo>();
  for (const e of exits) byId.set(e.vtxoId, e);
  const tips = [...[...byId.values()].map((e) => e.state.tipHeight), chainTip ?? 0].filter(
    (h) => Number.isFinite(h) && h > 0,
  );
  const tipHeight = tips.length > 0 ? Math.max(...tips) : null;
  const coins = [...byId.values()].map((e) =>
    viewCoin(e, sdkClaimable, claims, now, expiryHeights?.get(e.vtxoId) ?? null, tipHeight),
  );

  const has = (p: ExitCoinPhase) => coins.some((c) => c.phase === p);
  const live = coins.some((c) => !FINISHED.has(c.phase));
  let stage: ExitStage = "none";
  if (has("claimable")) stage = "ready";
  else if (has("broadcasting")) stage = "broadcasting";
  else if (has("preparing")) stage = "preparing";
  else if (has("timelock")) stage = "timelock";
  else if (has("claim-sent") || has("claiming")) stage = "claiming";
  else if (has("claimed")) stage = "done";

  const timelockBlocks = coins.filter((c) => c.phase === "timelock").map((c) => c.blocksLeft ?? 0);
  const liveIds = new Set(coins.filter((c) => c.phase === "claim-sent" || c.phase === "claiming").map((c) => c.vtxoId));
  const broadcasting = coins.filter((c) => c.phase === "preparing" || c.phase === "broadcasting");
  const expiries = broadcasting.filter((c) => c.expiresInBlocks !== null);

  return {
    coins,
    stage,
    live,
    liveSats: coins.filter((c) => !FINISHED.has(c.phase)).reduce((acc, c) => acc + c.amountSats, 0),
    broadcastingIds: broadcasting.map((c) => c.vtxoId),
    broadcastingSats: broadcasting.reduce((acc, c) => acc + c.amountSats, 0),
    timelockSats: sum(coins, ["timelock"]),
    claimableIds: coins.filter((c) => c.phase === "claimable").map((c) => c.vtxoId),
    claimableSats: sum(coins, ["claimable"]),
    claimingSats: sum(coins, ["claim-sent", "claiming"]),
    claimedSats: sum(coins, ["claimed"]),
    abortedSats: sum(coins, ["aborted"]),
    cancelableIds: coins.filter((c) => c.cancelable).map((c) => c.vtxoId),
    firstReadyInBlocks: timelockBlocks.length > 0 ? Math.min(...timelockBlocks) : null,
    lastReadyInBlocks: timelockBlocks.length > 0 ? Math.max(...timelockBlocks) : null,
    firstExpiryInBlocks: expiries.length > 0 ? Math.min(...expiries.map((c) => c.expiresInBlocks!)) : null,
    feeStalledSats: coins.filter((c) => c.phase === "broadcasting" && c.waitingFor === "fee").reduce((a, c) => a + c.amountSats, 0),
    expiryRiskSats: expiries
      .filter((c) => c.expiresInBlocks! <= EXIT_EXPIRY_WARN_BLOCKS)
      .reduce((acc, c) => acc + c.amountSats, 0),
    tipHeight,
    pendingClaims: claims.filter((c) => c.vtxoIds.some((id) => liveIds.has(id))),
    txProgress: countTxs(mergeExitTxs(txsSeen, coins)),
  };
}

// While the exit still has transactions to get on-chain, whether it is
// stuck on fees. bark funds each CPFP child from CONFIRMED on-chain coins
// only (a TRUC child may have one unconfirmed parent, the exit transaction),
// so its own change from the previous step, or a payment still in the
// mempool, leaves the next step waiting for a block. That is the exit
// running, not stuck: only when even the unconfirmed money wouldn't cover the
// rest, or it has waited FEE_PENDING_GRACE_BLOCKS (a payment stuck at a low
// fee), does the user have to send more.
export const FEE_PENDING_GRACE_BLOCKS = 3;

export function feesStalled(x: {
  broadcasting: boolean;
  // bark's simulated walk over the confirmed coins; null before it answered.
  fundable: boolean | null;
  // A transaction already sits in awaiting-cpfp-broadcast.
  feeStalled: boolean;
  neededSats: number | null;
  onchain: { confirmedSats: number; pendingSats: number } | null;
  // Tip when unconfirmed money started covering the shortfall, null if not.
  coveredSinceTip: number | null;
  tip: number | null;
}): boolean {
  if (!x.broadcasting) return false;
  const short = x.fundable !== null ? !x.fundable : x.feeStalled;
  if (!short) return false;
  if (!pendingCoversFees(x.neededSats, x.onchain)) return true;
  if (x.coveredSinceTip === null || x.tip === null) return false;
  return x.tip - x.coveredSinceTip >= FEE_PENDING_GRACE_BLOCKS;
}

export function pendingCoversFees(
  neededSats: number | null,
  onchain: { confirmedSats: number; pendingSats: number } | null,
): boolean {
  if (neededSats === null || onchain === null || onchain.pendingSats <= 0) return false;
  return onchain.confirmedSats + onchain.pendingSats >= neededSats;
}

// Drops claim records nothing depends on any more: every coin they claimed is
// finished or unknown to bark (after a reopen bark forgets finished exits), or
// they are too old. `exits` must come from a successful read — an empty list
// because a call failed would wipe records that are still needed.
export function pruneClaimRecords(
  claims: readonly ExitClaimRecord[],
  exits: readonly ExitVtxo[],
  now: number,
): ExitClaimRecord[] {
  const stillOpen = new Set(
    exits
      .filter((e) => e.state.type === "claimable" || e.state.type === "claim-in-progress")
      .map((e) => e.vtxoId),
  );
  return claims.filter(
    (c) => now - c.attemptedAt < CLAIM_RECORD_MAX_AGE_MS && c.vtxoIds.some((id) => stillOpen.has(id)),
  );
}

// How a failed broadcastTx() should be read. Bitcoin nodes reject a
// transaction they already have instead of accepting it again, with wording
// that differs per implementation; Core ≥ 25 says "Transaction outputs already
// in utxo set" for one that is already confirmed.
export type BroadcastErrorKind = "already-sent" | "rejected" | "unknown";

export function classifyBroadcastError(message: string): BroadcastErrorKind {
  const m = message.toLowerCase();
  if (
    m.includes("already in block chain") ||
    m.includes("already in utxo set") ||
    m.includes("already in the mempool") ||
    m.includes("already known") ||
    m.includes("txn-already-known") ||
    m.includes("txn-already-in-mempool") ||
    m.includes("transaction already exists") ||
    m.includes("duplicate transaction") ||
    // The exit outputs are already spent, or a transaction spending them is
    // in the mempool. After the timelock only the owner's key can spend
    // them, so that is an earlier claim of ours: the money is on its way.
    m.includes("missingorspent") ||
    m.includes("txn-mempool-conflict") ||
    // A node refusing to replace the transaction already in its mempool
    // (Core: "insufficient fee, rejecting replacement <txid>…"): that one is
    // an earlier claim of ours (external audit 2026-09-27, L3). Checked here,
    // before the "insufficient fee" of the rejected branch below.
    m.includes("rejecting replacement") ||
    m.includes("replacement-disallowed")
  ) {
    return "already-sent";
  }
  // A node that looked at the transaction and said no. Nothing is out there,
  // so the coins can be claimed again straight away.
  if (
    m.includes("sendrawtransaction") ||
    m.includes("rpc error") ||
    m.includes("bad-txns") ||
    m.includes("min relay fee") ||
    m.includes("mempool min fee") ||
    m.includes("non-final") ||
    m.includes("non-bip68-final") ||
    m.includes("insufficient fee") ||
    m.includes("dust") ||
    m.includes("invalid transaction")
  ) {
    return "rejected";
  }
  // Timeouts, a killed worker, a dropped connection: it may be out there.
  return "unknown";
}

// --- when the app should be open again (push nudge) --------------------------

// An exit only moves while the app is open (useExitTracker.ts), so with push
// on, the app asks to be woken up. Masked on purpose (decided with the user,
// 2026-09-27): it reports a block height through the SAME field as the
// ordinary expiry nudge (notifications.ts), and the Worker sends the same
// generic "Mrkni do peněženky", so the server can't tell an exit from a coin
// nearing expiry.
//
// If the app hasn't been opened this many blocks after the last report, it's
// needed: the next tree level can't get its CPFP, a claim is waiting.
export const EXIT_WAKE_AFTER_BLOCKS = 6;

// The block height by which the app should be open again, or null when the
// exit doesn't need it (none running, only claims confirming). Rounded up to
// a multiple of EXIT_WAKE_AFTER_BLOCKS so an open app re-reports at most
// about once an hour instead of every block.
export function exitWakeHeight(o: ExitOverview): number | null {
  if (!o.live || o.tipHeight === null) return null;
  const soon = Math.ceil((o.tipHeight + EXIT_WAKE_AFTER_BLOCKS) / EXIT_WAKE_AFTER_BLOCKS) * EXIT_WAKE_AFTER_BLOCKS;
  switch (o.stage) {
    case "ready":
    case "preparing":
    case "broadcasting":
      return soon;
    case "timelock":
      return o.firstReadyInBlocks !== null ? o.tipHeight + Math.max(1, o.firstReadyInBlocks) : null;
    default:
      return null;
  }
}

// Soonest expiry height among coins not yet fully on-chain (see
// EXIT_EXPIRY_WARN_BLOCKS), for the ordinary expiry nudge to cover them.
export function exitExpiryHeight(o: ExitOverview): number | null {
  if (o.tipHeight === null || o.firstExpiryInBlocks === null) return null;
  return o.tipHeight + o.firstExpiryInBlocks;
}
