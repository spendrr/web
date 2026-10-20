// A small model of bark-0.7.1 + the Ark server, just enough for the engine:
// - lockVtxos only from Spendable (or re-lock by the same holder), atomic
//   (vtxo/mod.rs lock_vtxos); unlockVtxos releases only the named holder's
//   locks and skips the rest (unlock_vtxos).
// - refreshVtxosDelegated stores a delegated-pending round state and does NOT
//   lock inputs (join_delegated_round_inner).
// - When the server issues the round, bark locks the inputs under the round's
//   movement (progress_delegated), a checked lock that fails on a coin locked
//   by anyone else: the round then can't go on (recorded as a violation).
// - A finished round marks inputs spent from Spendable or Locked and removes
//   the state (persist_round_success, then remove_round_state); a failed one
//   releases its movement's locks and removes the state.
// - The server supersedes a participation on the same inputs, and an OOR
//   spend of an input cancels it (the round then fails: "not found").
import type { EngineRoundState, EngineWallet } from "../../src/lib/refreshEngine/engine";
import type { EngineVtxo } from "../../src/lib/refreshEngine/plan";

export type Fault =
  | { kind: "reject"; message: string } // server says no, nothing stored
  | { kind: "lost-before-store"; message: string } // server accepted, local state never stored
  | { kind: "lost-after-store"; message: string } // both happened, the reply got lost
  | { kind: "throw-before-server"; message: string }; // network error before anything left

export class FakeWallet implements EngineWallet {
  vtxos = new Map<string, EngineVtxo>();
  rounds: { id: number; state: string; inputs: string[]; issued?: boolean }[] = [];
  // Server-side live participations, by round id (local or orphaned).
  server: { id: number; inputs: string[]; at: number }[] = [];
  // Clock for the server side; an orphaned participation (no local state)
  // is gone once its round ran without our forfeits, within ~1 h.
  clock: () => number = () => 0;
  static ORPHAN_LIFETIME_MS = 90 * 60_000;
  submits: string[][] = [];
  faults: Fault[] = [];
  // Coins the server rejects at submit, WITHOUT naming them in the text: the
  // id travels in gRPC metadata the browser never sees (engine.ts,
  // ENGINE.SUSPECT_MS). Text as it reaches JS: bark's context + tonic's
  // Display of the Status (code description + message, no metadata).
  unusableCoins = new Set<string>();
  missingCoins = new Set<string>();
  // Coins whose participation the server drops at round time (already in use
  // elsewhere, banned for the round): the round just fails, naming nothing.
  roundBadCoins = new Set<string>();
  lockFaults = 0;
  maxVtxoAmountSats: number | undefined = 10_000_000;
  maxVtxoExitDepth = 100;
  feePpm = 0;
  private nextRound = 1;
  private nextVtxo = 1;
  // Invariant checks record here instead of throwing inside the engine.
  violations: string[] = [];

  add(v: Omit<EngineVtxo, "id" | "state"> & { id?: string; state?: EngineVtxo["state"] }): EngineVtxo {
    const id = v.id ?? `${(this.nextVtxo++).toString(16).padStart(64, "b")}:0`;
    const full: EngineVtxo = { state: { type: "spendable" }, ...v, id };
    this.vtxos.set(id, full);
    return full;
  }

  async refreshServer() {}
  async arkLimits() {
    return { maxVtxoExitDepth: this.maxVtxoExitDepth, maxVtxoAmountSats: this.maxVtxoAmountSats };
  }
  async allVtxos() {
    return [...this.vtxos.values()].map((v) => structuredClone(v));
  }
  async pendingRoundStates(): Promise<EngineRoundState[]> {
    return this.rounds.map((r) => ({ id: r.id, state: r.state }));
  }
  async pendingRoundInputs() {
    return this.rounds.flatMap((r) => r.inputs);
  }
  async progressPendingRounds() {}
  async estimateRefreshFee(ids: string[]) {
    const gross = ids.reduce((s, id) => s + (this.vtxos.get(id)?.amountSats ?? 0), 0);
    const feeSats = Math.floor((gross * this.feePpm) / 1_000_000);
    return { feeSats, netAmountSats: gross - feeSats };
  }

