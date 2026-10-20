// Write-token check for the cloud backup (see src/lib/backup/backupCrypto.ts's
// WRITE_TOKEN_INFO). Pure, so it is unit-testable outside the Workers
// runtime, same reason as backupVersion.ts.
//
// Before this, a lookupKey was the only thing standing between anyone and a
// wallet's backup: whoever learned one (a log, localStorage, a proxy) could
// commit garbage over it (the version check is no obstacle, /meta hands out
// the current version) and leave the owner's devices latched in a conflict,
// or replay an older blob they had fetched earlier, restoring a stale state,
// which is the STOP_GAP loss this feature exists to prevent.
//
// The token is derived from the seed, so only someone holding the seed has
// it. The server keeps its SHA-256 in the objects' customMetadata
// (`writeTokenHash`): recorded by the first commit that carries one (trust on
// first use, which is also how every backup made before this migrates) and
// required from then on. What it does NOT cover: the operator of this server
// can still roll a backup back (it could anyway), and a caller that invents
// its own lookupKey and token still owns that key, so the endpoints remain
// usable as generic storage by whoever controls both ends.

export const WRITE_TOKEN_RE = /^[0-9a-f]{64}$/;

export type BackupAuthDecision = "ok" | "forbidden";

// `storedHash`: the writeTokenHash on the object being written or read, or
// undefined when it has none (no object yet, or one from before tokens).
// `presentedHash`: SHA-256 of the token the request carried, or null.
export function checkWriteToken(storedHash: string | undefined, presentedHash: string | null): BackupAuthDecision {
  if (storedHash === undefined) return "ok";
  if (presentedHash === null) return "forbidden";
  return storedHash === presentedHash ? "ok" : "forbidden";
}

export async function hashWriteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
