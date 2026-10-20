// Which VTXOs the wallet worker should lock (or release) because of a
// unilateral exit. Pure, no SDK import, so it can be unit-tested; the worker
// (walletWorkerImpl.ts, syncExitLocks) applies the plan.
//
// Why a lock at all: bark does not touch a VTXO's state when its exit starts
// (exit/mod.rs, start_exit_for_vtxos: "We don't touch the VTXO's own state
// here"). It only becomes `Exited` once the exit chain confirms (AwaitingDelta).
// Until then — hours to days, one confirmation per tree level — the coin is
// `Spendable`: it sits in the headline balance, a payment can select it, and
// the SDK daemon or the refresh engine can put it into a round. Any of those
// spends it off-chain, the exit ends as "vtxo-already-spent", the fees already
// paid for its tree levels are lost, and the money silently stays in Ark.
//
// A lock with our own holder closes all of that with bark's own rules: coin
// selection and refresh only take Spendable coins, and `balance().spendable`
// no longer counts it. bark's exit progress does not mind — it only checks for
// `Spent`, and mark_vtxos_as_exited accepts Locked (vtxo/mod.rs:118-127).

export const EXIT_LOCK_HOLDER_ID = "spendrr-exit";

// Exit states in which the coin is still Spendable in bark's eyes (before
// every exit transaction confirmed). Later states have already marked it
// Exited, which replaces our lock by itself.
const PRE_EXITED_STATES: ReadonlySet<string> = new Set(["start", "processing"]);

// States whose exit is over without the coin having left through it: the
// user canceled it (the coin stays theirs in Ark) or it was spent elsewhere.
const RELEASING_STATES: ReadonlySet<string> = new Set(["canceled", "vtxo-already-spent"]);

export interface ExitLockVtxo {
  id: string;
  state:
    | { type: "spendable" }
    | { type: "locked"; holder?: { type: string; id: string | number } | undefined }
    | { type: "spent" }
    | { type: "exited" };
}

export interface ExitLockExit {
  vtxoId: string;
  state: { type: string };
}

export interface ExitLockPlan {
  lock: string[];
  unlock: string[];
}

// What the worker's syncExitLocks hands back: the locks it actually changed,
// plus the expiry height of every coin in an exit, read from the same
// allVtxos() call so the tracker doesn't need a second one (exitModel.ts,
// EXIT_EXPIRY_WARN_BLOCKS).
export interface ExitLockSync extends ExitLockPlan {
  expiryHeights: Record<string, number>;
  // Requests since the open that went to Second's esplora because the
  // independent one failed (walletWorkerGuard.ts, exitChainRedirect).
  chainFallbacks: number;
}

// The worker refuses a start when it can't tell which coins are inputs of a
// pending round (a delegated round leaves them Spendable, so nothing else
// shows it) and the caller didn't ask to include them anyway (external audit
// 2026-09-27, L1).
export const EXIT_ROUND_INPUTS_UNKNOWN = "EXIT_ROUND_INPUTS_UNKNOWN";

// A coin the caller asked for that the worker's own plan doesn't allow.
export const EXIT_COIN_NOT_ELIGIBLE = "EXIT_COIN_NOT_ELIGIBLE";

// Checks startExitForCoins' arguments: a list of distinct VTXO id strings and
// the include flag. The call is behind a password, but it still decides what
// reaches the SDK.
export function parseExitStartArgs(args: unknown[]): { ids: string[]; includeInRound: boolean } | null {
  const [ids, includeInRound] = args;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10_000) return null;
  if (!ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)) return null;
  if (typeof includeInRound !== "boolean") return null;
  return { ids: [...new Set(ids as string[])], includeInRound };
}

// What the worker's startExitForCoins did, coin by coin.
export interface ExitStartResult {
  started: string[];
  // Refused by bark before anything happened: dust, a non-standard exit
  // chain, a coin it doesn't know. The message is bark's.
  skipped: { id: string; error: string }[];
}

