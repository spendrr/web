// The one sheet the money chat uses for money: asks the amount and confirms in
// the same step. Sends go through the same narrow arkoor-only call as
// tap-to-pay (BumpOverlay.tsx): the recipient address is the contact's, frozen
// when the sheet opens, the worker's spend policy decides about the password,
// and nothing is re-derived after the user saw it.
import { useMemo, useState } from "react";
import type { WalletClient } from "../../lib/wallet/bark";
import type { Contact, Schedule } from "../../lib/chat/chatClient";
import { addSchedule, markSchedulePaid, sendPayload } from "../../lib/chat/chatClient";
import { MAX_NOTE_CHARS, clampText, describeInterval, type Interval } from "../../lib/chat/messages";
import { nextDue } from "../../lib/chat/recurrence";
import { loadVaultOrPrompt, missingVaultText } from "../../lib/vault/vaultAccess";
import type { FiatCurrency } from "../../lib/currency";
import { hapticSuccess } from "../../lib/ui/haptics";
import { localeFor, tf, useLang, useT } from "../../lib/i18n";
import { checkNamePin, logNamedPayment, pinName } from "../../lib/names/namePins";
import { isWalletCallTimeout, SEND_WATCHDOG_MS, TIMEOUT_MESSAGE, withTimeout } from "../../lib/wallet/walletCall";
import {
  PASSWORD_REQUIRED_THRESHOLD_SATS,
  SPEND_AUTH_FAILED,
  SPEND_AUTH_REQUIRED,
  SPEND_LIMIT_EXCEEDED,
} from "../../lib/wallet/walletSession";
import { displayName } from "../../lib/chat/contactName";
import { ContactAvatar } from "./ContactSheet";
import { BooleanSwitch } from "../BooleanSwitch";
import { AmountField, Collapse, Screen, Sheet, StatusMark, useAmountEntry, useSheetClose } from "../sheet/PaySheet";

export type PaySheetMode = "send" | "request";

// Repeat is off unless switched on, and switching it on starts at monthly.
const REPEAT_OPTIONS: { label: string; value: Interval }[] = [
  { label: "Denně", value: { unit: "day", n: 1 } },
  { label: "Týdně", value: { unit: "week", n: 1 } },
  { label: "Měsíčně", value: { unit: "month", n: 1 } },
];
const MONTHLY = REPEAT_OPTIONS[2].value;

// The option an interval belongs to. One with no option of its own (a
// suggestion like "every 2 weeks") highlights its unit and keeps its own text
// in the line below until another is picked.
function repeatOption(every: Interval | null): number {
  if (!every) return -1;
  return every.unit === "day" ? 0 : every.unit === "week" ? 1 : 2;
}

