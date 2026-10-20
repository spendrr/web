// What happens to the exit destination's tag when the key behind it changes
// (a password change, or the vault re-encrypted at a new PBKDF2 count). The
// tag is keyed by the password and the vault's salt, so it has to be
// recomputed, but ONLY over an address the old tag still vouches for.
// Re-tagging whatever sits in localStorage would let anything that can only
// write there (rewrite the address, delete the tag) get a forged address
// signed by the user's next password change (external audit 2026-09-27, M1).
// Pure apart from WebCrypto; tests/exitDestinationTag.test.ts.
import { computeValueTag, verifyValueTag } from "../vault/crypto";
import type { EncryptedVault } from "../vault/vaultCrypto";

export type RekeyDecision =
  | { kind: "none" }
  // The old tag matched: this is the new one.
  | { kind: "retag"; tag: string }
  // No tag, or one that doesn't match: the address can't be vouched for.
  // Drop it; the exit screen asks for it again before any claim.
  | { kind: "clear" };

export async function rekeyDestinationTag(
  stored: { address: string | null; tag: string | null },
  previous: { password: string; vault: EncryptedVault },
  next: { password: string; vault: EncryptedVault },
): Promise<RekeyDecision> {
  if (!stored.address) return { kind: "none" };
  if (!stored.tag) return { kind: "clear" };
  const ok = await verifyValueTag(stored.address, stored.tag, previous.password, previous.vault);
  if (!ok) return { kind: "clear" };
  return { kind: "retag", tag: await computeValueTag(stored.address, next.password, next.vault) };
}
