// One Ark SubscribeMailbox stream per watched mailbox (mailbox_server.proto:
// one mailbox per call, resumes after a checkpoint), multiplexed over as few
// HTTP/2 connections as the server's SETTINGS_MAX_CONCURRENT_STREAMS allows
// (512 on ark.second.tech, 2026-10-04). A payment message calls onPayment; the
// relay never reads amounts or anything else out of it.
//
// A stream that ends is reopened from the last checkpoint after a growing,
// jittered delay. A stream the server refuses for its authorization waits for
// a newer authorization, or half an hour in case the refusal was the server's.
// A connection that stops answering pings is torn down: a dead TCP path would
// otherwise leave every stream on it looking open while nothing arrives.
//
// Per-stream events are counted, not logged: thousands of streams dropping at
// once must not flood the journal. drainCounters() feeds the minute log line.
import http2 from "node:http2";
import { decodeMailboxMessage, encodeMailboxRequest, hexToBytes } from "../worker/mailboxProto.ts";
import { FrameReader } from "./frames.ts";
import type { Registration, Store } from "./store.ts";

const PATH = "/mailbox_server.MailboxService/SubscribeMailbox";
// Below the server's own limit, so a connection never queues streams.
const STREAMS_PER_SESSION_CAP = 400;
const DEFAULT_STREAMS_PER_SESSION = 100;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60_000;
const REFUSED_RETRY_MS = 30 * 60_000;
// A stream that stayed up this long was healthy: its next reconnect starts
// from the shortest delay again.
const HEALTHY_AFTER_MS = 60_000;
// A ping not answered by the next one means the connection is dead.
const PING_EVERY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
// gRPC codes that mean "this authorization will not do": retrying with it at
// once is pointless.
const AUTH_REFUSED = new Set(["3", "7", "16"]);

type Session = { s: http2.ClientHttp2Session; streams: number; ping: ReturnType<typeof setInterval> };

type Watch = {
  stream: http2.ClientHttp2Stream | null;
  // The server answered 200 without an error status: messages can flow.
  live: boolean;
  openedAt: number;
  backoffMs: number;
  retry: ReturnType<typeof setTimeout> | null;
  // The authorization the server refused; cleared by a different one.
  refused: string | null;
};

export interface StreamDeps {
  arkServer: string;
  store: Store;
  onPayment: (mailboxId: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
  random?: () => number;
  pingEveryMs?: number;
  connectTimeoutMs?: number;
}

export class StreamManager {
  private sessions: Session[] = [];
  private watches = new Map<string, Watch>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly random: () => number;
  private readonly deps: StreamDeps;
  private stopped = false;
  // Since the last drainCounters(): streams ended (by gRPC status, "reset" for
  // none), connections dropped for silence, requests that could not start.
  private ended = new Map<string, number>();
  private deadSessions = 0;
  private failedStarts = 0;

  constructor(deps: StreamDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(m));
    this.random = deps.random ?? Math.random;
  }

  // Start (or keep) watching. A new authorization lifts an earlier refusal.
  ensure(reg: Registration): void {
    if (this.stopped) return;
    let w = this.watches.get(reg.mailboxId);
    if (!w) {
      w = { stream: null, live: false, openedAt: 0, backoffMs: BACKOFF_MIN_MS, retry: null, refused: null };
      this.watches.set(reg.mailboxId, w);
    }
    if (w.refused && w.refused !== reg.authorization) {
      w.refused = null;
      if (w.retry) clearTimeout(w.retry);
      w.retry = null;
    }
    if (!w.stream && !w.retry) this.open(reg.mailboxId);
  }

  stop(mailboxId: string): void {
    const w = this.watches.get(mailboxId);
    if (!w) return;
    this.watches.delete(mailboxId);
    if (w.retry) clearTimeout(w.retry);
    w.stream?.close(http2.constants.NGHTTP2_CANCEL);
  }

  stopAll(): void {
    this.stopped = true;
    for (const id of [...this.watches.keys()]) this.stop(id);
    for (const sess of this.sessions) {
      clearInterval(sess.ping);
      sess.s.close();
    }
    this.sessions = [];
  }

  // Streams whose authorization has run out are closed; they reopen when a
  // renewal comes in (ensure).
  closeExpired(): number {
    let closed = 0;
    for (const [id, w] of this.watches) {
      const reg = this.deps.store.get(id);
      if (w.stream && reg && reg.expiresAt * 1000 <= this.now()) {
        w.stream.close(http2.constants.NGHTTP2_CANCEL);
        closed++;
      }
    }
    return closed;
  }

  // `open` counts only streams the server accepted.
  stats(): { watched: number; open: number; refused: number; sessions: number } {
    let open = 0;
    let refused = 0;
    for (const w of this.watches.values()) {
      if (w.stream && w.live) open++;
      if (w.refused) refused++;
    }
    return { watched: this.watches.size, open, refused, sessions: this.sessions.length };
  }

  drainCounters(): string {
    const ended = [...this.ended].map(([k, v]) => `${k}:${v}`).join(" ") || "0";
    const line = `ended ${ended}, dead connections ${this.deadSessions}, failed starts ${this.failedStarts}`;
    this.ended.clear();
    this.deadSessions = 0;
    this.failedStarts = 0;
    return line;
  }

  watching(mailboxId: string): boolean {
    return this.watches.has(mailboxId);
  }

