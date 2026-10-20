// Glue between the pure refresh engine (engine.ts) and the real wallet:
// the WalletClient adapter, a localStorage store per wallet, a throttle, and a
// tiny pub/sub so Settings and the Dashboard can show the engine's status.
import { pendingRoundInputIds } from "../wallet/roundInputs";
import type { WalletClient } from "../wallet/bark";
import { WALLET_CALL_TIMEOUT_MS, withTimeout } from "../wallet/walletCall";
import { netState } from "../connectivity/connectivity";
import {
  EMPTY_STATE,
  engineStatus,
  parseState,
  previewManual,
  releaseBatch,
  releaseQuarantine,
  releaseStranded,
  unplannable,
  resetBreaker,
  sweepEngineLocks,
  tick,
  type EngineDeps,
  type EngineFee,
  type EngineRoundState,
  type EngineState,
  type EngineStatus,
  type EngineStore,
  type ManualExpectation,
  type TickMode,
  type TickResult,
} from "./engine";
import type { EngineVtxo, Plan } from "./plan";
import { forecast, type Forecast } from "./forecast";
import { dropVtxoSnapshot, readVtxosShared, recordVtxoRead } from "../wallet/vtxoSnapshot";

// How often an automatic tick may run. refresh() fires every few seconds, but
// a tick is ~8 wallet calls and nothing it watches moves faster than a block.
export const AUTO_TICK_INTERVAL_MS = 60_000;

const TIMEOUT = "Časový limit volání peněženky vypršel";

const STORAGE_PREFIX = "btc-wallet-refresh-engine:";

function storageKey(fingerprint: string): string {
  return `${STORAGE_PREFIX}${fingerprint}`;
}

// Wallet reset (resetLocalState.ts): every wallet's engine state, including
// its log of coin ids and amounts, goes with the wallet. The old mode setting
// (btc-wallet-refresh-engine-mode, unused since the switch went) stays.
export function clearEngineStates(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // storage blocked: nothing stored either
  }
  snapshot = { state: EMPTY_STATE, status: null, lastTick: null };
}

export function localStorageStore(fingerprint: string): EngineStore {
  const key = storageKey(fingerprint);
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? parseState(JSON.parse(raw)) : structuredClone(EMPTY_STATE);
      } catch {
        return structuredClone(EMPTY_STATE);
      }
    },
    save(state) {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch {
        // Storage unavailable: the worker's own submission cap still holds.
      }
      notify(state);
    },
  };
}

// Every wallet call gets the app's usual UI-level timeout. A timeout on the
// submit surfaces as an error the engine classifies as "uncertain" and
// resubmits the same inputs, which is exactly right for a call that may
// still have landed.
function t<T>(p: Promise<T>): Promise<T> {
  return withTimeout(p, WALLET_CALL_TIMEOUT_MS, TIMEOUT);
}

export function engineDeps(wallet: WalletClient): EngineDeps {
  return {
    wallet: {
      refreshServer: () => t(wallet.refreshServer()),
      arkLimits: async () => {
        const info = await t(wallet.arkInfo());
        // No ArkInfo = can't know the caps; refuse rather than guess.
        if (!info) throw new Error("ArkInfo není k dispozici");
        return {
          maxVtxoExitDepth: info.maxVtxoExitDepth,
          maxVtxoAmountSats: info.maxVtxoAmountSats,
          refreshFees: info.feeSchedule?.refresh ?? null,
        };
      },
      // Fresh on purpose (the engine decides on it); the display readers
      // behind it reuse the result (wallet/vtxoSnapshot.ts).
      allVtxos: async () => {
        const v = await t(wallet.allVtxos());
        recordVtxoRead(wallet.fingerprint, v);
        return v as EngineVtxo[];
      },
      pendingRoundStates: () => t(wallet.pendingRoundStates()),
      pendingRoundInputs: async () => [...(await t(pendingRoundInputIds(wallet)))],
      progressPendingRounds: () => t(wallet.progressPendingRounds()).finally(() => dropVtxoSnapshot(wallet.fingerprint)),
      estimateRefreshFee: (ids) => t(wallet.estimateRefreshFee(ids)),
      // No UI-level timeout here, on purpose: in the worker's FIFO queue a
      // 60 s race could expire while the call is still waiting its turn,
      // and the engine would then resubmit inputs whose participation is
      // live, unlock them, and burn another key index. The worker's own
      // watchdog is what bounds it; if it kills the worker, the persisted
      // `submitting` record handles the outcome on the next open.
      refreshAndLock: (ids, holderId) =>
        wallet.refreshVtxosDelegatedAndLock(ids, holderId).finally(() => dropVtxoSnapshot(wallet.fingerprint)),
      lockVtxos: (ids, holderId) =>
        t(wallet.lockVtxos({ vtxoIds: ids, holder: { type: "action", id: holderId } })).finally(() =>
          dropVtxoSnapshot(wallet.fingerprint),
        ),
      unlockVtxos: (ids, holderId) =>
        t(wallet.unlockVtxos({ vtxoIds: ids, expectedHolder: { type: "action", id: holderId } })).finally(() =>
          dropVtxoSnapshot(wallet.fingerprint),
        ),
    },
    getTipHeight: () => t(wallet.onchainWallet.tipHeight()),
    store: localStorageStore(wallet.fingerprint),
    now: () => Date.now(),
    appVersion: __APP_VERSION__,
    // A submit only while the app is in front and the network works: a reply
    // lost to a backgrounded tab (iOS kills its requests) or a dying network
    // is how an orphan participation starts (engine.ts, RESUBMIT_BACKOFF_MS).
    canSubmit: () =>
      (typeof document === "undefined" || document.visibilityState === "visible") && netState() === "online",
  };
}

