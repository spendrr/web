// Recognises "send every week" / "chci každý měsíc" typed into the chat field,
// so the composer can offer a chip that opens the amount sheet. Fixed rules, no
// guessing beyond them: a miss just means no chip and the text goes out as a
// message. Never triggers anything by itself.
import type { Interval } from "./messages";

export type Recurrence = { kind: "send" | "request"; every: Interval };

// Long sentences are conversation, not a command.
const MAX_INPUT_CHARS = 40;

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SEND = /\b(send|pay|posli|posilej|poslat|posilat|zaplat|zaplatit|plat|platit)\b/;
const REQUEST = /\b(request|chci|chtej|zadej|zadam|pozadej|vyzadej)\b/;

const UNIT_WORDS: [RegExp, Interval["unit"]][] = [
  [/^(day|days|den|dny|dni|dnu)$/, "day"],
  [/^(week|weeks|tyden|tydny|tydnu)$/, "week"],
  [/^(month|months|mesic|mesice|mesicu)$/, "month"],
];

function unitOf(word: string): Interval["unit"] | null {
  for (const [re, unit] of UNIT_WORDS) if (re.test(word)) return unit;
  return null;
}

function intervalOf(t: string): Interval | null {
  if (/\b(daily|denne)\b/.test(t)) return { unit: "day", n: 1 };
  if (/\b(weekly|tydne)\b/.test(t)) return { unit: "week", n: 1 };
  if (/\b(monthly|mesicne)\b/.test(t)) return { unit: "month", n: 1 };
  const m = t.match(/\b(every|kazdy|kazde|kazdych|kazdou)\s+(?:(\d{1,3})\s+)?([a-z]+)\b/);
  if (!m) return null;
  const unit = unitOf(m[3]);
  if (!unit) return null;
  const n = m[2] ? Number(m[2]) : 1;
  if (n < 1 || n > 365) return null;
  return { unit, n };
}

export function detectRecurrence(text: string): Recurrence | null {
  if (text.length > MAX_INPUT_CHARS) return null;
  const t = fold(text);
  const isSend = SEND.test(t);
  const isRequest = REQUEST.test(t);
  if (isSend === isRequest) return null;
  const every = intervalOf(t);
  return every ? { kind: isSend ? "send" : "request", every } : null;
}

// Next due time after `from` (ms). Months are calendar months, clamped to the
// last day, so "every month" from 31 January is 28/29 February.
export function nextDue(from: number, every: Interval): number {
  const d = new Date(from);
  if (every.unit === "day") return from + every.n * 86_400_000;
  if (every.unit === "week") return from + every.n * 7 * 86_400_000;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + every.n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}
