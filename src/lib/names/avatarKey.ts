// Where an address's public avatar PNG lives (the public bucket behind
// data.spendrr.app), shared by the Worker that writes it and the app that puts
// the URL in its kind 0 profile. No imports: the Worker bundles it too.
//
// The key is a hash of the address, not the address, so a profile published on
// relays is not a list of Ark addresses. That is not a secret: whoever has an
// address can compute it. The engine version is part of the key, so a changed
// engine is a new URL (and a new profile) rather than an edited immutable file.
export const AVATAR_PUBLIC_ORIGIN = "https://data.spendrr.app";
export const AVATAR_PUBLIC_ENGINE = "v4";
const AVATAR_HASH_HEX_CHARS = 32;

export async function avatarAddressHash(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, AVATAR_HASH_HEX_CHARS);
}

export function avatarObjectKey(hash: string): string {
  return `avatar/${AVATAR_PUBLIC_ENGINE}/${hash}.png`;
}

export function avatarPictureUrl(hash: string): string {
  return `${AVATAR_PUBLIC_ORIGIN}/${avatarObjectKey(hash)}`;
}
