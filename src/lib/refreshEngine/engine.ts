// Refresh engine: one tick = reconcile what earlier ticks started, then (auto
// or manual) submit delegated refreshes for exactly what plan.ts picked.
// Replaces the SDK daemon's interactive round joins and maintenanceDelegated()'s
// own selection. Agreed with the user 2026-09-26; see plan.ts and breaker.ts.
//
// What a tick guarantees, each for a reason seen live or read in bark-0.7.1:
// - Inputs are checked by a lock (holder = this engine) taken right before
//   the submit and released right after it, in the same worker queue item: a
//   coin a payment took fails the lock and nothing is submitted. No lock of
//   ours stays on a submitted coin: bark locks the inputs itself under the
//   round's movement once the server issues the round (round/mod.rs
//   progress_delegated), with a checked lock_vtxos that fails on a coin we
//   hold, and the round then never finishes. Until the round is issued the
//   coins are spendable; a send with one makes the server drop the
//   participation (tree.rs invalidate_pending_participations_for_inputs), so
//   a batch whose round ends without bark ever having held its inputs proves
//   nothing (TrackedBatch.locked).
// - A submit whose result we never saw (worker killed, timeout) is resubmitted
//   with the SAME inputs and nothing else is started meanwhile: the server
//   drops any pending participation sharing an input with a new one
//   (delete_pending_participations_for_inputs), and an orphan a round takes
//   is lost to us (the server spends its inputs at round time), see ARCHITECTURE.md.
// - Server-rejected coins are quarantined: out of every plan, and locked only
//   when the server said "spent" (so sends skip them too).
// - Every submission goes through the breaker first (breaker.ts).

import {
  BREAKER,
  charge,
  EMPTY_BREAKER,
  pruneAttempts,
  manualReset,
  mayAttempt,
  normalizeBreaker,
  recordFailure,
  recordSuccess,
  resumeOnNewVersion,
  type BreakerState,
} from "./breaker";
import { REFRESH_INPUTS_UNAVAILABLE, REFRESH_LIMIT_EXCEEDED, WALLET_LOCKED_MESSAGE, WALLET_NOT_OPEN } from "../wallet/walletSession";
import {
  bandsFromFeeTable,
  companionReasons,
  DEFAULT_BANDS,
  dedupeVtxos,
  dueReasons,
  planRefresh,
  POLICY,
  watchedExpiryHeight,
  type Bands,
  type Batch,
  type EngineVtxo,
  type Plan,
} from "./plan";

export const ENGINE = {
  // Lock holder ids, so our locks never get confused with bark's own
  // (movement holders) and unlockVtxos can check it's releasing ours.
  HOLDER_REFRESH: "spendrr-refresh",
  HOLDER_QUARANTINE: "spendrr-refresh-quarantine",
  // A quarantined coin whose rejection didn't say "spent" is offered again
  // after this long. "spent" ones only come back by hand.
  QUARANTINE_RETRY_MS: 7 * 24 * 60 * 60_000,
  STUCK_MS: 24 * 60 * 60_000,
  // An uncertain submit (no answer) may have been stored by the server with
  // no local round state: an orphan. The server spends the inputs of every
  // participation when its round is finalized (mark_vtxos_round_spent), so a
  // round that takes an orphan strands the coin: spent server-side, its
  // refreshed output hash-locked with nothing here to claim it. Only a
  // resubmit of the same inputs saves it (the server drops a pending
  // participation sharing any input). So resubmit until the answer is
  // definite, spaced by RESUBMIT_BACKOFF_MS (from the previous attempt), only
  // while the tab is visible and the network works (EngineDeps.canSubmit),
  // and leaving RESUBMIT_RESERVE of the 24 h window to ordinary refreshes.
  // Given up UNCERTAIN_GIVE_UP_MS after the first attempt: by then any orphan
  // has met its round. (Agreed with the user 2026-09-26; it was "twice within
  // 10 min", which in the fuzzer stranded ~3-5x more coins.)
  RESUBMIT_BACKOFF_MS: [1, 2, 5, 10, 20, 40].map((m) => m * 60_000),
  RESUBMIT_RESERVE: 2,
  UNCERTAIN_GIVE_UP_MS: 2 * 60 * 60_000,
  // Inputs of an uncertain submit we gave up on may still sit in a live
  // (orphaned) participation on the server until its round has run. Rounds
  // are hourly; keep them out of any new participation for two.
  ORPHAN_HOLD_MS: 2 * 60 * 60_000,
  // Island threshold: breaker stopped and a coin is this close to expiry.
  URGENT_BLOCKS: 144,
  LOG_MAX: 300,
  // The log lives in localStorage, next to the seed vault, the backup's
  // version marker and everything else the app needs to write. Unbounded it
  // grew to megabytes (a 2-batch dry-run plan logged every minute, every
  // entry carrying every coin twice) and could fill the origin's quota
  // (audit 2026-09-26). So: at most this many coins in detail per entry
  // (the count is kept), and the whole log under LOG_MAX_CHARS.
  LOG_COIN_DETAIL_MAX: 20,
  LOG_MAX_CHARS: 150_000,
  // Isolation (see submitIsolating). The Ark server names a rejected input
  // only in the gRPC metadata `identifiers`, which ark.second.tech's envoy
  // doesn't expose to browsers (Access-Control-Expose-Headers lists only
  // grpc-status/-message/-status-details-bin/-encoding, checked live
  // 2026-09-26), and tonic's Display for Status leaves metadata out, so in
  // this app a rejection never says which coin. The engine finds it itself.
  // Companions left out after a batch passed without them: not offered as
  // companions for this long (they can still be refreshed when due).
  SUSPECT_MS: 24 * 60 * 60_000,
  // Round-time failures carry no coin either (already in use, already
  // registered, banned for the round). A batch whose round failed this many
  // times in a row is split into two isolation groups (a group that fails is
  // split again right away)...
  ROUND_FAILS_ISOLATE: 2,
  // ...and a coin whose round failed this many times while alone goes to
  // quarantine.
  ROUND_FAILS_ALONE: 3,
  // A coin rejected at submit while alone goes to quarantine on this many
  // such rejections (audit 2026-09-26: it was the first).
  ALONE_REJECTS_QUARANTINE: 2,
  // Submissions of the breaker's 24 h window that isolation leaves free for
  // ordinary refreshes (see submit(), `soft`).
  SOFT_RESERVE: 2,
  // A resubmit of several coins rejected as unusable: either the orphan
  // landed (a round spends ALL of a participation's inputs) or one coin was
  // bad all along. The coins are tried alone, one at a time; one that goes
  // through proves no orphan landed, and this many rejected alone strand the
  // whole set (see EngineState.strandCheck).
  STRAND_CHECK_REJECTS: 2,
} as const;

export type RoundKind = "delegated-pending" | "pending" | "ongoing" | "awaiting-confirmations" | "failed" | "canceled";
const NON_FINAL = new Set<string>(["delegated-pending", "pending", "ongoing", "awaiting-confirmations"]);
const KNOWN = new Set<string>([...NON_FINAL, "failed", "canceled"]);

export interface ArkLimits {
  maxVtxoExitDepth: number;
  maxVtxoAmountSats: number | undefined;
  // arkInfo().feeSchedule.refresh; the companion bands come from it
  // (plan.ts bandsFromFeeTable). Absent: the fallback bands.
  refreshFees?: { baseFeeSats: number; ppmExpiryTable: { expiryBlocksThreshold: number; ppm: number }[] } | null;
}

export interface EngineRoundState {
  id: number;
  state?: string;
}

export interface EngineFee {
  feeSats: number;
  netAmountSats: number;
}

// The subset of WalletClient (src/lib/wallet/bark.ts) the engine needs. Integration
// wraps each in withTimeout; a timeout surfaces as a thrown error.
export interface EngineWallet {
  refreshServer(): Promise<void>;
  arkLimits(): Promise<ArkLimits>;
  allVtxos(): Promise<EngineVtxo[]>;
  pendingRoundStates(): Promise<EngineRoundState[]>;
  // Ids of the inputs of every pending round, issued or not (runner.ts: bark
  // 0.7.1's pendingRoundInputVtxos lists only the issued ones).
  pendingRoundInputs(): Promise<string[]>;
  progressPendingRounds(): Promise<void>;
  estimateRefreshFee(vtxoIds: string[]): Promise<EngineFee>;
  // Lock the inputs, submit, unlock, as one worker queue item: a coin a
  // payment took fails the lock (REFRESH_INPUTS_UNAVAILABLE) and nothing is
  // submitted. No lock is left behind either way.
  refreshAndLock(vtxoIds: string[], holderId: string): Promise<{ round: EngineRoundState | undefined }>;
  lockVtxos(vtxoIds: string[], holderId: string): Promise<void>;
  unlockVtxos(vtxoIds: string[], holderId: string): Promise<void>;
}

export interface TrackedBatch {
  ids: string[];
  amountSats: number;
  feeSats: number;
  roundId: number | null;
  at: number;
  manual: boolean;
  // bark was seen holding every input under its round's lock: the server
  // issued the round, the coins are out of the balance and no send can take
  // them. Never set back. Only then does "every input spent" mean the
  // refresh completed (before it, a send may have spent them), and only then
  // does the balance note show.
  locked: boolean;
  // Submitted from an isolation group (see EngineState.groups).
  group?: boolean;
  // See EngineState.submitting; only used when roundId is null.
  afterRoundId?: number;
  // Per-coin detail at submit time, for Settings.
  coins?: LoggedCoin[];
  // Our lock let go while the round is still pending: stuck over STUCK_MS,
  // or "Uvolnit" in Settings. The coins are spendable again; the batch is
  // only kept to see how its round ends.
  released?: boolean;
  // When the lock was let go.
  releasedAt?: number;
  // Released by the user ("Uvolnit mince", or an exit taking the coins):
  // not planned again until the round ends, or for STUCK_MS at most (a round
  // that never ends must not keep them out for good: second audit
  // 2026-09-28). They were planned right away,
  // so the next tick (within a minute) submitted and LOCKED them again, and
  // once the round had picked the participation up (the server only
  // supersedes one not yet assigned to a round, query.rs
  // delete_pending_participations_for_inputs) the resubmit came back
  // "unusable" and quarantined the coin (seen on signet 2026-09-28). A stuck
  // release (STUCK_MS) stays plannable: a new submit may replace a
  // participation the server never issued.
  releasedByUser?: boolean;
}

export interface QuarantineEntry {
  at: number;
  reason: "spent" | "unknown";
  error: string;
}

