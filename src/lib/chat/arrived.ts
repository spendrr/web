// Which payment notes in the chat belong to which movement in the wallet's own
// history. Pure, so the attribution rule is unit-tested (tests/chatMessages.test.ts).
import type { Movement } from "@secondts/bark";
import type { StoredMessage } from "./chatClient";
import { formatAddressValue } from "../send/movementAddress";

export type ReceiptLike = Pick<
  Movement,
  "id" | "effectiveBalanceSats" | "receivedOnAddresses" | "sentToAddresses" | "createdAt"
>;

const MATCH_WINDOW_S = 3600;

function arkAddresses(raw: readonly string[]): string[] {
  return raw.map(formatAddressValue).filter((a) => /^t?ark1/i.test(a));
}

// What we sent can carry a fee on top of the note's amount (same tolerance as
// namePins.ts's payment log).
function paidWithFee(spent: number, sats: number): boolean {
  return spent >= sats && spent <= sats + Math.max(50, Math.ceil(sats * 0.02));
}

// An incoming payment note is the sender's claim; this wallet's own history is
// the truth. A note is tied to a movement only when the amount, the address and
// the time (within an hour) match and no other note claims that same movement:
// the address is the public @name address, so anyone could otherwise send a
// note for a payment somebody else made. The SDK sometimes returns the
// addresses as tagged JSON and sometimes none at all; an unreadable or empty
// list falls back to amount and time, still under the same uniqueness rule.
// Our own notes are matched the same way against what we sent, so the history
// can show the note and the chat can open the payment.
export function noteMovements(
  messages: readonly StoredMessage[],
  history: readonly ReceiptLike[],
): Map<string, number> {
  const matches = new Map<string, number[]>();
  const claims = new Map<number, number>();
  for (const m of messages) {
    const p = m.payload;
    if (!p || p.t !== "payment") continue;
    const hits = history
      .filter((mv) => {
        if (m.outgoing ? !paidWithFee(-mv.effectiveBalanceSats, p.sats) : mv.effectiveBalanceSats !== p.sats) return false;
        const addresses = arkAddresses(m.outgoing ? mv.sentToAddresses : mv.receivedOnAddresses);
        if (addresses.length > 0 && !addresses.includes(p.to)) return false;
        const at = Date.parse(mv.createdAt) / 1000;
        return Number.isFinite(at) && Math.abs(at - m.createdAt) < MATCH_WINDOW_S;
      })
      .map((mv) => mv.id);
    matches.set(m.id, hits);
    for (const id of hits) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [noteId, hits] of matches) {
    const unique = hits.find((id) => claims.get(id) === 1);
    if (unique !== undefined) out.set(noteId, unique);
  }
  return out;
}

export function arrivedNotes(messages: readonly StoredMessage[], history: readonly ReceiptLike[]): Set<string> {
  const incoming = new Map(messages.map((m) => [m.id, m.outgoing]));
  return new Set([...noteMovements(messages, history).keys()].filter((id) => incoming.get(id) === false));
}
