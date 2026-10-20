// gRPC length-prefixed messages out of an HTTP/2 data stream: each message is
// a 1-byte compression flag, a 4-byte big-endian length and the protobuf
// payload, and the stream's chunks can split or join them anywhere. Pure.

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);

  // Every complete message so far; a partial one waits for the next chunk.
  // Throws on a compressed or oversized message (we never ask for compression,
  // and a mailbox message is far smaller): the stream is then not trusted.
  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let pos = 0;
    while (merged.length - pos >= 5) {
      const view = new DataView(merged.buffer, merged.byteOffset + pos, 5);
      if (view.getUint8(0) !== 0) throw new Error("compressed gRPC message");
      const len = view.getUint32(1, false);
      if (len > MAX_MESSAGE_BYTES) throw new Error("gRPC message too large");
      if (merged.length - pos - 5 < len) break;
      out.push(merged.slice(pos + 5, pos + 5 + len));
      pos += 5 + len;
    }
    this.buf = merged.slice(pos);
    return out;
  }
}
