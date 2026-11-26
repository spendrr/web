import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function stubStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });
  return m;
}

describe("chat defaults", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("chat and read receipts are on, push is off, with nothing stored", async () => {
    stubStorage();
    const c = await import("../src/lib/chat/chatEnabled");
    expect(c.isChatEnabled()).toBe(true);
    expect(c.isReadReceiptsOn()).toBe(true);
    expect(c.isChatPushOn()).toBe(false);
  });
  it("turning a switch off sticks, turning it on again clears it", async () => {
    const m = stubStorage();
    const c = await import("../src/lib/chat/chatEnabled");
    c.setChatEnabled(false);
    c.setReadReceiptsOn(false);
    expect(c.isChatEnabled()).toBe(false);
    expect(c.isReadReceiptsOn()).toBe(false);
    c.setChatEnabled(true);
    c.setReadReceiptsOn(true);
    expect(c.isChatEnabled()).toBe(true);
    expect(c.isReadReceiptsOn()).toBe(true);
    expect(m.size).toBe(0);
  });
  it("an earlier explicit on still reads as on", async () => {
    const m = stubStorage();
    m.set("spendrr-chat-enabled-v1", "1");
    m.set("spendrr-chat-read-receipts-v1", "1");
    const c = await import("../src/lib/chat/chatEnabled");
    expect(c.isChatEnabled()).toBe(true);
    expect(c.isReadReceiptsOn()).toBe(true);
  });
  it("blocked storage reads as the defaults", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    const c = await import("../src/lib/chat/chatEnabled");
    expect(c.isChatEnabled()).toBe(true);
    expect(c.isReadReceiptsOn()).toBe(true);
    expect(c.isChatPushOn()).toBe(false);
  });
});
