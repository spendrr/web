// gzip between the backup's JSON and its encryption.
//
// The dump is JSON with every binary value tagged as base64 (backupStore.ts's
// tagValue), so it is large and very compressible; ciphertext is not, hence
// this has to happen BEFORE encryption. Only the bytes that get encrypted
// change. The hash the whole version/lost-commit logic keys on stays the
// SHA-256 of the uncompressed JSON (backup.ts), so "is this the same state"
// means exactly what it did before, and gzip needs no determinism.
//
// Backward compatible in the reading direction: a plaintext JSON document
// starts with "{" (0x7b), a gzip stream with 0x1f 0x8b, so every backup
// written before this existed is read as it always was. NOT compatible the
// other way: a device still running an older build cannot read a compressed
// backup (JSON.parse of gzip bytes throws, which its restore path treats as a
// failed restore). That only matters for a stale cached tab or a second device
// that has not updated.

const GZIP_0 = 0x1f;
const GZIP_1 = 0x8b;

// Upper bound on what a backup may inflate to. The blob is authenticated
// (AES-GCM under a key derived from the seed), so only the owner can produce
// one; this only keeps a bug or a corrupted stream from eating the tab's memory.
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_0 && bytes[1] === GZIP_1;
}

function compressionAvailable(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

// Returns the gzip of `plain`, or `plain` itself when the platform has no
// CompressionStream or gzip would not make it smaller.
export async function compressBackup(plain: Uint8Array): Promise<Uint8Array> {
  if (!compressionAvailable()) return plain;
  const stream = new Blob([plain as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  return packed.length < plain.length ? packed : plain;
}

// Inverse of compressBackup: inflates a gzip stream, passes anything else
// through unchanged (a backup from before compression existed).
export async function decompressBackup(bytes: Uint8Array, maxBytes = MAX_DECOMPRESSED_BYTES): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  if (!compressionAvailable()) throw new Error("backup is compressed but this browser has no DecompressionStream");
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("backup inflates past the size limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
