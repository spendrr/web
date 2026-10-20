// A contact's profile, opened from the conversation header: who they are, what
// went between you, the recurring payments, and blocking. One sheet, no steps.
import { useEffect, useMemo, useState } from "react";
import type { Movement } from "@secondts/bark";
import {
  acceptContact,
  blockContact,
  removeSchedule,
  setContactVerified,
  type Contact,
  type Schedule,
  type StoredMessage,
} from "../../lib/chat/chatClient";
import { displayName } from "../../lib/chat/contactName";
import { safetyCode } from "../../lib/chat/safety";
import { contactPayments } from "../../lib/chat/chatHistory";
import { describeInterval } from "../../lib/chat/messages";
import { localeFor, tf, useLang, useT } from "../../lib/i18n";
import Avatar from "../Avatar";
import { Screen, Sheet, useSheetClose } from "../sheet/PaySheet";

const RECENT_PAYMENTS = 4;

// The same picture the @name shows everywhere else (its address is the seed).
// A contact known only by key gets one drawn from the key, with a dashed edge:
// the picture is not proof of anything, and nobody can make one that looks
// like a verified contact's.
export function ContactAvatar({ contact, pubkey, size }: { contact: Contact | undefined; pubkey: string; size: number }) {
  if (contact?.address) return <Avatar seed={contact.address} size={size} />;
  return (
    <span className="cht-avatar-key" style={{ width: size, height: size }} aria-hidden="true">
      <Avatar seed={`nostr:${pubkey}`} size={size} />
    </span>
  );
}

export function VerifiedMark({ label }: { label: string }) {
  return (
    <svg className="cht-verified" viewBox="0 0 24 24" width="16" height="16" role="img" aria-label={label}>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M8 12.5l2.6 2.6L16 9.7" fill="none" stroke="var(--bg)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ContactSheet({
  me,
  peer,
  contact,
  messages,
  history,
  schedules,
  onOpenMovement,
  onBlocked,
  onClose,
}: {
  // Our own chat key, the other half of the safety code.
  me: string | null;
  peer: string;
  contact: Contact | undefined;
  messages: readonly StoredMessage[];
  history: readonly Movement[];
  schedules: readonly Schedule[];
  onOpenMovement?: (m: Movement) => void;
  onBlocked: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const locale = localeFor(lang);
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);
  const pay = useMemo(
    () => contactPayments(peer, contact?.address, messages, history),
    [peer, contact?.address, messages, history],
  );
  const num = (n: number) => n.toLocaleString(locale);
  const day = (unix: number) => new Date(unix * 1000).toLocaleDateString(locale, { day: "numeric", month: "numeric" });
  const name = displayName(contact, peer);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState<string[] | null>(null);
  useEffect(() => {
    if (!showCode || !me) return;
    let live = true;
    void safetyCode(me, peer).then((c) => {
      if (live) setCode(c);
    });
    return () => {
      live = false;
    };
  }, [showCode, me, peer]);

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="contact">
      <Screen>
        <div className="cht-profile-head">
          <ContactAvatar contact={contact} pubkey={peer} size={72} />
          <h2 className="sht-title">
            {name}
            {contact?.verified && <VerifiedMark label={t("Ověřeno")} />}
          </h2>
          {(pay.sent > 0 || pay.received > 0) && (
            <p className="sht-sub cht-num">
              {tf(t("Poslal jsi {sent} · Dostal jsi {received} sats"), { sent: num(pay.sent), received: num(pay.received) })}
            </p>
          )}
        </div>
        {contact?.accepted && me && (
          <div className="cht-profile-list">
            <button type="button" className="cht-profile-row" onClick={() => setShowCode((v) => !v)} aria-expanded={showCode}>
              <span className="cht-profile-note">{t("Bezpečnostní kód")}</span>
              <span className="cht-profile-day">{contact.verified ? t("Ověřeno") : t("Neověřeno")}</span>
              <svg
                className={`cht-chevron${showCode ? " is-open" : ""}`}
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            {showCode && (
              <div className="cht-safety">
                <p className="cht-safety-code cht-num" aria-label={code?.join(" ")}>
                  {(code ?? Array.from({ length: 8 }, () => "·····")).map((g, i) => (
                    <span key={i}>{g}</span>
                  ))}
                </p>
                <p className="sht-sub">{t("Stejný kód musí vidět i druhý telefon.")}</p>
                <button
                  type="button"
                  className={contact.verified ? "secondary sht-wide" : "primary sht-wide"}
                  disabled={!code}
                  onClick={() => setContactVerified(peer, !contact.verified)}
                >
                  {contact.verified ? t("Zrušit ověření") : t("Kód sedí, ověřit")}
                </button>
              </div>
            )}
          </div>
        )}
        {pay.items.length > 0 && (
          <div className="cht-profile-list">
            {pay.items.slice(0, RECENT_PAYMENTS).map((p) => {
              const mv = history.find((m) => m.id === p.movementId);
              return (
                <button
                  key={p.movementId}
                  type="button"
                  className="cht-profile-row"
                  onClick={mv && onOpenMovement ? () => onOpenMovement(mv) : undefined}
                >
                  <span className="cht-profile-note">{p.note ?? (p.sats < 0 ? t("Posláno") : t("Platba"))}</span>
                  <span className="cht-profile-day">{day(p.at)}</span>
                  <b className={`cht-num ${p.sats < 0 ? "is-out" : "is-in"}`}>
                    {p.sats < 0 ? "−" : "+"}
                    {num(Math.abs(p.sats))}
                  </b>
                </button>
              );
            })}
          </div>
        )}
        {schedules.length > 0 && (
          <div className="cht-profile-list">
            {schedules.map((s) => (
              <div key={s.id} className="cht-profile-row">
                <span className="cht-profile-note">
                  {s.kind === "send" ? t("Posílám") : t("Platím")} {describeInterval(s.every)}
                </span>
                <b className="cht-num">{num(s.sats)}</b>
                <button
                  type="button"
                  className="cht-schedule-x"
                  onClick={() => removeSchedule(s.id)}
                  aria-label={t("Zrušit")}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {contact?.blocked ? (
          <button type="button" className="secondary sht-wide" onClick={() => closeThen(() => { acceptContact(peer); onClose(); })}>
            {t("Odblokovat")}
          </button>
        ) : (
          <button
            type="button"
            className="secondary sht-wide cht-danger"
            onClick={() =>
              closeThen(() => {
                blockContact(peer);
                onBlocked();
              })
            }
          >
            {t("Blokovat")}
          </button>
        )}
      </Screen>
    </Sheet>
  );
}