export default function ChatPaySheet({
  wallet,
  contact,
  mode: initialMode,
  initialEvery,
  initialSats,
  initialNote,
  schedule,
  spendable,
  rates,
  currency,
  onClose,
  onPaid,
  onCriticalOpChange,
}: {
  wallet: WalletClient;
  contact: Contact;
  mode: PaySheetMode;
  initialEvery?: Interval | null;
  initialSats?: number;
  initialNote?: string;
  // Paying a due reminder: the amount is fixed and the schedule moves on.
  schedule?: Schedule;
  spendable?: number;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  onClose: () => void;
  onPaid?: () => void;
  onCriticalOpChange?: (active: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const rate = rates?.[currency] ?? null;
  const [error, setError] = useState<string | null>(null);
  const amount = useAmountEntry(rate, currency, fmt, () => setError(null));
  const { closing, closeThen } = useSheetClose();
  const [every, setEvery] = useState<Interval | null>(initialEvery ?? null);
  // Switching repeat off and on again brings back what was picked.
  const [lastEvery, setLastEvery] = useState<Interval>(initialEvery ?? MONTHLY);
  const pick = repeatOption(every);
  const [note, setNote] = useState(initialNote ?? "");
  const [password, setPassword] = useState("");
  const [forcePassword, setForcePassword] = useState(false);
  const [phase, setPhase] = useState<"compose" | "sending" | "uncertain">("compose");
  // Frozen at open: the address this sheet pays is the one it was opened with.
  const [address] = useState(contact.address ?? null);
  const pin = useMemo(() => (contact.name && address ? checkNamePin(contact.name, address) : "new"), [contact, address]);

  const [mode, setMode] = useState<PaySheetMode>(initialMode);
  const fixedSats = schedule?.sats ?? initialSats;
  // Paying a request or a reminder is a payment, nothing else.
  const canSwitchMode = fixedSats === undefined;
  const sats = fixedSats ?? amount.sats;
  const isSend = mode === "send";
  const needsPassword = isSend && (sats >= PASSWORD_REQUIRED_THRESHOLD_SATS || forcePassword);
  const overBalance = isSend && spendable !== undefined && sats > spendable;
  const who = displayName(contact, contact.pubkey);
  const close = () => closeThen(onClose);

  const submit = async () => {
    if (sats <= 0) {
      setError(t("Zadej částku."));
      amount.shake();
      return;
    }
    if (overBalance) {
      setError(t("Nedostatek prostředků."));
      amount.shake();
      return;
    }
    const cleanNote = clampText(note, MAX_NOTE_CHARS) || undefined;
    if (!isSend) {
      setPhase("sending");
      try {
        await sendPayload(contact.pubkey, { t: "request", sats, ...(cleanNote ? { note: cleanNote } : {}), ...(every ? { every } : {}) });
        hapticSuccess();
        closeThen(onClose);
      } catch {
        setError(t("Žádost se nepodařilo poslat."));
        setPhase("compose");
      }
      return;
    }
    if (!address) {
      setError(t("Kontakt nemá adresu."));
      return;
    }
    setPhase("sending");
    onCriticalOpChange?.(true);
    try {
      let spender = wallet;
      if (needsPassword) {
        const vault = loadVaultOrPrompt();
        if (!vault) throw new Error(t(missingVaultText()));
        spender = wallet.withAuth({ vault, password });
      }
      await withTimeout(spender.sendArkoorPayment(address, sats), SEND_WATCHDOG_MS, t(TIMEOUT_MESSAGE));
    } catch (e) {
      onCriticalOpChange?.(false);
      if (isWalletCallTimeout(e)) {
        setPhase("uncertain");
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setPhase("compose");
      if (message === SPEND_LIMIT_EXCEEDED || (message === SPEND_AUTH_REQUIRED && !needsPassword)) {
        setForcePassword(true);
        setError(t("Tuto platbu je potřeba potvrdit heslem."));
      } else if (message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED) {
        setError(t("Nesprávné heslo."));
      } else if (/insufficient|not enough|balance/i.test(message)) {
        setError(t("Nedostatek prostředků."));
      } else {
        setError(t("Platbu se nepodařilo odeslat."));
      }
      return;
    }
    onCriticalOpChange?.(false);
    if (contact.name) {
      pinName(contact.name, address);
      logNamedPayment(contact.name, sats);
    }
    if (schedule) markSchedulePaid(schedule.id);
    hapticSuccess();
    // No success screen: the payment bubble in the conversation (and the
    // island) is the confirmation.
    closeThen(onClose);
    onPaid?.();
    // The money has moved; the messages are a courtesy and must not turn a
    // completed payment into an error.
    try {
      await sendPayload(contact.pubkey, { t: "payment", sats, to: address, ...(cleanNote ? { note: cleanNote } : {}) });
      if (every && !schedule) {
        addSchedule({ peer: contact.pubkey, kind: "send", sats, every, ...(cleanNote ? { note: cleanNote } : {}) }, nextDue(Date.now(), every));
        await sendPayload(contact.pubkey, { t: "schedule", sats, every, ...(cleanNote ? { note: cleanNote } : {}) });
      }
    } catch (e) {
      console.error("[chat] payment note not sent", e);
    }
  };

  let body;
  if (phase === "compose") {
    const shownEvery = every ?? lastEvery;
    body = (
      <Screen>
        <div className="cht-pay-head">
          <ContactAvatar contact={contact} pubkey={contact.pubkey} size={44} />
          <h2 className="sht-title">{who}</h2>
        </div>
        {canSwitchMode && (
          <div className="mode-toggle cht-pay-modes" role="tablist">
            {(["send", "request"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "active" : ""}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
              >
                {m === "send" ? t("Poslat") : t("Chci")}
              </button>
            ))}
          </div>
        )}
        {fixedSats !== undefined ? (
          <p className="cht-fixed-amount">
            {fmt(fixedSats)} <span>sats</span>
          </p>
        ) : (
          <AmountField entry={amount} currency={currency} over={overBalance} autoFocus deferFocus label={t("Částka")} />
        )}
        <div className="cht-pay-options">
          <input
            className="cht-pay-note"
            placeholder={t("Poznámka (nepovinné)")}
            aria-label={t("Poznámka (nepovinné)")}
            value={note}
            maxLength={MAX_NOTE_CHARS}
            onChange={(e) => setNote(e.target.value)}
          />
          {!schedule && (
            <div className="cht-repeat">
              <div className="cht-repeat-head">
                <span className="cht-repeat-label">{t("Opakovat")}</span>
                <BooleanSwitch checked={every !== null} onChange={(on) => setEvery(on ? lastEvery : null)} label={t("Opakovat")} />
              </div>
              <Collapse open={every !== null}>
                <div className="mode-toggle cht-pay-intervals" role="radiogroup" aria-label={t("Opakovat")}>
                  {REPEAT_OPTIONS.map((o, i) => (
                    <button
                      key={o.label}
                      type="button"
                      role="radio"
                      aria-checked={i === pick}
                      className={i === pick ? "active" : ""}
                      onClick={() => {
                        setEvery(o.value);
                        setLastEvery(o.value);
                      }}
                    >
                      {t(o.label)}
                    </button>
                  ))}
                </div>
                <p className="cht-repeat-hint">
                  {isSend
                    ? tf(t("Teď a pak připomínka {when}."), { when: describeInterval(shownEvery) })
                    : tf(t("Opakovaně {when}. Druhá strana musí přijmout."), { when: describeInterval(shownEvery) })}
                </p>
              </Collapse>
            </div>
          )}
        </div>
        {isSend && pin === "changed" && (
          <p className="sht-warning">{t("Adresa tohoto jména se od minulé platby změnila.")}</p>
        )}
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
        {error && <p className="sht-error">{error}</p>}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={close}>
            {t("Zrušit")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={needsPassword && !password}
            onClick={() => void submit()}
          >
            {isSend ? t("Zaplatit") : t("Poslat žádost")}
          </button>
        </div>
      </Screen>
    );
  } else if (phase === "sending") {
    body = (
      <Screen>
        <StatusMark state="progress" />
        <h2 className="sht-title">{isSend ? t("Platím…") : t("Posílám…")}</h2>
      </Screen>
    );
  } else {
    body = (
      <Screen>
        <h2 className="sht-title">{t("Nevíme jistě, jestli platba prošla")}</h2>
        <p className="sht-sub">{t("Zkontroluj historii, než zaplatíš znovu.")}</p>
        <div className="sht-actions">
          <button type="button" className="primary" onClick={close}>
            {t("Zavřít")}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={phase === "compose" ? close : undefined} screenKey={phase}>
      {body}
    </Sheet>
  );
}
