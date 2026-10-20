// Interleaving fuzzer (audit 2026-09-26).
//
// A model closer to bark-0.7.1 + bark-ffi v0.29.0 + server-0.7.1 than
// fakeWallet.ts:
// - every wallet call is atomic (the worker's FIFO queue); JS-side code of
//   different actors interleaves BETWEEN calls, at random;
// - unlockVtxos with an expected holder fails as a whole on any id not
//   Spendable / not locked by that holder (ffi ensure_locked_by);
// - the server supersedes a not-yet-issued participation sharing ANY input
//   (delete_pending_participations_for_inputs), and an OOR spend drops it
//   (invalidate_pending_participations_for_inputs);
// - a round issues participations (server marks inputs spent); bark's next
//   sync() locks the inputs under the round's movement (a checked lock that
//   fails on a coin anyone else holds: the round is then stuck), the one
//   after forfeits and completes (inputs Spent, new coin); a participation
//   the server no longer has fails locally.
// Actors: engine auto ticks, open-time sweep, sends, receives, server rounds,
// bark sync, Settings (release quarantine, manual refresh).
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  ENGINE,
  memoryStore,
  previewManual,
  refreshNoteSafe,
  releaseQuarantine,
  sweepEngineLocks,
  tick,
  type EngineDeps,
  type EngineRoundState,
  type EngineWallet,
} from "../../src/lib/refreshEngine/engine";
import type { EngineVtxo } from "../../src/lib/refreshEngine/plan";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Part {
  id: number; // local round-state id (bark autoincrement), also the unlock hash stand-in
  inputs: string[];
  issued: boolean;
  engine: boolean; // created through refreshAndLock
}

