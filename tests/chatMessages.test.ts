import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { deriveChatKey } from "../src/lib/chat/chatKey";
import {
  MAX_TEXT_CHARS,
  clampText,
  fallbackText,
  messageFromRumor,
  parsePayload,
  payloadTags,
  reactionTags,
  replyTags,
} from "../src/lib/chat/messages";
import { KIND_CHAT, KIND_REACTION, makeRumor, publicKeyOf } from "../src/lib/chat/nostr";
import { detectRecurrence, nextDue } from "../src/lib/chat/recurrence";
import { arrivedNotes, noteMovements } from "../src/lib/chat/arrived";
import { contactPayments, unannouncedSends } from "../src/lib/chat/chatHistory";
import { parseSignal, signalContent } from "../src/lib/chat/signals";
import { buildBackup, mergeBackup, parseBackup, type ChatBackup } from "../src/lib/chat/chatBackup";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("chat key", () => {
  it("is deterministic, valid and pinned for a known mnemonic", async () => {
    const a = await deriveChatKey(MNEMONIC);
    const b = await deriveChatKey(MNEMONIC);
    expect(a).toEqual(b);
    expect(secp256k1.utils.isValidSecretKey(a)).toBe(true);
    // Pinned: a change here gives every user a new chat identity (see chatKey.ts).
    expect(publicKeyOf(a)).toMatchInlineSnapshot(`"1987cf9588841f639dd48378a8a73d56e5edee9e090bb04877498fae9edce552"`);
  });

  it("differs per mnemonic", async () => {
    const other = await deriveChatKey("legal winner thank year wave sausage worth useful legal winner thank yellow");
    expect(other).not.toEqual(await deriveChatKey(MNEMONIC));
  });
});

describe("payloads", () => {
  it("round trips through tags and keeps readable content", () => {
    const p = { t: "payment" as const, sats: 5000, to: "ark1qqq", note: "za pivo" };
    const rumor = makeRumor(publicKeyOf(secp256k1.utils.randomSecretKey()), KIND_CHAT, fallbackText(p), payloadTags(p));
    const m = messageFromRumor(rumor);
    expect(m?.payload).toEqual(p);
    expect(m?.text).toBe("Poslal(a) 5 000 sats: za pivo");
  });

  it("rejects malformed payloads", () => {
    expect(parsePayload({ t: "payment", sats: -1, to: "x" })).toBeNull();
    expect(parsePayload({ t: "payment", sats: 1.5, to: "x" })).toBeNull();
    expect(parsePayload({ t: "request", sats: 10, every: { unit: "minute", n: 1 } })).toBeNull();
    expect(parsePayload({ t: "request-reply", ref: "nothex", accept: true })).toBeNull();
    expect(parsePayload({ t: "unknown" })).toBeNull();
    expect(parsePayload("x")).toBeNull();
  });

  it("broken payload JSON degrades to text", () => {
    const rumor = makeRumor(publicKeyOf(secp256k1.utils.randomSecretKey()), KIND_CHAT, "ahoj", [["spendrr", "1", "{"]]);
    expect(messageFromRumor(rumor)).toMatchObject({ text: "ahoj", payload: null });
  });

  it("clamps text by code points and strips control characters", () => {
    expect([...clampText("😀".repeat(600))].length).toBe(MAX_TEXT_CHARS);
    expect(MAX_TEXT_CHARS).toBe(500);
    expect(clampText("a\nb\u0007c")).toBe("a b c");
  });
});

describe("recurrence", () => {
  it.each([
    ["send every week", { kind: "send", every: { unit: "week", n: 1 } }],
    ["pošli každý týden", { kind: "send", every: { unit: "week", n: 1 } }],
    ["posílej měsíčně", { kind: "send", every: { unit: "month", n: 1 } }],
    ["Send every 13 days", { kind: "send", every: { unit: "day", n: 13 } }],
    ["request every month", { kind: "request", every: { unit: "month", n: 1 } }],
    ["chci každý měsíc", { kind: "request", every: { unit: "month", n: 1 } }],
    ["chci každé 2 týdny", { kind: "request", every: { unit: "week", n: 2 } }],
    ["pay daily", { kind: "send", every: { unit: "day", n: 1 } }],
    ["poslat každý měsíc", { kind: "send", every: { unit: "month", n: 1 } }],
    ["pošli mu 500 sats každý týden", { kind: "send", every: { unit: "week", n: 1 } }],
  ])("%s", (text, expected) => {
    expect(detectRecurrence(text)).toEqual(expected);
  });

  it.each([
    "send every minute",
    "ahoj, jak se máš",
    "every week",
    "pošli a chci každý týden",
    "pošli mi to každý týden, jo? a nezapomeň na to prosím tě",
  ])("no chip: %s", (text) => {
    expect(detectRecurrence(text)).toBeNull();
  });

  it("calendar months clamp to the last day", () => {
    const jan31 = new Date(2027, 0, 31, 12).getTime();
    expect(new Date(nextDue(jan31, { unit: "month", n: 1 })).getDate()).toBe(28);
  });
});

