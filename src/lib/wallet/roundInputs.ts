// Ids of the inputs of every pending round, issued by the server or not.
//
// bark 0.7.1's pendingRoundInputVtxos() lists only the inputs a round holds
// (locked under its movement, round/mod.rs pending_round_input_vtxos): those
// of a delegated participation the server has issued. One still waiting for
// its round leaves its inputs Spendable and shows up only as its round
// movement, status "pending", inputs = the participation's (join_delegated_round,
// to_movement_update). Exits, the refresh engine and the balance note all need
// both.
//
// Shared by the main thread (WalletClient) and the wallet worker (the SDK's
// Wallet): only the two calls below, same names on both.

export interface RoundInputsSource {
  pendingRoundStates(): Promise<{ state?: string }[]>;
  pendingRoundInputVtxos(): Promise<{ id: string }[]>;
  history(): Promise<{ subsystemName: string; status: string; inputVtxoIds: string[] }[]>;
}

export async function pendingRoundInputIds(w: RoundInputsSource): Promise<Set<string>> {
  const issued = (await w.pendingRoundInputVtxos()).map((v) => v.id);
  // The history is only read while a participation is waiting: a round
  // movement left "pending" by a crash must not hold coins back for good.
  if (!(await w.pendingRoundStates()).some((r) => r.state === "delegated-pending")) return new Set(issued);
  const waiting = (await w.history())
    .filter((m) => m.subsystemName === "bark.round" && m.status === "pending")
    .flatMap((m) => m.inputVtxoIds);
  return new Set([...issued, ...waiting]);
}