// --- status pub/sub -------------------------------------------------------

export interface EngineSnapshot {
  state: EngineState;
  status: EngineStatus | null;
  lastTick: { at: number; outcome: TickResult["outcome"] } | null;
}

let snapshot: EngineSnapshot = { state: EMPTY_STATE, status: null, lastTick: null };
const listeners = new Set<() => void>();

function notify(state: EngineState, status?: EngineStatus, lastTick?: EngineSnapshot["lastTick"]) {
  snapshot = { state, status: status ?? snapshot.status, lastTick: lastTick ?? snapshot.lastTick };
  for (const l of listeners) l();
}

export function subscribeEngine(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function engineSnapshot(): EngineSnapshot {
  return snapshot;
}

// Called on open so a relocked session starts from the stored state, not
// from whatever the previous wallet left in memory.
export function loadEngineSnapshot(wallet: WalletClient): void {
  const state = localStorageStore(wallet.fingerprint).load();
  snapshot = { state, status: null, lastTick: null };
  for (const l of listeners) l();
}

// Last verdict of refreshNoteSafe() (engine.ts), set by the Dashboard's
// balance read. Shared so SendPanel's "coins are in a refresh" error uses the
// same condition as the balance note.
let noteSafe = false;
export function setRefreshNoteSafe(v: boolean): void {
  noteSafe = v;
}
export function isRefreshNoteSafe(): boolean {
  return noteSafe;
}

// --- running --------------------------------------------------------------

let lastAutoAt = 0;
let lastAutoFingerprint: string | null = null;

// refresh() calls this every cycle; it runs at most once per
// AUTO_TICK_INTERVAL_MS per wallet. Returns the result when a tick ran.
export async function maybeRunEngine(
  wallet: WalletClient,
  mode: Exclude<TickMode, "manual">,
  opts: { force?: boolean } = {},
): Promise<TickResult | null> {
  const now = Date.now();
  if (lastAutoFingerprint !== wallet.fingerprint) {
    lastAutoFingerprint = wallet.fingerprint;
    lastAutoAt = 0;
  }
  if (!opts.force && now - lastAutoAt < AUTO_TICK_INTERVAL_MS) return null;
  lastAutoAt = now;
  return runEngine(wallet, mode);
}

export async function runEngine(wallet: WalletClient, mode: TickMode, expect?: ManualExpectation): Promise<TickResult> {
  const deps = engineDeps(wallet);
  const result = await tick(deps, mode, { expect });
  notify(deps.store.load(), result.status, { at: Date.now(), outcome: result.outcome });
  return result;
}

// Releases engine locks nothing covers any more (engine.ts settleLocks). Runs
// on every open for every wallet, V1 included: a lock left by a beta "live"
// session must not outlive the mode, the toggle, or a wiped localStorage.
// Also once a minute while not live and a tracked batch remains, so a round
// that finishes mid-session releases its coins without waiting for a relock.
let lastSweepAt = 0;
export async function sweepLocks(wallet: WalletClient, live: boolean, opts: { onlyIfTracking?: boolean } = {}): Promise<void> {
  const deps = engineDeps(wallet);
  if (opts.onlyIfTracking) {
    if (deps.store.load().batches.length === 0) return;
    if (Date.now() - lastSweepAt < AUTO_TICK_INTERVAL_MS) return;
  }
  lastSweepAt = Date.now();
  const events = await sweepEngineLocks(deps, live);
  if (events.length > 0) notify(deps.store.load());
}

export async function previewManualRefresh(wallet: WalletClient): Promise<{ plan: Plan; fees: EngineFee[] }> {
  return previewManual(engineDeps(wallet));
}

export function resetEngineBreaker(wallet: WalletClient): Promise<void> {
  return resetBreaker(engineDeps(wallet));
}

export async function releaseEngineStranded(wallet: WalletClient, id: string): Promise<void> {
  const deps = engineDeps(wallet);
  await releaseStranded(deps, id);
  notify(deps.store.load());
}

export async function releaseEngineBatch(wallet: WalletClient, at: number): Promise<void> {
  const deps = engineDeps(wallet);
  await releaseBatch(deps, at);
  notify(deps.store.load());
}

// A unilateral exit taking coins that are inputs of our refresh (the Ark
// server is down, or the user chose to): mark every tracked batch that holds
// one as released by the user, so the engine doesn't submit them again
// (releaseBatch; a batch whose round the server issued is left alone).
export async function releaseEngineBatchesFor(wallet: WalletClient, ids: readonly string[]): Promise<void> {
  const deps = engineDeps(wallet);
  const wanted = new Set(ids);
  const batches = deps.store.load().batches.filter((b) => !b.released && b.ids.some((id) => wanted.has(id)));
  for (const b of batches) await releaseBatch(deps, b.at);
  if (batches.length > 0) notify(deps.store.load());
}

export async function releaseEngineQuarantine(wallet: WalletClient, id: string): Promise<void> {
  await releaseQuarantine(engineDeps(wallet), id);
}

// Status without a tick, e.g. for Settings on open. Needs the VTXO list and
// the tip for the "urgent" and push-height parts.
export async function computeEngineStatus(wallet: WalletClient): Promise<EngineStatus> {
  const deps = engineDeps(wallet);
  const [vtxos, tip, limits] = await Promise.all([
    deps.wallet.allVtxos(),
    deps.getTipHeight().catch(() => 0),
    deps.wallet.arkLimits().catch(() => null),
  ]);
  const state = deps.store.load();
  const status = engineStatus(state, vtxos, tip, Date.now(), { maxAmountSats: limits?.maxVtxoAmountSats });
  notify(state, status);
  return status;
}

// Everything Settings → Automatická obnova shows about the future and the
// present: the forecast (what will be refreshed, when, why, with what riding
// along, for how much), the engine's state, and the live round states so an
// in-progress batch can say where it is.
// Also the status (Settings shows its warnings next to the plan) and the raw
// VTXO list, so the whole VTXO screen loads from one read.
export interface EngineOverview {
  forecast: Forecast;
  rounds: EngineRoundState[];
  state: EngineState;
  status: EngineStatus;
  vtxos: EngineVtxo[];
  // How long a fresh coin lives, in blocks (ArkInfo.vtxoExpiryDelta).
  lifetimeBlocks: number;
  at: number;
}

export async function computeOverview(wallet: WalletClient): Promise<EngineOverview> {
  const deps = engineDeps(wallet);
  const [vtxos, tip, info, rounds] = [
    (await t(readVtxosShared(wallet))) as EngineVtxo[],
    await deps.getTipHeight(),
    await t(wallet.arkInfo()),
    await deps.wallet.pendingRoundStates(),
  ];
  if (!info) throw new Error("ArkInfo není k dispozici");
  const state = deps.store.load();
  const now = Date.now();
  const status = engineStatus(state, vtxos, tip, now, { maxAmountSats: info.maxVtxoAmountSats });
  notify(state, status);
  const refreshFees = info.feeSchedule?.refresh;
  const f = forecast({
    vtxos,
    tipHeight: tip,
    maxExitDepth: info.maxVtxoExitDepth,
    maxAmountSats: info.maxVtxoAmountSats,
    quarantined: unplannable(state),
    inFlight: new Set([...state.batches.flatMap((b) => b.ids), ...(state.submitting?.ids ?? [])]),
    held: new Set(state.held.filter((h) => h.until > now).flatMap((h) => h.ids)),
    noCompanion: new Set(Object.entries(state.suspects).filter(([, until]) => until > now).map(([id]) => id)),
    groups: state.groups,
    fees: refreshFees ? { baseFeeSats: refreshFees.baseFeeSats, ppmExpiryTable: refreshFees.ppmExpiryTable } : null,
  });
  return { forecast: f, rounds, state, status, vtxos, lifetimeBlocks: info.vtxoExpiryDelta, at: now };
}
