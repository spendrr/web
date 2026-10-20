// The network fee of boardAll()'s funding transaction, which bark's
// estimateBoardFee() leaves out: that one is only the Ark server's board fee
// (bark-0.7.0 board.rs, fees.board). bark builds the funding transaction as a
// drain of the on-chain wallet (prepare_drain_tx) to one P2TR board output at
// the chain source's "regular" rate (board.rs, fee_rates().regular), so the
// fee is that rate times the drain's weight.
//
// Estimate only: it assumes every input is a taproot key-path spend (this
// app's on-chain wallet hands out tb1p/bc1p addresses) and that the drain
// takes exactly the confirmed UTXOs.
import type { FeeRates, OnchainUtxo } from "@secondts/bark";

// Weight units: version, locktime, counts, segwit marker and flag.
const TX_OVERHEAD_WU = 42;
// Outpoint, empty scriptSig, sequence (41 bytes x 4) plus a 64-byte Schnorr
// signature witness with its item count and length.
const P2TR_INPUT_WU = 41 * 4 + 66;
// Amount, script length and a 34-byte P2TR script.
const P2TR_OUTPUT_WU = 43 * 4;

export function boardDrainWeight(inputs: number): number {
  return TX_OVERHEAD_WU + inputs * P2TR_INPUT_WU + P2TR_OUTPUT_WU;
}

// null when there is nothing confirmed to board or the rate is unusable.
export function estimateBoardNetworkFee(
  utxos: readonly OnchainUtxo[],
  rates: FeeRates,
): number | null {
  const inputs = utxos.filter(
    (u) => u.type === "local" && u.confirmationHeight !== undefined,
  ).length;
  const rate = rates.regularSatPerKwu;
  if (inputs === 0 || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.ceil((boardDrainWeight(inputs) * rate) / 1000);
}
