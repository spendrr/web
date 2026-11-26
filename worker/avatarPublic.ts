// The v4 avatar PNG of an address in the public bucket (PRICE_PUBLIC, behind
// data.spendrr.app), so other Nostr clients that show our kind 0 profile read
// the picture from the CDN and not from a Worker request. Written once per
// address: the key is a hash of the address and the engine version
// (src/lib/names/avatarKey.ts), so the file is immutable.
//
// Best-effort and idempotent. Callers run it after the response is decided
// (ctx.waitUntil): a failure leaves a profile whose picture 404s until the
// next name write or the weekly name check writes it.
import { avatarAddressHash, avatarObjectKey } from "../src/lib/names/avatarKey";
import { avatarPng, isAvatarAddress } from "./avatarPng";
import type { Env } from "./index";

export async function ensurePublicAvatar(env: Pick<Env, "PRICE_PUBLIC">, address: string): Promise<void> {
  const bucket = env.PRICE_PUBLIC;
  if (!bucket || !isAvatarAddress(address)) return;
  try {
    const key = avatarObjectKey(await avatarAddressHash(address));
    if (await bucket.head(key)) return;
    const png = await avatarPng(address, true);
    await bucket.put(key, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (e) {
    console.error("public avatar write failed", e instanceof Error ? e.message : e);
  }
}
