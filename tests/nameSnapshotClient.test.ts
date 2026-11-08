// lookupName answers "not registered" itself from the published snapshot
// (data.spendrr.app/names.bin) and asks the Worker for everything else, and
// whenever the snapshot cannot be trusted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeNameSnapshot, wrapNameFile } from "../src/lib/names/nameHashSet";
import { lookupName } from "../src/lib/names/names";
import { resetNameSnapshotClient } from "../src/lib/names/nameSnapshotClient";
import { PUBLIC_NAMES_URL } from "../src/lib/publicData";

const REGISTERED = ["alice", "goat", "spendrr"];
const file = (names: string[]) => wrapNameFile(encodeNameSnapshot(names)).buffer as ArrayBuffer;

interface Calls {
  names: string[];
  snapshot: number;
}

// names.bin answers with `snapshot()`, /api/names/<x> with the Worker's answer.
function stubFetch(snapshot: () => Promise<Response>) {
  const calls: Calls = { names: [], snapshot: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === PUBLIC_NAMES_URL) {
        calls.snapshot++;
        return snapshot();
      }
      calls.names.push(decodeURIComponent(String(url).replace("/api/names/", "")));
      const name = decodeURIComponent(String(url).replace("/api/names/", ""));
      return REGISTERED.includes(name)
        ? new Response(JSON.stringify({ name, address: "ark1x" }), { status: 200 })
        : new Response(JSON.stringify({ status: "free" }), { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
  resetNameSnapshotClient();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("lookupName with the published snapshot", () => {
  it("says free for a name that is not in it, without asking the Worker", async () => {
    const calls = stubFetch(async () => new Response(file(REGISTERED)));
    expect(await lookupName("snapx1")).toEqual({ kind: "absent", status: "free" });
    expect(await lookupName("snapx2")).toEqual({ kind: "absent", status: "free" });
    expect(calls.names).toEqual([]);
    expect(calls.snapshot).toBe(1); // one copy serves both
  });

  it("says reserved for a name on the static list that nobody holds", async () => {
    const calls = stubFetch(async () => new Response(file(REGISTERED)));
    expect(await lookupName("admin")).toEqual({ kind: "absent", status: "reserved" });
    expect(calls.names).toEqual([]);
  });

  it("asks the Worker about a name that is in it, and takes the Worker's answer", async () => {
    const calls = stubFetch(async () => new Response(file(REGISTERED)));
    expect(await lookupName("goat")).toMatchObject({ kind: "found", name: "goat", address: "ark1x" });
    expect(calls.names).toEqual(["goat"]);
  });

  it("answers an invalid name itself, before anything is fetched", async () => {
    const calls = stubFetch(async () => new Response(file(REGISTERED)));
    expect(await lookupName("a")).toEqual({ kind: "absent", status: "invalid" });
    expect(calls.snapshot).toBe(0);
    expect(calls.names).toEqual([]);
  });
});

describe("when the snapshot cannot be trusted the Worker is asked, as before", () => {
  it("no copy published (404)", async () => {
    const calls = stubFetch(async () => new Response("no", { status: 404 }));
    await lookupName("nocopy1");
    expect(calls.names).toEqual(["nocopy1"]);
  });

  it("a file that is not the snapshot (no tag), an empty one, one with no names", async () => {
    for (const body of [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), new Uint8Array(), wrapNameFile(new Uint8Array())]) {
      resetNameSnapshotClient();
      const calls = stubFetch(async () => new Response(body.buffer as ArrayBuffer));
      await lookupName("garbage1");
      expect(calls.names).toEqual(["garbage1"]);
    }
  });

  it("an HTML page where the file should be", async () => {
    const calls = stubFetch(async () => new Response("<html>spendrr</html>", { status: 200 }));
    await lookupName("htmlpage1");
    expect(calls.names).toEqual(["htmlpage1"]);
  });

  it("a fetch that hangs holds a lookup for 1.5 s at most", async () => {
    const calls = stubFetch(() => new Promise<Response>(() => {}));
    const pending = lookupName("hang1");
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls.names).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(calls.names).toEqual(["hang1"]);
  });

  it("a failed fetch is not repeated for every lookup", async () => {
    const calls = stubFetch(async () => new Response("no", { status: 500 }));
    await lookupName("fail1");
    await lookupName("fail2");
    await lookupName("fail3");
    expect(calls.snapshot).toBe(1);
    expect(calls.names).toEqual(["fail1", "fail2", "fail3"]);
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    await lookupName("fail4");
    expect(calls.snapshot).toBe(2);
  });
});

describe("how long a copy is used", () => {
  it("refetches after a minute, and a registered-since name is then asked about", async () => {
    let names = REGISTERED;
    const calls = stubFetch(async () => new Response(file(names)));
    expect(await lookupName("newbie1")).toEqual({ kind: "absent", status: "free" });
    names = [...REGISTERED, "newbie1"];
    await vi.advanceTimersByTimeAsync(61_000);
    // the old copy answers at once while the new one is fetched in the background
    expect(await lookupName("newbie1")).toEqual({ kind: "absent", status: "free" });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.snapshot).toBe(2);
    await lookupName("newbie1");
    expect(calls.names).toEqual(["newbie1"]);
  });

  it("an old copy still answers while a refresh fails, up to ten minutes, then the Worker is asked", async () => {
    let ok = true;
    const calls = stubFetch(async () => (ok ? new Response(file(REGISTERED)) : new Response("no", { status: 500 })));
    await lookupName("stale1");
    ok = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await lookupName("stale2")).toEqual({ kind: "absent", status: "free" });
    expect(calls.names).toEqual([]);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await lookupName("stale3");
    expect(calls.names).toEqual(["stale3"]);
  });
});
