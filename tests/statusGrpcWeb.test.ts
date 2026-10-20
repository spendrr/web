import { describe, expect, it } from "vitest";
import { grpcWebMessage, readVarintField1 } from "../status/grpcWeb";

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
// NextRoundTime from ark.second.tech over gRPC-web, 2026-10-05 17:21 UTC:
// message frame, then the trailer frame "grpc-status:0".
const NEXT_ROUND_TIME = hex("000000000608adc68fd606800000000f677270632d7374617475733a300d0a");

describe("status gRPC-web", () => {
  it("reads the next round time from a real reply", () => {
    const msg = grpcWebMessage(200, null, NEXT_ROUND_TIME);
    expect(msg).not.toBeNull();
    const secs = readVarintField1(msg as Uint8Array);
    expect(new Date((secs as number) * 1000).toISOString()).toBe("2026-10-05T17:49:33.000Z"); // protoc --decode_raw: 1: 1791222573;
  });

  it("fails on a non-200, a non-zero status in header or trailer", () => {
    expect(grpcWebMessage(500, null, NEXT_ROUND_TIME)).toBeNull();
    expect(grpcWebMessage(200, "14", NEXT_ROUND_TIME)).toBeNull();
    const trailer14 = new TextEncoder().encode("grpc-status:14\r\n");
    expect(grpcWebMessage(200, null, Uint8Array.from([0x80, 0, 0, 0, trailer14.length, ...trailer14]))).toBeNull();
    // No status anywhere is not a success either.
    expect(grpcWebMessage(200, null, NEXT_ROUND_TIME.subarray(0, 11))).toBeNull();
  });

  it("takes an empty message (GetArkInfo-style status-only reply) when the status is 0", () => {
    const trailer0 = new TextEncoder().encode("grpc-status:0\r\n");
    expect(grpcWebMessage(200, null, Uint8Array.from([0x80, 0, 0, 0, trailer0.length, ...trailer0]))).toEqual(new Uint8Array(0));
  });

  it("rejects other fields and truncated varints", () => {
    expect(readVarintField1(hex("1005"))).toBeNull();
    expect(readVarintField1(hex("0880"))).toBeNull();
    expect(readVarintField1(hex("0805"))).toBe(5);
  });
});
