// The text of a payment reminder push, sealed on the device (beta, V2). The
// server only forwards the blob (worker/reminder.ts); the Service Worker opens
// it with the same key from IndexedDB (public/sw-chat.js, mirrored there).
// Plaintext is padded to one size, so the length says nothing about the name or
// the note.
import { b64urlDecode, b64urlEncode } from "./pushFormat";

const AAD = "spendrr-remind-v1";
export const REMINDER_PAD = 256;
const MAX_NAME_CHARS = 40;
const MAX_NOTE_CHARS = 60;

export interface ReminderBody {
  v: 1;
  // The schedule the tap opens.
  id: string;
  // The contact's @name without the @, when the user shows names.
  n?: string;
  s: number;
  o?: string;
  // Unix seconds at sealing.
  t: number;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

function encodeBody(body: ReminderBody): Uint8Array {
  const enc = new TextEncoder();
  let b: ReminderBody = {
    ...body,
    ...(body.n ? { n: clip(body.n, MAX_NAME_CHARS) } : {}),
    ...(body.o ? { o: clip(body.o, MAX_NOTE_CHARS) } : {}),
  };
  let bytes = enc.encode(JSON.stringify(b));
  // Wide scripts can exceed the pad: drop the note, then the name, never the amount.
  if (bytes.length > REMINDER_PAD && b.o) {
    const { o: _o, ...rest } = b;
    b = rest;
    bytes = enc.encode(JSON.stringify(b));
  }
  if (bytes.length > REMINDER_PAD && b.n) {
    const { n: _n, ...rest } = b;
    b = rest;
    bytes = enc.encode(JSON.stringify(b));
  }
  const out = new Uint8Array(REMINDER_PAD);
  out.set(bytes.subarray(0, REMINDER_PAD));
  return out;
}

// One key per browser, written by the page and read by the Service Worker.
// Non-extractable: neither can hand it on.
export function newReminderKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealReminder(key: CryptoKey, body: ReminderBody): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(AAD) }, key, encodeBody(body) as BufferSource),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64urlEncode(out);
}

// As the Service Worker does it, for the tests.
export async function openReminder(key: CryptoKey, blob: string): Promise<ReminderBody | null> {
  try {
    const bytes = b64urlDecode(blob);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(AAD) }, key, bytes.slice(12)),
    );
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end--;
    const body = JSON.parse(new TextDecoder().decode(plain.subarray(0, end))) as ReminderBody;
    return body.v === 1 && typeof body.id === "string" && typeof body.s === "number" ? body : null;
  } catch {
    return null;
  }
}

// The soonest schedule still ahead: the one reminder the server holds. Overdue
// ones are skipped on purpose (already pushed, or the app shows them on open).
export function nextReminder<T extends { nextDue: number }>(schedules: readonly T[], nowMs: number, minAheadMs = 30_000): T | null {
  let best: T | null = null;
  for (const s of schedules) {
    if (!Number.isFinite(s.nextDue) || s.nextDue < nowMs + minAheadMs) continue;
    if (!best || s.nextDue < best.nextDue) best = s;
  }
  return best;
}
