// Zprávy (beta): conversations with @names, payments and requests as bubbles,
// one field for text and money. The chat itself (keys, relays, storage) lives
// in src/lib/chat/; this is only the UI over chatClient's state.
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Movement } from "@secondts/bark";
import type { WalletClient } from "../../lib/wallet/bark";
import {
  acceptContact,
  addContactByKey,
  addContactByName,
  addSchedule,
  blockContact,
  refreshNameBinding,
  removeSchedule,
  retryMessage,
  sendPayload,
  markPeerRead,
  peerLastRead,
  sendRead,
  sendReaction,
  sendText,
  sendTyping,
  sendTypingStop,
  useChat,
  loadContactProfile,
  verifyContactName,
  type Contact,
  type Schedule,
  type StoredMessage,
} from "../../lib/chat/chatClient";
import { noteMovements } from "../../lib/chat/arrived";
import { looksLikeNostrKey } from "../../lib/chat/npub";
import { unannouncedSends, type LocalSend } from "../../lib/chat/chatHistory";
import { chatLastRead, markChatRead } from "../../lib/chat/chatRead";
import { useReadReceiptsOn } from "../../lib/chat/chatEnabled";
import { markConversationSeen } from "../../lib/chat/chatPush";
import { MAX_TEXT_CHARS, REACTIONS, describeInterval, type Interval } from "../../lib/chat/messages";
import { detectRecurrence } from "../../lib/chat/recurrence";
import type { FiatCurrency } from "../../lib/currency";
import { localeFor, tf, useLang, useT } from "../../lib/i18n";
import { recentPinnedNames } from "../../lib/names/namePins";
import { parseLinks, shortDestination, splitHost, type LinkSegment } from "../../lib/chat/links";
import type { GiftLinkParams } from "../../lib/gift/giftLink";
import { hapticNotify, hapticTap } from "../../lib/ui/haptics";
import { useBackLayer } from "../../lib/ui/backLayers";
import Avatar from "../Avatar";
import { Screen, Sheet, useBodyScrollLock, useKeyboardInset, useSheetClose } from "../sheet/PaySheet";
import ChatPaySheet, { type PaySheetMode } from "./ChatPaySheet";
import { displayName } from "../../lib/chat/contactName";
import ContactSheet, { ContactAvatar, VerifiedMark } from "./ContactSheet";
import "./Chat.css";

type SheetState = {
  contact: Contact;
  mode: PaySheetMode;
  every?: Interval | null;
  sats?: number;
  note?: string;
  schedule?: Schedule;
};

// Where our own gift and request links live: production, and this origin
// (a local or preview build links to itself).
const OUR_HOSTS = ["spendrr.app", window.location.host];

type PayTarget = { destination: string; amountSats?: number };
type TimelineItem = { kind: "msg"; at: number; m: StoredMessage } | { kind: "send"; at: number; send: LocalSend };
type OnLink = (seg: LinkSegment) => void;

type MenuState = { id: string; outgoing: boolean; top: number; edge: number; below: boolean };

// Hold this long on a bubble for the reaction picker; moving further than the
// slop first is a scroll, not a press.
const LONG_PRESS_MS = 420;
const PRESS_SLOP_PX = 10;
const MENU_HEIGHT_PX = 48;
// Swipe a bubble right this far to reply to it; past it the pull stiffens.
const SWIPE_REPLY_PX = 56;
// Closer than this to the end counts as "at the newest message".
const NEAR_BOTTOM_PX = 80;
// Where each conversation was left this session; null means at the newest.
const savedScroll = new Map<string, number | null>();

// Bubbles closer than this in time, from the same side, read as one group:
// tighter spacing, one time label under the last.
const GROUP_GAP_S = 5 * 60;

// Payment and request cards stand on their own: never grouped with the
// bubbles around them, so two in a row keep their spacing and each its time.
function isCard(m: StoredMessage): boolean {
  return m.payload?.t === "payment" || m.payload?.t === "request";
}

// The newest message a list row shows: reactions are not messages.
function lastShown(msgs: readonly StoredMessage[]): StoredMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (!msgs[i].reactTo) return msgs[i];
  return undefined;
}

function dayKey(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function useFormatters() {
  const t = useT();
  const lang = useLang();
  const locale = localeFor(lang);
  return useMemo(() => {
    const time = (unix: number) =>
      new Date(unix * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const day = (unix: number) => {
      const nowS = Date.now() / 1000;
      const k = dayKey(unix);
      if (k === dayKey(nowS)) return t("Dnes");
      if (k === dayKey(nowS - 86400)) return t("Včera");
      return new Date(unix * 1000).toLocaleDateString(locale, { day: "numeric", month: "numeric" });
    };
    // List rows: time today, the day otherwise.
    const when = (unix: number) => (dayKey(unix) === dayKey(Date.now() / 1000) ? time(unix) : day(unix));
    return { time, day, when, sats: (n: number) => n.toLocaleString(locale) };
  }, [locale, t]);
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function BackGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

// The money button's mark, Cash App style: a heavy slanted B with one short
// stroke above and below, rather than the two-tick ₿ character.
function BtcGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform="translate(2.4 0) skewX(-12)">
        <path d="M9 6.5v11M9 6.5h4a2.6 2.6 0 0 1 0 5.2H9M9 11.7h4.8a2.9 2.9 0 0 1 0 5.8H9M11.6 3.6v2.9M11.6 17.5v2.9" />
      </g>
    </svg>
  );
}

// Tabler's "repeat" (MIT).
function RepeatGlyph() {
  return (
    <svg
      className="cht-chip-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12V9a3 3 0 0 1 3-3h13m-3-3l3 3-3 3" />
      <path d="M20 12v3a3 3 0 0 1-3 3H4m3 3l-3-3 3-3" />
    </svg>
  );
}

// Tabler's "copy" (MIT).
function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4 10-10" />
    </svg>
  );
}

// Tabler's "arrow-back-up" (MIT).
function ReplyGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14l-4-4 4-4" />
      <path d="M5 10h11a4 4 0 1 1 0 8h-1" />
    </svg>
  );
}

// Tabler's "send" paper plane (MIT), same set as the header's @ icon.
function SendGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 14L21 3" />
      <path d="M21 3l-6.5 18a.55 .55 0 0 1-1 0L10 14l-7-3.5a.55 .55 0 0 1 0-1L21 3" />
    </svg>
  );
}

