// Passwordless wallet for gift recipients (beta). A wallet that arrives through a gift link is created WITHOUT a
// password: its seed is encrypted under a random AES-GCM key that the browser keeps non-extractable in IndexedDB,
// and the next open asks the user to set a password and write the seed down (PasswordSetupSheet).
//
// Same shape, and same honest limits, as the biometric vault (webauthn.ts): the key cannot be read back out of the
// CryptoKey, but any script on this origin can USE it to decrypt, so this protects against passive leaks and a copied
// vault string, not against hostile code on the main thread (see the threat-model note in walletSession.ts). The
// wallet opens through the existing "bioVault" prepare source, so the worker's seed handling is unchanged.
//
// Never created for a wallet the user made themselves; only a gift link made by a V2 sender asks for it.
import { fromB64, toB64, zeroBytes } from "./vaultCrypto";

const VAULT_KEY = "btc-wallet-device-vault";
const DB_NAME = "btc-wallet-device-key";
const STORE = "keys";
const KEY_ID = "main";

interface DeviceVault {
  ivB64: string;
  cipherB64: string;
}

// The key is gone (storage evicted, profile cleaned) while the vault string survived: the seed cannot be opened.
export const DEVICE_KEY_MISSING = "DEVICE_KEY_MISSING";

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("device key db"));
  });
}

async function putKey(key: CryptoKey): Promise<void> {
  const db = await openKeyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(key, KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("device key write"));
      tx.onabort = () => reject(tx.error ?? new Error("device key write aborted"));
    });
  } finally {
    db.close();
  }
}

async function getKey(): Promise<CryptoKey | null> {
  const db = await openKeyDb();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID);
      req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error("device key read"));
    });
  } finally {
    db.close();
  }
}

function readVault(): DeviceVault | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DeviceVault>;
    return typeof v.ivB64 === "string" && typeof v.cipherB64 === "string" ? { ivB64: v.ivB64, cipherB64: v.cipherB64 } : null;
  } catch {
    return null;
  }
}

export function hasDeviceVault(): boolean {
  return readVault() !== null;
}

// Key first, vault second: a vault whose key was never stored cannot be opened, while a stored key without a vault
// is just an unused key.
export async function createDeviceVault(mnemonic: string): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(mnemonic);
  let cipher: ArrayBuffer;
  try {
    cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, bytes as BufferSource);
  } finally {
    zeroBytes(bytes);
  }
  await putKey(key);
  const vault: DeviceVault = { ivB64: toB64(iv.buffer as ArrayBuffer), cipherB64: toB64(cipher) };
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

// What the wallet worker needs to open the wallet ("bioVault" prepare source): the key, never the seed.
export interface DeviceUnwrap {
  unwrapKey: CryptoKey;
  ivB64: string;
  cipherB64: string;
}

export async function loadDeviceUnwrap(): Promise<DeviceUnwrap> {
  const vault = readVault();
  if (!vault) throw new Error(DEVICE_KEY_MISSING);
  const unwrapKey = await getKey();
  if (!unwrapKey) throw new Error(DEVICE_KEY_MISSING);
  return { unwrapKey, ivB64: vault.ivB64, cipherB64: vault.cipherB64 };
}

// The seed as raw bytes, for re-encrypting it under a password. The caller zeroes them.
export async function decryptDeviceVaultBytes(): Promise<Uint8Array> {
  const { unwrapKey, ivB64, cipherB64 } = await loadDeviceUnwrap();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) as BufferSource },
    unwrapKey,
    fromB64(cipherB64) as BufferSource,
  );
  return new Uint8Array(plain);
}

export async function clearDeviceVault(): Promise<void> {
  try {
    localStorage.removeItem(VAULT_KEY);
  } catch {
    /* ignore */
  }
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  } catch {
    /* ignore */
  }
}
