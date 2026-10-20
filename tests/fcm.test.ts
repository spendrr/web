import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFcmMessage,
  buildServiceAccountJwt,
  fcmShouldDeleteSubscription,
  isFcmEndpoint,
  isValidFcmToken,
  parseServiceAccount,
  resetFcmTokenCacheForTests,
  sendFcm,
} from "../worker/fcm";
import { isKnownPushEndpoint } from "../worker/mailboxShared";

const TOKEN = "dGVzdC10b2tlbg:APA91bH" + "x".repeat(140);

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function makeServiceAccount() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({
    type: "service_account",
    project_id: "spendrr-test",
    client_email: "push@spendrr-test.iam.gserviceaccount.com",
    private_key: pem,
  });
  return { json, publicKey: pair.publicKey };
}

describe("FCM token and endpoint validation", () => {
  it("accepts real-looking registration tokens only", () => {
    expect(isValidFcmToken(TOKEN)).toBe(true);
    expect(isValidFcmToken("short")).toBe(false);
    expect(isValidFcmToken(TOKEN + " ")).toBe(false);
    expect(isValidFcmToken(TOKEN + "/")).toBe(false);
    expect(isValidFcmToken("x".repeat(513))).toBe(false);
    expect(isValidFcmToken(42)).toBe(false);
  });

  it("recognises fcm: endpoints as known push endpoints, nothing looser", () => {
    expect(isFcmEndpoint(`fcm:${TOKEN}`)).toBe(true);
    expect(isKnownPushEndpoint(`fcm:${TOKEN}`)).toBe(true);
    expect(isKnownPushEndpoint("fcm:https://evil.example/x")).toBe(false);
    expect(isKnownPushEndpoint("https://evil.example/fcm:" + TOKEN)).toBe(false);
    // The browser endpoints keep working.
    expect(isKnownPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
  });
});

describe("service account JWT", () => {
  it("parses the Firebase key file and rejects anything else", async () => {
    const { json } = await makeServiceAccount();
    expect(parseServiceAccount(json)?.projectId).toBe("spendrr-test");
    expect(parseServiceAccount("{}")).toBeNull();
    expect(parseServiceAccount("not json")).toBeNull();
  });

  it("builds an RS256 JWT with the FCM scope, verifiable with the key", async () => {
    const { json, publicKey } = await makeServiceAccount();
    const sa = parseServiceAccount(json)!;
    const jwt = await buildServiceAccountJwt(sa, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c)))).toEqual({
      iss: sa.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlDecode(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});

describe("FCM message", () => {
  it("routes payments and expiry nudges to separate channels and tags", () => {
    const pay = buildFcmMessage(TOKEN, { title: "Spendrr", body: "Přijatá platba" }) as {
      message: { token: string; android: { notification: { channel_id: string; tag: string } }; data: { type: string } };
    };
    expect(pay.message.token).toBe(TOKEN);
    expect(pay.message.android.notification.channel_id).toBe("payments");
    expect(pay.message.android.notification.tag).toBe("spendrr-payment");
    expect(pay.message.data.type).toBe("payment");
    const exp = buildFcmMessage(TOKEN, { title: "Spendrr", body: "x", type: "expiry" }) as typeof pay;
    expect(exp.message.android.notification.channel_id).toBe("expiry");
    expect(exp.message.android.notification.tag).toBe("spendrr-expiry");
  });

  it("drops a subscription only for a token that is gone or invalid", () => {
    expect(fcmShouldDeleteSubscription(404, '{"error":{"status":"NOT_FOUND"}}')).toBe(true);
    expect(fcmShouldDeleteSubscription(400, "The registration token is not a valid FCM registration token")).toBe(
      true,
    );
    expect(fcmShouldDeleteSubscription(400, "Invalid JSON payload")).toBe(false);
    expect(fcmShouldDeleteSubscription(500, "")).toBe(false);
    expect(fcmShouldDeleteSubscription(429, "")).toBe(false);
    expect(fcmShouldDeleteSubscription(401, "")).toBe(false);
  });
});

describe("sendFcm", () => {
  beforeEach(() => resetFcmTokenCacheForTests());
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges the JWT once and reuses the access token", async () => {
    const { json } = await makeServiceAccount();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        expect(String(init.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
      }
      expect(url).toBe("https://fcm.googleapis.com/v1/projects/spendrr-test/messages:send");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer ya29.test");
      return new Response("{}");
    });
    expect((await sendFcm(json, `fcm:${TOKEN}`, { title: "Spendrr", body: "a" })).ok).toBe(true);
    expect((await sendFcm(json, `fcm:${TOKEN}`, { title: "Spendrr", body: "b" })).ok).toBe(true);
    expect(calls.filter((u) => u.includes("oauth2")).length).toBe(1);
  });

  it("reports an unregistered token for deletion", async () => {
    const { json } = await makeServiceAccount();
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        : new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 }),
    );
    const r = await sendFcm(json, `fcm:${TOKEN}`, { title: "Spendrr", body: "a" });
    expect(r).toEqual({ ok: false, status: 404, shouldDeleteSubscription: true });
  });

  it("sends nothing without a service account", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendFcm(undefined, `fcm:${TOKEN}`, { title: "Spendrr", body: "a" });
    expect(r.ok).toBe(false);
    expect(r.shouldDeleteSubscription).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
