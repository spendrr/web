// Chat push formats (docs/chat-push-design.md). Pure and unit-tested.
//
// Control messages travel between two chat clients inside ordinary gift wraps,
// with their own rumor kind so no client shows them as a message:
//   grant  the recipient's token and preview key for this contact
//   revoke the recipient turned notifications off
//   ask    a sender without a working grant asks for one
//
// The blob is the notification preview, encrypted by the sender with the
// preview key of this contact (one key per contact, so a blob opens only under
// its own slot) and opened by public/sw-chat.js. Its layout is
// mirrored there: change both or neither.

export const KIND_PUSH_CONTROL = 20015;
export type PreviewLevel = "text" | "name" | "none";
export const PREVIEW_LEVELS: readonly PreviewLevel[] = ["text", "name", "none"];

export type PushControl =
  | { t: "grant"; token: string; key: string; preview: PreviewLevel }
  | { t: "revoke" }
  | { t: "ask" };

const MAX_CONTROL_CHARS = 2000;
const TOKEN_RE = /^c1\.[A-Za-z0-9_-]{40,1500}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function parseControl(content: string): PushControl | null {
  if (content.length > MAX_CONTROL_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (c.t === "revoke") return { t: "revoke" };
  if (c.t === "ask") return { t: "ask" };
  if (c.t !== "grant") return null;
  if (typeof c.token !== "string" || !TOKEN_RE.test(c.token)) return null;
  if (typeof c.key !== "string" || !KEY_RE.test(c.key)) return null;
  if (typeof c.preview !== "string" || !PREVIEW_LEVELS.includes(c.preview as PreviewLevel)) return null;
  return { t: "grant", token: c.token, key: c.key, preview: c.preview as PreviewLevel };
}

export function controlContent(c: PushControl): string {
  return JSON.stringify(c);
}

// ---- preview blob ------------------------------------------------------------

export type PreviewKind = "text" | "request" | "payment" | "reply" | "schedule";

export interface Preview {
  k: PreviewKind;
  // Text, only at preview level "text".
  x?: string;
  // Amount and note, only at "text" as well.
  s?: number;
  o?: string;
  // Messages since the last push of this conversation, this one included.
  c: number;
}

export interface BlobBody extends Preview {
  v: 1;
  // Counter per grant: the service worker drops anything not newer than the
  // last it showed, so a replayed request shows nothing.
  n: number;
  // Unix seconds at sending.
  t: number;
}

export const MAX_PREVIEW_CHARS = 120;
// Plaintext is padded to one of these sizes, so the push does not give away
// how long the message is.
const BUCKETS = [256, 640];
const AAD = "spendrr-push-v1";

// What the recipient asked to see decides what is sent at all.
export function previewFor(level: PreviewLevel, p: Preview): Preview {
  if (level === "text") return p;
  if (level === "name") return { k: p.k, c: p.c };
  return { k: "text", c: p.c };
}

function encodeBody(body: BlobBody): Uint8Array {
  const enc = new TextEncoder();
  let b = body;
  let bytes = enc.encode(JSON.stringify(b));
  // Long text in a wide script can exceed the largest bucket: shorten it.
  while (bytes.length > BUCKETS[BUCKETS.length - 1] && b.x) {
    b = { ...b, x: Array.from(b.x).slice(0, -10).join("") + "…" };
    bytes = enc.encode(JSON.stringify(b));
  }
  if (bytes.length > BUCKETS[BUCKETS.length - 1]) {
    const { o: _o, ...rest } = b;
    bytes = enc.encode(JSON.stringify(rest));
  }
  const size = BUCKETS.find((s) => s >= bytes.length) ?? bytes.length;
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

export function clampPreviewText(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > MAX_PREVIEW_CHARS ? chars.slice(0, MAX_PREVIEW_CHARS - 1).join("") + "…" : chars.join("");
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPreviewKey(raw: Uint8Array, usage: "encrypt" | "decrypt", extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", extractable, [usage]);
}

export async function sealBlob(key: CryptoKey, body: BlobBody): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(AAD) },
      key,
      encodeBody(body) as BufferSource,
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64urlEncode(out);
}

// The inverse, as the service worker does it (kept here for the tests and for
// anything in the page that needs it).
export async function openBlob(key: CryptoKey, blob: string): Promise<BlobBody | null> {
  try {
    const bytes = b64urlDecode(blob);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(AAD) },
        key,
        bytes.slice(12),
      ),
    );
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end--;
    const body = JSON.parse(new TextDecoder().decode(plain.subarray(0, end))) as BlobBody;
    return body.v === 1 ? body : null;
  } catch {
    return null;
  }
}

// When to poke after one of our messages: null while the contact is in the
// chat (they wrote or signalled within PRESENT_MS), otherwise how long to wait
// so a conversation gets at most one push per POKE_WINDOW_MS.
export const PRESENT_MS = 90 * 1000;
export const POKE_WINDOW_MS = 60 * 1000;

export function pokeDelay(now: number, lastHeardAt: number, lastPokeAt: number): number | null {
  if (now - lastHeardAt < PRESENT_MS) return null;
  return Math.max(0, lastPokeAt + POKE_WINDOW_MS - now);
}

export function randomSlot(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
