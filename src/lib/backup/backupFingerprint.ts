// What "nothing changed since the last upload" means for the cloud backup.
//
// The on-chain database holds one BDK changeset record whose `local_chain` is
// the wallet's list of recent block checkpoints (height to hash). It moves with
// every block (about every 10 minutes), so a byte-exact comparison called every
// open after a new block "changed" and cost four Worker requests. The
// checkpoints are a cache the next sync rebuilds from esplora, never the only
// copy of anything: addresses revealed, transactions and their anchors live in
// the other fields of the same record and still count.
//
// Only the SKIP decision uses this view. The uploaded blob, its sha256 and the
// read-back check stay on the full dump. Anything unexpected (no such record,
// bytes that do not parse, a record without `tx_graph`) leaves the dump
// untouched, so the fingerprint equals the full hash and nothing is skipped
// that was not skipped before.

export interface FingerprintDump {
  onchain?: { stores?: Record<string, { records?: { key: unknown; value: unknown }[] }> } | null;
}

function stripChain(value: unknown): unknown | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0 || data.length > 64 * 1024 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(data as number[])));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const changeset = parsed as Record<string, unknown>;
  if (!("local_chain" in changeset) || !("tx_graph" in changeset)) return null;
  const { local_chain: _chain, ...rest } = changeset;
  return { ...(value as Record<string, unknown>), data: undefined, withoutChain: rest };
}

// A copy of the dump with the checkpoints of the on-chain changeset left out,
// or null when there was nothing to leave out (the caller then reuses the full
// hash). Never mutates its input.
export function dumpWithoutChainCheckpoints<T extends FingerprintDump>(dump: T): T | null {
  const stores = dump.onchain?.stores;
  if (!stores) return null;
  let changed = false;
  const outStores: Record<string, unknown> = {};
  for (const [name, store] of Object.entries(stores)) {
    const records = store.records?.map((r) => {
      const stripped = stripChain(r.value);
      if (stripped === null) return r;
      changed = true;
      return { ...r, value: stripped };
    });
    outStores[name] = records ? { ...store, records } : store;
  }
  if (!changed) return null;
  return { ...dump, onchain: { ...dump.onchain, stores: outStores } } as T;
}
