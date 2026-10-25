// bark prices an exit as a whole and fails on the first coin whose exit chain
// is not relayable ("Non-Standard VTXO <id>: exit chain is not relayable ...").
// startExitForCoins already skips such a coin on its own; the fee preview has
// to do the same, or one coin hides the fee of every other.
const NON_STANDARD_VTXO = /Non-Standard VTXO ([0-9a-f]{64}:\d+)/i;

export function nonStandardVtxoId(message: string): string | null {
  return NON_STANDARD_VTXO.exec(message)?.[1] ?? null;
}

// Each retry is a full estimate (it syncs the on-chain wallet first), so the
// number of coins left out is capped; past it the error is shown as it is.
const MAX_SKIPPED = 5;

export async function estimateWithoutNonStandard<T>(
  estimate: (ids: string[]) => Promise<T>,
  ids: string[],
): Promise<{ result: T; skipped: string[] }> {
  const left = [...ids];
  const skipped: string[] = [];
  for (;;) {
    try {
      return { result: await estimate(left), skipped };
    } catch (e) {
      const bad = nonStandardVtxoId(e instanceof Error ? e.message : String(e));
      const at = bad === null ? -1 : left.indexOf(bad);
      // Not named, not one of ours, nothing left to price, or too many: the
      // original error is the honest answer.
      if (at < 0 || left.length === 1 || skipped.length >= MAX_SKIPPED) throw e;
      left.splice(at, 1);
      skipped.push(bad!);
    }
  }
}
