import http2 from "node:http2";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameReader } from "../relay/frames";
import { HookBatcher, sign } from "../relay/hook";
import { Store } from "../relay/store";
import { StreamManager } from "../relay/streams";
import { apiHandler, health, WARM_AFTER_S } from "../relay/api";
import { hookSignature, verifyHook } from "../worker/pushRelay";
import { authorizationExpiry } from "../worker/mailboxProto";
import { mailboxAuthorizationFreshness, mailboxAuthorizationProblem, NAME_PROOF_LIFETIME_S } from "../worker/names";

const ID = "02" + "ab".repeat(32);
const NOW_S = 1_800_000_000;

// A mailbox authorization: mailbox key, 8-byte little-endian expiry, 64-byte signature.
function auth(mailboxId: string, expiresAt: number): string {
  const exp = Buffer.alloc(8);
  exp.writeBigUInt64LE(BigInt(expiresAt));
  return mailboxId + exp.toString("hex") + "ee".repeat(64);
}

function frame(payload: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}

function varint(n: bigint): number[] {
  const out: number[] = [];
  while (n > 0x7fn) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

// MailboxMessage { arkoor = 1 { vtxos = 1 }, checkpoint = 2 } or a non-payment one (field 4).
function mailboxMessage(checkpoint: bigint, payment: boolean): Uint8Array {
  const vtxo = Buffer.alloc(10);
  vtxo.writeUInt16LE(2, 0);
  vtxo.writeBigUInt64LE(5000n, 2);
  const arkoor = [0x0a, vtxo.length, ...vtxo];
  const body = payment ? [0x0a, arkoor.length, ...arkoor] : [0x22, 0];
  return Uint8Array.from([...body, 0x10, ...varint(checkpoint)]);
}

// The checkpoint a SubscribeMailbox request asks to resume after (field 3).
function requestCheckpoint(buf: Buffer): bigint {
  const p = buf.subarray(5);
  let i = 0;
  while (i < p.length) {
    const tag = p[i++];
    if (tag === 0x18) {
      let n = 0n;
      let shift = 0n;
      for (;;) {
        const b = p[i++];
        n |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return n;
        shift += 7n;
      }
    }
    const len = p[i++];
    i += len;
  }
  return 0n;
}

const tmp: string[] = [];
function store(nowS = NOW_S): Store {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  tmp.push(dir);
  return new Store(join(dir, "relay.db"), nowS);
}

afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("authorization expiry", () => {
  // names.ts reads the expiry the way live authorizations proved it (name
  // proofs pass and fail on it in production); the relay must agree.
  it("matches the worker's proven parser", () => {
    const a = auth(ID, NOW_S + 3600);
    expect(authorizationExpiry(a)).toBe(NOW_S + 3600);
    expect(mailboxAuthorizationProblem(ID, a, NOW_S)).toBeNull();
    expect(mailboxAuthorizationProblem(ID, a, NOW_S + 3600)).toBe("expired");
    expect(mailboxAuthorizationFreshness(auth(ID, NOW_S + NAME_PROOF_LIFETIME_S), NOW_S)).toBeNull();
  });
});

describe("gRPC frames", () => {
  it("joins split messages and splits joined ones", () => {
    const r = new FrameReader();
    const a = frame(Uint8Array.from([1, 2, 3]));
    const b = frame(Uint8Array.from([4]));
    const all = Buffer.concat([a, b]);
    expect(r.push(all.subarray(0, 4))).toEqual([]);
    expect(r.push(all.subarray(4, 9)).map((m) => [...m])).toEqual([[1, 2, 3]]);
    expect(r.push(all.subarray(9)).map((m) => [...m])).toEqual([[4]]);
  });

  it("refuses a compressed message", () => {
    const f = frame(Uint8Array.from([1]));
    f[0] = 1;
    expect(() => new FrameReader().push(f)).toThrow();
  });
});

describe("pokes to the Worker", () => {
  const OTHER = "03" + "cd".repeat(32);
  const mailbox = (i: number) => "02" + i.toString(16).padStart(64, "0");

  function batcher(opts: Partial<ConstructorParameters<typeof HookBatcher>[0]> = {}) {
    const posts: { headers: Record<string, string>; body: string }[] = [];
    let status = 204;
    const h = new HookBatcher({
      url: "https://w/hook",
      secret: "s".repeat(40),
      delayMs: 1000,
      log: () => {},
      post: async (_u, init) => {
        posts.push(init);
        return { status };
      },
      ...opts,
    });
    const shards = () => posts.map((p) => JSON.parse(p.body).shards as Record<string, string[]>);
    return { h, posts, shards, setStatus: (s: number) => (status = s) };
  }

  it("batches ids by shard into one signed request the Worker accepts", async () => {
    vi.useFakeTimers({ now: NOW_S * 1000 });
    const { h, posts, shards } = batcher();
    h.add(ID, "shard-1");
    h.add(ID, "shard-1");
    h.add(OTHER, "shard-2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(shards()).toEqual([{ "shard-1": [ID], "shard-2": [OTHER] }]);
    const p = posts[0];
    const byShard = await verifyHook({ PUSH_RELAY_HOOK_SECRET: "s".repeat(40) }, p.headers["x-relay-timestamp"], p.headers["x-relay-signature"], p.body, NOW_S);
    expect(byShard).toEqual(new Map([["shard-1", [ID]], ["shard-2", [OTHER]]]));
    expect(sign("k", "1", "b")).toBe(await hookSignature("k", "1", "b"));
  });

  it("retries a 5xx, gives up quietly and reports itself unhealthy for a while", async () => {
    vi.useFakeTimers({ now: NOW_S * 1000 });
    const { h, posts, setStatus } = batcher({ delayMs: 10 });
    setStatus(503);
    expect(h.healthy).toBe(true);
    h.add(ID, "shard-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts).toHaveLength(4);
    expect(h.failed).toBe(1);
    expect(h.healthy).toBe(false);
    setStatus(204);
    h.add(OTHER, "shard-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.healthy).toBe(true);
  });

  it("holds a noisy mailbox to its own budget without losing its last poke", async () => {
    vi.useFakeTimers({ now: NOW_S * 1000 });
    const { h, shards } = batcher({ delayMs: 10, mailboxBurst: 2, mailboxRefillMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      h.add(ID, "shard-1");
      await vi.advanceTimersByTimeAsync(20);
    }
    h.add(OTHER, "shard-1");
    await vi.advanceTimersByTimeAsync(20);
    // Two from the burst, the quiet mailbox unaffected, the rest owed.
    expect(shards()).toEqual([{ "shard-1": [ID] }, { "shard-1": [ID] }, { "shard-1": [OTHER] }]);
    expect(h.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shards()).toHaveLength(4);
    expect(h.waiting).toBe(0);
  });

  it("spends the overall budget in requests and merges what waits", async () => {
    vi.useFakeTimers({ now: NOW_S * 1000 });
    // Room for one send to one shard (2 units), then one unit every 10 s.
    const { h, shards } = batcher({ delayMs: 10, budgetBurst: 2, budgetPerSecond: 0.1 });
    h.add(mailbox(1), "shard-1");
    await vi.advanceTimersByTimeAsync(20);
    for (let i = 2; i < 30; i++) h.add(mailbox(i), "shard-1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(shards()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(shards()).toHaveLength(2);
    expect(shards()[1]["shard-1"]).toHaveLength(28);
  });

  it("sends whatever is due on shutdown", async () => {
    vi.useFakeTimers({ now: NOW_S * 1000 });
    const { h, shards } = batcher({ delayMs: 60_000, budgetBurst: 2, budgetPerSecond: 0.001 });
    h.add(ID, "shard-1");
    h.add(OTHER, "shard-2");
    await h.drain();
    expect(shards()).toEqual([{ "shard-1": [ID], "shard-2": [OTHER] }]);
  });
});

describe("registration store", () => {
  it("keeps the newest authorization and the furthest checkpoint", () => {
    const s = store();
    s.upsert({ mailboxId: ID, authorization: "a1", expiresAt: 100, checkpoint: "50", shard: "shard-1" });
    s.upsert({ mailboxId: ID, authorization: "a2", expiresAt: 200, checkpoint: "10", shard: "shard-1" });
    expect(s.get(ID)).toEqual({ mailboxId: ID, authorization: "a2", expiresAt: 200, checkpoint: "50", shard: "shard-1" });
    s.upsert({ mailboxId: ID, authorization: "old", expiresAt: 150, checkpoint: "60", shard: "shard-2" });
    expect(s.get(ID)?.authorization).toBe("a2");
    expect(s.get(ID)?.shard).toBe("shard-2");
    s.setCheckpoint(ID, "18446744073709551600");
    s.setCheckpoint(ID, "70");
    expect(s.get(ID)?.checkpoint).toBe("18446744073709551600");
  });

  it("prunes long-expired registrations", () => {
    const s = store();
    s.upsert({ mailboxId: ID, authorization: "a", expiresAt: 100, checkpoint: "0", shard: "shard-1" });
    expect(s.prune(101)).toEqual({ count: 1, ids: [ID] });
    expect(s.all()).toEqual([]);
  });

  it("removes for a shard only while that shard owns the mailbox", () => {
    const s = store();
    s.upsert({ mailboxId: ID, authorization: "a", expiresAt: 100, checkpoint: "0", shard: "shard-2" });
    expect(s.remove(ID, "shard-1")).toBe(false);
    expect(s.count()).toBe(1);
    expect(s.remove(ID, "shard-2")).toBe(true);
    expect(s.count()).toBe(0);
  });
});

describe("relay API", () => {
  function call(handler: ReturnType<typeof apiHandler>, method: string, path: string, body?: unknown, token = "T".repeat(40)) {
    return new Promise<{ status: number; body: string }>((resolve) => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
      const req = Object.assign((async function* () {
        yield* chunks;
      })(), { method, url: path, headers: { authorization: `Bearer ${token}` } });
      let status = 0;
      const res = {
        headersSent: false,
        writeHead(s: number) {
          status = s;
        },
        end(b?: string) {
          resolve({ status, body: b ?? "" });
        },
      };
      void handler(req as never, res as never);
    });
  }

  function deps() {
    const s = store();
    const ensured: string[] = [];
    const stopped: string[] = [];
    const stats = { open: -1, refused: 0 };
    const streams = {
      ensure: (r: { mailboxId: string }) => ensured.push(r.mailboxId),
      stop: (id: string) => stopped.push(id),
      stats: () => ({ watched: ensured.length, open: stats.open < 0 ? ensured.length : stats.open, refused: stats.refused, sessions: 1 }),
    };
    const hook = { healthy: true, waiting: 0 };
    return { s, ensured, stopped, stats, hook, d: { store: s, streams: streams as never, hook, token: "T".repeat(40), nowS: () => NOW_S } };
  }

  it("registers a valid authorization and starts a stream", async () => {
    const { s, ensured, d } = deps();
    const r = await call(apiHandler(d), "POST", "/register", { mailboxId: ID, authorization: auth(ID, NOW_S + 3600), checkpoint: "7", shard: "shard-4" });
    expect(r.status).toBe(204);
    expect(ensured).toEqual([ID]);
    expect(s.get(ID)?.expiresAt).toBe(NOW_S + 3600);
    expect(s.get(ID)?.shard).toBe("shard-4");
  });

  it("refuses a bad token, another mailbox's authorization and an expired one", async () => {
    const { d } = deps();
    const h = apiHandler(d);
    expect((await call(h, "GET", "/health", undefined, "wrong")).status).toBe(401);
    const other = "03" + "cd".repeat(32);
    const reg = (authorization: string, shard: unknown = "shard-0") => call(h, "POST", "/register", { mailboxId: ID, authorization, checkpoint: "0", shard });
    expect((await reg(auth(other, NOW_S + 3600))).status).toBe(400);
    expect((await reg(auth(ID, NOW_S - 1))).status).toBe(410);
    expect((await reg("zz")).status).toBe(400);
    expect((await reg(auth(ID, NOW_S + 3600), null)).status).toBe(400);
    expect((await reg(auth(ID, NOW_S + 3600), "elsewhere")).status).toBe(400);
  });

  it("unregisters, but not for a shard that no longer owns the mailbox", async () => {
    const { s, stopped, d } = deps();
    const h = apiHandler(d);
    s.upsert({ mailboxId: ID, authorization: "a", expiresAt: NOW_S + 10, checkpoint: "0", shard: "shard-2" });
    expect((await call(h, "POST", "/unregister", { mailboxId: ID, shard: "shard-1" })).status).toBe(204);
    expect(stopped).toEqual([]);
    expect((await call(h, "POST", "/unregister", { mailboxId: ID, shard: "shard-2" })).status).toBe(204);
    expect(stopped).toEqual([ID]);
    expect(s.get(ID)).toBeNull();
  });

  it("is warm only once the database is older than an authorization lives", () => {
    const { d } = deps();
    expect(health(d).warm).toBe(false);
    expect(health({ ...d, nowS: () => NOW_S + WARM_AFTER_S }).warm).toBe(true);
  });

  it("is not ok when the server refuses streams, too few are open, or pokes fail", () => {
    const { s, stats, hook, d } = deps();
    for (let i = 0; i < 10; i++) {
      const id = "02" + i.toString(16).padStart(64, "0");
      s.upsert({ mailboxId: id, authorization: "a", expiresAt: NOW_S + 100, checkpoint: "0", shard: "shard-0" });
    }
    stats.open = 8;
    expect(health(d).ok).toBe(true);
    stats.open = 0;
    stats.refused = 10;
    expect(health(d).ok).toBe(false);
    stats.open = 7;
    stats.refused = 0;
    expect(health(d).ok).toBe(false);
    stats.open = 10;
    hook.healthy = false;
    expect(health(d)).toMatchObject({ ok: false, hookOk: false });
  });
});

describe("mailbox streams against a gRPC server", () => {
  type Handler = (stream: http2.ServerHttp2Stream, checkpoint: bigint, n: number) => void;

  async function server(handler: Handler) {
    let n = 0;
    const srv = http2.createServer();
    // The relay tearing a connection down is expected here.
    srv.on("sessionError", () => {});
    srv.on("stream", (stream, headers) => {
      expect(headers[":path"]).toBe("/mailbox_server.MailboxService/SubscribeMailbox");
      const chunks: Buffer[] = [];
      stream.on("error", () => {});
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => handler(stream, requestCheckpoint(Buffer.concat(chunks)), n++));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
  }

  const until = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("pokes on a payment, not on routine traffic, and resumes from the last checkpoint", async () => {
    const asked: bigint[] = [];
    const srv = await server((stream, checkpoint, n) => {
      asked.push(checkpoint);
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      if (n === 0) {
        stream.write(frame(mailboxMessage(11n, false)));
        stream.write(frame(mailboxMessage(12n, true)));
        stream.end();
      }
    });
    const s = store(Math.floor(Date.now() / 1000));
    const reg = s.upsert({ mailboxId: ID, authorization: auth(ID, Math.floor(Date.now() / 1000) + 3600), expiresAt: Math.floor(Date.now() / 1000) + 3600, checkpoint: "10", shard: "shard-0" });
    const pokes: string[] = [];
    const m = new StreamManager({ arkServer: srv.url, store: s, onPayment: (id) => pokes.push(id), random: () => 0, log: () => {} });
    m.ensure(reg);
    await until(() => asked.length >= 2);
    expect(pokes).toEqual([ID]);
    expect(asked).toEqual([10n, 12n]);
    expect(s.get(ID)?.checkpoint).toBe("12");
    m.stopAll();
    await srv.close();
  });

  it("waits after the server refuses the authorization, and a new one starts it again", async () => {
    let calls = 0;
    const srv = await server((stream) => {
      calls++;
      stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "3" }, { endStream: true });
    });
    const nowS = Math.floor(Date.now() / 1000);
    const s = store(nowS);
    const reg = s.upsert({ mailboxId: ID, authorization: auth(ID, nowS + 3600), expiresAt: nowS + 3600, checkpoint: "0", shard: "shard-0" });
    const m = new StreamManager({ arkServer: srv.url, store: s, onPayment: () => {}, random: () => 0, log: () => {} });
    m.ensure(reg);
    await until(() => m.stats().refused === 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(1);
    const renewed = s.upsert({ mailboxId: ID, authorization: auth(ID, nowS + 7200), expiresAt: nowS + 7200, checkpoint: "0", shard: "shard-0" });
    m.ensure(renewed);
    await until(() => calls === 2);
    m.stopAll();
    await srv.close();
  });

  it("closes a stream when told to stop", async () => {
    let held = false;
    let closed = false;
    const srv = await server((stream) => {
      stream.on("close", () => (closed = true));
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      held = true;
    });
    const nowS = Math.floor(Date.now() / 1000);
    const s = store(nowS);
    const reg = s.upsert({ mailboxId: ID, authorization: auth(ID, nowS + 3600), expiresAt: nowS + 3600, checkpoint: "0", shard: "shard-0" });
    const m = new StreamManager({ arkServer: srv.url, store: s, onPayment: () => {}, log: () => {} });
    m.ensure(reg);
    await until(() => held);
    m.stop(ID);
    await until(() => closed);
    expect(m.watching(ID)).toBe(false);
    m.stopAll();
    await srv.close();
  });
  it("counts a stream open only once the server accepted it", async () => {
    let respond: (() => void) | null = null;
    const srv = await server((stream) => {
      respond = () => stream.respond({ ":status": 200, "content-type": "application/grpc" });
    });
    const nowS = Math.floor(Date.now() / 1000);
    const s = store(nowS);
    const reg = s.upsert({ mailboxId: ID, authorization: auth(ID, nowS + 3600), expiresAt: nowS + 3600, checkpoint: "0", shard: "shard-0" });
    const m = new StreamManager({ arkServer: srv.url, store: s, onPayment: () => {}, log: () => {} });
    m.ensure(reg);
    await until(() => respond !== null);
    expect(m.stats().open).toBe(0);
    respond!();
    await until(() => m.stats().open === 1);
    m.stopAll();
    await srv.close();
  });

  it("tears down a connection that stops answering and reconnects", async () => {
    let streams = 0;
    const srv = await server((stream) => {
      streams++;
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
    });
    // A TCP proxy that can go silent towards the relay, like a dead NAT path.
    let silent = false;
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(new URL(srv.url).port), "127.0.0.1");
      client.on("data", (d) => upstream.write(d));
      upstream.on("data", (d) => {
        if (!silent) client.write(d);
      });
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("close", end);
      upstream.on("close", end);
      client.on("error", end);
      upstream.on("error", end);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const nowS = Math.floor(Date.now() / 1000);
    const s = store(nowS);
    const reg = s.upsert({ mailboxId: ID, authorization: auth(ID, nowS + 3600), expiresAt: nowS + 3600, checkpoint: "0", shard: "shard-0" });
    const m = new StreamManager({
      arkServer: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      store: s,
      onPayment: () => {},
      log: () => {},
      random: () => 0,
      pingEveryMs: 100,
    });
    m.ensure(reg);
    await until(() => m.stats().open === 1);
    silent = true;
    await until(() => m.stats().open === 0);
    silent = false;
    await until(() => streams === 2 && m.stats().open === 1);
    expect(m.drainCounters()).toContain("dead connections 1");
    m.stopAll();
    await new Promise<void>((r) => proxy.close(() => r()));
    await srv.close();
  });

  it("gives up on a connection that never completes", async () => {
    let connections = 0;
    const blackhole = net.createServer((sock) => {
      connections++;
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
    const nowS = Math.floor(Date.now() / 1000);
    const s = store(nowS);
    const reg = s.upsert({ mailboxId: ID, authorization: auth(ID, nowS + 3600), expiresAt: nowS + 3600, checkpoint: "0", shard: "shard-0" });
    const m = new StreamManager({
      arkServer: `http://127.0.0.1:${(blackhole.address() as AddressInfo).port}`,
      store: s,
      onPayment: () => {},
      log: () => {},
      random: () => 0,
      connectTimeoutMs: 100,
    });
    m.ensure(reg);
    await until(() => connections >= 2);
    m.stopAll();
    blackhole.close();
  });
});
