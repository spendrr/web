import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBlob,
  isSlot,
  openToken,
  parseTarget,
  sealToken,
  sendChatPush,
  TOKEN_MAX_AGE_DAYS,
  topicFor,
} from "../worker/chatPush";
import { generateVapidKeys } from "../worker/webPush";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);
const SLOT = "0123456789abcdef0123456789abcdef";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function browserSubscription() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { endpoint: "https://fcm.googleapis.com/fcm/send/abc:def", keys: { p256dh, auth } };
}

afterEach(() => vi.unstubAllGlobals());

describe("chat push tokens", () => {
  it("round-trips the subscription and slot", async () => {
    const sub = await browserSubscription();
    const target = parseTarget(sub, undefined)!;
    const token = await sealToken(SECRET, target, SLOT);
    expect(token.startsWith("c1.")).toBe(true);
    const opened = await openToken(SECRET, token);
    expect(opened).toEqual({ target, slot: SLOT });
  });

  it("hides the endpoint from whoever holds the token", async () => {
    const sub = await browserSubscription();
    const token = await sealToken(SECRET, parseTarget(sub, undefined)!, SLOT);
    expect(token).not.toContain("fcm.googleapis");
    expect(atob(token.slice(3).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((token.length - 3 + 3) % 4))).not.toContain("googleapis");
  });

  it("refuses another key, a changed byte, and junk", async () => {
    const sub = await browserSubscription();
    const token = await sealToken(SECRET, parseTarget(sub, undefined)!, SLOT);
    expect(await openToken(OTHER, token)).toBeNull();
    const i = token.length - 5;
    const flipped = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
    expect(await openToken(SECRET, flipped)).toBeNull();
    expect(await openToken(SECRET, "c1.AAAA")).toBeNull();
    expect(await openToken(SECRET, 42)).toBeNull();
    expect(await openToken(undefined, token)).toBeNull();
  });

  it("expires after the maximum age", async () => {
    const sub = await browserSubscription();
    const issued = Date.UTC(2026, 0, 1);
    const token = await sealToken(SECRET, parseTarget(sub, undefined)!, SLOT, issued);
    expect(await openToken(SECRET, token, issued + TOKEN_MAX_AGE_DAYS * 86_400_000)).not.toBeNull();
    expect(await openToken(SECRET, token, issued + (TOKEN_MAX_AGE_DAYS + 1) * 86_400_000)).toBeNull();
    expect(await openToken(SECRET, token, issued - 2 * 86_400_000)).toBeNull();
  });

  it("will not seal without a proper key", async () => {
    const target = parseTarget(await browserSubscription(), undefined)!;
    await expect(sealToken("short", target, SLOT)).rejects.toThrow();
    await expect(sealToken(undefined, target, SLOT)).rejects.toThrow();
  });
});

describe("chat push input checks", () => {
  it("accepts real subscription shapes only", async () => {
    const sub = await browserSubscription();
    expect(parseTarget(sub, undefined)).not.toBeNull();
    expect(parseTarget({ ...sub, endpoint: "https://evil.example/push" }, undefined)).toBeNull();
    expect(parseTarget({ ...sub, keys: { ...sub.keys, auth: "AAAA" } }, undefined)).toBeNull();
    expect(parseTarget({ ...sub, keys: { ...sub.keys, p256dh: "AAAA" } }, undefined)).toBeNull();
    expect(parseTarget({ ...sub, endpoint: "fcm:abc" }, undefined)).toBeNull();
    expect(parseTarget(null, undefined)).toBeNull();
    expect(parseTarget(undefined, "dGVzdC10b2tlbg:APA91bH" + "x".repeat(40))?.endpoint.startsWith("fcm:")).toBe(true);
    expect(parseTarget(undefined, "bad token")).toBeNull();
  });

  it("checks slots and blobs", () => {
    expect(isSlot(SLOT)).toBe(true);
    expect(isSlot(SLOT.toUpperCase())).toBe(false);
    expect(isSlot(SLOT.slice(1))).toBe(false);
    expect(isBlob("A".repeat(400))).toBe(true);
    expect(isBlob("A".repeat(2000))).toBe(false);
    expect(isBlob("A+B/".repeat(20))).toBe(false);
    expect(isBlob("short")).toBe(false);
  });

  it("gives one short topic per slot", async () => {
    const t = await topicFor(SLOT);
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await topicFor(SLOT)).toBe(t);
    expect(await topicFor("f".repeat(32))).not.toBe(t);
  });
});

describe("sendChatPush", () => {
  it("posts an encrypted push with urgency and topic", async () => {
    const sub = await browserSubscription();
    const vapid = await generateVapidKeys();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 201 });
      }),
    );
    const opened = { target: parseTarget(sub, undefined)!, slot: SLOT };
    expect(await sendChatPush({ VAPID_PRIVATE_KEY: vapid.privateKeyJwk }, opened, "A".repeat(100))).toBe("sent");
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe(sub.endpoint);
    expect(headers.urgency).toBe("high");
    expect(headers.topic).toBe(await topicFor(SLOT));
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization.startsWith("vapid t=")).toBe(true);
  });

  it("reports a gone subscription and a missing key", async () => {
    const sub = await browserSubscription();
    const vapid = await generateVapidKeys();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
    const opened = { target: parseTarget(sub, undefined)!, slot: SLOT };
    expect(await sendChatPush({ VAPID_PRIVATE_KEY: vapid.privateKeyJwk }, opened, "A".repeat(100))).toBe("gone");
    expect(await sendChatPush({}, opened, "A".repeat(100))).toBe("failed");
  });
});
