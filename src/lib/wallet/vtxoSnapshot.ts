// One shared read of the live coins (vtxos(), not allVtxos(): see bark.ts) for
// callers that only DISPLAY or REPORT the list (Settings → VTXO mince, the
// expiry watch the push report carries). The list holds at least the spendable
// and locked coins; a tick's recorded allVtxos() read also carries spent and
// exited ones, so readers filter by state as before.
// The call costs seconds even on a quiet wallet and queues in the worker's
// FIFO, so three readers asking within seconds of each other tripled the wait.
//
// Not for anything that decides about money: the engine tick, sends, exit and
// backup read fresh. A tick's own fresh read is recorded here (so the display
// readers right behind it reuse it), and every engine action that changes
// coin state drops the snapshot.
import type { WalletClient } from "./bark";

type Vtxo = Awaited<ReturnType<WalletClient["allVtxos"]>>[number];

export const VTXO_SNAPSHOT_TTL_MS = 15_000;

interface Entry {
  at: number;
  vtxos: Vtxo[] | null;
  pending: Promise<Vtxo[]> | null;
  // Bumped by a drop: a read that began before it must not be recorded.
  gen: number;
}

const entries = new Map<string, Entry>();

function entry(fp: string): Entry {
  let e = entries.get(fp);
  if (!e) {
    e = { at: 0, vtxos: null, pending: null, gen: 0 };
    entries.set(fp, e);
  }
  return e;
}

export function recordVtxoRead(fingerprint: string, vtxos: Vtxo[], now = Date.now()): void {
  const e = entry(fingerprint);
  e.at = now;
  e.vtxos = vtxos;
}

export function dropVtxoSnapshot(fingerprint: string): void {
  const e = entry(fingerprint);
  e.vtxos = null;
  e.pending = null;
  e.gen += 1;
}

export function readVtxosShared(wallet: WalletClient, now = Date.now()): Promise<Vtxo[]> {
  const e = entry(wallet.fingerprint);
  if (e.vtxos && now - e.at < VTXO_SNAPSHOT_TTL_MS) return Promise.resolve(e.vtxos);
  if (e.pending) return e.pending;
  const gen = e.gen;
  const pending: Promise<Vtxo[]> = wallet.vtxos().then(
    (v) => {
      if (e.gen === gen) {
        e.at = Date.now();
        e.vtxos = v;
      }
      if (e.pending === pending) e.pending = null;
      return v;
    },
    (err) => {
      if (e.pending === pending) e.pending = null;
      throw err;
    },
  );
  e.pending = pending;
  return pending;
}
