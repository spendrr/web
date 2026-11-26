// What a Nostr client shows for a person we only know by key: the name in their
// kind 0 profile. Anyone can write anything there, so it is shown as unverified
// (never as an @name) and cleaned first. Pure, unit-tested.
export const MAX_PROFILE_CHARS = 32;
export const MAX_PROFILE_JSON_CHARS = 20_000;

// Controls, format characters (zero-width, bidi, soft hyphen), line and
// paragraph separators, variation selectors, and the blank "letters" some
// scripts have that draw nothing.
const INVISIBLE_CLASS = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
const BLANK_LETTERS = new Set([0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0]);

function invisible(ch: string): boolean {
  const cp = ch.codePointAt(0) as number;
  return INVISIBLE_CLASS.test(ch) || BLANK_LETTERS.has(cp) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x180b && cp <= 0x180d);
}

// A name that fits on one line, or undefined. A leading "@" or "~" goes: the
// first would pass for a Spendrr name, the second is our own "unverified" mark.
export function cleanProfileName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = [...raw]
    .map((ch) => (invisible(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[@~\s]+/, "");
  if (s === "") return undefined;
  return [...s].slice(0, MAX_PROFILE_CHARS).join("").trim() || undefined;
}

// The name out of a kind 0 event's content (a JSON string): display_name, else name.
export function profileNameFrom(content: unknown): string | undefined {
  if (typeof content !== "string" || content.length > MAX_PROFILE_JSON_CHARS) return undefined;
  let p: unknown;
  try {
    p = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof p !== "object" || p === null) return undefined;
  const o = p as Record<string, unknown>;
  return cleanProfileName(o.display_name) ?? cleanProfileName(o.name);
}

// Our own kind 0 content, so other Nostr clients show the @name, verify it
// (NIP-05, resolved by the Worker's nostr.json against the chat key) and can
// pay the Lightning address. `lud16` only while the owner has the address
// switched on. `picture` is the address's avatar PNG in the public bucket
// (avatarKey.ts, written by worker/avatarPublic.ts), left out while the
// address is not known yet. A released name publishes an empty profile, so a
// stale nip05 claim does not linger. Key order is fixed: the app compares this
// string to know whether it has to publish again.
export function ownProfileContent(name: string | null, lnAddress: boolean, picture?: string, domain = "spendrr.app"): string {
  if (!name) return "{}";
  const address = `${name}@${domain}`;
  const p: Record<string, string> = { name, nip05: address };
  if (lnAddress) p.lud16 = address;
  if (picture) p.picture = picture;
  return JSON.stringify(p);
}
