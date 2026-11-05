import { useState } from "react";
import { deriveGiftFundingAddress, generateMnemonic, type WalletClient } from "../lib/wallet/bark";
import { loadVaultOrPrompt, missingVaultText } from "../lib/vault/vaultAccess";
import { buildGiftUrl, generateGiftId, type GiftLinkParams } from "../lib/gift/giftLink";
import { deleteGift, encryptGiftMnemonic, putGift, type OutgoingGift } from "../lib/gift/giftStore";
import { reclaimGift } from "../lib/gift/giftReclaim";
import {
  PASSWORD_REQUIRED_THRESHOLD_SATS,
  SPEND_AUTH_FAILED,
  SPEND_AUTH_REQUIRED,
  SPEND_LIMIT_EXCEEDED,
} from "../lib/wallet/walletSession";
import { withTimeout, isWalletCallTimeout, SEND_WATCHDOG_MS, TIMEOUT_MESSAGE } from "../lib/wallet/walletCall";
import { getFiatCurrency, type FiatCurrency } from "../lib/currency";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import {
  AmountField,
  BigAmount,
  Collapse,
  Screen,
  Sheet,
  StatusMark,
  useAmountEntry,
  useSheetClose,
} from "./sheet/PaySheet";
import { ShareLinkResult } from "./sheet/ShareLink";
import { GiftCardResult } from "./GiftCardResult";
import { GiftDoneRow } from "./GiftReadySheet";
import { useDesignVersion } from "../lib/ui/designVersion";
import { surfaceError } from "../lib/appErrors";
import { isOffline } from "../lib/connectivity/connectivity";

// "Poslat dárkem" — send bitcoin as a link. Rebuilt on the shared sheet
// (sheet/PaySheet.tsx) that tap-to-pay uses, so entering an amount here is
// the same big field, the same sats/fiat toggle and the same step-to-step
// motion rather than a separate, plainer modal.
//
// The flow itself is unchanged: compose -> confirm -> the funding payment ->
// the link. See create()'s own comments for why the timeout case is its own
// terminal screen.

const GIFT_MAX_SATS = 100_000;
const MESSAGE_MAX = 140;
const EXPIRY_DAYS = 7;

type Phase = "compose" | "confirm" | "sending" | "result" | "error" | "indeterminate" | "cancelled" | "taken";

