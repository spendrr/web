import type { Contact } from "./chatClient";

// A verified @name, else the name from their Nostr profile behind a "~" (it is
// theirs to write, so it is never shown like a Spendrr name), else the key.
export function displayName(c: Contact | undefined, pubkey: string): string {
  if (c?.name) return `@${c.name}`;
  if (c?.profileName) return `~${c.profileName}`;
  return `${pubkey.slice(0, 8)}\u2026`;
}