export type LogKind =
  | "dry-run"
  | "submitted"
  | "fee"
  | "rejected"
  | "uncertain"
  | "resubmitted"
  | "adopted"
  | "uncertain-dropped"
  | "lock-failed"
  | "completed"
  | "round-failed"
  | "unlocked"
  | "quarantined"
  | "quarantine-released"
  | "breaker"
  | "breaker-reset"
  | "suspected"
  | "stranded"
  | "released-ended"
  // A batch whose round ended without bark ever having held its inputs, and
  // some of them went elsewhere (settleLocks): no success, no failure.
  | "ended-unseen"
  | "strand-check"
  | "skipped"
  // A tick ran (note = its outcome). Consecutive ones with the same outcome
  // are one entry: at = the first, until = the last, count = how many.
  | "check";

// One coin of a refresh as the log and Settings show it: what it was worth,
// how close to expiry and how deep it was, and whether it started the refresh
// ("due") or rode along ("companion"), with the rule that put it there.
export interface LoggedCoin {
  id: string;
  amountSats: number;
  blocksLeft: number;
  exitDepth: number;
  role: "due" | "companion";
  reasons: string[];
}

export interface LogEntry {
  at: number;
  kind: LogKind;
  // Only when there are few; coinCount always says how many.
  ids?: string[];
  coinCount?: number;
  amountSats?: number;
  feeSats?: number;
  // amountSats - feeSats: what the new coin is worth.
  outputSats?: number;
  coins?: LoggedCoin[];
  roundId?: number | null;
  error?: string;
  note?: string;
  count?: number;
  until?: number;
}

export function describeCoins(
  ids: readonly string[],
  vtxos: readonly EngineVtxo[],
  tipHeight: number,
  maxExitDepth: number,
  bands: Bands = DEFAULT_BANDS,
): LoggedCoin[] {
  const byId = new Map(vtxos.map((v) => [v.id, v]));
  return ids.flatMap((id) => {
    const v = byId.get(id);
    if (!v) return [];
    const due = dueReasons(v, tipHeight, maxExitDepth);
    return [
      {
        id,
        amountSats: v.amountSats,
        blocksLeft: v.expiryHeight - tipHeight,
        exitDepth: v.exitDepth,
        role: due.length > 0 ? ("due" as const) : ("companion" as const),
        reasons: due.length > 0 ? due : companionReasons(v, tipHeight, bands),
      },
    ];
  });
}

// Appends to the log with the size bounds above. Every writer goes through here.
export function appendLog(log: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const e: LogEntry = { ...entry };
  const count = e.coins?.length ?? e.ids?.length;
  if (count !== undefined) e.coinCount = entry.coinCount ?? count;
  if (e.coins && e.coins.length > ENGINE.LOG_COIN_DETAIL_MAX) e.coins = e.coins.slice(0, ENGINE.LOG_COIN_DETAIL_MAX);
  // The ids are only for counting in the UI; the coins (when there are any) carry them anyway.
  if (e.coins || (e.ids && e.ids.length > ENGINE.LOG_COIN_DETAIL_MAX)) delete e.ids;
  if (e.error) e.error = e.error.slice(0, 300);
  const out = [...log, e].slice(-ENGINE.LOG_MAX);
  let chars = out.reduce((n, x) => n + JSON.stringify(x).length, 0);
  while (out.length > 1 && chars > ENGINE.LOG_MAX_CHARS) chars -= JSON.stringify(out.shift()).length;
  return out;
}

// Coins kept per tracked batch for Settings' "Právě probíhá".
function capCoins(coins: LoggedCoin[]): LoggedCoin[] {
  return coins.slice(0, ENGINE.LOG_COIN_DETAIL_MAX);
}

export interface EngineState {
  v: 1;
  breaker: BreakerState;
  // Written right before a submit, cleared once its outcome is known. Still
  // set on the next tick = the outcome was never seen.
  // afterRoundId: the highest local round-state id that existed before the
  // first attempt. bark's ids are autoincrement, so only a newer state can be
  // the one this submit created (never an older one the SDK path left).
  // lastAt: the latest attempt (the backoff counts from it).
  submitting: { ids: string[]; at: number; lastAt: number; resubmits: number; afterRoundId: number } | null;
  batches: TrackedBatch[];
  quarantine: Record<string, QuarantineEntry>;
  // See ORPHAN_HOLD_MS.
  held: { ids: string[]; until: number }[];
  // Coin id -> until when it isn't offered as a companion (SUSPECT_MS).
  suspects: Record<string, number>;
  // Coin id -> rounds failed in a row (ROUND_FAILS_*).
  roundFails: Record<string, number>;
  // Isolation groups: disjoint sets of coins, each submitted as a batch of
  // its own and halved on every failure until the culprit is alone. Kept
  // across ticks, so the search goes at the pace the breaker allows.
  groups: string[][];
  // Note -> the key it was last logged for, so a condition that holds tick
  // after tick (the same dry-run plan, a batch too small after its fee, the
  // daily window being full) is logged once, not once a minute.
  quiet: Record<string, string>;
  // Coin id -> rejections at submit while alone (ALONE_REJECTS_QUARANTINE).
  aloneRejects: Record<string, number>;
  // Coins a lost submit's orphan participation took (a resubmit found them
  // unusable): spent server-side, refreshed output unclaimable by bark 0.7.0.
  // Out of every plan until released by hand.
  stranded: Record<string, { at: number; error: string }>;
  // A resubmit of several coins rejected as unusable, being told apart from
  // one bad coin (ENGINE.STRAND_CHECK_REJECTS): out of every plan meanwhile,
  // `rejected` = coins rejected alone so far. Stranding the whole set at once
  // left good coins to expire behind one the server never accepted
  // (review 2026-09-26).
  strandCheck: { ids: string[]; error: string; at: number; rejected: string[] } | null;
  // Round-state id -> when a delegated round we don't track was first seen
  // pending; over STUCK_MS it raises the "stuck" island.
  foreignSeen: Record<string, number>;
  log: LogEntry[];
}

export const EMPTY_STATE: EngineState = {
  v: 1,
  breaker: EMPTY_BREAKER,
  submitting: null,
  batches: [],
  quarantine: {},
  held: [],
  suspects: {},
  roundFails: {},
  groups: [],
  quiet: {},
  aloneRejects: {},
  foreignSeen: {},
  stranded: {},
  strandCheck: null,
  log: [],
};

export interface EngineStore {
  load(): EngineState;
  save(state: EngineState): void;
}

export interface EngineDeps {
  wallet: EngineWallet;
  getTipHeight(): Promise<number>;
  store: EngineStore;
  now(): number;
  appVersion: string;
  // Whether a submit may go out now (runner: tab visible, network working).
  // Absent = always.
  canSubmit?(): boolean;
}

export type TickMode = "auto" | "manual" | "dry-run";

export interface EngineStatus {
  breaker: BreakerState["tripped"];
  backoffUntil: number | null;
  // Why backoffUntil is set: the rolling 24 h cap, or a pause after a failure.
  backoffWhy: "rate" | "backoff" | null;
  inRefresh: { amountSats: number; feeSats: number; since: number; locked: boolean; stuck: boolean }[];
  // Sum of confirmed-locked batches: the "+ X sats v obnově mincí" note.
  lockedInRefreshSats: number;
  quarantined: number;
  // Sats in quarantined coins we still hold.
  quarantinedSats: number;
  // Sats in coins over the server's max amount (never refreshed).
  overCapSats: number;
  // Sats a lost submit's orphan took (EngineState.stranded).
  strandedSats: number;
  // All three: the "X sats nejde obnovit" note under the balance.
  unrefreshableSats: number;
  uncertain: boolean;
  // Island: breaker stopped with a coin close to expiry, a refresh stuck, or
  // a coin no refresh will take close to expiry.
  needsAttention: "breaker-urgent" | "stuck" | "unrefreshable-urgent" | null;
  watchedExpiryHeight: number | undefined;
}

export interface TickResult {
  outcome:
    | "idle"
    | "submitted"
    | "resubmitted"
    | "plan-changed"
    | "dry-run"
    | "skip-foreign-pending"
    | "skip-unknown-round"
    | "skip-uncertain"
    | "skip-breaker"
    | "skip-backoff"
    | "skip-rate"
    | "skip-network"
    | "partial"
    | "failed"
    | "error";
  plan?: Plan;
  events: LogEntry[];
  status: EngineStatus;
}