describe("payment note attribution", () => {
  const addr = "ark1qqq";
  const at = 1_800_000_000;
  const receipt = {
    id: 7,
    effectiveBalanceSats: 5000,
    receivedOnAddresses: [addr],
    sentToAddresses: [] as string[],
    createdAt: new Date(at * 1000).toISOString(),
  };
  const note = (id: string, from: string) => ({
    id,
    from,
    peer: from,
    createdAt: at + 30,
    text: "",
    outgoing: false,
    payload: { t: "payment" as const, sats: 5000, to: addr },
  });

  it("confirms a note with a unique matching receipt", () => {
    expect(arrivedNotes([note("a".repeat(64), "p")], [receipt])).toEqual(new Set(["a".repeat(64)]));
  });

  it("confirms neither when two notes claim the same receipt", () => {
    expect(arrivedNotes([note("a".repeat(64), "petr"), note("b".repeat(64), "mallory")], [receipt]).size).toBe(0);
  });

  it("needs amount, address and time to match", () => {
    expect(arrivedNotes([note("a".repeat(64), "p")], [{ ...receipt, effectiveBalanceSats: 4999 }]).size).toBe(0);
    expect(arrivedNotes([note("a".repeat(64), "p")], [{ ...receipt, receivedOnAddresses: ["ark1other"] }]).size).toBe(0);
    const late = { ...receipt, createdAt: new Date((at + 7200) * 1000).toISOString() };
    expect(arrivedNotes([note("a".repeat(64), "p")], [late]).size).toBe(0);
  });

  it("reads addresses the SDK returns as tagged JSON", () => {
    const tagged = { ...receipt, receivedOnAddresses: [JSON.stringify({ type: "ark", address: addr })] };
    expect(arrivedNotes([note("a".repeat(64), "p")], [tagged]).size).toBe(1);
  });

  it("falls back to amount and time when the receipt has no readable address", () => {
    expect(arrivedNotes([note("a".repeat(64), "p")], [{ ...receipt, receivedOnAddresses: [] }]).size).toBe(1);
    expect(arrivedNotes([note("a".repeat(64), "p"), note("b".repeat(64), "m")], [{ ...receipt, receivedOnAddresses: [] }]).size).toBe(0);
  });

  it("ties our own note to what we sent, fee included", () => {
    const sent = { ...receipt, id: 9, effectiveBalanceSats: -5010, receivedOnAddresses: [], sentToAddresses: [addr] };
    const ours = { ...note("c".repeat(64), "p"), outgoing: true };
    expect(noteMovements([ours], [sent])).toEqual(new Map([["c".repeat(64), 9]]));
    expect(noteMovements([ours], [{ ...sent, sentToAddresses: ["ark1else"] }]).size).toBe(0);
    // An incoming note never claims an outgoing movement and vice versa.
    expect(noteMovements([note("a".repeat(64), "p")], [sent]).size).toBe(0);
    expect(noteMovements([ours], [receipt]).size).toBe(0);
  });
});

describe("message lengths", () => {
  it("keeps a long text but cuts a payment note to the note limit", () => {
    const long = "x".repeat(400);
    expect(messageFromRumor(makeRumor("b".repeat(64), KIND_CHAT, long, []))?.text).toBe(long);
    const tags = payloadTags({ t: "payment", sats: 1, to: "ark1x", note: "y".repeat(200) });
    expect(messageFromRumor(makeRumor("b".repeat(64), KIND_CHAT, "", tags))?.payload).toMatchObject({ note: "y".repeat(80) });
  });
});

describe("live signals", () => {
  it("accepts only the known shapes", () => {
    expect(parseSignal('{"t":"typing","what":"amount"}')).toEqual({ t: "typing", what: "amount" });
    expect(parseSignal('{"t":"read","upTo":1800000000}')).toEqual({ t: "read", upTo: 1800000000 });
    expect(parseSignal('{"t":"stop"}')).toEqual({ t: "stop" });
    expect(parseSignal('{"t":"typing","what":"video"}')).toBeNull();
    expect(parseSignal('{"t":"read","upTo":-1}')).toBeNull();
    expect(parseSignal("nope")).toBeNull();
    expect(parseSignal(signalContent({ t: "stop" }) + " ".repeat(300))).toBeNull();
  });
});