class World implements EngineWallet {
  vtxos = new Map<string, EngineVtxo>();
  serverSpent = new Set<string>();
  server: Part[] = [];
  local: { id: number; state: string; inputs: string[]; held?: boolean }[] = [];
  completed = new Set<number>();
  failed = new Set<number>();
  submitsAt: number[] = [];
  violations: string[] = [];
  nextId = 1;
  nextCoin = 1;
  tip = 900_000;
  now = 1_800_000_000_000;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    public r: () => number,
    public faultRate = 0.05,
  ) {}

  // Random delay before joining the FIFO queue, then atomic execution.
  private async call<T>(fn: () => T | Promise<T>): Promise<T> {
    // Skewed: usually immediate, sometimes a long wait (a slow sync() ahead
    // of us in the real queue).
    const x = this.r();
    const hops = x < 0.7 ? Math.floor(x * 4) : Math.floor(x * x * 120);
    for (let i = 0; i < hops; i++) await Promise.resolve();
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  addCoin(amountSats: number, blocks: number, depth = 1) {
    const id = `${(this.nextCoin++).toString(16).padStart(64, "c")}:0`;
    this.vtxos.set(id, { id, amountSats, expiryHeight: this.tip + blocks, exitDepth: depth, state: { type: "spendable" } });
    return id;
  }

  // --- EngineWallet ---
  refreshServer = () => this.call(() => {});
  arkLimits = () => this.call(() => ({ maxVtxoExitDepth: 100, maxVtxoAmountSats: 2_000_000 as number | undefined }));
  allVtxos = () => this.call(() => [...this.vtxos.values()].map((v) => structuredClone(v)));
  pendingRoundStates = () => this.call((): EngineRoundState[] => this.local.map((x) => ({ id: x.id, state: x.state })));
  pendingRoundInputs = () => this.call(() => this.local.flatMap((x) => x.inputs));
  progressPendingRounds = () => this.call(() => this.syncRounds());
  estimateRefreshFee = (ids: string[]) =>
    this.call(() => {
      const gross = ids.reduce((s, id) => s + (this.vtxos.get(id)?.amountSats ?? 0), 0);
      return { feeSats: 0, netAmountSats: gross };
    });
  refreshAndLock = (ids: string[], holderId: string) =>
    this.call(() => {
      // Worker: take over a lock of ours, lock (only Spendable), submit,
      // unlock whatever the outcome.
      const release = () => {
        for (const id of ids) {
          const v = this.vtxos.get(id);
          if (v?.state.type === "locked" && v.state.holder?.id === holderId) v.state = { type: "spendable" };
        }
      };
      release();
      try {
        this.lockNow(ids, holderId);
      } catch (e) {
        throw new Error(`REFRESH_INPUTS_UNAVAILABLE: ${String(e)}`);
      }
      try {
        return this.submitLocked(ids, holderId);
      } finally {
        release();
      }
    });
  private submitLocked(ids: string[], holderId: string) {
    this.submitsAt.push(this.now);
    for (const id of ids) {
      const v = this.vtxos.get(id);
      const ours = v?.state.type === "locked" && v.state.holder?.id === holderId;
      if (!ours) this.violations.push(`S2 submitted a coin not locked by us ${id.slice(0, 6)} (${v?.state.type})`);
    }
    if (ids.some((id) => this.serverSpent.has(id))) {
      throw new Error(
        `error submitting round participation to server: code: 'Client specified an invalid argument', message: "bad user input: input vtxo(s) unusable"`,
      );
    }
    const f = this.r();
    if (f < this.faultRate / 2) throw new Error("error submitting round participation to server: code: 'Unknown error', message: \"JS API error: TypeError: Failed to fetch\"");
    for (const p of this.server.filter((p) => !p.issued && p.inputs.some((i) => ids.includes(i)))) {
      const loc = this.local.find((x) => x.id === p.id);
      if (p.engine && loc) this.violations.push(`S3 engine superseded its own live participation #${p.id}`);
      this.server = this.server.filter((x) => x !== p);
    }
    const id = Math.max(this.nextId, ...this.local.map((x) => x.id + 1));
    this.nextId = id + 1;
    this.server.push({ id, inputs: [...ids], issued: false, engine: true });
    if (f < this.faultRate) {
      if (this.r() < 0.5) this.local.push({ id, state: "delegated-pending", inputs: [...ids] });
      throw new Error("error submitting round participation to server: code: 'Unknown error', message: \"JS API error: TypeError: Failed to fetch\"");
    }
    this.local.push({ id, state: "delegated-pending", inputs: [...ids] });
    return { round: { id, state: "delegated-pending" } };
  }
  lockVtxos = (ids: string[], holderId: string) => this.call(() => this.lockNow(ids, holderId));
  unlockVtxos = (ids: string[], holderId: string) =>
    this.call(() => {
      if (ids.length === 0) return;
      const bad = ids.filter((id) => {
        const v = this.vtxos.get(id);
        if (!v) return true;
        return !(v.state.type === "spendable" || (v.state.type === "locked" && v.state.holder?.id === holderId));
      });
      if (bad.length) throw new Error(`refusing to unlock ${bad.length} VTXO(s) not locked by the expected holder`);
      for (const id of ids) {
        const v = this.vtxos.get(id)!;
        if (v.state.type === "locked") v.state = { type: "spendable" };
      }
    });

  private lockNow(ids: string[], holderId: string) {
    if (ids.length === 0) return;
    for (const id of ids) {
      const v = this.vtxos.get(id);
      const same = v?.state.type === "locked" && v.state.holder?.id === holderId;
      if (!v || (v.state.type !== "spendable" && !same)) throw new Error(`Lock VTXOs failed: ${id.slice(0, 6)} is ${v?.state.type}`);
    }
    for (const id of ids) this.vtxos.get(id)!.state = { type: "locked", holder: { type: "action", id: holderId } };
  }

  // bark sync_pending_rounds for delegated participations.
  syncRounds() {
    for (const loc of [...this.local]) {
      const p = this.server.find((x) => x.id === loc.id);
      if (!p) {
        this.local = this.local.filter((x) => x !== loc);
        this.failed.add(loc.id);
        continue;
      }
      if (!p.issued) continue;
      if (!loc.held) {
        // progress_delegated: lock the inputs under the round's movement.
        const blocked = p.inputs.filter((i) => {
          const v = this.vtxos.get(i);
          const same = v?.state.type === "locked" && v.state.holder?.type === "movement" && v.state.holder.id === loc.id;
          return v !== undefined && v.state.type !== "spendable" && !same;
        });
        if (blocked.length > 0) {
          this.violations.push(`S9 bark could not lock the inputs of issued round #${loc.id} (${blocked.map((i) => this.vtxos.get(i)?.state.holder?.id).join(",")})`);
          continue;
        }
        for (const i of p.inputs) {
          const v = this.vtxos.get(i);
          if (v) v.state = { type: "locked", holder: { type: "movement", id: loc.id } };
        }
        loc.held = true;
        continue;
      }
      // forfeit + persist_round_success
      let amount = 0;
      for (const i of p.inputs) {
        const v = this.vtxos.get(i);
        if (v) {
          amount += v.amountSats;
          v.state = { type: "spent" };
        }
      }
      this.addCoin(amount, 4032);
      this.server = this.server.filter((x) => x !== p);
      this.local = this.local.filter((x) => x !== loc);
      this.completed.add(loc.id);
    }
  }

  // --- actors (not engine calls) ---
  sync = () => this.call(() => this.syncRounds());
  serverRound = () =>
    this.call(() => {
      for (const p of this.server) {
        if (p.issued) continue;
        if (p.inputs.some((i) => this.serverSpent.has(i))) continue;
        p.issued = true;
        for (const i of p.inputs) this.serverSpent.add(i);
      }
      // Orphans (no local state) are never forfeited: drop them once issued.
      this.server = this.server.filter((p) => !p.issued || this.local.some((x) => x.id === p.id));
    });
  send = () =>
    this.call(() => {
      const cands = [...this.vtxos.values()].filter((v) => v.state.type === "spendable" && !this.serverSpent.has(v.id));
      if (cands.length === 0) return;
      const v = cands[Math.floor(this.r() * cands.length)];
      v.state = { type: "spent" };
      this.serverSpent.add(v.id);
      this.server = this.server.filter((p) => p.issued || !p.inputs.includes(v.id));
    });
  receive = () => this.call(() => this.addCoin(1_000 + Math.floor(this.r() * 200_000), (this.r() < 0.5 ? 100 : 200) + Math.floor(this.r() * 3800 * this.r())));
}