export default function GiftComposeModal({
  wallet,
  spendable,
  encryptionKey,
  rates,
  onClose,
}: {
  wallet: WalletClient;
  spendable: number | undefined;
  encryptionKey: CryptoKey;
  rates: Record<FiatCurrency, number> | null;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const cur = getFiatCurrency();
  const rate = rates ? rates[cur] : null;

  const { closing, closeThen } = useSheetClose();
  const [phase, setPhase] = useState<Phase>("compose");
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  // The worker asked for the password on an amount under the threshold: the
  // rolling cap on password-less sends is used up (SPEND_LIMIT_EXCEEDED). Kept
  // for the rest of this sheet, since the cap won't have refilled by the retry.
  const [forcePassword, setForcePassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  // The record of the gift just made, for "Zrušit dárek" (reclaimGift wants it).
  const [made, setMade] = useState<OutgoingGift | null>(null);

  const amount = useAmountEntry(rate, cur, fmt, () => setErrorMsg(null));
  const amountSats = amount.sats;
  const overCap = amountSats > GIFT_MAX_SATS;
  const overBalance = spendable !== undefined && amountSats > spendable;
  const validAmount = amountSats > 0 && !overCap && !overBalance;
  const needsPassword = amountSats >= PASSWORD_REQUIRED_THRESHOLD_SATS || forcePassword;

  const close = () => closeThen(onClose);
  // Beta: the result as a card with gallery and print export.
  const cardOn = useDesignVersion() === "v2";

  // Takes the gift back right here. The link stops working the moment the funds are ours again, so it asks once.
  const cancelGift = async () => {
    if (!made) return;
    setErrorMsg(null);
    try {
      const outcome = await reclaimGift(wallet, encryptionKey, made, { terminalWhenEmpty: true });
      setPhase(outcome === "reclaimed" ? "cancelled" : "taken");
    } catch (e) {
      surfaceError(e, setErrorMsg);
    }
  };

  const create = async () => {
    // Offline the SDK retries instead of failing, so the funding send would
    // hang for SEND_WATCHDOG_MS and end on "Nevíme, jestli platba prošla".
    // Nothing has been written or sent yet: stay on the confirm screen.
    if (isOffline()) {
      setErrorMsg(t("Jsi offline. Dárek vytvoříš, až se připojíš."));
      return;
    }
    setErrorMsg(null);
    setPhase("sending");
    const id = generateGiftId();
    const now = Date.now();
    // Whether this attempt got as far as writing its "creating" record, i.e.
    // whether there is one for the catch below to take back.
    let recordWritten = false;
    try {
      // Before anything is written: a missing vault is known up front and
      // must not leave a record behind.
      let spender = wallet;
      if (needsPassword) {
        const vault = loadVaultOrPrompt();
        if (!vault) throw new Error(t(missingVaultText()));
        spender = wallet.withAuth({ vault, password });
      }

      const giftMnemonic = await generateMnemonic();
      const fundingAddress = await deriveGiftFundingAddress(giftMnemonic, id);

      // Persist the reclaim seed (encrypted) *before* the funds move, in a
      // "creating" state — so a crash between here and the send leaves a
      // recoverable record rather than orphaned funds.
      const mnemonicCipher = await encryptGiftMnemonic(encryptionKey, giftMnemonic);
      await putGift({
        id,
        createdAt: now,
        expiresAt: now + EXPIRY_DAYS * 86_400_000,
        amountSats,
        message: message.trim() || undefined,
        state: "creating",
        mnemonicCipher,
      });
      recordWritten = true;

      await withTimeout(
        spender.sendArkoorPayment(fundingAddress, amountSats),
        SEND_WATCHDOG_MS,
        t(TIMEOUT_MESSAGE),
      );

      const unclaimed: OutgoingGift = {
        id,
        createdAt: now,
        expiresAt: now + EXPIRY_DAYS * 86_400_000,
        amountSats,
        message: message.trim() || undefined,
        state: "unclaimed",
        mnemonicCipher,
      };
      await putGift(unclaimed);
      setMade(unclaimed);

      const params: GiftLinkParams = {
        mnemonic: giftMnemonic,
        amountSats,
        message: message.trim() || undefined,
        id,
        // The recipient's new wallet starts without a password (deviceVault.ts).
        passwordless: true,
      };
      setLink(buildGiftUrl(window.location.origin, params));
      setPhase("result");
    } catch (e) {
      // A timeout here is not a failure — the funding sendArkoorPayment may
      // still be running in the worker and may yet settle (see
      // isWalletCallTimeout's own comment). The "error" phase's "Zpět"
      // button returns to "compose" with the amount/message untouched, and
      // Potvrdit there calls create() again with a brand-new id/mnemonic —
      // a genuine second funding payment stacked on top of a first one that
      // hasn't resolved. Both can settle: real double spend of the user's
      // own balance. Route a timeout to its own phase instead, with no path
      // back into compose/confirm — only closing the sheet. The gift record
      // this attempt already wrote stays in its "creating" state either
      // way; giftReclaim.ts's grace-period sweep reclaims it if the send
      // never lands.
      if (isWalletCallTimeout(e)) {
        setErrorMsg(
          t(
            "Nevíme, jestli se dárek odeslal. Zkontroluj historii peněženky, než to zkusíš znovu — druhý pokus by mohl poslat bitcoiny podruhé.",
          ),
        );
        setPhase("indeterminate");
        return;
      }
      // Refused by the wallet worker's spend gate, which runs before the SDK
      // is called at all (enforceSpendPolicy in walletWorkerImpl.ts): nothing
      // left the wallet, so the "creating" record describes a gift that will
      // never exist. Left in place it read "nedokončeno" for a week, and the
      // auto-return sweep opened its empty gift wallet on every app start.
      // Only these three: any other error may come from inside the SDK, where
      // a failed send is not proof that nothing moved.
      const message = e instanceof Error ? e.message : "";
      if (message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED || message === SPEND_LIMIT_EXCEEDED) {
        if (recordWritten) await deleteGift(id).catch(() => {});
        if (message === SPEND_AUTH_FAILED) {
          setErrorMsg(t("Nesprávné heslo."));
        } else {
          setForcePassword(true);
          setErrorMsg(
            message === SPEND_LIMIT_EXCEEDED
              ? t("Denní limit plateb bez hesla je vyčerpaný. Potvrď prosím platbu heslem.")
              : t("Potvrď prosím platbu heslem."),
          );
        }
        setPassword("");
        setPhase("confirm");
        return;
      }
      surfaceError(e, setErrorMsg);
      setPhase("error");
    }
  };

  const amountProblem = overCap
    ? t("Maximum je 100 000 sats.")
    : overBalance
      ? t("Víc, než máš k dispozici.")
      : null;

  let body;
  if (phase === "compose") {
    body = (
      <Screen>
        <h2 className="sht-title">{t("Poslat dárkem")}</h2>
        <AmountField
          entry={amount}
          currency={cur}
          over={overCap || overBalance}
          autoFocus
          deferFocus
          label={t("Částka")}
        />
        <p className={`sht-balance${overCap || overBalance ? " is-over" : ""}`}>
          {amountProblem ??
            (spendable !== undefined ? tf(t("Zůstatek {amount} sats"), { amount: fmt(spendable) }) : " ")}
        </p>
        <input
          className="sht-field"
          placeholder={t("Vzkaz (nepovinné)")}
          value={message}
          maxLength={MESSAGE_MAX}
          onChange={(e) => setMessage(e.target.value)}
        />
        {errorMsg && <p className="sht-error">{errorMsg}</p>}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={close}>
            {t("Zrušit")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              // Never disabled — an empty or refused amount is answered on
              // tap (a shake plus the reason) rather than by a dead button
              // with no explanation of what is missing.
              if (!validAmount) {
                setErrorMsg(amountProblem ?? t("Zadej částku."));
                amount.shake();
                return;
              }
              setPhase("confirm");
            }}
          >
            {t("Vytvořit odkaz")}
          </button>
        </div>
      </Screen>
    );
  } else if (phase === "confirm") {
    body = (
      <Screen>
        <h2 className="sht-title">{t("Poslat dárkem")}</h2>
        <BigAmount sats={amountSats} rate={rate} currency={cur} fmt={fmt} />
        <p className="sht-sub">
          {t("Částka teď opustí tvůj zůstatek. Nevyzvednutý dárek se ti sám vrátí po 7 dnech.")}
        </p>
        <Collapse open={needsPassword}>
          <input
            className="sht-field"
            type="password"
            placeholder={t("Heslo")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Collapse>
        {errorMsg && <p className="sht-error">{errorMsg}</p>}
        <div className="sht-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setErrorMsg(null);
              setPhase("compose");
            }}
          >
            {t("Zpět")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={needsPassword && !password}
            onClick={() => void create()}
          >
            {t("Potvrdit")}
          </button>
        </div>
      </Screen>
    );
  } else if (phase === "sending") {
    body = (
      <Screen>
        <StatusMark state="progress" />
        <h2 className="sht-title">{t("Vytvářím odkaz…")}</h2>
        <BigAmount sats={amountSats} rate={rate} currency={cur} fmt={fmt} />
      </Screen>
    );
  } else if (phase === "result" && link) {
    body = (
      <Screen>
        <StatusMark state="sent" />
        <h2 className="sht-title">{t("Dárek je připravený")}</h2>
        {cardOn && made ? (
          <GiftCardResult
            link={link}
            amountSats={amountSats}
            message={made.message}
            expiresAt={made.expiresAt}
            shareText={t("Poslal jsem ti bitcoin 🎁")}
          />
        ) : (
          <ShareLinkResult link={link} shareText={t("Poslal jsem ti bitcoin 🎁")} compact>
            <BigAmount sats={amountSats} rate={rate} currency={cur} fmt={fmt} />
            <p className="sht-sub">{t("Kdo odkaz otevře, ten si dárek vyzvedne. Posílej ho jen komu věříš.")}</p>
          </ShareLinkResult>
        )}
        {errorMsg && <p className="sht-error">{errorMsg}</p>}
        <GiftDoneRow onDone={close} onCancelGift={cancelGift} />
      </Screen>
    );
  } else if (phase === "cancelled") {
    body = (
      <Screen>
        <StatusMark state="sent" />
        <h2 className="sht-title">{t("Dárek je zpět")}</h2>
        <BigAmount sats={amountSats} rate={rate} currency={cur} fmt={fmt} />
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (phase === "taken") {
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Tenhle dárek už je vyzvednutý")}</h2>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  } else if (phase === "indeterminate") {
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Nevíme jistě, jestli platba prošla")}</h2>
        {errorMsg && <p className="sht-sub">{errorMsg}</p>}
        {/* Deliberately no "Zpět" here — see create()'s catch above.
            Closing is the only way out, so re-sending needs a fresh,
            deliberate reopen of this sheet rather than one more tap on the
            same still-filled form. */}
        <button type="button" className="primary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  } else {
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Dárek se nepodařilo vytvořit")}</h2>
        {errorMsg && <p className="sht-sub">{errorMsg}</p>}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={close}>
            {t("Zavřít")}
          </button>
          <button type="button" className="primary" onClick={() => setPhase("compose")}>
            {t("Zpět")}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Sheet
      closing={closing}
      // A stray tap outside must never dismiss a screen carrying an
      // uncertain outcome, a running payment, or a link that has not been
      // copied anywhere yet.
      onBackdrop={phase === "compose" ? close : undefined}
      screenKey={phase}
    >
      {body}
    </Sheet>
  );
}
