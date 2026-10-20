// Tests for src/lib/gift/giftReclaim.ts — the decision that says a gift is gone
// for good. Getting it wrong is unrecoverable in one direction: writing the
// record to "claimed"/"reclaimed" stops the auto-return sweep AND hides the
// manual "Vzít zpět" button, so a gift whose funds are still sitting on the
// Ark server is written off with its reclaim seed unused. Everything here is
// about keeping that write off the transient-error path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GIFT_EMPTY_MESSAGE = "Dárek je prázdný nebo už byl vyzvednut.";
const GIFT_SLOW_MESSAGE = "Dárek už byl nejspíš vyzvednut, nebo je pomalé spojení. Zkus to za chvíli znovu.";
const reclaimGiftToAddress = vi.fn();
const scanGiftStatus = vi.fn();

// bark.ts pulls the 7.7MB WASM SDK in at module load, so it's replaced
// wholesale rather than imported — this test is about giftReclaim's own
// branching, not the SDK.
vi.mock("../src/lib/wallet/bark", () => ({
  GIFT_EMPTY_MESSAGE,
  GIFT_SLOW_MESSAGE,
  reclaimGiftToAddress: (...a: unknown[]) => reclaimGiftToAddress(...a),
  scanGiftStatus: (...a: unknown[]) => scanGiftStatus(...a),
}));

const putGift = vi.fn();
const listGifts = vi.fn(async () => [] as unknown[]);
vi.mock("../src/lib/gift/giftStore", () => ({
  decryptGiftMnemonic: async () => "abandon abandon abandon",
  listGifts: () => listGifts(),
  putGift: (...a: unknown[]) => putGift(...a),
}));

const { autoReturnExpiredGifts, claimIsAssumed, emptyMeansGone, GIFT_OFFLINE_MESSAGE, reclaimGift } = await import(
  "../src/lib/gift/giftReclaim"
);
type Gift = Parameters<typeof reclaimGift>[2];

const DAY = 86_400_000;
const gift = (state: string, createdAt = 0): Gift =>
  ({
    id: "g1",
    createdAt,
    expiresAt: createdAt + 7 * DAY,
    amountSats: 5000,
    state,
    mnemonicCipher: { ivB64: "x", cipherB64: "y" },
  }) as Gift;

const wallet = { newAddress: async () => "ark1recipient" } as Parameters<typeof reclaimGift>[0];
const key = {} as CryptoKey;

beforeEach(() => {
  reclaimGiftToAddress.mockReset();
  scanGiftStatus.mockReset();
  putGift.mockReset();
  listGifts.mockReset();
  listGifts.mockResolvedValue([]);
});

describe("reclaimGift", () => {
  it("does NOT write a terminal state for a transient SDK error", async () => {
    // The exact wording ARCHITECTURE.md records reaching users from a VTXO caught
    // mid-round. The old substring scan matched "not spendable" and marked
    // the gift claimed — permanently unrecoverable on a passing condition.
    for (const message of [
      "bad user input: vtxo 0f3a… is not spendable",
      "already spent in a pending round",
      "network error",
      "Wallet worker restarted after becoming unresponsive — please unlock again.",
    ]) {
      reclaimGiftToAddress.mockRejectedValueOnce(new Error(message));
      await expect(reclaimGift(wallet, key, gift("unclaimed"))).rejects.toThrow(message);
      expect(putGift).not.toHaveBeenCalled();
    }
  });

  it("marks a genuinely empty mailbox as claimed", async () => {
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_EMPTY_MESSAGE));
    await expect(reclaimGift(wallet, key, gift("unclaimed"))).resolves.toBe("already-claimed");
    expect(putGift).toHaveBeenCalledWith(expect.objectContaining({ state: "claimed" }));
  });

  it("leaves the record alone on empty when told the verdict isn't final", async () => {
    // The "creating"-before-expiry case: empty probably means the funding
    // send never landed, but it may simply not have landed yet, and a
    // terminal write would strand a late arrival with no sweep left for it.
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_EMPTY_MESSAGE));
    await expect(reclaimGift(wallet, key, gift("creating"), { terminalWhenEmpty: false })).resolves.toBe(
      "already-claimed",
    );
    expect(putGift).not.toHaveBeenCalled();
  });

  it("records a successful sweep as reclaimed", async () => {
    reclaimGiftToAddress.mockResolvedValueOnce({ claimedSats: 5000 });
    await expect(reclaimGift(wallet, key, gift("unclaimed"))).resolves.toBe("reclaimed");
    expect(putGift).toHaveBeenCalledWith(expect.objectContaining({ state: "reclaimed" }));
  });
});

