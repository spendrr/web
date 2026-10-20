// Relays the money chat writes to and reads from, also published as the user's
// NIP-17 DM relay list (kind 10050) and in NIP-05. Shared by the app, the chat
// worker's network guard, CSP (public/_headers) and the Worker. A change here
// needs the same change in public/_headers' connect-src.
//
// Public relays for the POC; which ones stay is the outcome of the phase 0
// reliability measurement (docs/money-chat-design.md).
export const CHAT_RELAYS: readonly string[] = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

// Relays other Nostr clients commonly list as their NIP-17 inbox (kind 10050),
// plus indexers that hold those lists. Reached only on demand, never
// subscribed to: a message to a person whose client reads from one of these is
// published there too. A relay outside CHAT_RELAYS and this list is never
// contacted, however a contact's list names it (the worker guard and CSP are
// fixed lists, not "any wss").
export const CHAT_EXTRA_RELAYS: readonly string[] = [
  "wss://purplepag.es",
  "wss://nostr.mom",
  "wss://nostr.wine",
  "wss://offchain.pub",
  "wss://relay.snort.social",
  "wss://relay.satlantis.io",
];

// Where a contact's kind 10050 is looked up, and where ours is published so
// their clients can find it, besides the chat relays.
export const CHAT_INDEX_RELAYS: readonly string[] = ["wss://purplepag.es", "wss://nostr.mom"];

export const ALL_CHAT_RELAYS: readonly string[] = [...CHAT_RELAYS, ...CHAT_EXTRA_RELAYS];

// The known relay a tag value names, in our spelling, or null. Exact host and
// path after URL normalisation; no wildcard, no ws://.
export function knownRelay(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  let href: string;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "wss:" || u.username || u.password || u.search || u.hash) return null;
    href = u.href;
  } catch {
    return null;
  }
  return ALL_CHAT_RELAYS.find((r) => new URL(r).href === href) ?? null;
}

// The relays named by a kind 10050 event's "relay" tags that we may use.
export function dmRelaysFromTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (!Array.isArray(t) || t[0] !== "relay") continue;
    const r = knownRelay(t[1]);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

// The proof that a name's owner holds the chat key it publishes: a Schnorr
// signature by that key over sha256(CHAT_BIND_PREFIX + mailboxId). Without it a
// name could claim somebody else's Nostr identity in NIP-05.
export const CHAT_BIND_PREFIX = "spendrr-chat-bind-v1:";
