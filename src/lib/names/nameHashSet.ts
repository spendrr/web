// The set of name hashes behind the name snapshot (worker/nameSnapshot.ts): the
// Worker builds and publishes it, the app reads the published copy
// (nameSnapshotClient.ts). Pure, no imports, so both sides share one copy.
//
// Wire format: the 32-bit FNV-1a hashes of the names, sorted ascending, each as a
// little-endian uint32 (4 bytes per name). A lookup is a binary search over a
// view of the bytes, with no parsing.

// FNV-1a over the name's UTF-16 code units (a handle is ASCII).
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function encodeNameHashes(hashes: Iterable<number>): Uint8Array {
  const sorted = Uint32Array.from(new Set(hashes)).sort();
  const bytes = new Uint8Array(sorted.length * 4);
  const view = new DataView(bytes.buffer);
  sorted.forEach((h, i) => view.setUint32(i * 4, h, true));
  return bytes;
}

export function encodeNameSnapshot(names: Iterable<string>): Uint8Array {
  return encodeNameHashes(Array.from(names, nameHash));
}

export class NameSnapshot {
  private readonly view: DataView;
  readonly count: number;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.count = bytes.byteLength / 4;
  }

  has(name: string): boolean {
    const target = nameHash(name);
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = this.view.getUint32(mid * 4, true);
      if (value === target) return true;
      if (value < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
}

export function decodeNameSnapshot(bytes: ArrayBuffer | Uint8Array): NameSnapshot | null {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength % 4 !== 0) return null;
  return new NameSnapshot(view);
}

// The published file (data.spendrr.app/names.bin) is the hashes behind a 4-byte
// tag, so anything else that ever answers at that URL (an error page, an empty
// body, another file) is refused instead of being read as a list of names and
// making every real name look free.
const NAME_FILE_MAGIC = [0x4e, 0x53, 0x4e, 0x31]; // "NSN1"

export function wrapNameFile(hashes: Uint8Array): Uint8Array {
  const out = new Uint8Array(NAME_FILE_MAGIC.length + hashes.byteLength);
  out.set(NAME_FILE_MAGIC, 0);
  out.set(hashes, NAME_FILE_MAGIC.length);
  return out;
}

// The hashes inside a published file, or null when it is not one or holds no
// names at all (the registry always holds some; an empty copy is a fault, not an
// empty directory, and trusting it would turn every name "free").
export function unwrapNameFile(bytes: Uint8Array): NameSnapshot | null {
  if (bytes.byteLength <= NAME_FILE_MAGIC.length) return null;
  for (let i = 0; i < NAME_FILE_MAGIC.length; i++) if (bytes[i] !== NAME_FILE_MAGIC[i]) return null;
  const snapshot = decodeNameSnapshot(bytes.subarray(NAME_FILE_MAGIC.length));
  return snapshot && snapshot.count > 0 ? snapshot : null;
}