describe("contact payments", () => {
  const peer = "e".repeat(64);
  const at = 1_800_000_000;
  const iso = (s: number) => new Date(s * 1000).toISOString();
  it("counts sends to their address and chat-noted receipts, newest first", () => {
    const history = [
      { id: 1, effectiveBalanceSats: -1000, sentToAddresses: ["ark1them"], receivedOnAddresses: [], createdAt: iso(at) },
      { id: 2, effectiveBalanceSats: 700, sentToAddresses: [], receivedOnAddresses: ["ark1me"], createdAt: iso(at + 100) },
      { id: 3, effectiveBalanceSats: -50, sentToAddresses: ["ark1else"], receivedOnAddresses: [], createdAt: iso(at + 200) },
    ];
    const messages = [
      { id: "f".repeat(64), peer, from: peer, createdAt: at + 110, text: "", outgoing: false, payload: { t: "payment" as const, sats: 700, to: "ark1me", note: "pivo" } },
    ];
    const r = contactPayments(peer, "ark1them", messages, history);
    expect(r.sent).toBe(1000);
    expect(r.received).toBe(700);
    expect(r.items.map((i) => [i.movementId, i.note])).toEqual([
      [2, "pivo"],
      [1, undefined],
    ]);
  });
});

describe("sends outside the chat", () => {
  const peer = "e".repeat(64);
  const at = 1_800_000_000;
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  it("lists sends to their address that no chat note announced", () => {
    const history = [
      { id: 1, effectiveBalanceSats: -1000, sentToAddresses: [JSON.stringify({ type: "ark", address: "ark1them" })], receivedOnAddresses: [], createdAt: iso(at) },
      { id: 2, effectiveBalanceSats: -2000, sentToAddresses: ["ark1them"], receivedOnAddresses: [], createdAt: iso(at + 50) },
      { id: 3, effectiveBalanceSats: -10, sentToAddresses: ["ark1else"], receivedOnAddresses: [], createdAt: iso(at + 60) },
      { id: 4, effectiveBalanceSats: 500, sentToAddresses: [], receivedOnAddresses: ["ark1me"], createdAt: iso(at + 70) },
    ];
    const noted = [
      { id: "f".repeat(64), peer, from: "me", createdAt: at + 55, text: "", outgoing: true, payload: { t: "payment" as const, sats: 2000, to: "ark1them" } },
    ];
    expect(unannouncedSends("ark1them", noted, history)).toEqual([{ movementId: 1, sats: 1000, at }]);
  });
});

describe("reactions and replies", () => {
  const author = "b".repeat(64);
  const target = "c".repeat(64);

  it("reads a NIP-25 reaction by its last e tag", () => {
    const r = messageFromRumor(makeRumor(author, KIND_REACTION, "🔥", [["p", "d".repeat(64)], ...reactionTags(target)]));
    expect(r?.reactTo).toBe(target);
    expect(r?.text).toBe("🔥");
  });

  it("maps + and - and keeps an empty reaction as a take-back", () => {
    expect(messageFromRumor(makeRumor(author, KIND_REACTION, "+", reactionTags(target)))?.text).toBe("👍");
    expect(messageFromRumor(makeRumor(author, KIND_REACTION, "-", reactionTags(target)))?.text).toBe("👎");
    expect(messageFromRumor(makeRumor(author, KIND_REACTION, "", reactionTags(target)))?.text).toBe("");
  });

  it("drops a reaction without a target and clamps a long one", () => {
    expect(messageFromRumor(makeRumor(author, KIND_REACTION, "👍", []))).toBeNull();
    expect([...(messageFromRumor(makeRumor(author, KIND_REACTION, "x".repeat(100), reactionTags(target)))?.text ?? "")].length).toBe(16);
  });

  it("reads a reply's e tag and only writes one for a real id", () => {
    expect(messageFromRumor(makeRumor(author, KIND_CHAT, "jo", replyTags(target)))?.replyTo).toBe(target);
    expect(messageFromRumor(makeRumor(author, KIND_CHAT, "jo", []))?.replyTo).toBeUndefined();
    expect(replyTags("nope")).toEqual([]);
  });
});

