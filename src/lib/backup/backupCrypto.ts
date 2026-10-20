// Key derivation for the encrypted cloud backup of local wallet state (see
// ARCHITECTURE.md's backup section). Deliberately separate from crypto.ts: that
// file's key material is always password-derived (PBKDF2) for the local
// vault; this derives everything from the mnemonic itself instead, because
// backup restore has to work during the import/recovery flow, before the
// user has set or entered any local password.
//
// Two independent, domain-separated secrets come out of the same mnemonic:
//   - `lookupKey`: a public, opaque R2 object key. Safe to hand to the
//     server — it identifies the backup but grants no way to decrypt it.
//   - `encryptionKey`: never leaves the browser.
// The split matters: the server must never be able to compute one from the
// other. HKDF's `info` parameter provides that separation from a single
// input (the BIP39 seed) — see deriveBackupKeys below.
//
// The `-v1` suffix on both info strings is deliberate and must never change
// silently: changing either info string (or the salt) after real backups
// exist under it orphans them without any error — decrypts elsewhere would
// just produce garbage keys, not a caught mismatch. If this derivation ever
// needs to change, it needs a new versioned info string and an explicit
// migration story, not an edit in place.

import { toB64, fromB64 } from "../vault/vaultCrypto";

const LOOKUP_KEY_INFO = "btc-wallet-backup-lookup-key-v1";
const ENCRYPTION_KEY_INFO = "btc-wallet-backup-encryption-key-v1";
// Added 2026-09-24. A bearer secret proving the caller holds the seed, not
// just the (much less protected) lookupKey: the server stores its SHA-256 on
// the first commit that carries it and from then on refuses writes and reads
// without it (worker/backupAuth.ts). Same never-change-in-place rule: a new
// info string here locks every existing backup out of its own updates.
const WRITE_TOKEN_INFO = "btc-wallet-backup-write-token-v1";

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Standard BIP39 seed derivation (PBKDF2-HMAC-SHA512, 2048 rounds, salt
// "mnemonic" + passphrase, NFKD-normalized) — the same 64-byte seed any
// BIP32 derivation from this mnemonic would use. Implemented directly via
// WebCrypto rather than round-tripping through the WASM SDK, so it works
// standalone before a wallet is ever opened.
export async function bip39Seed(mnemonic: string, passphrase = ""): Promise<Uint8Array> {
  const normalizedMnemonic = mnemonic.trim().normalize("NFKD");
  const salt = ("mnemonic" + passphrase).normalize("NFKD");
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalizedMnemonic),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 2048, hash: "SHA-512" },
    keyMaterial,
    512,
  );
  return new Uint8Array(bits);
}

export interface BackupKeys {
  lookupKey: string; // 64 hex chars (32 bytes) — sent to the server.
  writeToken: string; // 64 hex chars — sent to the server, which keeps only its SHA-256.
  encryptionKey: CryptoKey; // AES-GCM-256, non-extractable — never leaves the browser.
}

export async function deriveBackupKeys(mnemonic: string): Promise<BackupKeys> {
  return deriveBackupKeysFromSeed(await bip39Seed(mnemonic));
}

// For a caller that already holds the BIP39 seed (the wallet worker derives
// the chat key from the same seed at unlock and computes it once).
export async function deriveBackupKeysFromSeed(seed: Uint8Array): Promise<BackupKeys> {
  const hkdfKeyMaterial = await crypto.subtle.importKey("raw", seed as BufferSource, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const emptySalt = new Uint8Array(0);

  const lookupBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: emptySalt, info: new TextEncoder().encode(LOOKUP_KEY_INFO) },
    hkdfKeyMaterial,
    256,
  );
  const encryptionKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: emptySalt, info: new TextEncoder().encode(ENCRYPTION_KEY_INFO) },
    hkdfKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const writeTokenBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: emptySalt, info: new TextEncoder().encode(WRITE_TOKEN_INFO) },
    hkdfKeyMaterial,
    256,
  );

  return { lookupKey: toHex(lookupBits), writeToken: toHex(writeTokenBits), encryptionKey };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(digest);
}

// Wire format matches the worker's validation exactly: hex IV
// (IV_HEX_RE, 12 bytes), base64 ciphertext (BASE64_RE).
export interface EncryptedBackupBlob {
  ivHex: string;
  cipherB64: string;
}

export async function encryptBackupBlob(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBackupBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { ivHex: toHex(iv), cipherB64: toB64(cipher) };
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

export async function decryptBackupBlob(key: CryptoKey, ivHex: string, cipherB64: string): Promise<Uint8Array> {
  const iv = fromHex(ivHex);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    fromB64(cipherB64) as BufferSource,
  );
  return new Uint8Array(plain);
}
