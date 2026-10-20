// Shared "take a gift back" logic — used by the Settings "Odeslané odkazy"
// list (manual "Vzít zpět") and by the dashboard's 7-day auto-return sweep.
import {
  GIFT_EMPTY_MESSAGE,
  GIFT_SLOW_MESSAGE,
  reclaimGiftToAddress,
  scanGiftStatus,
  type WalletClient,
} from "../wallet/bark";
import { decryptGiftMnemonic, listGifts, putGift, type OutgoingGift } from "./giftStore";
import { stableArkAddress } from "../send/arkAddress";
import { isOffline } from "../connectivity/connectivity";

// Offline, a reclaim can only time out, and a timed-out pull is exactly what
// counts toward concluding a gift was claimed (FAILED_CHECKS_TO_CONCLUDE). So
// neither the manual button nor the sweep tries without a network.
export const GIFT_OFFLINE_MESSAGE = "Jsi offline. Dárek vrátíš, až se připojíš.";

// How long a gift may sit in "creating" before the sweep starts trying to
// pull it back. That state means the funding send was dispatched but its
// result never got recorded — the modal writes "unclaimed" only after
// sendArkoorPayment resolves — so the money may well have moved while the
// record still says otherwise.
//
// Crucially, the link is built *after* that write too, so a gift stuck in
// "creating" was never shown to the sender and cannot be in anyone's hands.
// There is nobody to wait for: the only reason not to sweep it immediately
// is that the funding payment may still be in flight. The compose modal
// gives up on it after SEND_WATCHDOG_MS (3 min) but pushes no watchdog
// override, so the call can sit in the worker behind Dashboard's 20-minute
// onchain-sync override before anything tears it down. Half an hour clears
// that comfortably.
const CREATING_GRACE_MS = 30 * 60_000;

// A claimed gift's mailbox pull never finishes, so every reclaim attempt on
// one burns the full mailbox budget and then fails (see GIFT_SLOW_MESSAGE).
// Past its expiry the sweep would repeat that on every app open, forever,
// holding the shared gift worker the whole time. Instead a timed-out gift is
// left alone for a day, and after timing out on this many separate days it
// is taken to be claimed. An unclaimed gift gets pulled back in seconds on
// any reasonable connection, so three separate bad days in a row on one that
// was never touched is not a realistic way to write it off — while a single
// timeout, which is all a slow network ever costs, never does.
const CHECK_RETRY_AFTER_MS = 24 * 60 * 60_000;
const FAILED_CHECKS_TO_CONCLUDE = 3;

export type ReclaimOutcome = "reclaimed" | "already-claimed";

// Whether an empty ephemeral wallet is proof the gift is gone for good, and
// so may be written to a terminal state that stops all future retries.
//
// For an "unclaimed" gift, yes: the link was handed out, and empty means the
// recipient took it. For a "creating" gift, empty most likely means the
// funding payment never landed — but it can equally mean it hasn't landed
// *yet*, and marking the record terminal would strand a late arrival with no
// sweep left to catch it. Stay retryable until the expiry makes that
// implausible.
export function emptyMeansGone(gift: OutgoingGift, now = Date.now()): boolean {
  return gift.state !== "creating" || now >= gift.expiresAt;
}

// A "claimed" gift that was only ever inferred from timeouts on
// FAILED_CHECKS_TO_CONCLUDE separate days, never seen empty. That is enough to
// stop the auto-return sweep from retrying it on every open, but not proof: on
// a connection bad enough three days running, an untouched gift reads exactly
// the same, with its funds still on the Ark server and its reclaim seed right
// here. So the manual "Vzít zpět" stays for these (Settings). Keyed off the
// counter the conclusion itself wrote, so records concluded before this
// existed qualify too; a definite empty resets it (see reclaimGift).
export function claimIsAssumed(gift: OutgoingGift): boolean {
  return gift.state === "claimed" && (gift.failedChecks ?? 0) >= FAILED_CHECKS_TO_CONCLUDE;
}

