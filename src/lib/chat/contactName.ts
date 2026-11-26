import type { Contact } from "./chatClient";
import { encodeNpub } from "./npub";

// What other Nostr apps show for a bare key: the start and end of its npub.
export function shortNpub(pubkey: string): string {
  const npub = encodeNpub(pubkey);
  return npub === null ? `${pubkey.slice(0, 8)}\u2026` : `${npub.slice(0, 10)}\u2026${npub.slice(-4)}`;
}

// The user's own name for them, else the verified @name, else the name from
// their Nostr profile (theirs to write, so it never carries an @), else the short npub.
export function displayName(c: Contact | undefined, pubkey: string): string {
  if (c?.nickname) return c.nickname;
  if (c?.name) return `@${c.name}`;
  if (c?.profileName) return c.profileName;
  return shortNpub(pubkey);
}

// What sits under a nickname in the profile: who they are otherwise.
export function originalName(c: Contact | undefined, pubkey: string): string | undefined {
  if (!c?.nickname) return undefined;
  if (c.name) return `@${c.name}`;
  return c.profileName ?? shortNpub(pubkey);
}
