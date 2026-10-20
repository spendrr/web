// What the chat knows about a movement in the wallet's history: who it was
// with (a verified @name) and the note that came with it. Empty while the chat
// is off, so the history pays nothing for it then.
import { useMemo } from "react";
import { noteMovements, type ReceiptLike } from "./arrived";
import { useChat, type StoredMessage } from "./chatClient";
import { formatAddressValue } from "../send/movementAddress";

export type ChatPaymentInfo = { name?: string; note?: string };

export function useChatPayments(history: readonly ReceiptLike[]): Map<number, ChatPaymentInfo> {
  const chat = useChat();
  return useMemo(() => {
    const out = new Map<number, ChatPaymentInfo>();
    if (chat.messages.length === 0) return out;
    const byId = new Map(chat.messages.map((m) => [m.id, m]));
    for (const [noteId, movementId] of noteMovements(chat.messages, history)) {
      const m = byId.get(noteId);
      const p = m?.payload;
      if (!m || p?.t !== "payment") continue;
      const name = chat.contacts[m.peer]?.name;
      out.set(movementId, { ...(name ? { name } : {}), ...(p.note ? { note: p.note } : {}) });
    }
    return out;
  }, [chat.messages, chat.contacts, history]);
}

export type ContactPayment = { movementId: number; sats: number; at: number; note?: string };

// Payments with one contact, newest first, for their profile. Sent ones are
// matched by the address their @name points at (any payment there, chat or
// not) and by our own chat notes; received ones only by their chat notes,
// since nothing else in a receipt says who paid.
export function contactPayments(
  peer: string,
  address: string | undefined,
  messages: readonly StoredMessage[],
  history: readonly ReceiptLike[],
): { sent: number; received: number; items: ContactPayment[] } {
  const notes = new Map<number, StoredMessage>();
  const mine = messages.filter((m) => m.peer === peer && m.payload?.t === "payment");
  for (const [noteId, movementId] of noteMovements(messages, history)) {
    const m = mine.find((x) => x.id === noteId);
    if (m) notes.set(movementId, m);
  }
  const items: ContactPayment[] = [];
  let sent = 0;
  let received = 0;
  for (const mv of history) {
    const note = notes.get(mv.id);
    const toAddress =
      !!address && mv.effectiveBalanceSats < 0 && mv.sentToAddresses.map(formatAddressValue).includes(address);
    if (!note && !toAddress) continue;
    const at = Date.parse(mv.createdAt) / 1000;
    const p = note?.payload;
    items.push({
      movementId: mv.id,
      sats: mv.effectiveBalanceSats,
      at: Number.isFinite(at) ? at : 0,
      ...(p?.t === "payment" && p.note ? { note: p.note } : {}),
    });
    if (mv.effectiveBalanceSats < 0) sent += -mv.effectiveBalanceSats;
    else received += mv.effectiveBalanceSats;
  }
  items.sort((a, b) => b.at - a.at);
  return { sent, received, items };
}

export type LocalSend = { movementId: number; sats: number; at: number };

// What we paid to a contact's @name address outside the chat (the ordinary
// Send form): shown only in our own conversation, as a quiet line. Nothing is
// sent for it, so the other side learns nothing it did not know. Sends the
// chat already tells about (a payment note) are left out.
export function unannouncedSends(
  address: string,
  messages: readonly StoredMessage[],
  history: readonly ReceiptLike[],
): LocalSend[] {
  const announced = new Set(noteMovements(messages, history).values());
  const out: LocalSend[] = [];
  for (const mv of history) {
    if (mv.effectiveBalanceSats >= 0 || announced.has(mv.id)) continue;
    if (!mv.sentToAddresses.map(formatAddressValue).includes(address)) continue;
    const at = Date.parse(mv.createdAt) / 1000;
    if (!Number.isFinite(at)) continue;
    out.push({ movementId: mv.id, sats: -mv.effectiveBalanceSats, at });
  }
  return out.sort((a, b) => a.at - b.at);
}
