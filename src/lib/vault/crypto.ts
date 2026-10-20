// Main-thread-facing vault module: the localStorage accessors plus the
// exit-address authentication tag.
//
// The actual PBKDF2/AES-GCM primitives live in vaultCrypto.ts, which has no
// DOM dependency so the wallet worker can import it too — the worker is now
// the only realm that ever turns a password + vault into a plaintext
// mnemonic (see App.tsx's prepareSession path and ARCHITECTURE.md). Everything
// from there is re-exported here so existing importers are unaffected by
// the split.

import { fromB64, resolveIterations, toB64, type EncryptedVault } from "./vaultCrypto";

export {
  PBKDF2_ITERATIONS,
  decryptMnemonic,
  decryptVaultBytes,
  encryptMnemonic,
  encryptVaultBytes,
  fromB64,
  resolveIterations,
  toB64,
  vaultNeedsRehash,
  verifyVaultPassword,
  zeroBytes,
  type EncryptedVault,
} from "./vaultCrypto";

// An authentication tag over a short, non-secret string, keyed by the user's
// password and this vault's own salt.
//
// This exists for the unilateral-exit destination address. That address is
// stored in plain localStorage so the UI can display it for the days or
// weeks an exit runs — but plain localStorage is writable by anything with
// script access on this origin, which is a threat this app explicitly takes
// seriously (see the network-hardening notes in ARCHITECTURE.md). Rewriting that
// one key redirects the entire wallet balance on the final claim, and needs
// no network at all, so the fetch allowlist — this app's main defence — does
// nothing against it. A tag doesn't prevent the rewrite; it makes the
// rewrite *detectable* at the moment it would matter, using the password the
// user now has to type to claim anyway.
//
// Same PBKDF2 cost as the vault deliberately: an attacker holding an
// address/tag pair gets an offline password-guessing oracle, and it should
// be no cheaper than the vault oracle already sitting next to it.
async function deriveTagKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
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
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function computeValueTag(value: string, password: string, vault: EncryptedVault): Promise<string> {
  const key = await deriveTagKey(password, fromB64(vault.saltB64), resolveIterations(vault));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toB64(sig);
}

// crypto.subtle.verify rather than comparing strings, so a wrong tag can't
// be narrowed down by timing.
export async function verifyValueTag(
  value: string,
  tagB64: string,
  password: string,
  vault: EncryptedVault,
): Promise<boolean> {
  try {
    const key = await deriveTagKey(password, fromB64(vault.saltB64), resolveIterations(vault));
    return await crypto.subtle.verify("HMAC", key, fromB64(tagB64) as BufferSource, new TextEncoder().encode(value));
  } catch {
    // Malformed tag (not base64, wrong length) — indistinguishable from a
    // forged one as far as the caller is concerned.
    return false;
  }
}

const VAULT_KEY = "btc-wallet-vault";

export function loadVault(): EncryptedVault | null {
  const raw = localStorage.getItem(VAULT_KEY);
  return raw ? (JSON.parse(raw) as EncryptedVault) : null;
}

export function saveVault(vault: EncryptedVault): void {
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

export function clearVault(): void {
  localStorage.removeItem(VAULT_KEY);
}