describe("chat backup", () => {
  const pk = (c: string) => c.repeat(64);
  const base: ChatBackup = { v: 1, contacts: [], schedules: [], schedulesAt: 0 };

  it("keeps only valid entries and never an address", () => {
    const json = JSON.stringify({
      v: 1,
      schedulesAt: 5,
      contacts: [
        { pubkey: pk("a"), name: "petr", accepted: true, updatedAt: 1, address: "ark1evil" },
        { pubkey: "nothex", accepted: true, updatedAt: 1 },
        { pubkey: pk("b"), name: "NOT A HANDLE!", accepted: false, blocked: true, updatedAt: 2 },
      ],
      schedules: [
        { id: "s1", peer: pk("a"), kind: "send", sats: 1000, every: { unit: "week", n: 1 }, nextDue: 10 },
        { id: "s2", peer: pk("a"), kind: "send", sats: -1, every: { unit: "week", n: 1 }, nextDue: 10 },
      ],
    });
    const b = parseBackup(json);
    expect(b?.contacts).toEqual([
      { pubkey: pk("a"), name: "petr", accepted: true, updatedAt: 1 },
      { pubkey: pk("b"), accepted: false, blocked: true, updatedAt: 2 },
    ]);
    expect(b?.schedules.map((s) => s.id)).toEqual(["s1"]);
    expect(parseBackup("{")).toBeNull();
    expect(parseBackup(JSON.stringify({ ...base, v: 2 }))).toBeNull();
  });

  it("stores chosen contacts only, without addresses, in a stable order", () => {
    const b = buildBackup(
      [
        { pubkey: pk("c"), name: "eva", address: "ark1x", accepted: true, updatedAt: 3 },
        { pubkey: pk("a"), accepted: false, updatedAt: 3 },
        { pubkey: pk("b"), accepted: false, blocked: true, updatedAt: 3 },
      ],
      [],
      0,
    );
    expect(b.contacts).toEqual([
      { pubkey: pk("b"), accepted: false, blocked: true, updatedAt: 3 },
      { pubkey: pk("c"), name: "eva", accepted: true, updatedAt: 3 },
    ]);
  });

  it("stays under the NIP-44 size limit by dropping blocked strangers first", () => {
    const blocked = Array.from({ length: 2000 }, (_, i) => ({
      pubkey: i.toString(16).padStart(64, "0"),
      accepted: false,
      blocked: true,
      updatedAt: i,
    }));
    const b = buildBackup([{ pubkey: pk("f"), name: "petr", accepted: true, updatedAt: 1 }, ...blocked], [], 0);
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(60_000);
    expect(b.contacts.some((c) => c.name === "petr")).toBe(true);
  });

  it("merges per contact by the newer edit and asks for addresses again", () => {
    const local = {
      [pk("a")]: { pubkey: pk("a"), name: "petr", address: "ark1p", accepted: true, updatedAt: 10 },
      [pk("b")]: { pubkey: pk("b"), name: "eva", address: "ark1e", accepted: true, updatedAt: 1 },
    };
    const remote: ChatBackup = {
      ...base,
      contacts: [
        { pubkey: pk("a"), name: "petr", accepted: false, blocked: true, updatedAt: 5 },
        { pubkey: pk("b"), name: "eva2", accepted: true, updatedAt: 7 },
        { pubkey: pk("c"), name: "jan", accepted: true, updatedAt: 7 },
      ],
    };
    const m = mergeBackup(local, [], 0, remote);
    expect(m.contacts[pk("a")]).toEqual(local[pk("a")]);
    expect(m.contacts[pk("b")]).toEqual({ pubkey: pk("b"), name: "eva2", accepted: true, updatedAt: 7 });
    expect(m.contacts[pk("c")]).toEqual({ pubkey: pk("c"), name: "jan", accepted: true, updatedAt: 7 });
    expect(m.needsAddress).toEqual([
      { pubkey: pk("b"), name: "eva2" },
      { pubkey: pk("c"), name: "jan" },
    ]);
  });

  it("carries the verified mark through a backup round trip", () => {
    const built = buildBackup([{ pubkey: pk("a"), name: "petr", accepted: true, verified: true, updatedAt: 4 }], [], 0);
    const parsed = parseBackup(JSON.stringify(built));
    expect(parsed?.contacts[0]).toEqual({ pubkey: pk("a"), name: "petr", accepted: true, verified: true, updatedAt: 4 });
    const merged = mergeBackup({}, [], 0, parsed as ChatBackup);
    expect(merged.contacts[pk("a")].verified).toBe(true);
  });

  it("takes the newer schedule list as a whole", () => {
    const s = { id: "s", peer: pk("a"), kind: "send" as const, sats: 1, every: { unit: "day" as const, n: 1 }, nextDue: 1 };
    expect(mergeBackup({}, [], 0, { ...base, schedules: [s], schedulesAt: 3 }).schedules).toEqual([s]);
    expect(mergeBackup({}, [], 9, { ...base, schedules: [s], schedulesAt: 3 }).schedules).toEqual([]);
  });
});

describe("chat key stays out of curve libraries", () => {
  it("chatKey.ts does not import @noble (it runs next to the mnemonic)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/lib/chat/chatKey.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["']@noble/);
  });
});
