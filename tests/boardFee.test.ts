import { describe, expect, it } from "vitest";
import type { OnchainUtxo } from "@secondts/bark";
import { boardDrainWeight, estimateBoardNetworkFee } from "../src/lib/send/boardFee";

const utxo = (confirmed: boolean): OnchainUtxo => ({
  type: "local",
  outpoint: { txid: "a".repeat(64), vout: 0 } as never,
  amountSats: 10_000,
  confirmationHeight: confirmed ? 100 : undefined,
});
const rates = (satPerVb: number) => ({
  fastSatPerKwu: 0,
  regularSatPerKwu: satPerVb * 250,
  slowSatPerKwu: 0,
});

describe("estimateBoardNetworkFee", () => {
  it("matches a one-input, one-output taproot transaction (111 vB)", () => {
    expect(boardDrainWeight(1)).toBe(444);
    expect(estimateBoardNetworkFee([utxo(true)], rates(10))).toBe(1110);
  });

  it("counts only confirmed on-chain UTXOs", () => {
    const exitUtxo: OnchainUtxo = {
      type: "exit",
      vtxoId: "v:0",
      amountSats: 1,
      height: 1,
    };
    expect(
      estimateBoardNetworkFee(
        [utxo(true), utxo(true), utxo(false), exitUtxo],
        rates(1),
      ),
    ).toBe(Math.ceil(boardDrainWeight(2) / 4));
  });

  it("gives up without confirmed coins or a usable rate", () => {
    expect(estimateBoardNetworkFee([utxo(false)], rates(5))).toBeNull();
    expect(estimateBoardNetworkFee([utxo(true)], rates(0))).toBeNull();
    expect(
      estimateBoardNetworkFee([utxo(true)], {
        fastSatPerKwu: 1,
        regularSatPerKwu: Number.NaN,
        slowSatPerKwu: 1,
      }),
    ).toBeNull();
  });
});
