import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { getFiatCurrency } from "../lib/currency";
import { fetchBtcRates } from "../lib/price";
import { loadQuickState, saveQuickState, type QuickPayState } from "../lib/send/quickPay";
import { loadVaultOrPrompt, missingVaultText } from "../lib/vault/vaultAccess";
import { changeSpendLimits } from "../lib/wallet/bark";
import { refreshSpendLimits, setSpendLimitsStatus, useSpendLimitsStatus } from "../lib/wallet/spendLimitsClient";
import { SPEND_AUTH_FAILED, SPEND_AUTH_REQUIRED } from "../lib/wallet/walletSession";
import { DEFAULT_LIMITS, type LimitChange } from "../lib/wallet/spendLimits";
import { SpendLimitSheet, type LimitKind } from "./SpendLimitSheet";
import { SpendLimitsPage } from "./SpendLimitsPage";

// Settings > Limity výdajů (beta). The worker holds and enforces the limits; this reads them, asks for changes
// and keeps the quick-pay setting, which is a main-thread convenience and not a limit.
export function SpendLimitsSettings() {
  const t = useT();
  const status = useSpendLimitsStatus();
  const currency = getFiatCurrency();
  const [rate, setRate] = useState<number | null>(null);
  const [quick, setQuick] = useState<QuickPayState>(() => loadQuickState());
  const [sheet, setSheet] = useState<LimitKind | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refreshSpendLimits();
    let cancelled = false;
    fetchBtcRates().then(
      (rates) => !cancelled && setRate(rates[currency]),
      () => undefined,
    );
    // The daily window moves while the page is open.
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [currency]);

  const apply = async (change: LimitChange, password: string): Promise<string | null> => {
    let auth;
    if (password !== "") {
      const vault = loadVaultOrPrompt();
      if (!vault) return t(missingVaultText());
      auth = { vault, password };
    }
    try {
      const res = await changeSpendLimits(change, auth);
      if (!res.ok) return res.reason === "above-hard" ? t("Nad denním limitem") : t("Neplatná částka");
      setSpendLimitsStatus(res.status);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED) return t("Nesprávné heslo.");
      return message;
    }
  };

  const shown = status ?? { limits: DEFAULT_LIMITS, hardRemainingSats: null, oldestAt: null, unreadable: false };

  return (
    <div className="settings-body">
      {status?.unreadable && <p className="limits-note">{t("Limity nejdou přečíst. Platí heslo u každé platby, dokud je znovu nenastavíš.")}</p>}
      <SpendLimitsPage
        status={shown}
        windowOldestAt={shown.oldestAt}
        now={now}
        quick={quick}
        currency={currency}
        btcRate={rate}
        onQuick={(q) => {
          setQuick(q);
          saveQuickState(q);
        }}
        onEditNoPassword={() => setSheet("noPassword")}
        onEditHard={() => setSheet("hard")}
        onCancelPending={() => void apply({ kind: "cancelPending" }, "")}
      />
      {sheet && (
        <SpendLimitSheet
          kind={sheet}
          limits={shown.limits}
          now={now}
          currency={currency}
          btcRate={rate}
          onClose={() => setSheet(null)}
          onSave={(sats, password) => apply(sheet === "noPassword" ? { kind: "noPassword", sats: sats ?? 0 } : { kind: "hard", sats }, password)}
        />
      )}
    </div>
  );
}