export function exitExpiryHeights(
  vtxos: readonly { id: string; expiryHeight: number }[],
  exits: readonly ExitLockExit[],
): Record<string, number> {
  const exiting = new Set(exits.map((e) => e.vtxoId));
  const out: Record<string, number> = {};
  for (const v of vtxos) if (exiting.has(v.id)) out[v.id] = v.expiryHeight;
  return out;
}

export function isExitLock(v: ExitLockVtxo): boolean {
  return v.state.type === "locked" && v.state.holder?.type === "action" && v.state.holder.id === EXIT_LOCK_HOLDER_ID;
}

// `exits` must be a successful getExitVtxos() read: a coin missing from it
// reads as "no exit any more" and gets unlocked. bark keeps only live exits
// across a reload (exit/mod.rs, load: LIVE_STATES), so a canceled exit from an
// earlier session shows up exactly like that.
export function planExitLocks(vtxos: readonly ExitLockVtxo[], exits: readonly ExitLockExit[]): ExitLockPlan {
  const stateById = new Map(exits.map((e) => [e.vtxoId, e.state.type]));
  const lock: string[] = [];
  const unlock: string[] = [];
  const seen = new Set<string>();
  for (const v of vtxos) {
    // A safeguard: allVtxos() once returned duplicate rows (cause never
    // found; bark 0.7.1's IndexedDB store is keyed by id).
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const exitState = stateById.get(v.id);
    if (v.state.type === "spendable" && exitState !== undefined && PRE_EXITED_STATES.has(exitState)) {
      lock.push(v.id);
    } else if (isExitLock(v) && (exitState === undefined || RELEASING_STATES.has(exitState))) {
      unlock.push(v.id);
    }
  }
  return { lock, unlock };
}

// --- which coins a new exit takes --------------------------------------------

// bark refuses to exit a coin under this (P2TR_DUST, exit/mod.rs).
export const EXIT_DUST_SATS = 330;

export interface ExitStartVtxo {
  id: string;
  amountSats: number;
  state: ExitLockVtxo["state"];
}

export interface ExitStartPlan {
  // What to hand to startExitForCoins.
  ids: string[];
  sats: number;
  // Inputs of a pending round (a refresh), left out unless `includeInRound`:
  // if the round completes it spends them server-side, the exit ends as
  // "vtxo-already-spent" and the fees paid for their tree are lost (audit
  // 2026-09-27). A delegated participation leaves its inputs Spendable until
  // the server issues its round, so wallet/roundInputs.ts is the only
  // reliable list; any coin locked by something other than the exit counts
  // too.
  inRoundIds: string[];
  inRoundSats: number;
  dustSats: number;
}

// `roundInputIds` null = couldn't read them: then only locked coins are held
// back. With `includeInRound` (the Ark server is down, or the user asked),
// everything goes in.
export function planExitStart(
  vtxos: readonly ExitStartVtxo[],
  roundInputIds: ReadonlySet<string> | null,
  includeInRound: boolean,
): ExitStartPlan {
  const plan: ExitStartPlan = { ids: [], sats: 0, inRoundIds: [], inRoundSats: 0, dustSats: 0 };
  const seen = new Set<string>();
  for (const v of vtxos) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const lockedByExit = isExitLock(v);
    // bark's UNSPENT_STATES, minus coins already in our exit.
    if (v.state.type !== "spendable" && !(v.state.type === "locked" && !lockedByExit)) continue;
    if (v.amountSats < EXIT_DUST_SATS) {
      plan.dustSats += v.amountSats;
      continue;
    }
    const inRound = v.state.type === "locked" || (roundInputIds?.has(v.id) ?? false);
    if (inRound) {
      plan.inRoundIds.push(v.id);
      plan.inRoundSats += v.amountSats;
      if (!includeInRound) continue;
    }
    plan.ids.push(v.id);
    plan.sats += v.amountSats;
  }
  return plan;
}
