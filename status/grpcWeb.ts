// Just enough gRPC-web for the status probes (status/worker.ts): the message
// frame and the status, and one varint field. No imports, tested on bytes
// captured from ark.second.tech in tests/statusGrpcWeb.test.ts.

// The message of a gRPC-web response, or null unless HTTP 200 and grpc-status
// 0 (a header, or the trailer frame after the message).
export function grpcWebMessage(status: number, grpcStatusHeader: string | null, bytes: Uint8Array): Uint8Array | null {
  if (status !== 200) return null;
  let message: Uint8Array | null = null;
  let grpcStatus = grpcStatusHeader;
  for (let i = 0; i + 5 <= bytes.length; ) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + i + 1, 4).getUint32(0);
    const frame = bytes.subarray(i + 5, i + 5 + len);
    if (bytes[i] & 0x80) grpcStatus ??= /grpc-status:\s*(\d+)/.exec(new TextDecoder().decode(frame))?.[1] ?? null;
    else message ??= frame;
    i += 5 + len;
  }
  return grpcStatus === "0" ? (message ?? new Uint8Array(0)) : null;
}

// Field 1 of a protobuf message as a varint (NextRoundTime's unix seconds).
export function readVarintField1(msg: Uint8Array): number | null {
  if (msg[0] !== 0x08) return null;
  let value = 0;
  for (let i = 1, shift = 0; i < msg.length && shift < 53; i++, shift += 7) {
    value += (msg[i] & 0x7f) * 2 ** shift;
    if (!(msg[i] & 0x80)) return value;
  }
  return null;
}