function deps(w: World, store = memoryStore(EMPTY_STATE)): EngineDeps {
  return { wallet: w, store, getTipHeight: async () => w.tip, now: () => w.now, appVersion: "v1" };
}

async function scenario(seed: number, steps: number, faultRate: number, sweepP = 0.15) {
  const r = rng(seed);
  const w = new World(r, faultRate);
  const store = memoryStore(EMPTY_STATE);
  const d = deps(w, store);
  for (let i = 0; i < 6; i++) w.addCoin(1_000 + Math.floor(r() * 300_000), 100 + Math.floor(r() * 3000));
  const found: string[] = [];
  for (let step = 0; step < steps; step++) {
    w.now += 60_000 * (1 + Math.floor(r() * 30));
    if (r() < 0.3) w.tip += 1;
    const actors: Promise<unknown>[] = [tick(d).catch((e) => found.push(`tick threw ${e}`))];
    if (r() < sweepP) actors.push(sweepEngineLocks(d, true).catch(() => {}));
    if (r() < 0.2) actors.push(w.sync());
    if (r() < 0.1) actors.push(w.serverRound());
    if (r() < 0.1) actors.push(w.send());
    if (r() < 0.1) actors.push(w.receive());
    if (r() < 0.03) {
      const q = Object.keys(store.peek().quarantine);
      if (q.length) actors.push(releaseQuarantine(d, q[0]));
    }
    if (r() < 0.02) {
      actors.push(
        previewManual(d)
          .then((p) => tick(d, "manual", { expect: { batches: p.plan.batches.map((b) => b.ids), feeSats: 0 } }))
          .catch(() => {}),
      );
    }
    await Promise.all(actors);

    // --- invariants at rest ---
    const st = store.peek();
    // S4: at most 6 submissions in any rolling 24 h.
    const recent = w.submitsAt.filter((t) => w.now - t < 24 * 3600_000);
    if (recent.length > 6) found.push(`S4 ${recent.length} submissions in 24h`);
    // S5: a completed round logged as failed.
    for (const e of st.log) if (e.kind === "round-failed" && e.roundId != null && w.completed.has(e.roundId)) found.push(`S5 completed round #${e.roundId} logged as failed`);
    // S10: a round that failed (a send took an input) logged as completed.
    for (const e of st.log) if (e.kind === "completed" && e.roundId != null && w.failed.has(e.roundId)) found.push(`S10 failed round #${e.roundId} logged as completed`);
    // S7 (at rest): a live engine round nobody tracks.
    {
      const trackedNow = new Set(st.batches.map((b) => b.roundId));
      const unsure = new Set(st.submitting?.ids ?? []);
      for (const loc of w.local) {
        const p = w.server.find((x) => x.id === loc.id);
        if (p?.engine && !trackedNow.has(loc.id) && !loc.inputs.some((i) => unsure.has(i))) found.push(`S7 live engine round #${loc.id} untracked at rest`);
      }
      // S8: a refresh lock no tracked batch covers, at rest.
      const covered = new Set(st.batches.flatMap((b) => b.ids));
      for (const v of w.vtxos.values()) if (v.state.type === "locked" && v.state.holder?.id === ENGINE.HOLDER_REFRESH && !covered.has(v.id)) found.push(`S8 refresh lock ${v.id.slice(0, 6)} not covered by any tracked batch`);
    }
    // S6: note safe => no double count.
    const nonFinal = w.local.filter((x) => x.state === "delegated-pending");
    if (refreshNoteSafe(st, w.local.map((x) => ({ id: x.id, state: x.state })))) {
      for (const loc of nonFinal) for (const i of loc.inputs) if (w.vtxos.get(i)?.state.type === "spendable") found.push(`S6 note shown while input ${i.slice(0, 6)} of #${loc.id} is spendable`);
    }
  }
  // Quiet period: rounds run, sync, a few ticks.
  for (let k = 0; k < 4; k++) {
    w.now += 3600_000;
    w.tip += 6;
    await w.serverRound();
    await w.sync();
    await tick(d);
    await sweepEngineLocks(d, true);
  }
  const st = store.peek();
  // S1: no refresh lock left at all (the worker drops it right after the submit).
  for (const v of w.vtxos.values()) {
    if (v.state.type === "locked" && v.state.holder?.id === ENGINE.HOLDER_REFRESH) found.push(`S1 stray refresh lock on ${v.id.slice(0, 6)}`);
  }
  // S7: every live engine round is tracked.
  const tracked = new Set(st.batches.map((b) => b.roundId));
  for (const loc of w.local) if (!tracked.has(loc.id)) found.push(`S7 live round #${loc.id} not tracked (engine now gates on it as foreign)`);
  // Stranded: consumed server-side by a round nobody can claim (orphan), coin
  // still ours locally. Needs an exit or a future bark's mailbox recovery.
  const stranded = [...w.vtxos.values()].filter((v) => v.state.type !== "spent" && w.serverSpent.has(v.id) && !w.local.some((x) => x.inputs.includes(v.id)));
  return { found: [...found, ...w.violations], w, st, stranded };
}

