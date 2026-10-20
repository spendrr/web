// The money chat's Nostr identity, derived from the wallet seed so it needs no
// account and comes back with a restore. Runs only in the wallet worker, the
// one realm that holds the mnemonic.
//
// HKDF over the BIP39 seed with its own info string, deliberately not NIP-06:
// interoperability comes from NIP-05 (name@spendrr.app), not from the path, and
// a Spendrr-only derivation keeps the chat key unrelated to anything that holds
// money. The info string must never change in place: a new one gives every
// user a new identity and orphans their conversations. New derivation = new
// versioned string plus a migration.
import { bip39Seed } from "../backup/backupCrypto";

const CHAT_KEY_INFO = "spendrr-chat-key-v1";

// secp256k1's group order. A plain range check instead of @noble's helper: this
// file runs in the wallet worker, next to the mnemonic, and nothing there may
// pull in a curve library just to compare a number.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function isValidSecretKey(key: Uint8Array): boolean {
  let k = 0n;
  for (const b of key) k = (k << 8n) | BigInt(b);
  return k > 0n && k < SECP256K1_N;
}

export async function deriveChatKey(mnemonic: string): Promise<Uint8Array> {
  const seed = await bip39Seed(mnemonic);
  try {
    return await deriveChatKeyFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

// `seed` is the BIP39 seed; the caller owns (and zeroes) it.
export async function deriveChatKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", seed as BufferSource, "HKDF", false, ["deriveBits"]);
  // A 32-byte HKDF output is outside the curve order with probability ~2^-128;
  // the counter only exists so that case has a defined answer.
  for (let counter = 0; counter < 256; counter++) {
    const info = counter === 0 ? CHAT_KEY_INFO : `${CHAT_KEY_INFO}/${counter}`;
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
      material,
      256,
    );
    const key = new Uint8Array(bits);
    if (isValidSecretKey(key)) return key;
    key.fill(0);
  }
  throw new Error("chat key derivation failed");
}
