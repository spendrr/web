// The client sends a push subscribe only when it changes something for the
// server, or when the authorization it holds is getting old.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableNotifications,
  enableNotifications,
  isSubscribeDue,
  refreshPushAuthorization,
  SUBSCRIBE_RESEND_AFTER_MS,
  subscribeKey,
} from "../src/lib/notifications";

const H = 60 * 60 * 1000;

describe("isSubscribeDue", () => {
  const key = subscribeKey({ mailboxId: "m", endpoint: "e", watch: { ok: true, value: 900_000 }, heightToken: "t" });
  const sent = { key, at: 0, priceUsd: 100_000 };

  it("nothing sent yet, or something the server holds would change", () => {
    expect(isSubscribeDue(null, key, 100_000, 0)).toBe(true);
    const other = subscribeKey({ mailboxId: "m", endpoint: "e2", watch: { ok: true, value: 900_000 }, heightToken: "t" });
    expect(isSubscribeDue(sent, other, 100_000, 1000)).toBe(true);
    const newWatch = subscribeKey({ mailboxId: "m", endpoint: "e", watch: { ok: true, value: 900_100 }, heightToken: "t" });
    expect(isSubscribeDue(sent, newWatch, 100_000, 1000)).toBe(true);
  });

  it("the same content: not again until the authorization gets old", () => {
    expect(isSubscribeDue(sent, key, 100_000, 1000)).toBe(false);
    expect(isSubscribeDue(sent, key, 100_000, SUBSCRIBE_RESEND_AFTER_MS - 1)).toBe(false);
    expect(isSubscribeDue(sent, key, 100_000, SUBSCRIBE_RESEND_AFTER_MS)).toBe(true);
    expect(SUBSCRIBE_RESEND_AFTER_MS).toBeLessThanOrEqual((24 * H) / 2);
    // A clock that went backwards is not trusted.
    expect(isSubscribeDue({ ...sent, at: 10 * H }, key, 100_000, 0)).toBe(true);
  });

  it("the price only when it drifted more than 0.5 %, and an unknown price never forces one", () => {
    expect(isSubscribeDue(sent, key, 100_400, 1000)).toBe(false);
    expect(isSubscribeDue(sent, key, 99_400, 1000)).toBe(true);
    expect(isSubscribeDue(sent, key, undefined, 1000)).toBe(false);
    expect(isSubscribeDue({ key, at: 0 }, key, 100_000, 1000)).toBe(true);
  });
});

describe("refreshPushAuthorization", () => {
  let posts: Record<string, unknown>[];
  let authCalls: number;
  let ok: boolean;
  let status: number;
  let store: Map<string, string>;
  let now: number;
  let endpoint: string;

  const wallet = {
    mailboxIdentifier: async () => "02" + "ab".repeat(32),
    mailboxAuthorization: async () => {
      authCalls++;
      return "cd".repeat(105);
    },
    getFirstExpiringVtxoBlockheight: async () => 900_000,
    allVtxos: async () => [],
    fingerprint: "f",
  } as never;

  beforeEach(() => {
    posts = [];
    authCalls = 0;
    ok = true;
    status = 204;
    now = 1_900_000_000_000;
    endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    store = new Map([["btc-wallet-notify-enabled", "1"]]);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const subscription = () => ({
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
      unsubscribe: async () => true,
    });
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal("window", { Notification: {}, PushManager: {}, dispatchEvent: () => true });
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: async () => "granted" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription() } }),
        register: async () => ({ pushManager: { getSubscription: async () => subscription() } }),
      },
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/push/subscribe") posts.push(JSON.parse(String(init?.body)));
      if (url !== "/api/push/subscribe") return new Response(null, { status: 204 });
      return new Response(null, { status: ok ? status : 503 });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends once, then not again for the same content, and does not even sign a new authorization", async () => {
    await refreshPushAuthorization(wallet, 100_000);
    for (let i = 0; i < 5; i++) {
      now += 10 * 60_000;
      await refreshPushAuthorization(wallet, 100_500);
    }
    expect(posts).toHaveLength(1);
    expect(authCalls).toBe(1);
    now += SUBSCRIBE_RESEND_AFTER_MS;
    await refreshPushAuthorization(wallet, 100_500);
    expect(posts).toHaveLength(2);
  });

  it("a new endpoint or an exit's watch height goes out at once", async () => {
    await refreshPushAuthorization(wallet, 100_000);
    endpoint = "https://fcm.googleapis.com/fcm/send/new";
    await refreshPushAuthorization(wallet, 100_000);
    await refreshPushAuthorization(wallet, 100_000, 899_000);
    expect(posts).toHaveLength(3);
    expect(posts[2].firstExpiringVtxoBlockheight).toBe(899_000);
  });

  it("a failed subscribe is retried on the next trigger", async () => {
    ok = false;
    await refreshPushAuthorization(wallet, 100_000);
    ok = true;
    await refreshPushAuthorization(wallet, 100_000);
    await refreshPushAuthorization(wallet, 100_000);
    expect(posts).toHaveLength(2);
  });

  it("a subscribe the push relay did not take (202) is sent again on the next trigger", async () => {
    status = 202;
    await refreshPushAuthorization(wallet, 100_000);
    status = 204;
    await refreshPushAuthorization(wallet, 100_000);
    await refreshPushAuthorization(wallet, 100_000);
    expect(posts).toHaveLength(2);
  });

  it("turning push off and on again always reaches the server", async () => {
    await refreshPushAuthorization(wallet, 100_000);
    await disableNotifications();
    await enableNotifications(wallet);
    expect(posts).toHaveLength(2);
    // Turning on sends no price; the next refresh brings the one it knows.
    await refreshPushAuthorization(wallet, 100_000);
    expect(posts).toHaveLength(3);
    await refreshPushAuthorization(wallet, 100_000);
    await enableNotifications(wallet);
    expect(posts).toHaveLength(4);
  });
});
