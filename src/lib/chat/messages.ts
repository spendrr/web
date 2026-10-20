// What a money chat message carries, on top of a plain NIP-17 kind 14 rumor.
//
// Structured data rides in one tag, ["spendrr", "1", <json>]; `content` is
// always readable text, so any other Nostr client shows a sensible message
// ("Poslal(a) 5 000 sats: za pivo") and only Spendrr draws the bubble. Anything
// that fails validation here degrades to that plain text, never to an action.
import { KIND_CHAT, KIND_REACTION, type Rumor } from "./nostr";

export const SPENDRR_TAG = "spendrr";
export const PAYLOAD_VERSION = "1";
// A text message; a note riding on a payment or request stays short, it is a
// label on the money, not a letter.
export const MAX_TEXT_CHARS = 500;
export const MAX_NOTE_CHARS = 80;
// The picker's choice; other clients may react with any short text.
export const REACTIONS = ["👍", "❤️", "😂", "🙏", "🔥"] as const;
// Code points: a skin tone or a ZWJ family is one emoji but several of these.
const MAX_REACTION_CHARS = 16;
const EVENT_ID = /^[0-9a-f]{64}$/;
const MAX_SATS = 21_000_000 * 100_000_000;

export type Interval = { unit: "day" | "week" | "month"; n: number };

export type Payload =
  | { t: "payment"; sats: number; to: string; vtxo?: string; note?: string }
  | { t: "request"; sats: number; note?: string; every?: Interval }
  | { t: "request-reply"; ref: string; accept: boolean }
  | { t: "schedule"; sats: number; every: Interval; note?: string };

export interface ChatMessage {
  id: string;
  from: string;
  createdAt: number;
  text: string;
  payload: Payload | null;
  // A NIP-25 reaction to that message: `text` is the emoji, "" takes it back.
  reactTo?: string;
  // A NIP-17 reply: the message this one answers.
  replyTo?: string;
}

// Code points, not UTF-16 units, so an emoji counts once.
export function clampText(text: string, max = MAX_TEXT_CHARS): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const chars = [...text.replace(/[\u0000-\u001f\u007f]/g, " ").trim()];
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

function isSats(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_SATS;
}

function optNote(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === "string" ? clampText(v, MAX_NOTE_CHARS) : null;
}

export function isInterval(v: unknown): v is Interval {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return (
    (i.unit === "day" || i.unit === "week" || i.unit === "month") &&
    typeof i.n === "number" &&
    Number.isInteger(i.n) &&
    i.n >= 1 &&
    i.n <= 365
  );
}

export function parsePayload(raw: unknown): Payload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const note = optNote(p.note);
  if (note === null) return null;
  const withNote = note ? { note } : {};
  switch (p.t) {
    case "payment":
      if (!isSats(p.sats) || typeof p.to !== "string" || p.to.length > 200) return null;
      if (p.vtxo !== undefined && (typeof p.vtxo !== "string" || p.vtxo.length > 200)) return null;
      return { t: "payment", sats: p.sats, to: p.to, ...(p.vtxo ? { vtxo: p.vtxo as string } : {}), ...withNote };
    case "request":
      if (!isSats(p.sats)) return null;
      if (p.every !== undefined && !isInterval(p.every)) return null;
      return { t: "request", sats: p.sats, ...(p.every ? { every: p.every as Interval } : {}), ...withNote };
    case "request-reply":
      if (typeof p.ref !== "string" || !/^[0-9a-f]{64}$/.test(p.ref) || typeof p.accept !== "boolean") return null;
      return { t: "request-reply", ref: p.ref, accept: p.accept };
    case "schedule":
      if (!isSats(p.sats) || !isInterval(p.every)) return null;
      return { t: "schedule", sats: p.sats, every: p.every, ...withNote };
    default:
      return null;
  }
}

export function formatSats(sats: number): string {
  return sats.toLocaleString("cs-CZ").replace(/ /g, " ");
}

export function describeInterval(i: Interval): string {
  if (i.n === 1) return i.unit === "day" ? "denně" : i.unit === "week" ? "týdně" : "měsíčně";
  const unit = i.unit === "day" ? "dní" : i.unit === "week" ? "týdnů" : "měsíců";
  return `každých ${i.n} ${unit}`;
}

// The readable `content` other clients show.
export function fallbackText(p: Payload): string {
  const note = "note" in p && p.note ? `: ${p.note}` : "";
  switch (p.t) {
    case "payment":
      return `Poslal(a) ${formatSats(p.sats)} sats${note}`;
    case "request":
      return p.every
        ? `Žádá ${formatSats(p.sats)} sats ${describeInterval(p.every)}${note}`
        : `Žádá ${formatSats(p.sats)} sats${note}`;
    case "request-reply":
      return p.accept ? "Žádost přijata" : "Žádost odmítnuta";
    case "schedule":
      return `Bude posílat ${formatSats(p.sats)} sats ${describeInterval(p.every)}${note}`;
  }
}

export function replyTags(replyTo: string | undefined): string[][] {
  return replyTo && EVENT_ID.test(replyTo) ? [["e", replyTo, "", "reply"]] : [];
}

export function reactionTags(target: string): string[][] {
  return [
    ["e", target],
    ["k", String(KIND_CHAT)],
  ];
}

// NIP-25's "+" and "-" are a like and a dislike.
function reactionText(content: string): string {
  const c = content.trim();
  if (c === "+") return "👍";
  if (c === "-") return "👎";
  return clampText(c, MAX_REACTION_CHARS);
}

function lastEventTag(rumor: Rumor): string | undefined {
  const ids = rumor.tags.filter((t) => t[0] === "e" && typeof t[1] === "string" && EVENT_ID.test(t[1])).map((t) => t[1]);
  return ids[ids.length - 1];
}

export function payloadTags(p: Payload | null): string[][] {
  return p ? [[SPENDRR_TAG, PAYLOAD_VERSION, JSON.stringify(p)]] : [];
}

// A rumor from unwrapGift (sender already authenticated by the seal) to what the
// UI shows. Unknown payload versions or broken JSON keep the text only.
export function messageFromRumor(rumor: Rumor): ChatMessage | null {
  if (rumor.kind === KIND_REACTION) {
    // NIP-25: the reacted-to event is the last e tag.
    const target = lastEventTag(rumor);
    if (!target) return null;
    return { id: rumor.id, from: rumor.pubkey, createdAt: rumor.created_at, text: reactionText(rumor.content), payload: null, reactTo: target };
  }
  if (rumor.kind !== KIND_CHAT) return null;
  const replyTo = lastEventTag(rumor);
  let payload: Payload | null = null;
  const tag = rumor.tags.find((t) => t[0] === SPENDRR_TAG && t[1] === PAYLOAD_VERSION);
  if (tag && typeof tag[2] === "string" && tag[2].length <= 2000) {
    try {
      payload = parsePayload(JSON.parse(tag[2]));
    } catch {
      payload = null;
    }
  }
  return {
    id: rumor.id,
    from: rumor.pubkey,
    createdAt: rumor.created_at,
    text: clampText(rumor.content),
    payload,
    ...(replyTo ? { replyTo } : {}),
  };
}
