// The sealed reminder text (src/lib/chat/reminderBlob.ts): opens only with its
// key, always the same size, and the amount survives any name or note.
import { describe, expect, it } from "vitest";
import { b64urlDecode } from "../src/lib/chat/pushFormat";
import { newReminderKey, nextReminder, openReminder, REMINDER_PAD, sealReminder } from "../src/lib/chat/reminderBlob";

const base = { v: 1 as const, id: "sched-1", s: 5000, t: 1_700_000_000 };

describe("reminder blob", () => {
  it("round-trips and is one size whatever the text", async () => {
    const key = await newReminderKey();
    const short = await sealReminder(key, { ...base, n: "pavel" });
    const long = await sealReminder(key, { ...base, n: "pavel", o: "nájem za byt a ještě něco navíc" });
    expect(b64urlDecode(short).length).toBe(b64urlDecode(long).length);
    expect(b64urlDecode(short).length).toBe(12 + REMINDER_PAD + 16);
    expect(await openReminder(key, short)).toMatchObject({ id: "sched-1", s: 5000, n: "pavel" });
    expect(await openReminder(key, long)).toMatchObject({ o: "nájem za byt a ještě něco navíc" });
  });

  it("does not open under another key or when altered", async () => {
    const key = await newReminderKey();
    const blob = await sealReminder(key, base);
    expect(await openReminder(await newReminderKey(), blob)).toBeNull();
    const bytes = b64urlDecode(blob);
    bytes[20] ^= 1;
    expect(await openReminder(key, btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))).toBeNull();
    expect(await openReminder(key, "short")).toBeNull();
  });

  it("keeps the amount when wide text would not fit the pad", async () => {
    const key = await newReminderKey();
    const wide = "漢".repeat(60);
    const opened = await openReminder(key, await sealReminder(key, { ...base, n: wide, o: wide }));
    expect(opened).toMatchObject({ id: "sched-1", s: 5000 });
  });
});

describe("nextReminder", () => {
  const now = 1_000_000;
  it("takes the soonest one still ahead and skips overdue and imminent ones", () => {
    const list = [{ nextDue: now - 1000 }, { nextDue: now + 10_000 }, { nextDue: now + 90_000 }, { nextDue: now + 60_000 }];
    expect(nextReminder(list, now)).toEqual({ nextDue: now + 60_000 });
    expect(nextReminder([{ nextDue: now - 5 }], now)).toBeNull();
    expect(nextReminder([], now)).toBeNull();
    expect(nextReminder([{ nextDue: Number.NaN }], now)).toBeNull();
  });
});

describe("reminderSignature", () => {
  it("is a keyed digest: changes with the reminder, never contains its text", async () => {
    const { reminderSignature } = await import("../src/lib/chat/reminderSync");
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const s = { id: "sched-1", nextDue: 5, sats: 5000, note: "nájem za byt", peer: "peerkey" };
    const a = await reminderSignature(s, "pavel", "https://push/x", key);
    expect(a).not.toContain("pavel");
    expect(a).not.toContain("nájem");
    expect(a).not.toContain("5000");
    expect(await reminderSignature(s, "pavel", "https://push/x", key)).toBe(a);
    expect(await reminderSignature({ ...s, sats: 6000 }, "pavel", "https://push/x", key)).not.toBe(a);
    const other = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(await reminderSignature(s, "pavel", "https://push/x", other)).not.toBe(a);
  });
});
