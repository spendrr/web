import { useState } from "react";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import { isDone, type GiftRowStatus, type ScanExpiry } from "../lib/gift/giftScan";
import "./SentGiftsView.css";

export interface GiftRowData {
  id: string;
  amountSats: number;
  createdAt: number;
  status: GiftRowStatus;
  expiry: ScanExpiry;
  canTakeBack: boolean;
  canCopy: boolean;
  // A look is running for this gift right now.
  looking: boolean;
  busy: boolean;
}

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

// Presentation only (the list and the preview share it): the rows, the status word, at most one visible action.
// A tap on the row opens the gift's sheet when `onOpen` is given (V2), else shows "Kopírovat odkaz".
export default function SentGiftsView({
  rows,
  checking,
  onTakeBack,
  onCopy,
  onOpen,
}: {
  rows: GiftRowData[];
  checking: boolean;
  onTakeBack: (id: string) => void;
  onCopy: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const num = new Intl.NumberFormat(localeFor(lang));
  const [expanded, setExpanded] = useState<string | null>(null);

  const LABEL: Record<GiftRowStatus, string> = {
    creating: t("Nedokončeno"),
    waiting: t("Čeká"),
    opened: t("Otevřeno"),
    claimed: t("Vyzvednuto"),
    reclaimed: t("Vráceno"),
  };
  const day = (ms: number) => new Date(ms).toLocaleDateString(localeFor(lang), { day: "numeric", month: "numeric" });
  const span = (ms: number) =>
    ms >= DAY_MS
      ? tf(t("{n} d"), { n: Math.ceil(ms / DAY_MS) })
      : tf(t("{n} h"), { n: Math.max(1, Math.ceil(ms / HOUR_MS)) });
  const sub = (r: GiftRowData): string => {
    const parts = [day(r.createdAt)];
    if (r.status === "creating") parts.push(t("platba se nejspíš neodeslala"));
    if (r.expiry?.kind === "in") parts.push(tf(t("vrátí se za {span}"), { span: span(r.expiry.ms) }));
    if (r.expiry?.kind === "due") parts.push(t("vrací se"));
    return parts.join(" · ");
  };

  const open = rows.filter((r) => !isDone(r.status));
  const done = rows.filter((r) => isDone(r.status));

  return (
    <>
      <div className="sgv-head">
        <h3 className="settings-subhead">{t("Odeslané dárky")}</h3>
        {checking && <span className="sgv-checking">{t("ověřuji…")}</span>}
      </div>

      {open.length > 0 && (
        <div className="settings-group">
          {open.map((r) => {
            const isOpen = expanded === r.id;
            const head = (
              <>
                <span className="sgv-amount">{num.format(r.amountSats)} sats</span>
                <span className={`sgv-status sgv-status--${r.status}`}>{LABEL[r.status]}</span>
              </>
            );
            return (
              <div className="sgv-row" key={r.id}>
                {r.canCopy ? (
                  <button
                    type="button"
                    className="sgv-main"
                    aria-expanded={onOpen ? undefined : isOpen}
                    onClick={() => (onOpen ? onOpen(r.id) : setExpanded(isOpen ? null : r.id))}
                  >
                    {head}
                  </button>
                ) : (
                  <div className="sgv-line">{head}</div>
                )}
                <div className="sgv-line">
                  <span className="sgv-sub">{sub(r)}</span>
                  {r.canTakeBack && (
                    <button type="button" className="sgv-link" disabled={r.busy} onClick={() => onTakeBack(r.id)}>
                      {r.busy ? t("Vracím…") : t("Vzít zpět")}
                    </button>
                  )}
                </div>
                {isOpen && r.canCopy && (
                  <div className="sgv-more">
                    <button type="button" className="sgv-link" onClick={() => onCopy(r.id)}>
                      {t("Kopírovat odkaz")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {done.length > 0 && (
        <details className="sgv-done" open={open.length === 0}>
          <summary>{tf(t("Dokončené ({n})"), { n: done.length })}</summary>
          <div className="settings-group">
            {done.map((r) => (
              <div className="sgv-done-row" key={r.id}>
                <span>
                  {day(r.createdAt)} · {num.format(r.amountSats)} sats
                </span>
                <span className={`sgv-status sgv-status--${r.status}`}>{LABEL[r.status]}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
