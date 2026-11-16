// The worker's refreshVtxosDelegatedAndLock (walletWorkerImpl.ts), kept free
// of the SDK runtime so tests can drive it.
//
// One queue item: lock, release, submit. The lock is only a probe:
// lock_vtxos is atomic and only takes Spendable coins, so an input a payment
// already spent (or locked) stops us here, before bark derives a key index for
// the output and before the server sees a participation it would reject as
// "unusable". It is released BEFORE the submit: bark 0.8 checks that every
// input is Spendable when it joins a delegated round (join_delegated_round,
// check_inputs_spendable), so a lock of ours would fail the submit. The
// delegated participation does not lock its inputs either; bark locks them
// itself once the server issues the round (progress_delegated, a checked
// lock_vtxos under the round's movement), and a lock of ours would make that
// fail and the round never finish. Until then the coins stay spendable; a
// payment with one makes the server drop the participation (tree.rs
// invalidate_pending_participations_for_inputs), nothing is lost. The window
// between release and submit is a few awaits in the same queue item, and bark's
// own check closes it.

import { REFRESH_INPUTS_UNAVAILABLE, REFRESH_LIMIT_EXCEEDED, type RefreshAndLockResult } from "./walletSession";

type Holder = { type: "action"; id: string };

export interface RefreshSubmitWallet {
  lockVtxos(args: { vtxoIds: string[]; holder: Holder }): Promise<void>;
  unlockVtxos(args: { vtxoIds: string[]; expectedHolder: Holder }): Promise<void>;
  refreshVtxosDelegated(vtxoIds: string[]): Promise<{ id: number; state?: string } | undefined>;
}

export async function refreshAndRelease(
  wallet: RefreshSubmitWallet,
  ids: string[],
  holderId: string,
  tryCharge: () => boolean,
): Promise<RefreshAndLockResult> {
  const holder: Holder = { type: "action", id: holderId };
  // Coins may still carry our lock from an older version (which kept it for
  // the whole round) or a worker killed mid-call. Take it over: release our
  // own holder's lock coin by coin (bark-ffi refuses a batch with any coin not
  // locked by the holder; a Spendable one just errors and is skipped), then
  // lock all of them.
  for (const id of ids) {
    await wallet.unlockVtxos({ vtxoIds: [id], expectedHolder: holder }).catch(() => {});
  }
  try {
    await wallet.lockVtxos({ vtxoIds: ids, holder });
  } catch (e) {
    throw new Error(`${REFRESH_INPUTS_UNAVAILABLE}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const release = () => wallet.unlockVtxos({ vtxoIds: ids, expectedHolder: holder });
  // Charged while the probe lock is still held, so a refused charge leaves
  // nothing to submit; released before bark sees the inputs; a failed release stops the submit.
  const allowed = tryCharge();
  await release();
  if (!allowed) throw new Error(REFRESH_LIMIT_EXCEEDED);
  const round = await wallet.refreshVtxosDelegated(ids);
  return { round: round ? { id: round.id, state: round.state } : undefined };
}