  // The worker's refreshVtxosDelegatedAndLock: one queue item, lock (a
  // check), submit, unlock whatever the outcome.
  async refreshAndLock(ids: string[], holderId: string) {
    for (const id of ids) await this.unlockVtxos([id], holderId).catch(() => {});
    try {
      await this.lockVtxos(ids, holderId);
    } catch (e) {
      throw new Error(`REFRESH_INPUTS_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`);
    }
    let round: { id: number; state: string } | undefined;
    try {
      round = await this.refreshVtxosDelegated(ids, holderId);
    } finally {
      await this.unlockVtxos(ids, holderId).catch(() => {});
    }
    this.betweenCalls?.();
    return { round };
  }

  // Runs after every other queue item, like a payment the app queued behind
  // it. Tests use it to try to spend coins the engine just submitted.
  betweenCalls: (() => void) | null = null;

  async refreshVtxosDelegated(ids: string[], lockedBy?: string) {
    this.submits.push([...ids]);
    for (const id of ids) {
      const v = this.vtxos.get(id);
      const ours = lockedBy !== undefined && v?.state.type === "locked" && v.state.holder?.id === lockedBy;
      if (!v || (v.state.type !== "spendable" && !ours)) this.violations.push(`submitted non-spendable ${id} (${v?.state.type})`);
    }
    if (this.maxVtxoAmountSats !== undefined) {
      const total = ids.reduce((s, id) => s + (this.vtxos.get(id)?.amountSats ?? 0), 0);
      if (total > this.maxVtxoAmountSats) this.violations.push(`batch over max: ${total}`);
    }
    if (ids.some((id) => this.missingCoins.has(id))) {
      throw new Error(
        `error submitting round participation to server: code: 'Some requested entity was not found', message: "not found: input vtxo does not exist"`,
      );
    }
    if (ids.some((id) => this.unusableCoins.has(id))) {
      throw new Error(
        `error submitting round participation to server: code: 'Client specified an invalid argument', message: "bad user input: input vtxo(s) unusable"`,
      );
    }
    const fault = this.faults.shift();
    if (fault?.kind === "reject" || fault?.kind === "throw-before-server") throw new Error(fault.message);

    this.expireOrphans();
    // Server: same inputs supersede, overlapping-but-different would be two live participations.
    const same = this.server.find((p) => sameSet(p.inputs, ids));
    if (same) this.server = this.server.filter((p) => p !== same);
    for (const p of this.server) {
      if (p.inputs.some((i) => ids.includes(i))) this.violations.push(`overlapping live participations ${p.id}`);
    }
    // Autoincrement, like bark's round-state ids: above anything that exists.
    const id = Math.max(this.nextRound, ...this.rounds.map((x) => x.id + 1), ...this.server.map((x) => x.id + 1));
    this.nextRound = id + 1;
    this.server.push({ id, inputs: [...ids], at: this.clock() });
    if (fault?.kind === "lost-before-store") throw new Error(fault.message);
    this.rounds.push({ id, state: "delegated-pending", inputs: [...ids] });
    if (fault?.kind === "lost-after-store") throw new Error(fault.message);
    return { id, state: "delegated-pending" };
  }

  async lockVtxos(ids: string[], holderId: string) {
    if (this.lockFaults > 0) {
      this.lockFaults--;
      throw new Error("Lock VTXOs failed: db busy");
    }
    for (const id of ids) {
      const v = this.vtxos.get(id);
      const sameHolder = v?.state.type === "locked" && v.state.holder?.id === holderId;
      if (!v || (v.state.type !== "spendable" && !sameHolder)) throw new Error(`Lock VTXOs failed: ${id} not spendable`);
    }
    for (const id of ids) this.vtxos.get(id)!.state = { type: "locked", holder: { type: "action", id: holderId } };
  }