export async function reclaimGift(
  wallet: WalletClient,
  encryptionKey: CryptoKey,
  gift: OutgoingGift,
  opts: { terminalWhenEmpty?: boolean; scanFirst?: boolean } = {},
): Promise<ReclaimOutcome> {
  const { terminalWhenEmpty = true, scanFirst = true } = opts;
  if (isOffline()) throw new Error(GIFT_OFFLINE_MESSAGE);
  const mnemonic = await decryptGiftMnemonic(encryptionKey, gift.mnemonicCipher);
  if (scanFirst) {
    // Only a definite "spent" ends it here, and it is written exactly like a definitely empty mailbox (same
    // terminalWhenEmpty rule). Waiting, half pulled or any failure to look falls through to the pull below.
    if ((await scanGiftStatus(mnemonic, gift.id)) === "claimed") {
      if (terminalWhenEmpty) await putGift({ ...gift, state: "claimed", claimedAt: Date.now(), failedChecks: 0 });
      return "already-claimed";
    }
  }
  const ownAddress = await stableArkAddress(wallet);
  try {
    await reclaimGiftToAddress(mnemonic, gift.id, ownAddress);
    await putGift({ ...gift, state: "reclaimed", claimedAt: Date.now() });
    return "reclaimed";
  } catch (e) {
    // Exact match on our own sentinel, and nothing else.
    //
    // This used to be a substring scan over ["prázdný nebo už byl
    // vyzvednut", "not spendable", "already spent"], which is a different
    // question entirely: "not spendable" is routine transient SDK output for
    // a VTXO briefly caught up in a round (ARCHITECTURE.md records that exact
    // wording reaching users), and folding it in here wrote the gift to the
    // terminal "claimed" state on a passing network condition. That kills
    // the auto-return sweep AND hides the manual button, so a gift whose
    // funds are sitting untouched on the Ark server is written off for good.
    // Anything that isn't a definitive "the mailbox is empty" stays
    // retryable — the one exception being a timeout seen on enough separate
    // days, handled just below.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === GIFT_EMPTY_MESSAGE) {
      // failedChecks back to 0: an empty wallet is proof, which settles any
      // earlier guess from timeouts (claimIsAssumed).
      if (terminalWhenEmpty) await putGift({ ...gift, state: "claimed", claimedAt: Date.now(), failedChecks: 0 });
      return "already-claimed";
    }
    if (msg === GIFT_SLOW_MESSAGE) {
      // Most likely claimed, possibly just slow. Counted at most once a day
      // no matter how often it's tried — the manual button bypasses the
      // sweep's own back-off, and three taps in a minute must not add up to
      // three separate days of evidence.
      const now = Date.now();
      const countsAsNewDay = gift.lastCheckFailedAt === undefined || now - gift.lastCheckFailedAt >= CHECK_RETRY_AFTER_MS;
      const failedChecks = (gift.failedChecks ?? 0) + (countsAsNewDay ? 1 : 0);
      if (terminalWhenEmpty && failedChecks >= FAILED_CHECKS_TO_CONCLUDE) {
        await putGift({ ...gift, state: "claimed", claimedAt: now, failedChecks, lastCheckFailedAt: now });
        return "already-claimed";
      }
      if (countsAsNewDay) await putGift({ ...gift, failedChecks, lastCheckFailedAt: now });
    }
    // A transient failure (network, worker reset, a VTXO mid-round), or a
    // timeout not yet seen on enough separate days — leave the state alone
    // so the next manual attempt or auto-return cycle retries.
    throw e;
  }
}

// Best-effort sweep, called on mount and on every return to the foreground
// (Dashboard). Returns every gift that can no longer be claimed by anyone
// back to the sender. Errors are swallowed per-gift — the next cycle retries.
export async function autoReturnExpiredGifts(wallet: WalletClient, encryptionKey: CryptoKey): Promise<number> {
  if (isOffline()) return 0;
  let returned = 0;
  const now = Date.now();
  let gifts: OutgoingGift[];
  try {
    gifts = await listGifts();
  } catch {
    return 0;
  }
  for (const g of gifts) {
    // Timed out recently — almost certainly claimed. Don't spend another
    // full mailbox budget on it until a day has passed (see
    // CHECK_RETRY_AFTER_MS).
    if (g.lastCheckFailedAt !== undefined && now - g.lastCheckFailedAt < CHECK_RETRY_AFTER_MS) continue;
    if (g.state === "unclaimed") {
      if (now < g.expiresAt) continue;
    } else if (g.state === "creating") {
      // Swept on its own short grace period rather than the 7-day expiry:
      // nobody holds this link, so waiting a week only delays the recovery
      // of money that is already stranded. Before this, "creating" was
      // skipped outright and neither the sweep nor the Settings list would
      // ever touch it — the funds stayed on the Ark server with the reclaim
      // seed sitting right there in the record, unused.
      if (now - g.createdAt < CREATING_GRACE_MS) continue;
    } else {
      continue; // "claimed" / "reclaimed" — terminal, nothing to do.
    }
    try {
      const outcome = await reclaimGift(wallet, encryptionKey, g, { terminalWhenEmpty: emptyMeansGone(g, now) });
      if (outcome === "reclaimed") returned++;
    } catch {
      // retry next cycle
    }
  }
  return returned;
}
