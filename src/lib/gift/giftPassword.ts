// The password protecting a fresh recipient's vault when they arrive via a
// gift link — generated for them, never typed. A vault has to be encrypted
// with *something*, and asking a first-time user to invent a password is the
// friction the gift link exists to remove.
//
// 60 bits of real entropy (12 symbols, three groups of four). The vault sits
// in this device's localStorage behind PBKDF2 (210k+ iterations), so an
// attacker first needs the ciphertext and then ~2^60 slow guesses each; more
// than that only makes the value harder for the recipient to copy. Vaults
// created earlier with the old 26-symbol password are unaffected.
//
// Delivery to the OS keychain (navigator.credentials / password-manager
// prompt) is a separate, best-effort concern handled on the main thread —
// this module only mints and formats the string.

// Crockford base32: no I, L, O, U, so nothing to misread when the value is
// shown once for the user to copy. 5 bits per symbol.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENTROPY_BYTES = 8;
const SYMBOLS = 12;
const GROUP = 4;

function toCrockford(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 0x1f];
  return out;
}

export function formatGiftPassword(raw: string): string {
  return raw.replace(new RegExp(`(.{${GROUP}})`, "g"), "$1-").replace(/-$/, "");
}

// e.g. "K7QF-9M2T-XW04" — 12 symbols, grouped.
export function generateGiftPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES));
  try {
    // 8 bytes encode to 13 symbols; drop the last so the groups come out even.
    return formatGiftPassword(toCrockford(bytes).slice(0, SYMBOLS));
  } finally {
    bytes.fill(0);
  }
}

// The raw (ungrouped, upper-case) form — what actually goes into the vault
// KDF and the keychain. Accepts the value with or without the grouping
// dashes / surrounding whitespace so a user who re-types it from the banner
// still unlocks.
export function normalizeGiftPassword(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}
