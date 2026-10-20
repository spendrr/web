// What the chat keeps on this device (messages in IndexedDB, contacts and the
// rest in localStorage) is stored sealed: AES-GCM under the store key the chat
// worker derives from the chat key (chatWorkerImpl.ts). With the wallet locked
// there is no key in memory, and the stored chat reads as random bytes.
//
// Each record is bound to what it is (`purpose`, e.g. "msg:<id>" or
// "contacts") as additional data, so a sealed record copied into another slot
// does not open there.

export interface Sealed {
  iv: string;
  ct: string;
}

// Chunked, so a large record never spreads into one huge argument list.
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function isSealed(v: unknown): v is Sealed {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.iv === "string" && typeof r.ct === "string";
}

export async function seal(key: CryptoKey, purpose: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

// null for anything that does not open: another key, another purpose, or
// damaged bytes. Never throws.
export async function open<T>(key: CryptoKey, purpose: string, sealed: Sealed): Promise<T | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(sealed.iv) as BufferSource, additionalData: new TextEncoder().encode(purpose) },
      key,
      fromB64(sealed.ct) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}