function tally(results: { found: string[] }[]) {
  const counts = new Map<string, { n: number; ex: string }>();
  for (const { found } of results) {
    for (const f of new Set(found.map((x) => x.split(" ")[0]))) {
      const c = counts.get(f) ?? { n: 0, ex: found.find((x) => x.startsWith(f))! };
      c.n++;
      counts.set(f, c);
    }
  }
  return [...counts].map(([k, v]) => `${k} in ${v.n} runs, e.g. ${v.ex}`);
}

describe("interleaving fuzzer", () => {
  // S1 stray refresh lock, S2 submitted a coin not locked by us, S3 superseded
  // our own live participation, S4 more than 6 submissions a day, S5 a
  // completed round logged as failed, S6 balance note over a spendable input,
  // S7 a live engine round nobody tracks, S8 a refresh lock no batch covers,
  // S9 bark couldn't lock an issued round's inputs, S10 a failed round logged
  // as completed.
  it("holds every invariant over random schedules", async () => {
    const results = [];
    for (let seed = 1; seed <= 150; seed++) results.push(await scenario(seed, 120, 0.06));
    const stats = results.reduce((a, r) => a + r.w.submitsAt.length, 0);
    expect(stats).toBeGreaterThan(300); // it actually exercises submits
    // Most finished rounds are seen held by bark first and count as
    // completed; one issued and finished between two looks, or dropped for a
    // send, ends as "ended-unseen" (measured: 288 of 357 completed rounds).
    const logged = results.reduce((a, r) => a + r.st.log.filter((e) => e.kind === "completed").length, 0);
    const finished = results.reduce((a, r) => a + r.w.completed.size, 0);
    expect(logged).toBeGreaterThan(finished * 0.6);
    expect(tally(results)).toEqual([]);
  }, 120_000);

  it("and with the open-time sweep racing the tick most of the time", async () => {
    const results = [];
    for (let seed = 1000; seed < 1150; seed++) results.push(await scenario(seed, 120, 0.03, 0.7));
    expect(tally(results)).toEqual([]);
  }, 120_000);
});

// Not an invariant, a measurement (see ARCHITECTURE.md, refresh engine, uncertain
// submits): a lost submit reply the server did store is an orphan; if a round
// takes it before a resubmit supersedes it, the server spends the input and
// the refreshed coin can't be claimed. Kept visible so a policy change shows
// its effect.
describe("orphan participations", () => {
  it("coins stranded by a lost submit reply (15 % faults)", async () => {
    let stranded = 0;
    for (let seed = 5000; seed < 5150; seed++) stranded += (await scenario(seed, 120, 0.15)).stranded.length;
    console.log(`orphans: ${stranded} stranded coins over 150 runs`);
    expect(stranded).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
