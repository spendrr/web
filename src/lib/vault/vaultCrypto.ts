// The pure vault crypto — PBKDF2 + AES-GCM over the mnemonic, with no
// dependency on `localStorage`, `window` or anything else DOM-only.
//
// Split out of crypto.ts deliberately: this module is imported by the wallet
// *worker* (walletWorkerImpl.ts), which is now the only realm that ever
// turns a password + vault into a plaintext mnemonic. crypto.ts keeps the
// main-thread-only parts (the localStorage accessors and the exit-address
// authentication tag) and re-exports everything here, so existing importers
// don't need to care about the split.
//
// The plaintext seed never leaves the browser and is never persisted
// unencrypted.

export interface EncryptedVault {
  saltB64: string;
  ivB64: string;
  cipherB64: string;
  // Added when the default iteration count was raised from 210k to 600k
  // (closer to current OWASP guidance for PBKDF2-SHA256). Vaults written
  // before this field existed have none — decryptMnemonic falls back to the
  // old count for those so they still open, and unlocking transparently
  // re-encrypts them at the new count (see App.tsx's unlock()).
  iterations?: number;
}

export const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 210_000;

// `iterations` is read straight out of localStorage, which anything with
// script access on this origin can rewrite — the same threat model that
// makes the exit-address tag in crypto.ts worth having. An absurd value
// there (1e12, Infinity, "600000" as a string, NaN) is handed directly to
// crypto.subtle.deriveKey, which either rejects or — worse — sits in a
// non-interruptible native PBKDF2 loop for effectively forever: the unlock
// screen hangs with no error and no way out but a reload, and it hangs again
// on the next attempt. Clamping is not a confidentiality control (a vault is
// only decryptable at the count it was written with, so a *lowered* value
// simply fails to decrypt rather than weakening anything); it exists so a
// malformed or hostile field can't turn into an unrecoverable lockout.
//
// The floor is the lowest count this app has ever written, so no real vault
// is excluded by it. The ceiling is generous — several seconds of PBKDF2 on
// a slow phone — but finite.
const MIN_ACCEPTED_ITERATIONS = LEGACY_PBKDF2_ITERATIONS;
const MAX_ACCEPTED_ITERATIONS = 4_000_000;

export function resolveIterations(vault: EncryptedVault): number {
  const raw = vault.iterations;
  // Missing field = a vault written before `iterations` existed, i.e. the
  // legacy count. Anything present but not a finite integer is a malformed
  // vault, not a legacy one — fall back to the same legacy count rather
  // than to NaN.
  if (raw === undefined || typeof raw !== "number" || !Number.isFinite(raw)) return LEGACY_PBKDF2_ITERATIONS;
  const rounded = Math.floor(raw);
  return Math.min(MAX_ACCEPTED_ITERATIONS, Math.max(MIN_ACCEPTED_ITERATIONS, rounded));
}

// Chunked deliberately: String.fromCharCode(...bytes) spreads the whole
// array as call arguments, which throws "Maximum call stack size exceeded"
// past a per-engine argument-count limit (tens of thousands, lower on some
// mobile browsers) — never hit by a mnemonic-sized buffer, but hit in
// practice by the cloud-backup feature's much larger encrypted blobs
// (lib/backupCrypto.ts). 32KB chunks stay well under any real limit.
const TO_B64_CHUNK_SIZE = 0x8000;

export function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += TO_B64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + TO_B64_CHUNK_SIZE));
  }
  return btoa(binary);
}

export function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// The byte-level primitives below exist so callers that don't actually need
// a mnemonic *string* never create one. A JS string is immutable and cannot
// be zeroed, so once the mnemonic exists as a string it stays in that
// realm's heap until GC decides otherwise; an ArrayBuffer can be
// overwritten the moment it's no longer needed. Everything that only has to
// re-encrypt the seed (change password, biometric enrolment) or merely
// check whether a password is right (the send/exit confirmation prompts)
// goes through these instead of decryptMnemonic.

export async function encryptVaultBytes(plaintext: Uint8Array, password: string): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  return {
    saltB64: toB64(salt.buffer as ArrayBuffer),
    ivB64: toB64(iv.buffer as ArrayBuffer),
    cipherB64: toB64(cipher),
    iterations: PBKDF2_ITERATIONS,
  };
}

export async function decryptVaultBytes(vault: EncryptedVault, password: string): Promise<Uint8Array> {
  const salt = fromB64(vault.saltB64);
  const iv = fromB64(vault.ivB64);
  const key = await deriveKey(password, salt, resolveIterations(vault));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    fromB64(vault.cipherB64) as BufferSource,
  );
  return new Uint8Array(plain);
}

export function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

export async function encryptMnemonic(mnemonic: string, password: string): Promise<EncryptedVault> {
  const bytes = new TextEncoder().encode(mnemonic);
  try {
    return await encryptVaultBytes(bytes, password);
  } finally {
    zeroBytes(bytes);
  }
}

export async function decryptMnemonic(vault: EncryptedVault, password: string): Promise<string> {
  const bytes = await decryptVaultBytes(vault, password);
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    zeroBytes(bytes);
  }
}

// Whether `password` opens this vault, without ever materializing the
// mnemonic as a string. AES-GCM's authentication tag is what actually
// answers the question — a wrong password makes crypto.subtle.decrypt
// reject, so the decrypted bytes are only ever used to be immediately
// zeroed. Used by every "re-enter your password to confirm this" prompt
// (large sends, the exit claim, the exit destination step), all of which
// previously called decryptMnemonic and threw the result away — leaving an
// unzeroable plaintext seed string in the React realm's heap for no reason.
export async function verifyVaultPassword(vault: EncryptedVault, password: string): Promise<boolean> {
  try {
    const bytes = await decryptVaultBytes(vault, password);
    zeroBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

// Whether this vault should be transparently re-encrypted at the current
// iteration count the next time we have the plaintext password in hand
// (i.e. right after a successful unlock).
export function vaultNeedsRehash(vault: EncryptedVault): boolean {
  return resolveIterations(vault) < PBKDF2_ITERATIONS;
}
