import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { messageFromRumor } from "../src/lib/chat/messages";
import {
  b64urlEncode,
  clampPreviewText,
  controlContent,
  importPreviewKey,
  openBlob,
  KIND_PUSH_CONTROL,
  parseControl,
  pokeDelay,
  POKE_WINDOW_MS,
  PRESENT_MS,
  previewFor,
  randomSlot,
  sealBlob,
  type BlobBody,
} from "../src/lib/chat/pushFormat";

type SwChat = {
  openBlob(key: CryptoKey, blob: string): Promise<BlobBody | null>;
  describe(body: Partial<BlobBody>, name: string | null, level: string, count: number): { title: string; body: string };
};

// The Service Worker's half, loaded the way sw.js loads it.
function loadSwChat(): SwChat {
  const self: { spendrrChatPush?: SwChat } = {};
  runInNewContext(readFileSync("public/sw-chat.js", "utf8"), { self, crypto, atob, TextEncoder, TextDecoder, Number });
  return self.spendrrChatPush!;
}

const TOKEN = "c1." + "A".repeat(600);
const KEY = b64urlEncode(new Uint8Array(32).fill(7));

async function keys() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { enc: await importPreviewKey(raw, "encrypt"), dec: await importPreviewKey(raw, "decrypt") };
}

describe("push control messages", () => {
  it("accepts grants, revokes and asks", () => {
    const grant = { t: "grant" as const, token: TOKEN, key: KEY, preview: "text" as const };
    expect(parseControl(controlContent(grant))).toEqual(grant);
    expect(parseControl(controlContent({ t: "revoke" }))).toEqual({ t: "revoke" });
    expect(parseControl(controlContent({ t: "ask" }))).toEqual({ t: "ask" });
  });

  it("refuses anything malformed", () => {
    expect(parseControl("nope")).toBeNull();
    expect(parseControl(JSON.stringify({ t: "grant", token: "x", key: KEY, preview: "text" }))).toBeNull();
    expect(parseControl(JSON.stringify({ t: "grant", token: TOKEN, key: "short", preview: "text" }))).toBeNull();
    expect(parseControl(JSON.stringify({ t: "grant", token: TOKEN, key: KEY, preview: "all" }))).toBeNull();
    expect(parseControl(JSON.stringify({ t: "other" }))).toBeNull();
    expect(parseControl("x".repeat(3000))).toBeNull();
  });
});

describe("preview levels", () => {
  const full = { k: "request" as const, s: 500, o: "oběd", c: 2 };
  it("sends only what the recipient wants to see", () => {
    expect(previewFor("text", full)).toEqual(full);
    expect(previewFor("name", full)).toEqual({ k: "request", c: 2 });
    expect(previewFor("none", full)).toEqual({ k: "text", c: 2 });
    expect(previewFor("name", { k: "text", x: "ahoj", c: 1 })).toEqual({ k: "text", c: 1 });
  });

  it("shortens long text", () => {
    expect(clampPreviewText("  a\n\nb  ")).toBe("a b");
    const long = clampPreviewText("x".repeat(500));
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("preview blob", () => {
  it("round-trips, and the Service Worker opens it too", async () => {
    const { enc, dec } = await keys();
    const body: BlobBody = { v: 1, n: 5, t: 1_700_000_000, k: "text", x: "Platíš dnes ten oběd? 🍕", c: 1 };
    const blob = await sealBlob(enc, body);
    expect(await openBlob(dec, blob)).toEqual(body);
    expect(await loadSwChat().openBlob(dec, blob)).toEqual(body);
  });

  it("does not open under another contact's key", async () => {
    const a = await keys();
    const b = await keys();
    const blob = await sealBlob(a.enc, { v: 1, n: 1, t: 1, k: "text", c: 1 });
    expect(await openBlob(b.dec, blob)).toBeNull();
    expect(await loadSwChat().openBlob(b.dec, blob)).toBeNull();
  });

  it("hides the length of the message", async () => {
    const { enc } = await keys();
    const short = await sealBlob(enc, { v: 1, n: 1, t: 1, k: "text", x: "ok", c: 1 });
    const longer = await sealBlob(enc, { v: 1, n: 1, t: 1, k: "text", x: "x".repeat(100), c: 1 });
    expect(short.length).toBe(longer.length);
  });

  it("stays within what the Worker accepts, even for wide text", async () => {
    const { enc, dec } = await keys();
    const wide = "𝓧".repeat(120);
    const blob = await sealBlob(enc, { v: 1, n: 1, t: 1, k: "payment", x: wide, s: 21_000_000, o: "𝓧".repeat(80), c: 99 });
    expect(blob.length).toBeLessThanOrEqual(1024);
    const opened = await openBlob(dec, blob);
    expect(opened?.k).toBe("payment");
  });

  it("makes random slots", () => {
    expect(randomSlot()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSlot()).not.toBe(randomSlot());
  });
});

describe("Service Worker text", () => {
  const sw = loadSwChat();
  it("shows name and text at full preview", () => {
    expect(sw.describe({ k: "text", x: "ahoj" }, "pepa", "text", 1)).toEqual({ title: "@pepa", body: "ahoj" });
    expect(sw.describe({ k: "request", s: 500, o: "oběd" }, "pepa", "text", 3)).toEqual({ title: "@pepa (3)", body: "Žádost 500 sats · oběd" });
    expect(sw.describe({ k: "payment", s: 1500 }, "pepa", "text", 1).body).toBe("Platba 1 500 sats");
  });

  it("applies the device's own level whatever the blob carries", () => {
    expect(sw.describe({ k: "text", x: "tajné" }, "pepa", "name", 1)).toEqual({ title: "@pepa", body: "Nová zpráva" });
    expect(sw.describe({ k: "request", s: 500 }, "pepa", "name", 1).body).toBe("Žádost");
    expect(sw.describe({ k: "text", x: "tajné" }, "pepa", "none", 1)).toEqual({ title: "Spendrr", body: "Nová zpráva" });
    expect(sw.describe({ k: "text", x: "ahoj" }, null, "text", 1).title).toBe("Spendrr");
  });
});

describe("when to poke", () => {
  const now = 1_000_000_000;
  it("stays quiet while the contact is in the chat", () => {
    expect(pokeDelay(now, now - 10_000, 0)).toBeNull();
    expect(pokeDelay(now, now - PRESENT_MS + 1, 0)).toBeNull();
  });
  it("pokes at once, then at most once a window", () => {
    expect(pokeDelay(now, 0, 0)).toBe(0);
    expect(pokeDelay(now, 0, now - 20_000)).toBe(POKE_WINDOW_MS - 20_000);
    expect(pokeDelay(now, 0, now - POKE_WINDOW_MS - 1)).toBe(0);
  });
});

describe("control messages and older clients", () => {
  it("is never read as a chat message", () => {
    const rumor = { id: "a".repeat(64), pubkey: "b".repeat(64), created_at: 1, kind: KIND_PUSH_CONTROL, tags: [["p", "c".repeat(64)]], content: controlContent({ t: "ask" }) };
    expect(messageFromRumor(rumor)).toBeNull();
  });
});