  private session(): Session {
    for (const sess of this.sessions) {
      if (sess.s.closed || sess.s.destroyed) continue;
      const limit = Math.min(sess.s.remoteSettings?.maxConcurrentStreams ?? DEFAULT_STREAMS_PER_SESSION, STREAMS_PER_SESSION_CAP);
      if (sess.streams < limit) return sess;
    }
    const s = http2.connect(this.deps.arkServer, { settings: { enablePush: false } });
    let awaitingPong = false;
    const sess: Session = {
      s,
      streams: 0,
      // Keeps NATs and the server's idle timers from dropping a quiet
      // connection, and finds one that died without a word.
      ping: setInterval(() => {
        if (s.closed || s.destroyed) return;
        if (awaitingPong) {
          this.deadSessions++;
          s.destroy(new Error("ping timeout"));
          return;
        }
        awaitingPong = true;
        try {
          s.ping((err) => {
            if (!err) awaitingPong = false;
          });
        } catch {
          // Still connecting: the next tick asks again.
          awaitingPong = false;
        }
      }, this.deps.pingEveryMs ?? PING_EVERY_MS),
    };
    // http2.connect itself never gives up on a connection that hangs, before
    // TCP or before the server's HTTP/2 SETTINGS.
    const connectTimer = setTimeout(() => {
      if (!s.closed && !s.destroyed) {
        this.deadSessions++;
        s.destroy(new Error("connect timeout"));
      }
    }, this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    s.once("remoteSettings", () => clearTimeout(connectTimer));
    s.on("error", (e) => this.log(`ark connection error: ${e.message}`));
    s.on("close", () => {
      clearTimeout(connectTimer);
      clearInterval(sess.ping);
      this.sessions = this.sessions.filter((x) => x !== sess);
    });
    this.sessions.push(sess);
    return sess;
  }

  private count(key: string): void {
    this.ended.set(key, (this.ended.get(key) ?? 0) + 1);
  }

  private retryLater(mailboxId: string, w: Watch, delay: number): void {
    w.retry = setTimeout(() => {
      w.retry = null;
      if (!this.stopped && this.watches.get(mailboxId) === w) this.open(mailboxId);
    }, delay);
  }

  private backoff(w: Watch): number {
    if (this.now() - w.openedAt >= HEALTHY_AFTER_MS) w.backoffMs = BACKOFF_MIN_MS;
    const delay = Math.round(w.backoffMs * (0.7 + 0.6 * this.random()));
    w.backoffMs = Math.min(w.backoffMs * 2, BACKOFF_MAX_MS);
    return delay;
  }

  private open(mailboxId: string): void {
    const w = this.watches.get(mailboxId);
    const reg = this.deps.store.get(mailboxId);
    if (!w || !reg) {
      this.stop(mailboxId);
      return;
    }
    // An expired authorization gets no stream; a renewal (ensure) restarts it.
    if (reg.expiresAt * 1000 <= this.now()) return;
    const authorization = reg.authorization;
    const body = encodeMailboxRequest(hexToBytes(mailboxId), hexToBytes(authorization), BigInt(reg.checkpoint));
    w.openedAt = this.now();
    const sess = this.session();
    let req: http2.ClientHttp2Stream;
    try {
      req = sess.s.request({
        ":method": "POST",
        ":path": PATH,
        "content-type": "application/grpc",
        te: "trailers",
      });
    } catch {
      // The connection went away between the check and the call (or ran out
      // of stream ids): drop it and try again shortly on a fresh one.
      this.failedStarts++;
      sess.s.destroy();
      this.retryLater(mailboxId, w, this.backoff(w));
      return;
    }
    sess.streams++;
    w.stream = req;
    w.live = false;
    const reader = new FrameReader();
    let status: string | null = null;

    const onStatus = (value: string | string[] | undefined) => {
      if (typeof value === "string" && status === null) status = value;
    };
    req.on("response", (headers) => {
      onStatus(headers["grpc-status"]);
      if (headers[":status"] === 200 && status === null) {
        w.live = true;
        w.refused = null;
      }
    });
    req.on("trailers", (headers) => onStatus(headers["grpc-status"]));
    req.on("data", (chunk: Buffer) => {
      let messages: Uint8Array[];
      try {
        messages = reader.push(chunk);
      } catch {
        this.count("bad-frame");
        req.close(http2.constants.NGHTTP2_PROTOCOL_ERROR);
        return;
      }
      for (const m of messages) {
        let decoded: ReturnType<typeof decodeMailboxMessage>;
        try {
          decoded = decodeMailboxMessage(m);
        } catch {
          continue;
        }
        if (decoded.checkpoint > 0n) this.deps.store.setCheckpoint(mailboxId, decoded.checkpoint.toString());
        if (decoded.event) this.deps.onPayment(mailboxId);
      }
    });
    // Counted on close; without a listener an error would throw.
    req.on("error", () => {});
    req.on("close", () => {
      sess.streams--;
      if (w.stream === req) {
        w.stream = null;
        w.live = false;
      }
      if (this.stopped || this.watches.get(mailboxId) !== w) return;
      this.count(status ?? "reset");
      if (status !== null && AUTH_REFUSED.has(status)) {
        w.refused = authorization;
        this.retryLater(mailboxId, w, REFUSED_RETRY_MS);
        return;
      }
      this.retryLater(mailboxId, w, this.backoff(w));
    });
    req.end(body);
  }
}