  // bark-ffi v0.27.0 (core/wallet.rs unlock_vtxos + ensure_locked_by): with an
  // expected holder EVERY id must be Spendable or locked by that holder, else
  // the whole call fails and nothing is unlocked (bark itself would skip
  // silently; the wrapper checks first). An unknown id fails too.
  async unlockVtxos(ids: string[], holderId: string) {
    if (ids.length === 0) return;
    const bad: string[] = [];
    for (const id of ids) {
      const v = this.vtxos.get(id);
      if (!v) throw new Error(`VTXO not found: ${id}`);
      const ok = v.state.type === "spendable" || (v.state.type === "locked" && v.state.holder?.id === holderId);
      if (!ok) bad.push(`${id} is ${v.state.type}`);
    }
    if (bad.length > 0) {
      throw new Error(`refusing to unlock ${bad.length} VTXO(s) not locked by the expected holder: ${bad.join(", ")}`);
    }
    for (const id of ids) {
      const v = this.vtxos.get(id)!;
      if (v.state.type === "locked" && v.state.holder?.id === holderId) v.state = { type: "spendable" };
    }
  }

  private expireOrphans() {
    const now = this.clock();
    this.server = this.server.filter(
      (p) => this.rounds.some((r) => r.id === p.id) || now - p.at < FakeWallet.ORPHAN_LIFETIME_MS,
    );
  }

  // --- test controls ---

  // The server issues the round and bark, on its next sync, locks the inputs
  // under the round's movement. False (and a violation) when a coin is
  // locked by anyone else: the round is stuck until that lock goes.
  issueRound(id: number): boolean {
    const r = this.rounds.find((x) => x.id === id);
    if (!r || !this.server.some((p) => p.id === id)) return false;
    r.issued = true;
    return this.sdkLock(r);
  }

  private sdkLock(r: { id: number; inputs: string[] }): boolean {
    const holder = { type: "movement", id: r.id };
    const blocked = r.inputs.filter((i) => {
      const v = this.vtxos.get(i);
      const same = v?.state.type === "locked" && v.state.holder?.type === "movement" && v.state.holder.id === r.id;
      return !v || (v.state.type !== "spendable" && !same);
    });
    if (blocked.length > 0) {
      this.violations.push(`bark could not lock the inputs of issued round ${r.id}: ${blocked.join(",")}`);
      return false;
    }
    for (const i of r.inputs) this.vtxos.get(i)!.state = { type: "locked", holder };
    return true;
  }

  finishRound(id: number, newExpiry: number) {
    const r = this.rounds.find((x) => x.id === id) ?? { id, inputs: this.server.find((p) => p.id === id)?.inputs ?? [], state: "" };
    const amount = r.inputs.reduce((s, i) => s + (this.vtxos.get(i)?.amountSats ?? 0), 0);
    for (const i of r.inputs) {
      const v = this.vtxos.get(i);
      if (v) v.state = { type: "spent" };
    }
    if (r.inputs.length > 0) this.add({ amountSats: amount, expiryHeight: newExpiry, exitDepth: 1 });
    this.rounds = this.rounds.filter((x) => x.id !== id);
    this.server = this.server.filter((p) => p.id !== id);
  }

  // Runs the next round for every pending participation: one the server
  // dropped (a send spent an input) and one holding a round-bad coin fail,
  // the rest are issued (bark locks the inputs) and complete.
  runRound(newExpiry: number) {
    for (const r of [...this.rounds]) {
      if (!this.server.some((p) => p.id === r.id)) this.failRound(r.id);
      else if (r.inputs.some((i) => this.roundBadCoins.has(i))) this.failRound(r.id);
      else if (this.issueRound(r.id)) this.finishRound(r.id, newExpiry);
    }
  }

  failRound(id: number) {
    for (const v of this.vtxos.values()) {
      if (v.state.type === "locked" && v.state.holder?.type === "movement" && v.state.holder.id === id) v.state = { type: "spendable" };
    }
    this.rounds = this.rounds.filter((x) => x.id !== id);
    this.server = this.server.filter((p) => p.id !== id);
  }

  // A send spending coins: only spendable ones (the SDK skips locked).
  spend(id: string) {
    const v = this.vtxos.get(id);
    if (v?.state.type !== "spendable") return false;
    v.state = { type: "spent" };
    this.server = this.server.filter((p) => !p.inputs.includes(id));
    return true;
  }

  lockedBy(holderId: string): string[] {
    return [...this.vtxos.values()].filter((v) => v.state.type === "locked" && v.state.holder?.id === holderId).map((v) => v.id);
  }
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