export default function ChatPanel({
  wallet,
  initialPeer,
  history,
  spendable,
  rates,
  currency,
  onClose,
  onOpenProfile,
  onPaid,
  onCriticalOpChange,
  renderMovement,
  onPayDestination,
  onClaimGift,
}: {
  wallet: WalletClient;
  // Opened from a chat notification: straight into that conversation.
  initialPeer?: string | null;
  history: readonly Movement[];
  spendable?: number;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  onClose: () => void;
  onOpenProfile?: () => void;
  onPaid?: () => void;
  onCriticalOpChange?: (active: boolean) => void;
  // The wallet's own detail sheet for a payment, opened from its bubble.
  renderMovement?: (m: Movement, onClose: () => void) => ReactNode;
  // A payment link in a message: the wallet's own Send form, prefilled.
  onPayDestination?: (target: PayTarget) => void;
  onClaimGift?: (gift: GiftLinkParams) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const chat = useChat();
  const [openMovement, setOpenMovement] = useState<Movement | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [leaving, setLeaving] = useState<{ url: string; host: string } | null>(null);

  const onLink: OnLink = (seg) => {
    switch (seg.t) {
      case "url":
        setLeaving({ url: seg.url, host: seg.host });
        return;
      case "name":
        void addContactByName(seg.name).then((r) => {
          if (r.ok) setPeer(r.contact.pubkey);
        });
        return;
      case "pay":
        onPayDestination?.({ destination: seg.destination, ...(seg.amountSats ? { amountSats: seg.amountSats } : {}) });
        return;
      case "request": {
        const destination = seg.request.address ?? seg.request.invoice;
        if (destination) onPayDestination?.({ destination, amountSats: seg.request.amountSats });
        return;
      }
      case "gift":
        onClaimGift?.(seg.gift);
        return;
      case "text":
        return;
    }
  };
  // iOS Safari and Android Chrome lay the keyboard over the page instead of
  // shrinking it, so a fixed panel would keep its composer under the keys.
  const keyboardInset = useKeyboardInset();
  // The panel is a fixed overlay over the home screen, and focusing the
  // message field makes the browser scroll the page underneath to keep the
  // field in view; without the lock, closing Zprávy left home scrolled down.
  // Read during render, before anything has moved (see useBodyScrollLock).
  const [pageScrollY] = useState(() => window.scrollY);
  useBodyScrollLock(pageScrollY);
  const [peer, setPeer] = useState<string | null>(initialPeer ?? null);
  // System back: conversation to the list, then out of chat. Outermost
  // first, so each layer sits above the one it opened from.
  useBackLayer(true, onClose);
  useBackLayer(peer !== null, () => setPeer(null));
  useEffect(() => {
    if (initialPeer) setPeer(initialPeer);
  }, [initialPeer]);
  // On screen: its notifications go, the app badge drops. Again on coming
  // back to the app with the conversation still open.
  useEffect(() => {
    if (!peer) return;
    markConversationSeen(peer);
    const onVisible = () => {
      if (document.visibilityState === "visible") markConversationSeen(peer);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [peer]);
  const [showRequests, setShowRequests] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  useEffect(() => {
    markChatRead();
    refreshNameBinding();
    return markChatRead;
  }, []);
  // The other side sees "zadává částku" while the amount sheet is open for them.
  const sheetPeer = sheet?.contact.pubkey;
  useEffect(() => {
    if (!sheetPeer) return;
    sendTyping(sheetPeer, "amount");
    const timer = window.setInterval(() => sendTyping(sheetPeer, "amount"), 2000);
    return () => {
      window.clearInterval(timer);
      sendTypingStop(sheetPeer);
    };
  }, [sheetPeer]);
  // Reminders become due while the panel is open, too.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const byPeer = useMemo(() => {
    const map = new Map<string, StoredMessage[]>();
    for (const m of chat.messages) {
      const list = map.get(m.peer) ?? [];
      list.push(m);
      map.set(m.peer, list);
    }
    return map;
  }, [chat.messages]);

  const conversations = useMemo(() => {
    const rows: { pk: string; last: StoredMessage | undefined }[] = [...byPeer.entries()]
      .filter(([pk]) => chat.contacts[pk]?.accepted && !chat.contacts[pk]?.blocked)
      .map(([pk, msgs]) => ({ pk, last: lastShown(msgs) }));
    // Contacts added by name with no messages yet still show.
    for (const c of Object.values(chat.contacts)) {
      if (c.accepted && !c.blocked && !byPeer.has(c.pubkey)) rows.push({ pk: c.pubkey, last: undefined });
    }
    return rows.sort((a, b) => (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0));
  }, [byPeer, chat.contacts]);

  // Unread per conversation: theirs, newer than what was seen there. A
  // conversation never opened on this device counts from the last time Zprávy
  // was open, like the header badge.
  const listLastRead = chatLastRead();
  const unreadFor = (pk: string): number => {
    const since = peerLastRead(pk) || listLastRead;
    return (byPeer.get(pk) ?? []).filter((m) => !m.outgoing && !m.reactTo && m.createdAt > since).length;
  };

  const requests = useMemo(
    () =>
      [...byPeer.entries()]
        .filter(([pk]) => !chat.contacts[pk]?.accepted && !chat.contacts[pk]?.blocked)
        .map(([pk, msgs]) => ({ pk, last: lastShown(msgs) })),
    [byPeer, chat.contacts],
  );

  const links = useMemo(() => noteMovements(chat.messages, history), [chat.messages, history]);
  const peerAddress = peer ? chat.contacts[peer]?.address : undefined;
  const localSends = useMemo(
    () => (peerAddress ? unannouncedSends(peerAddress, chat.messages, history) : []),
    [peerAddress, chat.messages, history],
  );
  const openLinked = renderMovement
    ? (noteId: string) => {
        const id = links.get(noteId);
        const m = id === undefined ? undefined : history.find((mv) => mv.id === id);
        if (m) setOpenMovement(m);
      }
    : undefined;
  // People this wallet has paid by @name and has no conversation with yet: a
  // first conversation one tap away. Local only; the lookup happens on tap.
  const suggestions = useMemo(() => {
    if (chat.status !== "ready") return [];
    const known = new Set(Object.values(chat.contacts).map((c) => c.name));
    return recentPinnedNames(12)
      .filter((n) => !known.has(n.name) && !noChatNames.has(n.name) && n.name !== chat.myName)
      .slice(0, 4);
  }, [chat.status, chat.contacts, chat.myName]);
  const due = chat.schedules.filter((s) => s.nextDue <= now && chat.contacts[s.peer]);
  const offline = chat.offline;

  let content;
  if (peer) {
    content = (
      <Conversation
        peer={peer}
        contact={chat.contacts[peer]}
        messages={byPeer.get(peer) ?? []}
        links={links}
        onOpenPayment={openLinked}
        offline={offline}
        onBack={() => setPeer(null)}
        onSheet={setSheet}
        onProfile={() => setProfileOpen(true)}
        onLink={onLink}
        localSends={localSends}
        onOpenMovement={
          renderMovement
            ? (id) => {
                const m = history.find((mv) => mv.id === id);
                if (m) setOpenMovement(m);
              }
            : undefined
        }
        activity={chat.activity[peer]}
        readUpTo={chat.readUpTo[peer] ?? 0}
        schedules={chat.schedules.filter((s) => s.peer === peer)}
      />
    );
  } else {
    content = (
      <>
        <header className="cht-head">
          <h2 className="cht-title">{t("Zprávy")}</h2>
          <button type="button" className="cht-icon-btn" onClick={onClose} aria-label={t("Zavřít")}>
            <CloseGlyph />
          </button>
        </header>
        {chat.status === "error" && <p className="cht-note is-error">{t("Zprávy teď nejdou načíst.")}</p>}
        {offline && <p className="cht-note">{t("Offline")}</p>}
        {chat.status === "ready" && !chat.myName && (
          <div className="cht-callout">
            <span>{t("Bez @jména ti nikdo nenapíše.")}</span>
            {onOpenProfile && (
              <button type="button" className="primary small" onClick={onOpenProfile}>
                {t("Vybrat jméno")}
              </button>
            )}
          </div>
        )}
        {due.map((s) => (
          <div className="cht-callout" key={s.id}>
            <ContactAvatar contact={chat.contacts[s.peer]} pubkey={s.peer} size={28} />
            <span>
              {displayName(chat.contacts[s.peer], s.peer)} · <b className="cht-num">{fmt.sats(s.sats)} sats</b>
            </span>
            <button
              type="button"
              className="primary small"
              onClick={() => setSheet({ contact: chat.contacts[s.peer], mode: "send", schedule: s, note: s.note })}
            >
              {t("Zaplatit")}
            </button>
          </div>
        ))}
        <NewConversation onOpen={setPeer} />
        {suggestions.length > 0 && (
          <div className="cht-suggestions">
            <p className="cht-section is-static">{t("Platil jsi")}</p>
            <div className="cht-suggest-row">
              {suggestions.map((n) => (
                <Suggestion key={n.name} name={n.name} address={n.address} onOpen={setPeer} />
              ))}
            </div>
          </div>
        )}
        <div className="cht-list">
          {requests.length > 0 && (
            <>
              <button
                type="button"
                className="cht-section"
                onClick={() => setShowRequests((v) => !v)}
                aria-expanded={showRequests}
              >
                <span>{t("Žádosti")}</span>
                <span className="cht-count">{requests.length}</span>
                <svg
                  className={`cht-chevron${showRequests ? " is-open" : ""}`}
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
              {showRequests &&
                requests.map(({ pk, last }) => (
                  <Row key={pk} contact={chat.contacts[pk]} pk={pk} last={last} unread={0} request onOpen={setPeer} />
                ))}
            </>
          )}
          {conversations.length === 0 && requests.length === 0 && suggestions.length === 0 && (
            <p className="cht-empty">{t("Napiš @jméno a začni.")}</p>
          )}
          {conversations.map(({ pk, last }) => (
            <Row
              key={pk}
              contact={chat.contacts[pk]}
              pk={pk}
              last={last}
              unread={unreadFor(pk)}
              activity={chat.activity[pk]}
              onOpen={setPeer}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <div
      className={`cht-panel${keyboardInset > 80 ? " has-keyboard" : ""}`}
      style={{ ["--kb" as string]: `${keyboardInset}px` }}
      role="dialog"
      aria-modal="true"
      aria-label={t("Zprávy")}
    >
      <div className="cht-inner">
        {/* Keyed so opening a conversation and going back each play their own
            entrance (motion.css gate, see Chat.css). */}
        <div className={`cht-view ${peer ? "is-push" : "is-pop"}`} key={peer ?? "list"}>
          {content}
        </div>
      </div>
      {sheet && (
        <ChatPaySheet
          wallet={wallet}
          contact={sheet.contact}
          mode={sheet.mode}
          initialEvery={sheet.every}
          initialSats={sheet.sats}
          initialNote={sheet.note}
          schedule={sheet.schedule}
          spendable={spendable}
          rates={rates}
          currency={currency}
          onClose={() => setSheet(null)}
          onPaid={onPaid}
          onCriticalOpChange={onCriticalOpChange}
        />
      )}
      {profileOpen && peer && (
        <ContactSheet
          me={chat.pubkey}
          peer={peer}
          contact={chat.contacts[peer]}
          messages={chat.messages}
          history={history}
          schedules={chat.schedules.filter((s) => s.peer === peer)}
          onOpenMovement={renderMovement ? setOpenMovement : undefined}
          onBlocked={() => {
            setProfileOpen(false);
            setPeer(null);
          }}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {openMovement && renderMovement?.(openMovement, () => setOpenMovement(null))}
      {leaving && <LeaveSheet url={leaving.url} host={leaving.host} onClose={() => setLeaving(null)} />}
    </div>
  );
}

// Names that turned out to have no chat key, this session: not suggested again.
const noChatNames = new Set<string>();

function Suggestion({ name, address, onOpen }: { name: string; address: string; onOpen: (pk: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    const result = await addContactByName(name);
    setBusy(false);
    if (result.ok) {
      onOpen(result.contact.pubkey);
      return;
    }
    if (result.error === "no-chat" || result.error === "not-found") noChatNames.add(name);
    setError(result.error === "network" ? t("Nepodařilo se spojit.") : t("Toto jméno zatím nemá zprávy."));
  };
  return (
    <button
      type="button"
      className={`cht-suggest${busy ? " is-busy" : ""}`}
      onClick={() => void open()}
      disabled={busy}
      title={error ?? undefined}
    >
      <Avatar seed={address} size={52} />
      <span className="cht-suggest-name">@{name}</span>
      {error && <span className="cht-suggest-error">{error}</span>}
    </button>
  );
}

// What a list row says about the newest message: money as money, our own
// text with "Ty:", a failed send as such.
function previewOf(m: StoredMessage, t: (s: string) => string, sats: (n: number) => string): string {
  if (m.delivery === "failed") return t("Neodesláno");
  const p = m.payload;
  if (p?.t === "payment") return `${m.outgoing ? t("Posláno") : t("Platba")} ${sats(p.sats)} sats`;
  if (p?.t === "request") return `${t("Žádost")} ${sats(p.sats)} sats`;
  if (p) return m.text;
  return m.outgoing ? `${t("Ty")}: ${m.text}` : m.text;
}

function Row({
  contact,
  pk,
  last,
  unread,
  activity,
  request,
  onOpen,
}: {
  contact: Contact | undefined;
  pk: string;
  last: StoredMessage | undefined;
  unread: number;
  activity?: "text" | "amount";
  request?: boolean;
  onOpen: (pk: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const preview = activity
    ? activity === "amount"
      ? t("zadává částku…")
      : t("píše…")
    : last
      ? previewOf(last, t, fmt.sats)
      : t("Napiš první zprávu");
  const tone = activity ? " is-live" : last?.delivery === "failed" ? " is-error" : "";
  return (
    <button
      type="button"
      className={`cht-row${request ? " is-request" : ""}${unread > 0 ? " is-unread" : ""}`}
      onClick={() => onOpen(pk)}
    >
      <ContactAvatar contact={contact} pubkey={pk} size={48} />
      <span className="cht-row-main">
        <span className="cht-row-top">
          <strong>
            {displayName(contact, pk)}
            {contact?.verified && <VerifiedMark label={t("Ověřeno")} />}
          </strong>
          {last && <span className="cht-row-time">{fmt.when(last.createdAt)}</span>}
        </span>
        <span className="cht-row-bottom">
          <span className={`cht-row-last${tone}`}>{preview}</span>
          {unread > 0 && (
            <span className="cht-row-count" aria-label={tf(t("{n} nepřečtené"), { n: unread })}>
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function NewConversation({ onOpen }: { onOpen: (peer: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const handle = name.trim().replace(/^@/, "");
    if (!handle) return;
    if (looksLikeNostrKey(handle)) {
      const r = addContactByKey(handle);
      if (r.ok) {
        setName("");
        onOpen(r.contact.pubkey);
      } else {
        setError(r.error === "self" ? t("To je tvůj klíč.") : t("Neplatný klíč."));
      }
      return;
    }
    setBusy(true);
    setError(null);
    const result = await addContactByName(handle);
    setBusy(false);
    if (result.ok) {
      setName("");
      onOpen(result.contact.pubkey);
    } else {
      setError(
        result.error === "not-found"
          ? t("Jméno neexistuje.")
          : result.error === "no-chat"
            ? t("Toto jméno zatím nemá zprávy.")
            : t("Nepodařilo se spojit."),
      );
    }
  };
  return (
    <form
      className="cht-new"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="cht-field">
        <span className="cht-field-at" aria-hidden="true" hidden={looksLikeNostrKey(name)}>
          @
        </span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value.replace(/^@/, ""));
            setError(null);
          }}
          placeholder={t("jméno nebo npub")}
          aria-label={t("Jméno")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <button type="submit" className="cht-new-go" disabled={busy || !name.trim()} aria-label={t("Napsat")}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </label>
      {error && <p className="cht-error">{error}</p>}
    </form>
  );
}

function Conversation({
  peer,
  contact,
  messages,
  links,
  onOpenPayment,
  offline,
  schedules,
  onBack,
  onSheet,
  onProfile,
  onLink,
  localSends,
  onOpenMovement,
  activity,
  readUpTo,
}: {
  peer: string;
  contact: Contact | undefined;
  messages: StoredMessage[];
  links: Map<string, number>;
  onOpenPayment?: (noteId: string) => void;
  offline: boolean;
  schedules: Schedule[];
  onBack: () => void;
  onSheet: (s: SheetState) => void;
  onProfile: () => void;
  onLink: OnLink;
  localSends: readonly LocalSend[];
  onOpenMovement?: (movementId: number) => void;
  activity: "text" | "amount" | undefined;
  readUpTo: number;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [cryptoInfo, setCryptoInfo] = useState(false);
  // The copy button turns into a check for a moment, then the menu goes,
  // the same confirmation as the app's other copy buttons.
  const [menuCopied, setMenuCopied] = useState(false);
  useEffect(() => {
    if (!menuCopied) return;
    const timer = window.setTimeout(() => {
      setMenu(null);
      setMenuCopied(false);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [menuCopied]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  // A horizontal drag on a bubble: once it is clearly sideways it is a swipe
  // to reply, not a press or a scroll.
  const swipeRef = useRef<{ el: HTMLElement; x: number; y: number; active: boolean; armed: boolean } | null>(null);
  const nearBottom = useRef(true);
  const [jump, setJump] = useState<{ show: boolean; fresh: number }>({ show: false, fresh: 0 });
  const receiptsOn = useReadReceiptsOn();
  // The click that ends a long press must not also open a linked payment.
  const swallowClick = useRef(false);
  // Messages already there when the conversation opened appear at once; only
  // ones that arrive or are sent while it is open animate in.
  const [initialIds] = useState(() => new Set(messages.map((m) => m.id)));
  // "Nové zprávy" goes above the first message from them that was not seen
  // before this opening; fixed for as long as the conversation stays open.
  const [dividerAt] = useState(() => {
    const last = peerLastRead(peer);
    if (last === 0) return null;
    return messages.find((m) => !m.outgoing && !m.reactTo && m.createdAt > last)?.id ?? null;
  });
  const recurrence = useMemo(() => detectRecurrence(text), [text]);
  const accepted = contact?.accepted === true;
  const replied = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) if (m.payload?.t === "request-reply") ids.add(m.payload.ref);
    return ids;
  }, [messages]);
  // Reactions are messages of their own; each side's newest one per bubble
  // counts, and an empty one takes it back.
  const { bubbles, reactions, byId } = useMemo(() => {
    const latest = new Map<string, Map<boolean, StoredMessage>>();
    const shown: StoredMessage[] = [];
    for (const m of messages) {
      if (!m.reactTo) {
        shown.push(m);
        continue;
      }
      const per = latest.get(m.reactTo) ?? new Map<boolean, StoredMessage>();
      const prev = per.get(m.outgoing);
      if (!prev || prev.createdAt <= m.createdAt) per.set(m.outgoing, m);
      latest.set(m.reactTo, per);
    }
    const out = new Map<string, { theirs?: string; mine?: string }>();
    for (const [target, per] of latest) {
      const theirs = per.get(false)?.text || undefined;
      const mine = per.get(true)?.text || undefined;
      if (theirs || mine) out.set(target, { theirs, mine });
    }
    return { bubbles: shown, reactions: out, byId: new Map(shown.map((m) => [m.id, m])) };
  }, [messages]);

  // The field grows with the text, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  // Messages and our sends outside the chat, in time order.
  const timeline = useMemo(() => {
    const items: TimelineItem[] = bubbles.map((m) => ({ kind: "msg", at: m.createdAt, m }));
    for (const send of localSends) items.push({ kind: "send", at: send.at, send });
    return items.sort((a, b) => a.at - b.at);
  }, [bubbles, localSends]);

  const cancelPress = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };

  const openMenu = (m: StoredMessage, el: HTMLElement) => {
    const list = listRef.current;
    if (!list) return;
    let top = el.offsetTop - MENU_HEIGHT_PX - 8;
    const below = top < list.scrollTop + 4;
    if (below) top = el.offsetTop + el.offsetHeight + 8;
    const edge = m.outgoing ? list.clientWidth - (el.offsetLeft + el.offsetWidth) : el.offsetLeft;
    setMenu({ id: m.id, outgoing: m.outgoing, top, edge: Math.max(0, edge), below });
    hapticTap();
  };

  // Long press (touch, pen or mouse) or a right click opens the picker.
  const pressFor = (m: StoredMessage): PressProps | undefined => {
    if (!accepted || m.delivery) return undefined;
    return {
      onPointerDown: (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const el = e.currentTarget;
        cancelPress();
        swipeRef.current = { el, x: e.clientX, y: e.clientY, active: false, armed: false };
        pressRef.current = {
          x: e.clientX,
          y: e.clientY,
          timer: window.setTimeout(() => {
            pressRef.current = null;
            swallowClick.current = true;
            openMenu(m, el);
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove: (e) => {
        const p = pressRef.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) cancelPress();
        const sw = swipeRef.current;
        if (!sw) return;
        const dx = e.clientX - sw.x;
        const dy = e.clientY - sw.y;
        if (!sw.active) {
          if (dx > PRESS_SLOP_PX && dx > Math.abs(dy) * 1.5) {
            sw.active = true;
            cancelPress();
            sw.el.setPointerCapture(e.pointerId);
            sw.el.classList.add("is-swiping");
          } else if (Math.abs(dy) > PRESS_SLOP_PX) {
            swipeRef.current = null;
          }
          return;
        }
        const pull = Math.max(0, dx < SWIPE_REPLY_PX ? dx : SWIPE_REPLY_PX + (dx - SWIPE_REPLY_PX) * 0.25);
        sw.el.style.transform = `translateX(${pull}px)`;
        sw.el.style.setProperty("--swipe", String(Math.min(1, pull / SWIPE_REPLY_PX)));
        if (!sw.armed && pull >= SWIPE_REPLY_PX) {
          sw.armed = true;
          hapticTap();
        } else if (sw.armed && pull < SWIPE_REPLY_PX) {
          sw.armed = false;
        }
      },
      onPointerUp: () => endGesture(m),
      onPointerCancel: () => endGesture(m),
      onPointerLeave: () => {
        if (!swipeRef.current?.active) cancelPress();
      },
      onContextMenu: (e) => {
        e.preventDefault();
        cancelPress();
        openMenu(m, e.currentTarget);
      },
      onClickCapture: (e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    };
  };

  const startReply = (m: StoredMessage) => {
    setReplyTo(m);
    inputRef.current?.focus();
  };

  // Lets go of a bubble: a swipe past the mark replies, and the bubble springs
  // back either way.
  const endGesture = (m: StoredMessage) => {
    cancelPress();
    const sw = swipeRef.current;
    swipeRef.current = null;
    if (!sw?.active) return;
    sw.el.classList.remove("is-swiping");
    sw.el.style.transform = "";
    sw.el.style.removeProperty("--swipe");
    swallowClick.current = true;
    if (sw.armed) startReply(m);
  };

  const quoteFor = (m: StoredMessage) => {
    const target = m.replyTo ? byId.get(m.replyTo) : undefined;
    if (!target) return null;
    return { who: target.outgoing ? t("Ty") : displayName(contact, peer), text: target.text };
  };

  // A stranger's claimed @name is checked only now that the user opened it; a
  // contact restored from the backup gets its address back.
  useEffect(() => {
    verifyContactName(peer);
    void loadContactProfile(peer);
  }, [peer]);

  const lastIncoming = useMemo(() => {
    for (let i = bubbles.length - 1; i >= 0; i--) if (!bubbles[i].outgoing) return bubbles[i];
    return undefined;
  }, [bubbles]);

  // At the newest message with the page visible: everything from them is seen.
  const markSeen = () => {
    if (!lastIncoming || !nearBottom.current || document.visibilityState !== "visible") return;
    markPeerRead(peer, lastIncoming.createdAt);
    if (accepted) sendRead(peer, lastIncoming.createdAt);
  };

  // Opening: the "Nové zprávy" divider if there is one, else where this
  // conversation was left, else the newest message.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const divider = list.querySelector<HTMLElement>(".cht-unread");
    const saved = savedScroll.get(peer);
    if (divider) list.scrollTop = Math.max(0, divider.offsetTop - 24);
    else if (typeof saved === "number") list.scrollTop = saved;
    else list.scrollTop = list.scrollHeight;
    nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
    setJump({ show: !nearBottom.current, fresh: 0 });
    return () => {
      savedScroll.set(peer, nearBottom.current ? null : list.scrollTop);
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer]);

  // A new message follows to the bottom only for someone already there or for
  // our own message; anyone reading further up gets a count on the jump button
  // instead.
  const lastId = bubbles[bubbles.length - 1]?.id;
  const prevLast = useRef(lastId);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ours = bubbles[bubbles.length - 1]?.outgoing === true;
    const arrived = lastId !== prevLast.current;
    prevLast.current = lastId;
    if (nearBottom.current || (ours && arrived)) {
      list.scrollTo({ top: list.scrollHeight, behavior: initialIds.has(lastId ?? "") ? "auto" : "smooth" });
      nearBottom.current = true;
    } else if (arrived) {
      setJump((j) => ({ show: true, fresh: j.fresh + 1 }));
    }
    markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  // Someone at the bottom stays there whatever grows below the newest message
  // (their typing bubble, the "Zadává částku" card, "Přečteno") or shrinks the
  // view (the keyboard sliding up over several frames). Checked after every
  // render, because the typing bubble appears a render after the activity
  // that causes it, and on every resize of the list. A new message itself is
  // left to the smooth scroll above.
  const pinnedHeight = useRef(0);
  const pinnedLast = useRef(lastId);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const height = list.scrollHeight;
    if (pinnedLast.current !== lastId) pinnedLast.current = lastId;
    else if (height !== pinnedHeight.current && nearBottom.current) list.scrollTop = height;
    pinnedHeight.current = height;
  });
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisible = () => markSeen();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  const onScroll = () => {
    if (menu) setMenu(null);
    const list = listRef.current;
    if (!list) return;
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    const near = gap < NEAR_BOTTOM_PX;
    if (near !== nearBottom.current) {
      nearBottom.current = near;
      if (near) markSeen();
    }
    const show = gap > NEAR_BOTTOM_PX * 2.5;
    if (show !== jump.show || (near && jump.fresh > 0)) setJump({ show, fresh: near ? 0 : jump.fresh });
  };

  const jumpDown = () => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  };

  // The typing bubble fades out when they stop, but goes at once when their
  // message takes its place.
  const [shownActivity, setShownActivity] = useState(activity);
  const [activityLeaving, setActivityLeaving] = useState(false);
  const activityLast = useRef(lastId);
  useEffect(() => {
    if (activity) {
      activityLast.current = lastId;
      setShownActivity(activity);
      setActivityLeaving(false);
      return;
    }
    if (activityLast.current !== lastId) {
      setShownActivity(undefined);
      return;
    }
    setActivityLeaving(true);
    const timer = window.setTimeout(() => setShownActivity(undefined), 200);
    return () => window.clearTimeout(timer);
  }, [activity, lastId]);

  // Our newest message, for "Přečteno" under it.
  const lastOutgoingId = useMemo(() => {
    for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].outgoing) return bubbles[i].id;
    return undefined;
  }, [bubbles]);

  const c: Contact = contact ?? { pubkey: peer, accepted: false };

  // The bubble appears at once and carries its own state; only a send that
  // never got as far as a message (chat off) gives the text back.
  const send = () => {
    const body = text.trim();
    if (!body) return;
    const answering = replyTo?.id;
    setText("");
    sendTypingStop(peer);
    setError(null);
    setReplyTo(null);
    // The keyboard stays up for the next message.
    inputRef.current?.focus();
    sendText(peer, body, answering).catch(() => {
      setText(body);
      setError(t("Zprávu se nepodařilo odeslat."));
    });
  };

  const reply = async (m: StoredMessage, accept: boolean) => {
    const p = m.payload;
    if (!p || p.t !== "request" || !p.every) return;
    try {
      await sendPayload(peer, { t: "request-reply", ref: m.id, accept });
      if (accept) {
        addSchedule(
          { peer, kind: "pay-request", sats: p.sats, every: p.every, ...(p.note ? { note: p.note } : {}) },
          Date.now(),
        );
      }
    } catch {
      setError(t("Odpověď se nepodařilo odeslat."));
    }
  };

  return (
    <>
      <header className="cht-head">
        <button type="button" className="cht-icon-btn" onClick={onBack} aria-label={t("Zpět")}>
          <BackGlyph />
        </button>
        <button type="button" className="cht-peer" onClick={onProfile} aria-label={t("Profil kontaktu")}>
          <ContactAvatar contact={contact} pubkey={peer} size={32} />
          <h2 className="cht-title is-small">
            {displayName(contact, peer)}
            {contact?.verified && <VerifiedMark label={t("Ověřeno")} />}
          </h2>
        </button>
      </header>
      {contact?.keyChanged && <p className="cht-warning">{t("Klíč tohoto jména se změnil. Ověř si, s kým píšeš.")}</p>}
      {!accepted && (
        <div className="cht-callout">
          <span>{contact?.name ? t("Nový kontakt") : t("Neznámý odesílatel")}</span>
          <button type="button" className="primary small" onClick={() => acceptContact(peer)}>
            {t("Přijmout")}
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              blockContact(peer);
              onBack();
            }}
          >
            {t("Blokovat")}
          </button>
        </div>
      )}
      {schedules.length > 0 && (
        <div className="cht-schedules">
          {schedules.map((s) => (
            <span key={s.id} className="cht-schedule">
              {s.kind === "send" ? t("Posílám") : t("Platím")} <b className="cht-num">{fmt.sats(s.sats)} sats</b>{" "}
              {describeInterval(s.every)}
              <button
                type="button"
                className="cht-schedule-x"
                onClick={() => removeSchedule(s.id)}
                aria-label={t("Zrušit")}
              >
                <CloseGlyph />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="cht-scroll">
      <div className="cht-messages" ref={listRef} onScroll={onScroll}>
        <p className="cht-e2e">
          <LockGlyph />
          <span>{t("Šifrováno mezi vámi")}</span>
          <button type="button" className="cht-e2e-info" onClick={() => setCryptoInfo(true)} aria-label={t("Jak šifrování funguje")}>
            {/* Italic "i" drawn as a shape: a font's italic cannot be centred
                the same on every phone. Placed by its measured ink bounds. */}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <g transform="translate(5.371 2.139) scale(0.0381)" fill="currentColor">
                <ellipse cx="98" cy="36" rx="36" ry="35" />
                <path d="M4 123 C14 112 36 102 62 101 C82 100 98 104 100 126 L78 248 C80 259 94 264 110 264 C121 264 131 265 131 276 C131 291 116 304 94 306 C60 309 28 301 24 282 L50 134 L14 131 Z" />
              </g>
            </svg>
          </button>
        </p>
        {bubbles.length === 0 && <p className="cht-empty">{t("Napiš první zprávu.")}</p>}
        {timeline.map((item, i) => {
          const before = timeline[i - 1];
          const after = timeline[i + 1];
          const newDay = !before || dayKey(before.at) !== dayKey(item.at);
          if (item.kind === "send") {
            return (
              <Fragment key={`send-${item.send.movementId}`}>
                {newDay && <p className="cht-day">{fmt.day(item.at)}</p>}
                <button
                  type="button"
                  className="cht-system cht-local-send"
                  onClick={onOpenMovement ? () => onOpenMovement(item.send.movementId) : undefined}
                >
                  {tf(t("Posláno {sats} sats"), { sats: fmt.sats(item.send.sats) })} · {fmt.time(item.at)}
                </button>
              </Fragment>
            );
          }
          const m = item.m;
          // A payment line between two bubbles breaks their group like any
          // other system line.
          const prev = before?.kind === "msg" ? before.m : undefined;
          const next = after?.kind === "msg" ? after.m : undefined;
          const joinsPrev =
            !newDay &&
            !!prev &&
            !isCard(prev) &&
            !isCard(m) &&
            prev.outgoing === m.outgoing &&
            m.createdAt - prev.createdAt < GROUP_GAP_S;
          const endsGroup =
            !next ||
            after?.kind !== "msg" ||
            isCard(m) ||
            isCard(next) ||
            next.outgoing !== m.outgoing ||
            next.createdAt - m.createdAt >= GROUP_GAP_S ||
            dayKey(next.createdAt) !== dayKey(m.createdAt);
          return (
            <Fragment key={m.id}>
              {newDay && <p className="cht-day">{fmt.day(m.createdAt)}</p>}
              {m.id === dividerAt && (
                <p className="cht-unread">
                  <span>{t("Nové zprávy")}</span>
                </p>
              )}
              <Bubble
                m={m}
                fmt={fmt.sats}
                joined={joinsPrev}
                isNew={!initialIds.has(m.id)}
                linked={links.has(m.id)}
                onOpen={onOpenPayment && links.has(m.id) ? () => onOpenPayment(m.id) : undefined}
                canAct={accepted}
                answered={replied.has(m.id)}
                reacts={[reactions.get(m.id)?.theirs, reactions.get(m.id)?.mine].filter((r): r is string => !!r)}
                quote={quoteFor(m)}
                press={pressFor(m)}
                pressed={menu?.id === m.id}
                onLink={onLink}
                onPay={() => {
                  const p = m.payload;
                  if (p?.t === "request") onSheet({ contact: c, mode: "send", sats: p.sats, note: p.note });
                }}
                onReply={(accept) => void reply(m, accept)}
              />
              {m.delivery === "failed" ? (
                <button type="button" className="cht-retry" onClick={() => void retryMessage(m.id)}>
                  {t("Neodesláno")} · <b>{t("Zkusit znovu")}</b>
                </button>
              ) : (
                endsGroup && (
                  <p className={`cht-time ${m.outgoing ? "is-out" : "is-in"}`}>
                    {fmt.time(m.createdAt)}
                    {receiptsOn && m.id === lastOutgoingId && !m.delivery && readUpTo >= m.createdAt && (
                      <span className="cht-read"> · {t("Přečteno")}</span>
                    )}
                  </p>
                )
              )}
            </Fragment>
          );
        })}
        {shownActivity && <PeerActivity what={shownActivity} leaving={activityLeaving} />}
        {menu && (
          <ReactionMenu
            at={menu}
            mine={reactions.get(menu.id)?.mine}
            onClose={() => setMenu(null)}
            onPick={(emoji) => {
              const id = menu.id;
              setMenu(null);
              void sendReaction(peer, id, emoji);
            }}
            onReply={() => {
              const target = byId.get(menu.id);
              setMenu(null);
              if (target) startReply(target);
            }}
            copied={menuCopied}
            onCopy={() => {
              const target = byId.get(menu.id);
              if (!target) return;
              navigator.clipboard.writeText(target.text).then(
                () => {
                  hapticTap();
                  setMenuCopied(true);
                },
                () => {
                  setMenu(null);
                  setError(t("Kopírování se nepovedlo."));
                },
              );
            }}
          />
        )}
      </div>
      {jump.show && (
        <button type="button" className="cht-jump" onClick={jumpDown} aria-label={t("Na nejnovější")}>
          {jump.fresh > 0 && <span className="cht-jump-count">{jump.fresh > 9 ? "9+" : jump.fresh}</span>}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M6 13l6 6 6-6" />
          </svg>
        </button>
      )}
      </div>
      {cryptoInfo && (
        <EncryptionSheet
          onClose={() => setCryptoInfo(false)}
          onVerify={contact?.verified ? undefined : onProfile}
        />
      )}
      {accepted && (
        <div className="cht-composer">
          {recurrence && (
            <button
              type="button"
              className="cht-chip"
              onClick={() => {
                onSheet({ contact: c, mode: recurrence.kind, every: recurrence.every });
                setText("");
              }}
            >
              <RepeatGlyph />
              <span className="cht-chip-main">
                {recurrence.kind === "send" ? t("Opakovaná platba") : t("Opakovaný požadavek")}
              </span>
              <span className="cht-chip-when">{describeInterval(recurrence.every)}</span>
              <svg
                className="cht-chip-go"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}
          {error && <p className="cht-error">{error}</p>}
          {replyTo && (
            <div className="cht-replying">
              <ReplyGlyph />
              <span className="cht-replying-text">
                <b>{replyTo.outgoing ? t("Ty") : displayName(contact, peer)}</b> {replyTo.text}
              </span>
              <button type="button" className="cht-schedule-x" onClick={() => setReplyTo(null)} aria-label={t("Zrušit")}>
                <CloseGlyph />
              </button>
            </div>
          )}
          <form
            className="cht-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <button
              type="button"
              className="cht-btc"
              aria-label={t("Poslat nebo chtít peníze")}
              onClick={() => onSheet({ contact: c, mode: "send" })}
            >
              <BtcGlyph />
            </button>
            <textarea
              ref={inputRef}
              className="cht-input"
              rows={1}
              value={text}
              onChange={(e) => {
                // One paragraph: a line break would be dropped on sending anyway.
                const next = [...e.target.value.replace(/\n/g, " ")].slice(0, MAX_TEXT_CHARS).join("");
                setText(next);
                if (next.trim()) sendTyping(peer, "text");
                else sendTypingStop(peer);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={offline ? t("Offline") : t("Zpráva")}
              aria-label={t("Zpráva")}
              enterKeyHint="send"
            />
            <button
              type="submit"
              className="cht-send"
              disabled={!text.trim()}
              aria-label={t("Poslat")}
              // A tap would move the focus to the button (which then turns
              // disabled) and close the keyboard.
              onMouseDown={(e) => e.preventDefault()}
            >
              <SendGlyph />
            </button>
          </form>
        </div>
      )}
    </>
  );
}

type PressProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onPointerLeave" | "onContextMenu" | "onClickCapture"
>;

function Bubble({
  m,
  fmt,
  joined,
  isNew,
  linked,
  onOpen,
  canAct,
  answered,
  reacts,
  quote,
  press,
  pressed,
  onLink,
  onPay,
  onReply,
}: {
  m: StoredMessage;
  fmt: (n: number) => string;
  joined: boolean;
  isNew: boolean;
  // Tied to a movement in this wallet's history (arrived.ts).
  linked: boolean;
  onOpen?: () => void;
  canAct: boolean;
  answered: boolean;
  reacts: string[];
  quote: { who: string; text: string } | null;
  press?: PressProps;
  pressed: boolean;
  onLink: OnLink;
  onPay: () => void;
  onReply: (accept: boolean) => void;
}) {
  const t = useT();
  const p = m.payload;
  const money = p?.t === "payment" || p?.t === "request";
  // The "Přijato" tag animates only when it appears while the bubble is on
  // screen, not for payments that were already confirmed when it opened.
  const [linkedAtMount] = useState(linked);
  // An incoming payment that arrives while the conversation is open is the one
  // moment worth a buzz.
  useEffect(() => {
    if (isNew && !m.outgoing && p?.t === "payment") hapticNotify();
    // Mount only: a bubble is new once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (p?.t === "request-reply") return <p className="cht-system">{p.accept ? t("Žádost přijata") : t("Žádost odmítnuta")}</p>;
  if (p?.t === "schedule") {
    return (
      <p className="cht-system">
        {tf(t("Bude posílat {sats} sats {when}"), { sats: fmt(p.sats), when: describeInterval(p.every) })}
      </p>
    );
  }
  const note = p && "note" in p && p.note ? <span className="cht-money-note">{p.note}</span> : null;
  let body: ReactNode;
  if (p?.t === "payment") {
    // An incoming note is only the sender's word; the tag appears once this
    // wallet's history shows the money. Linked bubbles open the payment.
    body = (
      <>
        <span className="cht-money-label">{m.outgoing ? t("Posláno") : t("Platba")}</span>
        <span className="cht-money-amount">
          {fmt(p.sats)} <small>sats</small>
        </span>
        {note}
        {!m.outgoing && linked && <span className={`cht-tag is-ok${linkedAtMount ? "" : " is-fresh"}`}>{t("Přijato")}</span>}
      </>
    );
  } else if (p?.t === "request") {
    body = (
      <>
        <span className="cht-money-label">
          {p.every ? tf(t("Žádost {when}"), { when: describeInterval(p.every) }) : t("Žádost")}
        </span>
        <span className="cht-money-amount">
          {fmt(p.sats)} <small>sats</small>
        </span>
        {note}
        {!m.outgoing && canAct && !p.every && (
          <button type="button" className="primary small cht-money-btn" onClick={onPay}>
            {t("Zaplatit")}
          </button>
        )}
        {!m.outgoing && canAct && p.every && !answered && (
          <span className="cht-actions">
            <button type="button" className="primary small" onClick={() => onReply(true)}>
              {t("Přijmout")}
            </button>
            <button type="button" className="secondary small" onClick={() => onReply(false)}>
              {t("Odmítnout")}
            </button>
          </span>
        )}
      </>
    );
  } else {
    // Links are live only in an accepted conversation; a stranger's message
    // is plain text until the user accepts them.
    body = canAct ? <MessageText m={m} fmt={fmt} onLink={onLink} /> : m.text;
  }
  const cls =
    `cht-bubble ${m.outgoing ? "is-out" : "is-in"}${joined ? " is-joined" : ""}${isNew ? " is-new" : ""}` +
    (m.delivery ? ` is-${m.delivery}` : "") +
    (money ? ` cht-money${p?.t === "payment" ? " is-payment" : ""}` : "") +
    (onOpen ? " is-link" : "") +
    (reacts.length > 0 ? " has-reacts" : "") +
    (pressed ? " is-pressed" : "");
  const link = onOpen
    ? {
        role: "button",
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        },
      }
    : {};
  return (
    <div className={cls} {...press} {...link}>
      {quote && (
        <span className="cht-quote">
          <b>{quote.who}</b>
          <span>{quote.text}</span>
        </span>
      )}
      {body}
      {reacts.length > 0 && (
        <span className="cht-reacts" aria-label={reacts.join(" ")}>
          {reacts.join("")}
        </span>
      )}
    </div>
  );
}

// Tabler's "lock" (MIT).
function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}

// What the lock line means, in a few words. Honest about the limits: the
// content is end-to-end, the fact that two people talk is not hidden.
function EncryptionSheet({ onClose, onVerify }: { onClose: () => void; onVerify?: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="e2e">
      <Screen>
        <span className="cht-e2e-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
            <path d="M8 11V7a4 4 0 1 1 8 0v4" />
          </svg>
        </span>
        <h2 className="sht-title">{t("Šifrováno mezi vámi")}</h2>
        <p className="sht-sub cht-e2e-lead">{t("Zprávy a platby v chatu přečtete jen vy dva. Relaye ani Spendrr ne.")}</p>
        <p className="sht-sub cht-e2e-limit">{t("Klíč je ze seedu, obnoví se s ním. Vidět je jen, že si píšete.")}</p>
        <button type="button" className="primary sht-wide" onClick={close}>
          {t("Rozumím")}
        </button>
        {onVerify && (
          <button
            type="button"
            className="secondary sht-wide"
            onClick={() =>
              closeThen(() => {
                onClose();
                onVerify();
              })
            }
          >
            {t("Bezpečnostní kód")}
          </button>
        )}
      </Screen>
    </Sheet>
  );
}

// What the other side is doing right now, as a bubble at the end: dots while
// they type, a payment card with dots while they enter an amount (the same
// look as tap-to-pay's "the other phone is entering the amount").
function PeerActivity({ what, leaving }: { what: "text" | "amount"; leaving: boolean }) {
  const t = useT();
  const dots = (
    <span className="cht-typing" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
  if (what === "amount") {
    return (
      <div className={`cht-bubble is-in cht-money cht-activity is-amount${leaving ? " is-leaving" : ""}`} role="status">
        <span className="cht-money-label">{t("Zadává částku")}</span>
        {dots}
      </div>
    );
  }
  return (
    <div className={`cht-bubble is-in cht-activity${leaving ? " is-leaving" : ""}`} role="status" aria-label={t("Píše…")}>
      {dots}
    </div>
  );
}

// A text message with its links: @names and web links inline, payment things
// shortened inline and, in what they sent us, as a card to act on.
function MessageText({ m, fmt, onLink }: { m: StoredMessage; fmt: (n: number) => string; onLink: OnLink }) {
  const t = useT();
  const segs = useMemo(() => parseLinks(m.text, OUR_HOSTS), [m.text]);
  if (segs.length === 1 && segs[0].t === "text") return <>{m.text}</>;
  const cards = m.outgoing ? [] : segs.filter((s) => s.t === "pay" || s.t === "gift" || s.t === "request").slice(0, 3);
  return (
    <>
      <span className="cht-text">
        {segs.map((s, i) => {
          if (s.t === "text") return <Fragment key={i}>{s.text}</Fragment>;
          if (s.t === "name" || s.t === "url") {
            return (
              <button key={i} type="button" className="cht-link" onClick={() => onLink(s)}>
                {s.t === "url" ? s.url.replace(/^https?:\/\//i, "").replace(/\/$/, "") : s.raw}
              </button>
            );
          }
          const label = s.t === "gift" ? t("Dárek") : s.t === "request" ? t("Žádost o platbu") : shortDestination(s.raw);
          return (
            <span key={i} className="cht-dest">
              {label}
            </span>
          );
        })}
      </span>
      {cards.map((s, i) => (
        <LinkCard key={i} seg={s} fmt={fmt} onOpen={() => onLink(s)} />
      ))}
    </>
  );
}

function LinkCard({ seg, fmt, onOpen }: { seg: LinkSegment; fmt: (n: number) => string; onOpen: () => void }) {
  const t = useT();
  let kind = "";
  let sats: number | undefined;
  let action = t("Zaplatit");
  if (seg.t === "pay") {
    kind = seg.kind === "lightning" ? "Lightning" : seg.kind === "ark" ? "Ark" : "Bitcoin";
    sats = seg.amountSats;
  } else if (seg.t === "request") {
    kind = t("Žádost o platbu");
    sats = seg.request.amountSats;
  } else if (seg.t === "gift") {
    kind = t("Dárek");
    sats = seg.gift.amountSats;
    action = t("Vyzvednout");
  }
  return (
    <button type="button" className="cht-linkcard" onClick={onOpen}>
      <span className="cht-linkcard-main">
        <span className="cht-linkcard-kind">{kind}</span>
        {sats !== undefined && (
          <b className="cht-num">
            {fmt(sats)} <small>sats</small>
          </b>
        )}
      </span>
      <span className="cht-linkcard-go">
        {action}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}

// Before any foreign link opens: where it really goes, the owner of the host
// in bold (punycode, so a look-alike name shows as what it is). Nothing is
// fetched for it, and it opens without an opener or a referrer.
function LeaveSheet({ url, host, onClose }: { url: string; host: string; onClose: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);
  const { sub, main } = splitHost(host);
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="leave">
      <Screen>
        <h2 className="sht-title">{t("Opouštíš Spendrr")}</h2>
        <p className="cht-leave-host">
          {sub && <span>{sub}</span>}
          <b>{main}</b>
        </p>
        <p className="cht-leave-url">{url}</p>
        {/* A plain link, like the app's other external links: fetch-guard.js
            blocks window.open (a new window is a fresh, unguarded realm). */}
        <a className="cht-leave-open" href={url} target="_blank" rel="noopener noreferrer" onClick={close}>
          {t("Otevřít")}
        </a>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zpět")}
        </button>
      </Screen>
    </Sheet>
  );
}

// The long-press picker: five reactions and Reply, floating above (or below)
// the pressed bubble inside the scrolling list.
function ReactionMenu({
  at,
  mine,
  onPick,
  onReply,
  onCopy,
  copied,
  onClose,
}: {
  at: MenuState;
  mine: string | undefined;
  copied: boolean;
  onPick: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="cht-menu-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className={`cht-menu ${at.outgoing ? "is-out" : "is-in"}${at.below ? " is-below" : ""}`}
        style={{ top: at.top, ...(at.outgoing ? { right: at.edge } : { left: at.edge }) }}
        role="menu"
      >
        {REACTIONS.map((emoji, i) => (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            className={`cht-menu-emoji${mine === emoji ? " is-mine" : ""}`}
            style={{ ["--i" as string]: i }}
            onClick={() => onPick(mine === emoji ? "" : emoji)}
            aria-label={emoji}
          >
            {emoji}
          </button>
        ))}
        <span className="cht-menu-sep" aria-hidden="true" />
        <button type="button" role="menuitem" className="cht-menu-act" onClick={onReply} aria-label={t("Odpovědět")}>
          <ReplyGlyph />
        </button>
        <button
          type="button"
          role="menuitem"
          className={`cht-menu-act${copied ? " is-done" : ""}`}
          onClick={onCopy}
          aria-label={copied ? t("Zkopírováno") : t("Kopírovat")}
        >
          {copied ? <CheckGlyph /> : <CopyGlyph />}
        </button>
      </div>
    </>
  );
}

// The header entry point. Its own component so a new message re-renders only
// this button, not the whole Dashboard.
export function ChatButton({ onOpen, label }: { onOpen: () => void; label: string }) {
  const chat = useChat();
  const lastRead = chatLastRead();
  const unread = chat.messages.filter(
    (m) => !m.outgoing && !m.reactTo && m.createdAt > lastRead && !chat.contacts[m.peer]?.blocked,
  ).length;
  return (
    <button className="secondary small icon-btn icon-btn-chat" onClick={onOpen} aria-label={label}>
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {unread > 0 && <span className="cht-badge">{unread > 9 ? "9+" : unread}</span>}
    </button>
  );
}