const VTXO_ID_RE = /\b[0-9a-f]{64}:\d+\b/g;
export function vtxoIdsInError(message: string): string[] {
  return [...new Set(message.match(VTXO_ID_RE) ?? [])];
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

// Definite = the server (or bark before sending anything) said no, so nothing
// is live. Anything else might have reached the server: treat as uncertain and
// resubmit the same inputs, which is safe either way.
export function classifySubmitError(message: string, offered: readonly string[]): "definite" | "uncertain" {
  if (vtxoIdsInError(message).some((id) => offered.includes(id))) return "definite";
  if (
    /bad user input|not spendable|already spent|insufficient|below dust|invalid argument|rejected|unusable|does not exist|not found|REFRESH_LIMIT_EXCEEDED/i.test(
      message,
    )
  ) {
    return "definite";
  }
  return "uncertain";
}

// A definite rejection that is about one of the inputs, even though it
// doesn't say which: the server's "input vtxo(s) unusable" (spent or exited,
// round/mod.rs:1970) and "input vtxo does not exist" (NotFound, :601), and
// bark's own pre-checks. Such a rejection is worth isolating; one about the
// whole participation (dust, amount, our own limit) is not.
export function isInputRejection(message: string): boolean {
  if (/REFRESH_LIMIT_EXCEEDED|below dust|insufficient|max.*amount|exceeds/i.test(message)) return false;
  return /unusable|does not exist|not found|not spendable|already spent|already registered|in use|banned|exit depth|must be refreshed|vtxo/i.test(
    message,
  );
}

// A culprit was found and quarantined: the failures that led there are
// explained, so they no longer count toward the breaker's streak. A trip
// that already happened stays (only a success or the user lifts it).
function explainedFailures(b: BreakerState): BreakerState {
  return { ...b, consecutiveFailures: 0, lastFailureAt: null };
}

// Replaces whatever group held any of `ids` with the two halves of `ids`
// (a single coin stays a group of its own, so it keeps going alone).
export function splitGroups(groups: readonly string[][], ids: readonly string[]): string[][] {
  const set = new Set(ids);
  const rest = groups.map((g) => g.filter((id) => !set.has(id))).filter((g) => g.length > 0);
  if (ids.length <= 1) return [...rest, [...ids]];
  const mid = Math.ceil(ids.length / 2);
  return [...rest, ids.slice(0, mid), ids.slice(mid)];
}

export function dropFromGroups(groups: readonly string[][], ids: Iterable<string>): string[][] {
  const set = new Set(ids);
  return groups.map((g) => g.filter((id) => !set.has(id))).filter((g) => g.length > 0);
}

function quarantineReason(message: string): QuarantineEntry["reason"] {
  return /already spent|is spent|double.?spen/i.test(message) ? "spent" : "unknown";
}

function isOurs(v: EngineVtxo | undefined, holder: string): boolean {
  return v?.state.type === "locked" && v.state.holder?.type === "action" && v.state.holder.id === holder;
}

// bark holds an issued round's inputs under the round's movement (round/mod.rs
// progress_delegated). A pending batch's input under a movement lock can only
// be that: the other movement holders (board, lightning receive) lock coins
// they create, not existing ones.
function heldByRound(v: EngineVtxo | undefined): boolean {
  return v?.state.type === "locked" && v.state.holder?.type === "movement";
}

// What the user confirmed on the manual "Obnovit teď" screen. The manual tick
// submits exactly this or nothing (same principle as the send flow's
// SendPlan: the confirmation must describe the call that is made).
export interface ManualExpectation {
  batches: string[][];
  feeSats: number;
}

function sameBatches(a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean {
  const key = (x: readonly (readonly string[])[]) =>
    x
      .map((ids) => [...ids].sort().join(","))
      .sort()
      .join("|");
  return key(a) === key(b);
}

// Everything that loads the engine state, awaits wallet calls and saves it
// again runs here, one at a time per page: a tick, the lock sweep, a
// quarantine release. Two of them interleaved used to save over each other
// (the open-time sweep dropped a batch a concurrent tick had just submitted,
// then released its lock as an orphan; found by the interleaving fuzzer).
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

export function tick(deps: EngineDeps, mode: TickMode = "auto", opts: { expect?: ManualExpectation } = {}): Promise<TickResult> {
  return exclusive(async () => {
    const r = await tickInner(deps, mode, opts.expect);
    // An "error" tick already logged why (or the session closed mid-tick).
    if (r.outcome !== "error") deps.store.save(recordCheck(deps.store.load(), r.outcome, deps.now()));
    return r;
  });
}

// The log shows every check, not just the ticks that did something, without
// a line a minute: a repeat of the same outcome extends the last entry.
export function recordCheck(state: EngineState, outcome: TickResult["outcome"], now: number): EngineState {
  const last = state.log.at(-1);
  if (last?.kind === "check" && last.note === outcome) {
    const merged: LogEntry = { ...last, until: now, count: (last.count ?? 1) + 1 };
    return { ...state, log: [...state.log.slice(0, -1), merged] };
  }
  return { ...state, log: appendLog(state.log, { at: now, kind: "check", note: outcome, count: 1 }) };
}

async function tickInner(deps: EngineDeps, mode: TickMode, expect: ManualExpectation | undefined): Promise<TickResult> {
  const { wallet } = deps;
  const events: LogEntry[] = [];
  let state = deps.store.load();
  state = { ...state, breaker: resumeOnNewVersion(normalizeBreaker(state.breaker), deps.appVersion) };
  const log = (e: Omit<LogEntry, "at">) => {
    const entry = { at: deps.now(), ...e };
    events.push(entry);
    state = { ...state, log: appendLog(state.log, entry) };
  };
  // Logs `e` unless the same `note` was last logged for the same `key`.
  const logOnce = (note: string, key: string, e: Omit<LogEntry, "at">) => {
    if (state.quiet[note] === key) return;
    state = { ...state, quiet: { ...state.quiet, [note]: key } };
    log(e);
  };
  // A dry run changes nothing but the log (and a breaker resume), so saving
  // is safe there too.
  const save = () => deps.store.save(state);
  const dry = mode === "dry-run";
  // What the tick actually did, for its outcome: a submit that went out, or
  // why the one that didn't was held back (not a failure: the window was
  // full, the tab hidden or the network down).
  let submittedAny = false;
  let heldBack: "skip-rate" | "skip-network" | null = null;

  let vtxos: EngineVtxo[] = [];
  let tip = 0;
  let maxExitDepth = Number.POSITIVE_INFINITY;
  let bands: Bands = DEFAULT_BANDS;
  let maxAmountSats: number | undefined;
  try {
    if (!dry) {
      // Best-effort housekeeping the daemon used to do. Neither may stop a tick.
      await wallet.progressPendingRounds().catch(() => {});
      await wallet.refreshServer().catch(() => {});
    }
    const limits = await wallet.arkLimits();
    maxExitDepth = limits.maxVtxoExitDepth;
    bands = bandsFromFeeTable(limits.refreshFees);
    maxAmountSats = limits.maxVtxoAmountSats;
    tip = await deps.getTipHeight();
    let rounds = await wallet.pendingRoundStates();
    vtxos = dedupeVtxos(await wallet.allVtxos());

    if (dry) {
      // Nothing live here, but locks a live session left behind still have to
      // be released once their round is over (or when nothing covers them).
      const settled = await settleLocks({ state, wallet, now: deps.now(), appVersion: deps.appVersion, live: false }, vtxos, rounds);
      state = settled.state;
      events.push(...settled.events);
      vtxos = dedupeVtxos(await wallet.allVtxos());
    } else {
      // A resubmit of an uncertain submit is this tick's one action.
      const again = await reconcile(rounds);
      if (again !== null && again !== "wait") {
        save();
        // Not the user's manual refresh: an earlier submit went out again,
        // or tried to (what it came to, not just that it was attempted).
        return result(again === "ok" ? "resubmitted" : (heldBack ?? "failed"));
      }
      // reconcile may have locked/unlocked: read again before planning.
      vtxos = dedupeVtxos(await wallet.allVtxos());
      rounds = await wallet.pendingRoundStates();
    }

    // In a dry run the SDK's own refresh is still live, so its participations
    // show up as "foreign": note the gate, plan anyway, so the log can be
    // compared with what the SDK did.
    let gate: TickResult["outcome"] | null = null;
    const tracked = new Set(state.batches.map((b) => b.roundId).filter((id) => id !== null));
    // A delegated participation we don't track (the SDK path's, one from
    // before a switch to live, a restored backup's) leaves its inputs
    // spendable; a submit sharing one would make the server drop it. Its
    // inputs are kept out of the plan. It used to stop the engine altogether
    // until that round ended, which could be never (audit 2026-09-26).
    const foreign = rounds.filter((r) => r.state === "delegated-pending" && !tracked.has(r.id));
    const nowMs = deps.now();
    state = {
      ...state,
      foreignSeen: Object.fromEntries(foreign.map((r) => [String(r.id), state.foreignSeen[String(r.id)] ?? nowMs])),
    };
    let foreignInputs = new Set<string>();
    if (rounds.some((r) => typeof r.state !== "string" || !KNOWN.has(r.state))) gate = "skip-unknown-round";
    else {
      const f = await foreignRoundInputs(state, rounds, wallet);
      if (f === null) gate = "skip-foreign-pending";
      else foreignInputs = f;
      if (!gate && state.submitting) gate = "skip-uncertain";
    }
    if (gate && !dry) {
      save();
      return result(gate);
    }

    if (mode === "manual") {
      if (state.breaker.tripped) log({ kind: "breaker-reset", note: "manual" });
      state = { ...state, breaker: manualReset(state.breaker) };
    } else if (!dry) {
      const verdict = mayAttempt(state.breaker, deps.now());
      if (!verdict.ok) {
        save();
        return result(verdict.why === "tripped" ? "skip-breaker" : verdict.why === "rate" ? "skip-rate" : "skip-backoff");
      }
      if (state.strandCheck) {
        const r = await strandCheckStep();
        if (r !== "done") {
          save();
          return result(r === "submitted" ? "submitted" : (heldBack ?? "failed"));
        }
      }
    }

    const plan = planRefresh(planInput(state, vtxos, tip, limits, deps.now(), foreignInputs, mode === "manual"));
    if (plan.batches.length === 0) {
      save();
      return result(mode === "manual" && expect ? "plan-changed" : "idle", plan);
    }

    const fees = new Map<Batch, EngineFee>();
    for (const batch of plan.batches) fees.set(batch, await wallet.estimateRefreshFee(batch.ids));
    if (mode === "manual" && expect) {
      const total = [...fees.values()].reduce((sum, f) => sum + f.feeSats, 0);
      if (!sameBatches(plan.batches.map((b) => b.ids), expect.batches) || total > expect.feeSats) {
        log({ kind: "skipped", note: "manual-plan-changed" });
        save();
        return result("plan-changed", plan);
      }
    }

    const dryPlanKey = plan.batches.map((b) => b.ids.join()).join("|");
    const dryPlanLogged = dry && state.quiet["dry-run"] === dryPlanKey;
    if (dry) state = { ...state, quiet: { ...state.quiet, "dry-run": dryPlanKey } };
    for (const batch of plan.batches) {
      const fee = fees.get(batch)!;
      if (fee.netAmountSats < POLICY.DUST_SATS) {
        logOnce("below-dust-after-fee", batch.ids.join(), {
          kind: "skipped",
          ids: batch.ids,
          amountSats: batch.amountSats,
          feeSats: fee.feeSats,
          note: "below-dust-after-fee",
        });
        continue;
      }
      if (dry) {
        // Once per distinct plan (all of its batches), not every tick. It
        // used to compare with the last dry-run entry only, so a plan of two
        // batches alternated and logged both every minute.
        if (dryPlanLogged) continue;
        log({
          kind: "dry-run",
          ids: batch.ids,
          amountSats: batch.amountSats,
          feeSats: fee.feeSats,
          outputSats: fee.netAmountSats,
          coins: describeCoins(batch.ids, vtxos, tip, maxExitDepth, bands),
          note: gate ?? undefined,
        });
        continue;
      }
      const ok = await submitIsolating(batch, fee.feeSats, mode === "manual");
      if (!ok) {
        save();
        // Some batch went out and a later one didn't: say so, a manual refresh
        // must not read as done.
        return result(submittedAny ? "partial" : (heldBack ?? "failed"), plan);
      }
    }
    save();
    return result(dry ? "dry-run" : submittedAny ? "submitted" : (heldBack ?? "idle"), plan);
  } catch (e) {
    // A read failed (network, timeout). Nothing was submitted in this branch:
    // submit() handles its own errors. Keep whatever was learned. A lock in
    // the middle of a tick isn't an error worth a log line: it filled the
    // log with "Přeskočeno · chyba kontroly" after every (auto-)lock.
    const error = errorText(e).slice(0, 300);
    if (!error.startsWith(WALLET_NOT_OPEN) && !error.startsWith(WALLET_LOCKED_MESSAGE)) log({ kind: "skipped", error, note: "tick-error" });
    save();
    return result("error");
  }

  // ---- helpers (closures over state) ----

  // Returns true when it resubmitted an uncertain submit.
  // `rounds` is the tick's own read, made BEFORE the coins: read after them, a
  // sync() in between that finishes a round made the batch look failed (its
  // coins not yet spent in our copy, its round already gone; second audit
  // 2026-09-28). The other way round a finished round just looks pending for
  // one more tick.
  // Returns what a resubmit of an uncertain submit came to, null when none ran.
  async function reconcile(rounds: readonly EngineRoundState[]): Promise<Awaited<ReturnType<typeof submit>> | null> {
    let resubmitted: Awaited<ReturnType<typeof submit>> | null = null;
    const byId = new Map(vtxos.map((v) => [v.id, v]));
    const now = deps.now();

    // 1. Batches and every lock we hold (see settleLocks).
    const settled = await settleLocks({ state, wallet, now, appVersion: deps.appVersion, live: true }, vtxos, rounds);
    state = settled.state;
    events.push(...settled.events);
    // settleLocks may have unlocked/relocked: its view of the coins wins.
    for (const [id, v] of settled.byId) byId.set(id, v);

    // 2. A submit whose outcome we never saw.
    const s = state.submitting;
    if (s) {
      const tracked = new Set(state.batches.map((b) => b.roundId));
      // Only a delegated state newer than anything that existed before the
      // submit can be ours; if a resubmit landed too, the newest one is live
      // (the server superseded the first).
      const orphan = rounds
        .filter((x) => x.state === "delegated-pending" && x.id > s.afterRoundId && !tracked.has(x.id))
        .sort((a, b) => b.id - a.id)[0];
      // Spendable, or still under the lock the worker took for that submit.
      const stillSpendable = s.ids.every((id) => {
        const v = byId.get(id);
        return v?.state.type === "spendable" || isOurs(v, ENGINE.HOLDER_REFRESH);
      });
      if (orphan) {
        // bark stored the round state, so the call did go through.
        const amountSats = s.ids.reduce((sum, id) => sum + (byId.get(id)?.amountSats ?? 0), 0);
        state = { ...state, submitting: null, breaker: recordSuccess(state.breaker) };
        log({ kind: "adopted", ids: s.ids, roundId: orphan.id });
        // A lock of ours a killed worker left would stop bark from taking
        // the round: let it go now (settleLocks would only next tick).
        const ours = s.ids.filter((id) => isOurs(byId.get(id), ENGINE.HOLDER_REFRESH));
        if (ours.length > 0) {
          try {
            await wallet.unlockVtxos(ours, ENGINE.HOLDER_REFRESH);
            for (const id of ours) byId.set(id, { ...byId.get(id)!, state: { type: "spendable" } });
            log({ kind: "unlocked", ids: ours, roundId: orphan.id, note: "handover" });
          } catch (e) {
            log({ kind: "lock-failed", ids: ours, error: errorText(e).slice(0, 300), note: "unlock" });
          }
        }
        state = {
          ...state,
          batches: [
            ...state.batches,
            { ids: s.ids, amountSats, feeSats: 0, roundId: orphan.id, at: s.at, manual: false, locked: false, afterRoundId: s.afterRoundId },
          ],
        };
      } else if (!stillSpendable) {
        // Some input moved on (spent by a send, locked by something else):
        // the old participation, if it exists, can't complete as submitted.
        state = { ...state, submitting: null, held: [...state.held, { ids: s.ids, until: now + ENGINE.ORPHAN_HOLD_MS }] };
        log({ kind: "uncertain-dropped", ids: s.ids });
      } else if (now - s.at > ENGINE.UNCERTAIN_GIVE_UP_MS) {
        // Past the resubmit window: give it up, keep its inputs out of any
        // new participation until a possible orphan's round has run.
        // The episode never got an answer, so it counts as ONE failure (not
        // one per attempt): a server that keeps answering "internal error"
        // used to be classified uncertain forever, never tripped the
        // breaker and burned 6 key indices a day (audit 2026-09-26).
        state = {
          ...state,
          submitting: null,
          held: [...state.held, { ids: s.ids, until: now + ENGINE.ORPHAN_HOLD_MS }],
          breaker: recordFailure(state.breaker, now, deps.appVersion),
        };
        log({ kind: "uncertain-dropped", ids: s.ids, note: "gave-up" });
        if (state.breaker.tripped) log({ kind: "breaker", note: state.breaker.tripped.reason });
      } else {
        const backoff = ENGINE.RESUBMIT_BACKOFF_MS;
        const due = now - s.lastAt >= backoff[Math.min(s.resubmits, backoff.length - 1)];
        const room = pruneAttempts(state.breaker, now).attempts.length < BREAKER.MAX_ATTEMPTS_PER_WINDOW - ENGINE.RESUBMIT_RESERVE;
        const amountSats = s.ids.reduce((sum, id) => sum + (byId.get(id)?.amountSats ?? 0), 0);
        const verdict = mayAttempt(state.breaker, now, { urgent: true });
        if (due && room && verdict.ok) {
          let feeSats = 0;
          try {
            feeSats = (await wallet.estimateRefreshFee(s.ids)).feeSats;
          } catch {
            // Only for the log; the resubmit itself matters more.
          }
          resubmitted = await submit(s.ids, amountSats, feeSats, { manual: false, resubmit: true, countFailure: true });
        }
      }
    }

    // 3. Quarantine: forget coins we no longer hold, release old "unknown" ones.
    const q: Record<string, QuarantineEntry> = {};
    for (const [id, entry] of Object.entries(state.quarantine)) {
      const v = byId.get(id);
      if (!v || v.state.type === "spent" || v.state.type === "exited") continue;
      if (entry.reason === "unknown" && now - entry.at >= ENGINE.QUARANTINE_RETRY_MS) {
        try {
          if (isOurs(v, ENGINE.HOLDER_QUARANTINE)) await wallet.unlockVtxos([id], ENGINE.HOLDER_QUARANTINE);
          log({ kind: "quarantine-released", ids: [id] });
          continue;
        } catch {
          // keep it; next tick tries again
        }
      }
      q[id] = entry;
    }
    const held = (id: string) => {
      const v = byId.get(id);
      return v !== undefined && v.state.type !== "spent" && v.state.type !== "exited";
    };
    state = {
      ...state,
      quarantine: q,
      held: state.held.filter((h) => h.until > now),
      suspects: Object.fromEntries(Object.entries(state.suspects).filter(([id, until]) => until > now && held(id))),
      roundFails: Object.fromEntries(Object.entries(state.roundFails).filter(([id]) => held(id))),
      aloneRejects: Object.fromEntries(Object.entries(state.aloneRejects).filter(([id]) => held(id) && !q[id])),
      stranded: Object.fromEntries(Object.entries(state.stranded).filter(([id]) => held(id))),
      strandCheck: (() => {
        const c = state.strandCheck;
        if (!c) return null;
        const ids = c.ids.filter(held);
        return ids.length === 0 ? null : { ...c, ids, rejected: c.rejected.filter(held) };
      })(),
      // A group left under dust can never go alone (planRefresh drops it) and
      // kept its coins out of every other batch for good: dissolve it, they
      // ride along as companions again.
      groups: state.groups
        .map((g) => g.filter((id) => held(id) && !q[id]))
        .filter((g) => g.reduce((sum, id) => sum + (byId.get(id)?.amountSats ?? 0), 0) >= POLICY.DUST_SATS),
    };
    save();
    return resubmitted;
  }

  // One refreshAndLock() call. "ok": submitted and tracked.
  // "input": a definite rejection about an input that named none we offered
  // (worth isolating). "stop": anything else; the tick submits nothing more.
  async function submit(
    ids: string[],
    amountSats: number,
    feeSats: number,
    opts: { manual: boolean; resubmit: boolean; countFailure: boolean; note?: string; soft?: boolean },
  ): Promise<"ok" | "input" | "stop" | "defer" | "wait"> {
    const { manual, resubmit } = opts;
    const now = deps.now();
    // Hidden tab or a network that doesn't work: a reply lost on its way back
    // is how an orphan starts (iOS kills a backgrounded request), so nothing
    // goes out now; nothing is charged either.
    if (deps.canSubmit && !deps.canSubmit()) {
      logOnce("waits-network", "1", { kind: "skipped", note: "waits-network" });
      heldBack = "skip-network";
      save();
      return "wait";
    }
    // Soft (isolation): wait rather than trip, and leave SOFT_RESERVE
    // submissions of the window to ordinary refreshes.
    if (opts.soft && pruneAttempts(state.breaker, now).attempts.length >= BREAKER.MAX_ATTEMPTS_PER_WINDOW - ENGINE.SOFT_RESERVE) {
      logOnce("isolation-waits", ids.join(), { kind: "skipped", ids, note: "isolation-waits" });
      heldBack = "skip-rate";
      save();
      return "defer";
    }
    const charged = charge(state.breaker, now);
    const unchargedAttempts = pruneAttempts(state.breaker, now).attempts;
    state = { ...state, breaker: charged.state };
    if (!charged.ok) {
      if (charged.state.tripped) {
        log({ kind: "breaker", note: charged.state.tripped.reason });
      } else {
        // Window full: this waits for a free slot (never trips), and a
        // resubmit that can't go out before its 10 min window just lapses.
        logOnce("rate-waits", ids.join(), { kind: "skipped", ids, note: "rate-waits" });
        heldBack = "skip-rate";
      }
      save();
      return "stop";
    }
    const prev = resubmit ? state.submitting : null;
    let afterRoundId = prev?.afterRoundId;
    if (afterRoundId === undefined) {
      try {
        afterRoundId = Math.max(-1, ...(await wallet.pendingRoundStates()).map((x) => x.id));
      } catch {
        // Unknown: never adopt for this submit, resubmit instead (safe).
        afterRoundId = Number.POSITIVE_INFINITY;
      }
    }
    state = {
      ...state,
      submitting: { ids, at: prev?.at ?? now, lastAt: now, resubmits: resubmit ? (prev?.resubmits ?? 0) + 1 : 0, afterRoundId },
    };
    // Persisted BEFORE the call: if it never returns, the next tick knows.
    save();

    // Snapshot of the coins as they are now, for the log and Settings.
    const coins = describeCoins(ids, vtxos, tip, maxExitDepth, bands);
    let round: EngineRoundState | undefined;
    try {
      ({ round } = await wallet.refreshAndLock(ids, ENGINE.HOLDER_REFRESH));
    } catch (e) {
      // Decided on the whole text: at 66 characters per id, a cut at 300 lost
      // the tail of the server's list (turning "all named" into "some") and
      // the reason after it. appendLog and the stored entries cut it.
      const error = errorText(e);
      const fullError = error;
      if (error.startsWith(WALLET_NOT_OPEN) || error.startsWith(WALLET_LOCKED_MESSAGE)) {
        // The session closed before the submit's turn in the queue: it never
        // ran. Refunded; a resubmit's earlier uncertain record stays as it was.
        state = { ...state, breaker: { ...state.breaker, attempts: unchargedAttempts }, submitting: prev };
        save();
        return "stop";
      }
      if (error.startsWith(REFRESH_LIMIT_EXCEEDED)) {
        // The worker's own 24 h cap (walletSpendPolicy.ts), hit when this
        // state lost track of attempts (localStorage wiped within one worker's
        // life): nothing went out, it waits like a full window, not a failure.
        state = { ...state, breaker: { ...state.breaker, attempts: unchargedAttempts }, submitting: prev };
        logOnce("rate-waits", ids.join(), { kind: "skipped", ids, note: "rate-waits" });
        heldBack = "skip-rate";
        save();
        return "stop";
      }
      if (error.startsWith(REFRESH_INPUTS_UNAVAILABLE)) {
        // An input changed since the plan (a payment took it): nothing was
        // submitted and no key index was used, so the attempt is refunded
        // and the next tick plans again. On a resubmit it means the earlier
        // participation lost an input (the server drops it then), so the
        // uncertain record goes the way a spent input always sent it.
        state = {
          ...state,
          breaker: { ...state.breaker, attempts: unchargedAttempts },
          submitting: null,
          held: resubmit ? [...state.held, { ids, until: deps.now() + ENGINE.ORPHAN_HOLD_MS }] : state.held,
        };
        logOnce("inputs-changed", ids.join(), { kind: "skipped", ids, note: "inputs-changed" });
        save();
        return "stop";
      }
      if (classifySubmitError(fullError, ids) === "uncertain") {
        log({ kind: "uncertain", ids, amountSats, error });
        save();
        return "stop";
      }
      state = { ...state, submitting: null };
      const named = vtxoIdsInError(fullError).filter((id) => ids.includes(id));
      if (resubmit && isInputRejection(error) && named.length > 0) {
        // The server lists EVERY unusable input (round/mod.rs: the loop over
        // all inputs before `badarg!("input vtxo(s) unusable")`), so the text
        // answers the orphan question by itself: a round takes all of a
        // participation's inputs, so all of them named = the orphan landed;
        // only some = no orphan took the set, just those coins are bad.
        if (named.length === ids.length) {
          strand(ids, error);
        } else {
          log({ kind: "rejected", ids, amountSats, error, note: "resubmit" });
          state = { ...state, held: [...state.held, { ids: ids.filter((id) => !named.includes(id)), until: deps.now() + ENGINE.ORPHAN_HOLD_MS }] };
          await namedRejection(named, error);
        }
        save();
        return "stop";
      }
      if (resubmit && isInputRejection(error)) {
        // Unusable to the server now: most likely the lost first submit
        // landed and a round took it. The coins are stranded (see
        // ENGINE.RESUBMIT_BACKOFF_MS): out of every plan, shown to the user,
        // not the engine's failure. With several coins it may instead be one
        // bad coin (the text never says which): checked first.
        if (ids.length > 1) {
          state = { ...state, strandCheck: { ids, error: error.slice(0, 300), at: deps.now(), rejected: [] } };
          log({ kind: "rejected", ids, amountSats, error, note: "strand-check" });
        } else {
          strand(ids, error);
        }
        save();
        return "stop";
      }
      if (opts.countFailure) state = { ...state, breaker: recordFailure(state.breaker, deps.now(), deps.appVersion) };
      if (resubmit) state = { ...state, held: [...state.held, { ids, until: deps.now() + ENGINE.ORPHAN_HOLD_MS }] };
      log({ kind: "rejected", ids, amountSats, error, note: resubmit ? "resubmit" : opts.note });
      if (state.breaker.tripped) log({ kind: "breaker", note: state.breaker.tripped.reason });
      // On a resubmit the rejection may be about the orphaned first
      // participation, not the coin: never quarantine or isolate on it.
      if (resubmit) {
        save();
        return "stop";
      }
      // The strand check keeps its own count of coins rejected alone.
      if (opts.note === "strand-check" && isInputRejection(error)) {
        save();
        return "input";
      }
      if (named.length > 0) {
        await namedRejection(named, error);
        save();
        return "stop";
      }
      save();
      return isInputRejection(error) ? "input" : "stop";
    }

    const { "rate-waits": _r, "isolation-waits": _i, "inputs-changed": _c, "waits-network": _w, ...quiet } = state.quiet;
    void _r;
    void _i;
    void _c;
    void _w;
    state = {
      ...state,
      quiet,
      submitting: null,
      breaker: recordSuccess(state.breaker),
      batches: [
        ...state.batches,
        {
          ids,
          amountSats,
          feeSats,
          roundId: round?.id ?? null,
          at: deps.now(),
          manual,
          // bark takes the inputs only once the server issues the round.
          locked: false,
          group: opts.soft ?? false,
          afterRoundId,
          coins: capCoins(coins),
        },
      ],
    };
    log({
      kind: resubmit ? "resubmitted" : "submitted",
      ids,
      amountSats,
      feeSats,
      outputSats: amountSats - feeSats,
      coins,
      roundId: round?.id ?? null,
      note: manual ? "manual" : opts.note,
    });
    // Never skipped for a fee (agreed), but always visible afterwards.
    if (feeSats > 0 && !manual) log({ kind: "fee", ids, feeSats, amountSats });
    submittedAny = true;
    save();
    return "ok";
  }

  // Ids in a rejection: bark's own pre-checks name them, and so does the
  // 0.23.0 wasm for the server's "unusable" (it prints the structured
  // unusable_inputs: "unusable inputs: [<id>]: bad user input: input vtxo(s)
  // unusable", seen on signet 2026-09-28). A named coin gets the same second
  // chance as a lone one (ALONE_REJECTS_QUARANTINE): it went to quarantine on
  // the first, for a week, even at 249 blocks left. "spent" is final.
  async function namedRejection(named: string[], error: string): Promise<void> {
    const aloneRejects = { ...state.aloneRejects };
    const again: string[] = [];
    for (const id of named) {
      const n = (aloneRejects[id] ?? 0) + 1;
      if (n >= ENGINE.ALONE_REJECTS_QUARANTINE || quarantineReason(error) === "spent") {
        again.push(id);
        delete aloneRejects[id];
      } else {
        aloneRejects[id] = n;
      }
    }
    state = { ...state, aloneRejects };
    if (again.length > 0) {
      await quarantine(again, error);
      state = { ...state, breaker: explainedFailures(state.breaker) };
    }
  }

  // A batch, and if the server rejects an input without saying which (see
  // ENGINE.SUSPECT_MS for why it never says), the search for it:
  // 1. the due coins alone: if they pass, the culprit is a companion; the
  //    companions are left out as companions for a day (not quarantined:
  //    innocent ones among them may be close to expiry);
  // 2. otherwise the due coins become two isolation groups, each tried on its
  //    own and halved again when rejected, until the culprit is alone and goes
  //    to quarantine. Groups that pass are real refreshes.
  // Only the first rejection counts toward the failure streak, and finding
  // the culprit clears it. Isolation attempts are charged softly: when the
  // window is (nearly) full they wait (the groups are persisted and the next
  // tick goes on) instead of tripping the breaker. Returns false to stop the tick.
  async function submitIsolating(batch: Batch, feeSats: number, manual: boolean): Promise<boolean> {
    if (batch.group) return runGroup(batch.due.map((v) => v.id), batch.amountSats, feeSats, manual);

    const first = await submit(batch.ids, batch.amountSats, feeSats, { manual, resubmit: false, countFailure: true });
    if (first !== "input") return first === "ok";

    if (batch.companions.length > 0) {
      const r = await attempt(batch.due.map((v) => v.id), manual, "without-companions");
      if (r === "ok") {
        const until = deps.now() + ENGINE.SUSPECT_MS;
        const ids = batch.companions.map((v) => v.id);
        state = { ...state, suspects: { ...state.suspects, ...Object.fromEntries(ids.map((id) => [id, until])) } };
        log({ kind: "suspected", ids });
        save();
        return true;
      }
      if (r === "stop") return false;
      if (r === "defer" || r === "wait") {
        state = { ...state, groups: splitGroups(state.groups, batch.due.map((v) => v.id)) };
        save();
        return false;
      }
      if (r === "skip") return true;
    }
    return rejectedSet(batch.due.map((v) => v.id), manual);
  }

  // `ids` was rejected as a whole: quarantine a lone coin, else split it into
  // groups and try both halves now, as far as the budget allows.
  async function rejectedSet(ids: string[], manual: boolean): Promise<boolean> {
    if (ids.length === 1) {
      // A lone coin goes to quarantine on its second rejection alone, not its
      // first: a wallet with one due coin used to lose it (hidden, locked)
      // on a single "unusable" (audit 2026-09-26). The first one keeps it as
      // a group of its own, tried again after the usual wait.
      const [id] = ids;
      const n = (state.aloneRejects[id] ?? 0) + 1;
      if (n < ENGINE.ALONE_REJECTS_QUARANTINE) {
        state = { ...state, aloneRejects: { ...state.aloneRejects, [id]: n }, groups: splitGroups(state.groups, ids) };
        save();
        return false;
      }
      const { [id]: _gone, ...aloneRejects } = state.aloneRejects;
      void _gone;
      state = { ...state, aloneRejects };
      await quarantine(ids, "rejected alone after isolation");
      state = { ...state, groups: dropFromGroups(state.groups, ids), breaker: explainedFailures(state.breaker) };
      save();
      return true;
    }
    state = { ...state, groups: splitGroups(state.groups, ids) };
    save();
    const mid = Math.ceil(ids.length / 2);
    const [a, b] = [ids.slice(0, mid), ids.slice(mid)];
    const ra = await tryGroup(a, undefined, undefined, manual);
    if (ra === "stop" || ra === "defer" || ra === "wait") return false;
    if (ra === "input" && !(await rejectedSet(a, manual))) return false;
    // `a` passed, so the culprit is in `b`: no need to try `b` whole.
    if (ra === "ok") return rejectedSet(b, manual);
    return runGroup(b, undefined, undefined, manual);
  }

  async function tryGroup(ids: string[], amount: number | undefined, fee: number | undefined, manual: boolean) {
    const r = await attempt(ids, manual, "isolation", amount, fee);
    if (r === "ok") {
      state = { ...state, groups: dropFromGroups(state.groups, ids) };
      save();
    }
    return r;
  }

  async function runGroup(ids: string[], amount: number | undefined, fee: number | undefined, manual: boolean): Promise<boolean> {
    const r = await tryGroup(ids, amount, fee, manual);
    if (r === "input") return rejectedSet(ids, manual);
    // "skip": too small to try on its own; the group waits for later.
    return r === "ok" || r === "skip";
  }

  async function attempt(
    ids: string[],
    manual: boolean,
    note: string,
    knownAmount?: number,
    knownFee?: number,
  ): Promise<"ok" | "input" | "stop" | "skip" | "defer" | "wait"> {
    const byId = new Map(vtxos.map((v) => [v.id, v]));
    const amountSats = knownAmount ?? ids.reduce((sum, id) => sum + (byId.get(id)?.amountSats ?? 0), 0);
    if (amountSats < POLICY.DUST_SATS) return "skip";
    let feeSats = knownFee;
    if (feeSats === undefined) {
      const fee = await wallet.estimateRefreshFee(ids);
      if (fee.netAmountSats < POLICY.DUST_SATS) return "skip";
      feeSats = fee.feeSats;
    }
    return submit(ids, amountSats, feeSats, { manual, resubmit: false, countFailure: false, note, soft: true });
  }

  function strand(ids: string[], error: string): void {
    if (ids.length === 0) return;
    const amountSats = ids.reduce((sum, id) => sum + (vtxos.find((v) => v.id === id)?.amountSats ?? 0), 0);
    state = {
      ...state,
      stranded: { ...state.stranded, ...Object.fromEntries(ids.map((id) => [id, { at: deps.now(), error: error.slice(0, 300) }])) },
    };
    log({ kind: "stranded", ids, amountSats, error });
  }

  // One step of ENGINE.STRAND_CHECK_REJECTS. "done": nothing (more) to submit
  // this tick, plan as usual; "submitted": a coin went through alone (the
  // check is over, and that was a real refresh); "stop": wait for a later tick.
  async function strandCheckStep(): Promise<"done" | "submitted" | "stop"> {
    const byId = new Map(vtxos.map((v) => [v.id, v]));
    let c = state.strandCheck!;
    const finish = (note: string, toStrand: string[]) => {
      state = { ...state, strandCheck: null };
      log({ kind: "strand-check", ids: c.ids, note });
      strand(toStrand, c.error);
    };
    for (;;) {
      // A coin that went out alone got through after all (an uncertain
      // try that was adopted or resubmitted): no orphan took the set.
      const inBatch = new Set(state.batches.filter((b) => !b.released).flatMap((b) => b.ids));
      if (c.ids.some((id) => inBatch.has(id))) return passed();
      const rejected = new Set([...c.rejected, ...c.ids.filter((id) => state.stranded[id] || state.quarantine[id])]);
      const held = c.ids.filter((id) => {
        const t = byId.get(id)?.state.type;
        return t === "spendable" || t === "locked";
      });
      if (rejected.size >= ENGINE.STRAND_CHECK_REJECTS) {
        finish("landed", held.filter((id) => !state.stranded[id] && !state.quarantine[id]));
        return "done";
      }
      const busy = inFlightIds(state, deps.now());
      const candidates = held
        .filter((id) => !rejected.has(id) && byId.get(id)!.state.type === "spendable" && !busy.has(id))
        .sort((a, b) => byId.get(a)!.expiryHeight - byId.get(b)!.expiryHeight);
      if (candidates.length === 0) {
        // Waiting out an earlier try's hold, or nothing left to try with.
        if (held.some((id) => busy.has(id))) return "done";
        finish("inconclusive", held.filter((id) => rejected.has(id) && !state.stranded[id] && !state.quarantine[id]));
        return "done";
      }
      let r: Awaited<ReturnType<typeof attempt>> = "skip";
      let tried = "";
      for (const id of candidates) {
        tried = id;
        r = await attempt([id], false, "strand-check");
        if (r !== "skip") break;
      }
      if (r === "ok") return passed("submitted");
      if (r === "skip") {
        // Every candidate is too small to go alone: can't tell, give the
        // untested ones back to the planner.
        finish("inconclusive", [...rejected].filter((id) => held.includes(id) && !state.stranded[id] && !state.quarantine[id]));
        return "done";
      }
      if (r !== "input") return "stop";
      c = { ...c, rejected: [...c.rejected, tried] };
      state = { ...state, strandCheck: c };
      save();
    }

    function passed(outcome: "done" | "submitted" = "done"): "done" | "submitted" {
      // The coins rejected alone meanwhile count as rejections alone; the
      // rest go back to the planner (and to isolation, should the bad coin
      // be among them).
      const aloneRejects = { ...state.aloneRejects };
      for (const id of c.rejected) aloneRejects[id] = (aloneRejects[id] ?? 0) + 1;
      state = { ...state, aloneRejects, strandCheck: null };
      log({ kind: "strand-check", ids: c.ids, note: "passed" });
      return outcome;
    }
  }

  async function quarantine(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    const reason = quarantineReason(error);
    for (const id of ids) {
      state = { ...state, quarantine: { ...state.quarantine, [id]: { at: deps.now(), reason, error: error.slice(0, 300) } } };
    }
    log({ kind: "quarantined", ids, error, note: reason });
    // Only a coin the server called spent is locked (so sends skip it too).
    // "unknown" only keeps it out of every plan: the lock hid real money
    // from the balance on a guess, for a week (audit 2026-09-26).
    if (reason !== "spent") return;
    try {
      await wallet.lockVtxos(ids, ENGINE.HOLDER_QUARANTINE);
    } catch {
      // A coin the server calls spent may not be lockable locally; the
      // quarantine entry alone still keeps it out of every plan.
    }
  }

  function result(outcome: TickResult["outcome"], plan?: Plan): TickResult {
    return { outcome, plan, events, status: engineStatus(state, vtxos, tip, deps.now(), { maxAmountSats }) };
  }
}

// --- locks ------------------------------------------------------------------

// Our locks live in bark's IndexedDB; what they belong to lives in this
// engine's state (localStorage). The two can drift apart: the engine switched
// out of "live", the v2 toggle off (V1 never ticks), localStorage wiped (iOS
// ITP, a Home Screen install), a cloud-backup restore on another device (the
// backup carries the locks, not the engine state). A lock nobody tracks would
// keep its coin out of the balance and out of every refresh until it expired,
// so this runs on every open in every mode (sweepEngineLocks) and at the start
// of every tick:
// - a tracked batch whose round is still pending keeps its lock (live: and
//   gets it back if it went missing);
// - a tracked batch whose round is over is settled: unlock, log, breaker;
// - any refresh lock no pending batch covers is released;
// - quarantine locks: live keeps them only on quarantined coins (and restores
//   them); any other mode releases all of them, the SDK is in charge there.
export interface SettleCtx {
  state: EngineState;
  wallet: EngineWallet;
  now: number;
  appVersion: string;
  live: boolean;
}

export async function settleLocks(
  ctx: SettleCtx,
  vtxosIn: readonly EngineVtxo[],
  rounds: readonly EngineRoundState[],
): Promise<{ state: EngineState; events: LogEntry[]; byId: Map<string, EngineVtxo> }> {
  const { wallet, now } = ctx;
  let state = ctx.state;
  const events: LogEntry[] = [];
  const log = (e: Omit<LogEntry, "at">) => {
    const entry = { at: now, ...e };
    events.push(entry);
    state = { ...state, log: appendLog(state.log, entry) };
  };
  const byId = new Map(dedupeVtxos(vtxosIn).map((v) => [v.id, structuredClone(v)]));
  const setState = (ids: string[], st: EngineVtxo["state"]) => {
    for (const id of ids) {
      const v = byId.get(id);
      if (v) v.state = st;
    }
  };
  const unlock = async (ids: string[], holder: string): Promise<boolean> => {
    if (ids.length === 0) return true;
    try {
      await wallet.unlockVtxos(ids, holder);
      setState(ids, { type: "spendable" });
      return true;
    } catch (e) {
      log({ kind: "lock-failed", ids, error: errorText(e).slice(0, 300), note: "unlock" });
      return false;
    }
  };
  const roundById = new Map(rounds.map((r) => [r.id, r]));

  // 1. Tracked batches.
  const isPending = (b: TrackedBatch) => {
    const r = b.roundId !== null ? roundById.get(b.roundId) : undefined;
    return b.roundId !== null
      ? r !== undefined && NON_FINAL.has(r.state ?? "")
      : rounds.some(
          (x) =>
            NON_FINAL.has(x.state ?? "") &&
            x.id > (b.afterRoundId ?? Number.POSITIVE_INFINITY) &&
            !state.batches.some((o) => o.roundId === x.id),
        );
  };
  // Coins a still-pending, not released batch holds: a batch that ends must
  // not unlock them (they may have gone out again since).
  const heldByLive = new Set(state.batches.filter((b) => !b.released && isPending(b)).flatMap((b) => b.ids));
  const keep: TrackedBatch[] = [];
  for (const b of state.batches) {
    const r = b.roundId !== null ? roundById.get(b.roundId) : undefined;
    const pending = isPending(b);
    if (pending && b.released) {
      keep.push(b);
      continue;
    }
    if (pending && ctx.live && ctx.now - b.at > ENGINE.STUCK_MS) {
      // Stuck for a day: let the coins go (audit 2026-09-26: they stayed
      // locked for good, even with the engine off). The round can still
      // finish: bark marks inputs spent from Spendable too.
      const ours = b.ids.filter((id) => isOurs(byId.get(id), ENGINE.HOLDER_REFRESH));
      if (await unlock(ours, ENGINE.HOLDER_REFRESH)) {
        log({ kind: "unlocked", ids: b.ids, roundId: b.roundId, note: "stuck" });
        keep.push({ ...b, locked: false, released: true, releasedAt: now });
      } else {
        keep.push(b);
      }
      continue;
    }
    if (pending) {
      // A lock of ours on a pending batch (an older version kept it for the
      // whole round) would stop bark from taking the inputs when the round is
      // issued: let it go, in every mode.
      const ours = b.ids.filter((id) => isOurs(byId.get(id), ENGINE.HOLDER_REFRESH));
      if (ours.length > 0 && (await unlock(ours, ENGINE.HOLDER_REFRESH))) log({ kind: "unlocked", ids: ours, roundId: b.roundId, note: "handover" });
      keep.push({ ...b, locked: b.locked || b.ids.every((id) => heldByRound(byId.get(id))) });
      continue;
    }
    if (b.released) {
      // A released batch holds no lock, and its coins were free to go
      // elsewhere (a payment, a newer batch that may already be settled), so
      // "every input spent" proves nothing about THIS refresh: no success, no
      // failure, no isolation bookkeeping. It used to log "completed" and
      // call recordSuccess, so an ordinary payment could lift a tripped
      // breaker (review 2026-09-26).
      log({ kind: "released-ended", ids: b.ids, amountSats: b.amountSats, roundId: b.roundId, note: r?.state });
      continue;
    }
    const ours = b.ids.filter((id) => isOurs(byId.get(id), ENGINE.HOLDER_REFRESH) && !heldByLive.has(id));
    if (!(await unlock(ours, ENGINE.HOLDER_REFRESH))) {
      // Try again next time rather than lose track of a lock we hold.
      keep.push(b);
      continue;
    }
    if (ours.length > 0) log({ kind: "unlocked", ids: ours });
    const spent = b.ids.filter((id) => {
      const v = byId.get(id);
      return v === undefined || v.state.type === "spent";
    });
    if (!b.locked && b.ids.some((id) => byId.get(id)?.state.type !== "spendable")) {
      // bark never held the inputs, and some of them went elsewhere: a send
      // (which made the server drop the participation) or a round that was
      // issued and finished between two looks. Neither success nor failure,
      // like a released batch.
      log({ kind: "ended-unseen", ids: b.ids, amountSats: b.amountSats, roundId: b.roundId, note: r?.state });
      continue;
    }
    if (spent.length === b.ids.length) {
      log({
        kind: "completed",
        ids: b.ids,
        amountSats: b.amountSats,
        feeSats: b.feeSats,
        outputSats: b.amountSats - b.feeSats,
        coins: b.coins,
        roundId: b.roundId,
      });
      const roundFails = { ...state.roundFails };
      const aloneRejects = { ...state.aloneRejects };
      for (const id of b.ids) {
        delete roundFails[id];
        delete aloneRejects[id];
      }
      state = { ...state, aloneRejects };
      state = { ...state, breaker: recordSuccess(state.breaker), roundFails, groups: dropFromGroups(state.groups, b.ids) };
    } else {
      log({ kind: "round-failed", ids: b.ids, amountSats: b.amountSats, coins: b.coins, roundId: b.roundId, note: r?.state });
      // Round-time failures name no coin. A group's failure is expected while
      // the culprit is being narrowed down, so it doesn't feed the streak.
      if (!b.group) state = { ...state, breaker: recordFailure(state.breaker, now, ctx.appVersion) };
      const held = b.ids.filter((id) => byId.get(id)?.state.type === "spendable");
      const roundFails = { ...state.roundFails };
      for (const id of held) roundFails[id] = (roundFails[id] ?? 0) + 1;
      state = { ...state, roundFails };
      if (held.length === 1) {
        const only = held[0];
        if (b.ids.length === 1 && roundFails[only] >= ENGINE.ROUND_FAILS_ALONE) {
          const error = `round failed ${roundFails[only]}x in a row, alone`;
          const { [only]: _gone, ...rest } = state.roundFails;
          void _gone;
          state = {
            ...state,
            quarantine: { ...state.quarantine, [only]: { at: now, reason: "unknown", error } },
            roundFails: rest,
            groups: dropFromGroups(state.groups, [only]),
            breaker: explainedFailures(state.breaker),
          };
          // Reason "unknown": out of every plan, not locked (see quarantine()).
          log({ kind: "quarantined", ids: [only], error, note: "unknown" });
        } else {
          state = { ...state, groups: splitGroups(state.groups, [only]) };
        }
      } else if (held.length > 1 && (b.group || held.some((id) => roundFails[id] >= ENGINE.ROUND_FAILS_ISOLATE))) {
        state = { ...state, groups: splitGroups(state.groups, held) };
      }
    }
  }
  state = { ...state, batches: keep };

  // 2. Refresh locks no pending batch covers. A released batch covers
  // nothing: it let its lock go, so a refresh lock on its coins belongs to
  // something newer. An uncertain submit's inputs ARE covered: the worker
  // locked them before a submit whose answer never came, and the adopt or the
  // resubmit takes the lock over (the worker's refreshVtxosDelegatedAndLock
  // accepts coins already locked by the engine). Releasing them here and
  // locking again on adopt left a gap a payment could fall into, cancelling a
  // live participation (second audit 2026-09-28).
  const covered = new Set([...keep.filter((b) => !b.released).flatMap((b) => b.ids), ...(state.submitting?.ids ?? [])]);
  const orphans = [...byId.values()]
    .filter((v) => isOurs(v, ENGINE.HOLDER_REFRESH) && !covered.has(v.id))
    .map((v) => v.id);
  if (orphans.length > 0 && (await unlock(orphans, ENGINE.HOLDER_REFRESH))) {
    log({ kind: "unlocked", ids: orphans, note: "orphan" });
  }

  // 3. Quarantine locks: live keeps (and restores) them only on coins the
  // server called spent; an "unknown" one locked by an older version is
  // released here.
  const lockable = (id: string) => state.quarantine[id]?.reason === "spent";
  const qHeld = [...byId.values()].filter((v) => isOurs(v, ENGINE.HOLDER_QUARANTINE)).map((v) => v.id);
  const qRelease = ctx.live ? qHeld.filter((id) => !lockable(id)) : qHeld;
  if (qRelease.length > 0 && (await unlock(qRelease, ENGINE.HOLDER_QUARANTINE))) {
    log({ kind: "unlocked", ids: qRelease, note: ctx.live ? "quarantine-orphan" : "quarantine-passive" });
  }
  if (ctx.live) {
    const relock = Object.keys(state.quarantine).filter((id) => lockable(id) && byId.get(id)?.state.type === "spendable");
    if (relock.length > 0) {
      try {
        await wallet.lockVtxos(relock, ENGINE.HOLDER_QUARANTINE);
        setState(relock, { type: "locked", holder: { type: "action", id: ENGINE.HOLDER_QUARANTINE } });
      } catch {
        // The quarantine entry alone still keeps them out of every plan.
      }
    }
  }
  return { state, events, byId };
}

// On every open, in every mode (V1 included): see settleLocks. Cheap when
// there's nothing to do: one allVtxos() and nothing else unless an engine lock
// or a tracked batch exists.
export function sweepEngineLocks(deps: EngineDeps, live: boolean): Promise<LogEntry[]> {
  return exclusive(() => sweepInner(deps, live));
}

async function sweepInner(deps: EngineDeps, live: boolean): Promise<LogEntry[]> {
  const state = deps.store.load();
  const first = await deps.wallet.allVtxos();
  const holds = first.some((v) => isOurs(v, ENGINE.HOLDER_REFRESH) || isOurs(v, ENGINE.HOLDER_QUARANTINE));
  const quarantined = live && Object.values(state.quarantine).some((q) => q.reason === "spent");
  if (!holds && state.batches.length === 0 && !quarantined) return [];
  // Rounds before coins, see reconcile(): the cheap check above read the coins
  // first, so read them again after the rounds.
  const rounds = await deps.wallet.pendingRoundStates();
  const vtxos = await deps.wallet.allVtxos();
  const settled = await settleLocks({ state, wallet: deps.wallet, now: deps.now(), appVersion: deps.appVersion, live }, vtxos, rounds);
  deps.store.save(settled.state);
  return settled.events;
}

// Quarantined, stranded and being-checked coins: never planned.
export function unplannable(state: EngineState): Set<string> {
  return new Set([...Object.keys(state.quarantine), ...Object.keys(state.stranded), ...(state.strandCheck?.ids ?? [])]);
}

// Inputs of delegated rounds we don't track (the SDK path's, a restored
// backup's): kept out of the plan, a submit sharing one would make the server
// drop that participation. null = there are such rounds and their inputs
// can't be read: stay out of the way.
async function foreignRoundInputs(
  state: EngineState,
  rounds: readonly EngineRoundState[],
  wallet: EngineWallet,
): Promise<Set<string> | null> {
  const tracked = new Set(state.batches.map((b) => b.roundId).filter((id) => id !== null));
  if (!rounds.some((r) => r.state === "delegated-pending" && !tracked.has(r.id))) return new Set();
  try {
    const ours = new Set(state.batches.flatMap((b) => b.ids));
    return new Set((await wallet.pendingRoundInputs()).filter((id) => !ours.has(id)));
  } catch {
    return null;
  }
}

// The one place a plan's input is built, for the tick and for the manual
// preview alike: the preview used to leave out the isolation groups and the
// foreign rounds' inputs, so "Obnovit teď" always ended as plan-changed while
// either existed (second audit 2026-09-28).
function planInput(
  state: EngineState,
  vtxos: readonly EngineVtxo[],
  tip: number,
  limits: ArkLimits,
  now: number,
  foreignInputs: ReadonlySet<string>,
  everything: boolean,
): Parameters<typeof planRefresh>[0] {
  return {
    vtxos,
    tipHeight: tip,
    maxExitDepth: limits.maxVtxoExitDepth,
    maxAmountSats: limits.maxVtxoAmountSats,
    quarantined: unplannable(state),
    inFlight: new Set([...inFlightIds(state, now), ...foreignInputs]),
    noCompanion: new Set(Object.entries(state.suspects).filter(([, until]) => until > now).map(([id]) => id)),
    groups: state.groups,
    everything,
    bands: bandsFromFeeTable(limits.refreshFees),
  };
}

// A user-released batch keeps its coins out of plans while its round may
// still take them, but no longer than STUCK_MS from the release.
function userHold(b: TrackedBatch, now: number): boolean {
  return b.released === true && b.releasedByUser === true && now - (b.releasedAt ?? b.at) < ENGINE.STUCK_MS;
}

function inFlightIds(state: EngineState, now: number): Set<string> {
  return new Set([
    ...state.batches.filter((b) => !b.released || userHold(b, now)).flatMap((b) => b.ids),
    ...(state.submitting?.ids ?? []),
    ...state.held.filter((h) => h.until > now).flatMap((h) => h.ids),
  ]);
}

// Whether "+ pendingInRoundSats sats v obnově mincí" is true right now.
// pendingInRoundSats sums the outputs of EVERY non-final round state, so the
// "+" is honest only if each of those rounds is one of ours AND locked (a
// locked input is out of the headline). A batch whose lock failed still has
// its inputs in the headline, and a round we don't track may not lock at all:
// either one and the note would count the same money twice (2026-09-08).
export function refreshNoteSafe(state: EngineState, rounds: readonly EngineRoundState[]): boolean {
  if (state.batches.length === 0) return false;
  if (state.batches.some((b) => !b.locked || b.roundId === null)) return false;
  const ours = new Set(state.batches.map((b) => b.roundId));
  return rounds.filter((r) => NON_FINAL.has(r.state ?? "")).every((r) => ours.has(r.id));
}

export function engineStatus(
  state: EngineState,
  vtxos: readonly EngineVtxo[],
  tip: number,
  now: number,
  opts: { maxAmountSats?: number } = {},
): EngineStatus {
  const quarantined = new Set(Object.keys(state.quarantine));
  const stranded = new Set(Object.keys(state.stranded));
  const inRefresh = state.batches.map((b) => ({
    amountSats: b.amountSats,
    feeSats: b.feeSats,
    since: b.at,
    locked: b.locked,
    // A released batch no longer holds anything (its coins are free again).
    stuck: !b.released && now - b.at > ENGINE.STUCK_MS,
  }));
  const br = state.breaker;
  // Backoff or a full 24 h window: either way the next automatic attempt.
  const attempt = mayAttempt(br, now);
  const waiting = !attempt.ok && attempt.why !== "tripped" ? attempt : null;
  const backoffWhy = waiting ? waiting.why : null;
  const backoffUntil = waiting ? waiting.until : null;
  const coins = dedupeVtxos(vtxos);
  const soon = (v: EngineVtxo) => tip > 0 && v.expiryHeight - tip < ENGINE.URGENT_BLOCKS;
  const urgent = coins.some((v) => v.state.type === "spendable" && !quarantined.has(v.id) && soon(v));
  const held = coins.filter((v) => v.state.type === "spendable" || v.state.type === "locked");
  // Coins no refresh will take: quarantined, or over the server's cap (the
  // server drops a round output above it, plan.ts). Both used to be visible
  // only in Settings; the user should hear about them before expiry
  // (audit 2026-09-26).
  const cap = opts.maxAmountSats;
  const overCap = held.filter((v) => cap !== undefined && v.state.type === "spendable" && !quarantined.has(v.id) && v.amountSats > cap);
  const inQuarantine = held.filter((v) => quarantined.has(v.id));
  const inStranded = held.filter((v) => stranded.has(v.id) && !quarantined.has(v.id));
  const unrefreshable = [...inQuarantine, ...overCap, ...inStranded];
  // Coins a user-released batch keeps out of plans, close to expiry: nothing
  // refreshes them until the hold ends (userHold), so say so.
  const heldByUser = new Set(state.batches.filter((b) => userHold(b, now)).flatMap((b) => b.ids));
  const userHeldUrgent = held.some((v) => heldByUser.has(v.id) && soon(v));
  const sum = (list: readonly EngineVtxo[]) => list.reduce((s, v) => s + v.amountSats, 0);
  return {
    breaker: br.tripped,
    backoffUntil,
    backoffWhy,
    inRefresh,
    lockedInRefreshSats: state.batches.filter((b) => b.locked).reduce((s, b) => s + b.amountSats, 0),
    quarantined: quarantined.size,
    quarantinedSats: sum(inQuarantine),
    overCapSats: sum(overCap),
    strandedSats: sum(inStranded),
    unrefreshableSats: sum(unrefreshable),
    uncertain: state.submitting !== null,
    needsAttention:
      br.tripped && urgent
        ? "breaker-urgent"
        : inRefresh.some((b) => b.stuck) || Object.values(state.foreignSeen).some((at) => now - at > ENGINE.STUCK_MS)
          ? "stuck"
          : unrefreshable.some(soon) || userHeldUrgent
            ? "unrefreshable-urgent"
            : null,
    watchedExpiryHeight: watchedExpiryHeight(vtxos, new Set([...quarantined, ...stranded])),
  };
}

// Manual "Obnovit teď": what would be submitted and what it costs, before the
// user confirms. Changes nothing.
export async function previewManual(deps: EngineDeps): Promise<{ plan: Plan; fees: EngineFee[] }> {
  const limits = await deps.wallet.arkLimits();
  const tip = await deps.getTipHeight();
  const state = deps.store.load();
  const rounds = await deps.wallet.pendingRoundStates();
  const vtxos = dedupeVtxos(await deps.wallet.allVtxos());
  const foreign = await foreignRoundInputs(state, rounds, deps.wallet);
  if (foreign === null) throw new Error("Nelze přečíst cizí obnovu");
  const plan = planRefresh(planInput(state, vtxos, tip, limits, deps.now(), foreign, true));
  const fees: EngineFee[] = [];
  for (const b of plan.batches) fees.push(await deps.wallet.estimateRefreshFee(b.ids));
  return { plan, fees };
}

// "Uvolnit" in Settings for a quarantined coin (the only way back for "spent").
export function releaseQuarantine(deps: EngineDeps, id: string): Promise<void> {
  return exclusive(() => releaseQuarantineInner(deps, id));
}

async function releaseQuarantineInner(deps: EngineDeps, id: string): Promise<void> {
  const state = deps.store.load();
  if (!state.quarantine[id]) return;
  await deps.wallet.unlockVtxos([id], ENGINE.HOLDER_QUARANTINE).catch(() => {});
  const { [id]: _gone, ...rest } = state.quarantine;
  void _gone;
  deps.store.save({
    ...state,
    quarantine: rest,
    log: appendLog(state.log, { at: deps.now(), kind: "quarantine-released", ids: [id], note: "manual" }),
  });
}

// An exit taking a batch's coins (runner.ts releaseEngineBatchesFor): the
// batch stays tracked (released) until its round ends and its coins stay out
// of plans meanwhile (userHold). Any lock of ours an older version left goes
// too. `at` identifies the batch.
export function releaseBatch(deps: EngineDeps, at: number): Promise<void> {
  return exclusive(async () => {
    const state = deps.store.load();
    const b = state.batches.find((x) => x.at === at && !x.released);
    if (!b) return;
    const vtxos = dedupeVtxos(await deps.wallet.allVtxos());
    const byId = new Map(vtxos.map((v) => [v.id, v]));
    // The server has issued the round: the coins are its now, the round
    // finishes on its own (Settings no longer offers this then).
    if (b.locked || b.ids.some((id) => heldByRound(byId.get(id)))) return;
    const ours = b.ids.filter((id) => isOurs(byId.get(id), ENGINE.HOLDER_REFRESH));
    if (ours.length > 0) await deps.wallet.unlockVtxos(ours, ENGINE.HOLDER_REFRESH);
    deps.store.save({
      ...state,
      batches: state.batches.map((x) =>
        x === b ? { ...x, locked: false, released: true, releasedByUser: true, releasedAt: deps.now() } : x,
      ),
      log: appendLog(state.log, { at: deps.now(), kind: "unlocked", ids: b.ids, roundId: b.roundId, note: "manual" }),
    });
  });
}

// "Uvolnit" for a stranded coin in Settings: planned again (a refresh of it
// will most likely be rejected as unusable, which shows it's still stuck).
export function releaseStranded(deps: EngineDeps, id: string): Promise<void> {
  return exclusive(async () => {
    const state = deps.store.load();
    if (!state.stranded[id]) return;
    const { [id]: _gone, ...stranded } = state.stranded;
    void _gone;
    deps.store.save({ ...state, stranded, log: appendLog(state.log, { at: deps.now(), kind: "quarantine-released", ids: [id], note: "stranded" }) });
  });
}

// "Zkusit znovu" in Settings.
// Through the chain too: a tick in flight would otherwise save its own
// (earlier) copy of the breaker over the reset.
export function resetBreaker(deps: EngineDeps): Promise<void> {
  return exclusive(async () => {
    const state = deps.store.load();
    deps.store.save({
      ...state,
      breaker: manualReset(state.breaker),
      log: appendLog(state.log, { at: deps.now(), kind: "breaker-reset", note: "user" }),
    });
  });
}

// localStorage is anything's to rewrite (and older versions wrote older
// shapes), so every nested value is checked and whatever doesn't fit is
// dropped. A single malformed batch used to make every tick and every lock
// sweep throw, silently and for good (audit 2026-09-26).
export function parseState(raw: unknown): EngineState {
  if (!isObj(raw) || raw.v !== 1) return structuredClone(EMPTY_STATE);
  const r = raw;
  const b = isObj(r.breaker) ? r.breaker : {};
  const tripped = isObj(b.tripped) && b.tripped.reason === "failures" && isNum(b.tripped.at)
    ? { reason: "failures" as const, at: b.tripped.at, appVersion: typeof b.tripped.appVersion === "string" ? b.tripped.appVersion : "" }
    : null;
  const s = isObj(r.submitting) ? r.submitting : null;
  return {
    v: 1,
    breaker: {
      attempts: Array.isArray(b.attempts) ? b.attempts.filter(isNum) : [],
      consecutiveFailures: isNum(b.consecutiveFailures) && b.consecutiveFailures >= 0 ? Math.floor(b.consecutiveFailures) : 0,
      lastFailureAt: isNum(b.lastFailureAt) ? b.lastFailureAt : null,
      tripped,
    },
    submitting:
      s && isIds(s.ids) && isNum(s.at)
        ? {
            ids: s.ids,
            at: s.at,
            lastAt: isNum(s.lastAt) ? s.lastAt : s.at,
            resubmits: isNum(s.resubmits) ? s.resubmits : 0,
            // JSON turns Infinity into null.
            afterRoundId: isNum(s.afterRoundId) ? s.afterRoundId : Number.POSITIVE_INFINITY,
          }
        : null,
    batches: (Array.isArray(r.batches) ? r.batches : []).flatMap((x): TrackedBatch[] => {
      if (!isObj(x) || !isIds(x.ids) || x.ids.length === 0 || !isNum(x.amountSats) || !isNum(x.at)) return [];
      return [
        {
          ids: x.ids,
          amountSats: x.amountSats,
          feeSats: isNum(x.feeSats) ? x.feeSats : 0,
          roundId: isNum(x.roundId) ? x.roundId : null,
          at: x.at,
          manual: x.manual === true,
          locked: x.locked === true,
          group: x.group === true,
          released: x.released === true,
          releasedByUser: x.releasedByUser === true,
          ...(isNum(x.releasedAt) ? { releasedAt: x.releasedAt } : {}),
          ...(isNum(x.afterRoundId) ? { afterRoundId: x.afterRoundId } : {}),
          ...(Array.isArray(x.coins) ? { coins: x.coins.filter(isObj) as unknown as LoggedCoin[] } : {}),
        },
      ];
    }),
    quarantine: Object.fromEntries(
      Object.entries(isObj(r.quarantine) ? r.quarantine : {}).flatMap(([id, q]): [string, QuarantineEntry][] =>
        isObj(q) && isNum(q.at)
          ? [[id, { at: q.at, reason: q.reason === "spent" ? "spent" : "unknown", error: typeof q.error === "string" ? q.error : "" }]]
          : [],
      ),
    ),
    held: (Array.isArray(r.held) ? r.held : []).flatMap((h) => (isObj(h) && isIds(h.ids) && isNum(h.until) ? [{ ids: h.ids, until: h.until }] : [])),
    suspects: numRecord(r.suspects),
    roundFails: numRecord(r.roundFails),
    groups: Array.isArray(r.groups) ? r.groups.filter(isIds).filter((g) => g.length > 0) : [],
    quiet: Object.fromEntries(Object.entries(isObj(r.quiet) ? r.quiet : {}).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    aloneRejects: numRecord(r.aloneRejects),
    foreignSeen: numRecord(r.foreignSeen),
    stranded: Object.fromEntries(
      Object.entries(isObj(r.stranded) ? r.stranded : {}).flatMap(([id, x]): [string, { at: number; error: string }][] =>
        isObj(x) && isNum(x.at) ? [[id, { at: x.at, error: typeof x.error === "string" ? x.error : "" }]] : [],
      ),
    ),
    strandCheck:
      isObj(r.strandCheck) && isIds(r.strandCheck.ids) && r.strandCheck.ids.length > 0 && isNum(r.strandCheck.at)
        ? {
            ids: r.strandCheck.ids,
            at: r.strandCheck.at,
            error: typeof r.strandCheck.error === "string" ? r.strandCheck.error : "",
            rejected: isIds(r.strandCheck.rejected) ? r.strandCheck.rejected : [],
          }
        : null,
    log: (Array.isArray(r.log) ? r.log : []).filter((e): e is LogEntry => isObj(e) && isNum(e.at) && typeof e.kind === "string"),
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isIds(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((id) => typeof id === "string");
}
function numRecord(x: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(isObj(x) ? x : {}).filter(([, v]) => isNum(v))) as Record<string, number>;
}

export function memoryStore(initial: EngineState = EMPTY_STATE): EngineStore & { peek(): EngineState } {
  let stored = structuredClone(initial);
  return {
    load: () => structuredClone(stored),
    save: (s) => {
      stored = structuredClone(s);
    },
    peek: () => stored,
  };
}
