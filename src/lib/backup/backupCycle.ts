// The heavy half of one cloud backup cycle: dump IndexedDB, serialize, hash, compress, encrypt, and
// hash what the server stored. No network, no SDK, no DOM: it runs unchanged in the backup worker
// (backup.worker.ts) and, as the fallback, on the main thread (backupEngine.ts). Everything that talks
// to the server, the version CAS and the localStorage bookkeeping stay in backup.ts.
//
// The hash the whole version and lost-commit logic keys on is the sha256 of the UNCOMPRESSED JSON of the
// whole bundle, exactly as before. The JSON is built from one serialized string per database so that the
// fingerprint view (backupFingerprint.ts) only re-serializes the small on-chain part.
import { GIFTS_DB_NAME } from "../gift/giftStore";
import { dumpWithoutChainCheckpoints } from "./backupFingerprint";
import { ARK_DB_NAME, ONCHAIN_DB_NAME, dumpDatabase, type SerializedDb } from "./backupStore";
import { compressBackup, decompressBackup } from "./backupCompress";
import { decryptBackupBlob, encryptBackupBlob, sha256Hex, type EncryptedBackupBlob } from "./backupCrypto";

export const VOUCHERS_DB_NAME = "btc-wallet-vouchers";

export interface BundledDump {
  ark: SerializedDb | null;
  onchain: SerializedDb | null;
  // Outgoing gift links (btc-wallet-gifts). Optional, not just nullable: every backup written before gifts
  // existed decodes without this field, and restore has to treat "absent" exactly like "no gifts".
  gifts?: SerializedDb | null;
  // Bitrefill orders (btc-wallet-vouchers), optional for the same reason.
  vouchers?: SerializedDb | null;
}

export async function dumpAllDatabases(): Promise<BundledDump> {
  const [ark, onchain, gifts, vouchers] = await Promise.all([
    dumpDatabase(ARK_DB_NAME),
    dumpDatabase(ONCHAIN_DB_NAME),
    // Small but load-bearing: each gift record carries the encrypted reclaim seed for funds sitting on the
    // Ark server. Lose it and neither the 7-day auto-return nor "Vzít zpět" has anything to work with.
    dumpDatabase(GIFTS_DB_NAME),
    // Also small and load-bearing: a paid, undelivered order, or a delivered order's redemption code, may be
    // the only copy of something as spendable as the gift card itself.
    dumpDatabase(VOUCHERS_DB_NAME),
  ]);
  return { ark, onchain, gifts, vouchers };
}

const bigintToString = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

// The plain call first: a replacer makes JSON.stringify about nine times slower on a large dump. Only a
// TypeError (a bigint that slipped past tagValue, which hit production once, see backupStore.ts) retries with
// the replacer, which coerces bigints to strings so one unanticipated field does not block the whole backup.
// Both paths give the same text for a dump without bigints, so the hash does not change.
export function stringifyDump(dump: unknown): string {
  try {
    return JSON.stringify(dump);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return JSON.stringify(dump, bigintToString);
  }
}

const KEYS = ["ark", "onchain", "gifts", "vouchers"] as const;

// `{"ark":..,"onchain":..}` from per-key JSON. Equal to stringifyDump of the whole object: same key order,
// and a key whose value is undefined is left out the way JSON.stringify leaves it out.
function assemble(parts: Record<(typeof KEYS)[number], string | undefined>): string {
  const fields: string[] = [];
  for (const k of KEYS) {
    const part = parts[k];
    if (part !== undefined) fields.push(`${JSON.stringify(k)}:${part}`);
  }
  return `{${fields.join(",")}}`;
}

export interface PreparedDump {
  plaintext: Uint8Array;
  expectedHash: string;
  // Hash of the same bundle without the block checkpoints, equal to expectedHash when the dump has none.
  fingerprint: string;
}

export type PrepareResult = { kind: "nothing" } | { kind: "noArk" } | { kind: "ready"; prepared: PreparedDump };

export async function prepareDump(): Promise<PrepareResult> {
  const dump = await dumpAllDatabases();
  if (!dump.ark && !dump.onchain) return { kind: "nothing" }; // Nothing local to back up yet.
  // The Ark database holds the VTXOs, the whole reason this feature exists. A null here does not mean
  // "new wallet" (every caller runs after a successful open), it means the dump did not see what it should
  // have. Committing it would overwrite the one server-side copy with a bundle missing its important half.
  if (!dump.ark) return { kind: "noArk" };

  const parts = {} as Record<(typeof KEYS)[number], string | undefined>;
  for (const k of KEYS) parts[k] = stringifyDump(dump[k]);
  const plaintext = new TextEncoder().encode(assemble(parts));
  const expectedHash = await sha256Hex(plaintext);

  let fingerprint = expectedHash;
  const stripped = dumpWithoutChainCheckpoints({ onchain: dump.onchain });
  if (stripped) {
    const view = { ...parts, onchain: stringifyDump(stripped.onchain) };
    fingerprint = await sha256Hex(new TextEncoder().encode(assemble(view)));
  }
  return { kind: "ready", prepared: { plaintext, expectedHash, fingerprint } };
}

// Compressed before encryption (backupCompress.ts); the hash stays on the uncompressed JSON.
export async function encryptPrepared(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBackupBlob> {
  return encryptBackupBlob(key, await compressBackup(plaintext));
}

// The hash of what the server actually stored, decrypted and inflated.
export async function hashReadBack(key: CryptoKey, ivHex: string, cipherB64: string): Promise<string> {
  return sha256Hex(await decompressBackup(await decryptBackupBlob(key, ivHex, cipherB64)));
}