describe("reclaimGift on a timed-out pull", () => {
  // A claimed gift's pull never finishes (observed live, commit d08d1cf), so
  // a timeout is the usual shape of "already claimed" — but a slow network
  // on an untouched gift looks the same, so one timeout must never write it
  // off. Only separate days of them add up.
  const HOUR = 3_600_000;
  const withChecks = (failedChecks: number, lastCheckFailedAt?: number) =>
    ({ ...gift("unclaimed"), failedChecks, lastCheckFailedAt }) as Gift;

  it("records the first timeout but keeps the gift retryable", async () => {
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_SLOW_MESSAGE));
    await expect(reclaimGift(wallet, key, gift("unclaimed"))).rejects.toThrow(GIFT_SLOW_MESSAGE);
    expect(putGift).toHaveBeenCalledTimes(1);
    expect(putGift.mock.calls[0][0]).toMatchObject({ state: "unclaimed", failedChecks: 1 });
  });

  it("does not count repeat timeouts inside the same day", async () => {
    // Three taps on "Vzít zpět" in a minute must not become three days.
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_SLOW_MESSAGE));
    await expect(reclaimGift(wallet, key, withChecks(2, Date.now() - HOUR))).rejects.toThrow(GIFT_SLOW_MESSAGE);
    expect(putGift).not.toHaveBeenCalled();
  });

  it("concludes claimed on the third separate day", async () => {
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_SLOW_MESSAGE));
    await expect(reclaimGift(wallet, key, withChecks(2, Date.now() - 25 * HOUR))).resolves.toBe("already-claimed");
    expect(putGift).toHaveBeenCalledWith(expect.objectContaining({ state: "claimed", failedChecks: 3 }));
  });

  it("never concludes while a terminal write isn't allowed", async () => {
    // An unfinished ("creating") gift before its expiry: nobody can hold its
    // link, so a timeout there is never evidence of a claim.
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_SLOW_MESSAGE));
    await expect(
      reclaimGift(wallet, key, withChecks(2, Date.now() - 25 * HOUR), { terminalWhenEmpty: false }),
    ).rejects.toThrow(GIFT_SLOW_MESSAGE);
    expect(putGift.mock.calls[0][0]).toMatchObject({ state: "unclaimed", failedChecks: 3 });
  });
});

describe("emptyMeansGone", () => {
  it("is final for a gift whose link was actually handed out", () => {
    expect(emptyMeansGone(gift("unclaimed"), 1)).toBe(true);
  });

  it("is not final for an unfinished gift until its expiry passes", () => {
    // A "creating" gift's link is built only after the record flips to
    // "unclaimed", so nobody can hold it — empty is never proof of a claim.
    expect(emptyMeansGone(gift("creating"), 1)).toBe(false);
    expect(emptyMeansGone(gift("creating"), 7 * DAY - 1)).toBe(false);
    expect(emptyMeansGone(gift("creating"), 7 * DAY)).toBe(true);
  });
});

// A gift concluded "claimed" from timeouts alone was written off for good: no
// sweep, no button, while an untouched gift on a bad connection reads exactly
// the same. The manual "Vzít zpět" now stays for it (Settings.tsx).
describe("claimIsAssumed", () => {
  const claimed = (failedChecks?: number) => ({ ...gift("claimed"), failedChecks }) as Gift;

  it("is true only for a claim inferred from timeouts on enough separate days", () => {
    expect(claimIsAssumed(claimed(3))).toBe(true);
    expect(claimIsAssumed(claimed(4))).toBe(true);
    // Seen empty: proof, not a guess. Records from before failedChecks existed
    // have none, and a definite empty resets it (below).
    expect(claimIsAssumed(claimed(2))).toBe(false);
    expect(claimIsAssumed(claimed(undefined))).toBe(false);
    expect(claimIsAssumed(claimed(0))).toBe(false);
    // Only ever about "claimed": a waiting gift with timeouts is still waiting.
    expect(claimIsAssumed({ ...gift("unclaimed"), failedChecks: 5 } as Gift)).toBe(false);
    expect(claimIsAssumed({ ...gift("reclaimed"), failedChecks: 5 } as Gift)).toBe(false);
  });

  it("the conclusion from timeouts reads as assumed, a definite empty afterwards settles it", async () => {
    const HOUR = 3_600_000;
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_SLOW_MESSAGE));
    const unclaimed = { ...gift("unclaimed"), failedChecks: 2, lastCheckFailedAt: Date.now() - 25 * HOUR } as Gift;
    await reclaimGift(wallet, key, unclaimed);
    const concluded = putGift.mock.calls[0][0] as Gift;
    expect(claimIsAssumed(concluded)).toBe(true);

    // The manual retry the button offers finds it empty: now it is proof.
    reclaimGiftToAddress.mockRejectedValueOnce(new Error(GIFT_EMPTY_MESSAGE));
    await expect(reclaimGift(wallet, key, concluded)).resolves.toBe("already-claimed");
    const settled = putGift.mock.calls[1][0] as Gift;
    expect(settled).toMatchObject({ state: "claimed", failedChecks: 0 });
    expect(claimIsAssumed(settled)).toBe(false);
  });

  it("a manual retry that finds the funds still there reclaims them", async () => {
    reclaimGiftToAddress.mockResolvedValueOnce(undefined);
    await expect(reclaimGift(wallet, key, claimed(3))).resolves.toBe("reclaimed");
    expect(putGift).toHaveBeenCalledWith(expect.objectContaining({ state: "reclaimed" }));
  });
});

