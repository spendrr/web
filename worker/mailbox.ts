// The Worker's two calls to the Ark server's mailbox gRPC service (a probe and
// a read), over fetch(). The protobuf encoding lives in mailboxProto.ts,
// shared with the push relay.

import { upstreamSignal } from "./upstream";
import { decodeMailboxMessages, encodeMailboxRequest, hexToBytes, type ReadMailboxResult } from "./mailboxProto";

export type { MailboxReceiveEvent, ReadMailboxResult } from "./mailboxProto";

/**
 * Whether the Ark server accepts this mailbox authorization, judged ONLY by
 * the gRPC status in the response headers. readMailbox() below cannot answer
 * that: the server reports a rejected request as HTTP 200 with an empty body
 * and `grpc-status: 3` (INVALID_ARGUMENT), which readMailbox() reads as "no
 * messages", i.e. success. Checked live 2026-09-21 against ark.second.tech:
 * garbage id and authorization, a well-formed authorization with a forged
 * signature, and an authorization for a different mailbox all came back as
 * HTTP 200 + grpc-status 3, and all three "succeeded" through readMailbox().
 *
 * A status header that is absent or "0" counts as accepted (a normal streamed
 * response carries its status in trailers, which fetch() here doesn't expose).
 * Anything else, a network error or a non-2xx is a refusal: fail closed. The
 * body is never read (it would be the whole backlog from checkpoint 0), only
 * cancelled once the headers are in.
 *
 * Not verified: a genuinely valid authorization coming back as accepted, since
 * minting one needs a real wallet. Expect it to; if it doesn't this fails
 * closed, which is the safe direction.
 */
export async function probeMailboxAuthorization(
  serverAddress: string,
  mailboxIdHex: string,
  authorizationHex: string,
): Promise<boolean> {
  const body = encodeMailboxRequest(hexToBytes(mailboxIdHex), hexToBytes(authorizationHex), 0n);
  let res: Response;
  try {
    res = await fetch(`${serverAddress}/mailbox_server.MailboxService/ReadMailbox`, {
      method: "POST",
      headers: { "content-type": "application/grpc", te: "trailers" },
      body,
      signal: upstreamSignal(),
    });
  } catch {
    return false;
  }
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
  if (!res.ok) return false;
  const status = res.headers.get("grpc-status");
  return status === null || status === "0";
}

/**
 * One ReadMailbox call against the Ark server's public mailbox gRPC service.
 * Plain HTTP/2 POST, no gRPC/protobuf library — verified live against
 * ark.second.tech before this was written (see ARCHITECTURE.md). Doesn't depend on
 * reading HTTP/2 trailers for success detection (Workers' fetch() trailer
 * support wasn't independently verified for this specific runtime) — a
 * well-formed response body is treated as success regardless of what arrives
 * in headers/trailers; anything else is a skip-and-retry-next-tick, same as
 * any other best-effort background check in this app.
 */
export async function readMailbox(
  serverAddress: string,
  mailboxIdHex: string,
  authorizationHex: string,
  checkpoint: bigint,
): Promise<ReadMailboxResult | null> {
  const body = encodeMailboxRequest(hexToBytes(mailboxIdHex), hexToBytes(authorizationHex), checkpoint);
  let res: Response;
  try {
    res = await fetch(`${serverAddress}/mailbox_server.MailboxService/ReadMailbox`, {
      method: "POST",
      headers: { "content-type": "application/grpc", te: "trailers" },
      body,
      signal: upstreamSignal(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  // The deadline also covers reading the body, and a body that stalls or
  // breaks throws here, outside the try above.
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  // gRPC frame: 1 byte compression flag + 4 byte big-endian length + payload.
  // An empty/short body (trailers-only error response, or nothing to say)
  // means no messages this tick, not necessarily a failure.
  if (buf.length < 5) return { events: [], nextCheckpoint: checkpoint, haveMore: false };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const payloadLen = view.getUint32(1, false);
  const payload = buf.subarray(5, 5 + payloadLen);
  try {
    return decodeMailboxMessages(payload);
  } catch {
    return null;
  }
}