// Offline a pull can only time out, and timeouts on separate days are what
// concludes a gift claimed. So nothing is tried, and nothing is counted.
describe("offline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a manual reclaim refuses up front and records nothing", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(reclaimGift(wallet, key, gift("unclaimed"))).rejects.toThrow(GIFT_OFFLINE_MESSAGE);
    expect(reclaimGiftToAddress).not.toHaveBeenCalled();
    expect(putGift).not.toHaveBeenCalled();
  });

  it("the auto-return sweep skips its whole run, then works again once online", async () => {
    const expired = { ...gift("unclaimed", 0), expiresAt: 1 } as Gift;
    listGifts.mockResolvedValue([expired]);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(autoReturnExpiredGifts(wallet, key)).resolves.toBe(0);
    expect(listGifts).not.toHaveBeenCalled();
    expect(reclaimGiftToAddress).not.toHaveBeenCalled();

    vi.stubGlobal("navigator", { onLine: true });
    reclaimGiftToAddress.mockResolvedValueOnce(undefined);
    await expect(autoReturnExpiredGifts(wallet, key)).resolves.toBe(1);
    expect(reclaimGiftToAddress).toHaveBeenCalledTimes(1);
  });
});

// Beta: the recovery scan runs before the pull. Only a definite "claimed" short-circuits; every other answer, and
// a scan that cannot look, leaves the pull exactly as it was.
describe("reclaimGift with scanFirst", () => {
  const scan = { scanFirst: true };

  it("a scan that says claimed settles it without touching the mailbox", async () => {
    scanGiftStatus.mockResolvedValueOnce("claimed");
    await expect(reclaimGift(wallet, key, gift("unclaimed"), scan)).resolves.toBe("already-claimed");
    expect(reclaimGiftToAddress).not.toHaveBeenCalled();
    expect(putGift).toHaveBeenCalledWith(expect.objectContaining({ state: "claimed", failedChecks: 0 }));
  });

  it("respects terminalWhenEmpty: an unfinished gift is not written off", async () => {
    scanGiftStatus.mockResolvedValueOnce("claimed");
    await expect(reclaimGift(wallet, key, gift("creating"), { ...scan, terminalWhenEmpty: false })).resolves.toBe(
      "already-claimed",
    );
    expect(putGift).not.toHaveBeenCalled();
    expect(reclaimGiftToAddress).not.toHaveBeenCalled();
  });

  it("waiting, half pulled and unknown all go on to reclaim", async () => {
    for (const verdict of ["waiting", "opened", "unknown"]) {
      scanGiftStatus.mockResolvedValueOnce(verdict);
      reclaimGiftToAddress.mockResolvedValueOnce({ claimedSats: 5000 });
      await expect(reclaimGift(wallet, key, gift("unclaimed"), scan)).resolves.toBe("reclaimed");
    }
    expect(reclaimGiftToAddress).toHaveBeenCalledTimes(3);
  });

  it("a settled claim is not the same as a timeout: nothing is counted", async () => {
    scanGiftStatus.mockResolvedValueOnce("claimed");
    await reclaimGift(wallet, key, { ...gift("unclaimed"), failedChecks: 2 } as Gift, scan);
    expect(putGift.mock.calls[0][0]).toMatchObject({ failedChecks: 0 });
  });

  it("is off unless asked (V1 keeps the pull only)", async () => {
    reclaimGiftToAddress.mockResolvedValueOnce({ claimedSats: 5000 });
    await expect(reclaimGift(wallet, key, gift("unclaimed"), { scanFirst: false })).resolves.toBe("reclaimed");
    expect(scanGiftStatus).not.toHaveBeenCalled();
  });

  it("offline still refuses before any look", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(reclaimGift(wallet, key, gift("unclaimed"), scan)).rejects.toThrow(GIFT_OFFLINE_MESSAGE);
    expect(scanGiftStatus).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
