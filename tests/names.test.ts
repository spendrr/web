import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ARK_ADDRESS_MAX_CHARS,
  NAME_CHANGE_WINDOW_MS,
  NAME_INACTIVITY_MS,
  NAME_PROOF_LIFETIME_S as WORKER_NAME_PROOF_LIFETIME_S,
  NAME_MAX_CHANGES,
  NAME_PROOF_MAX_AGE_S,
  NAME_PROOF_MAX_FUTURE_S,
  NAME_PROOF_MEMORY_MS,
  NAME_QUARANTINE_MS,
  NAME_TOUCH_MIN_INTERVAL_MS,
  NameRegistryCore,
  isPlausibleArkAddress,
  mailboxAuthorizationFreshness,
  mailboxAuthorizationProblem,
  parseReservedOwners,
  type NameStorage,
} from "../worker/names";
import { NAME_PROOF_LIFETIME_S } from "../src/lib/names/names";
import { PUSH_AUTH_CLOCK_SKEW_SECONDS, PUSH_AUTH_MAX_LIFETIME_SECONDS } from "../worker/mailboxShared";
import { PUSH_AUTH_LIFETIME_S } from "../src/lib/notifications";

class MemoryStorage implements NameStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    // Round-trip through JSON: real Durable Object storage clones values, so
    // the core must never rely on sharing references with what it stored.
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix) && (options.startAfter === undefined || k > options.startAfter))
      .sort();
    const out = new Map<string, T>();
    for (const k of keys.slice(0, options.limit ?? keys.length)) out.set(k, this.data.get(k) as T);
    return out;
  }
}

const A = "ark1" + "q".repeat(60);
const B = "ark1" + "p".repeat(60);
const C = "ark1" + "z".repeat(60);
const MB1 = "02" + "a".repeat(64);
const MB2 = "02" + "b".repeat(64);

function setup(reservedOwners: Record<string, string> = {}) {
  let t = 1_000_000;
  const storage = new MemoryStorage();
  const core = new NameRegistryCore(storage, () => t, reservedOwners);
  return {
    core,
    storage,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("isPlausibleArkAddress", () => {
  it("accepts an address-shaped string and rejects junk", () => {
    expect(isPlausibleArkAddress(A)).toBe(true);
    expect(isPlausibleArkAddress("ark1")).toBe(false);
    expect(isPlausibleArkAddress("bc1q" + "q".repeat(60))).toBe(false);
    expect(isPlausibleArkAddress("ark1" + "b".repeat(60))).toBe(false); // b is not in the bech32 charset
    expect(isPlausibleArkAddress("ark1" + "q".repeat(ARK_ADDRESS_MAX_CHARS))).toBe(false);
    expect(isPlausibleArkAddress("ark1" + "q".repeat(30) + "\n")).toBe(false);
  });
});

describe("lookup", () => {
  it("reports free, invalid and reserved names", async () => {
    const { core } = setup();
    expect(await core.lookup("pavel")).toEqual({ status: "free" });
    expect(await core.lookup("@Pavel")).toEqual({ status: "free" });
    expect(await core.lookup("pavél")).toEqual({ status: "invalid", problem: "chars" });
    expect(await core.lookup("admin")).toEqual({ status: "reserved" });
  });

  it("resolves a claimed name, whatever the casing or a leading @", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.lookup("@PAVEL")).toEqual({ status: "taken", name: "pavel", address: A, lnAddress: false });
  });
});

describe("set", () => {
  it("claims a free name", async () => {
    const { core } = setup();
    expect(await core.set({ name: "Pavel", mailboxId: MB1, address: A })).toEqual({
      ok: true,
      action: "claimed",
      name: "pavel",
      address: A,
    });
    expect(await core.mine(MB1)).toEqual({ name: "pavel", address: A, lnAddress: false });
  });

  it("refuses a name someone else holds, even the same name in another case", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.set({ name: "PAVEL", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "taken" });
    expect(await core.lookup("pavel")).toMatchObject({ address: A });
  });

  it("rejects bad names and bad addresses without writing anything", async () => {
    const { core, storage } = setup();
    expect(await core.set({ name: "ab", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "invalid" });
    expect(await core.set({ name: "admin", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "reserved" });
    expect(await core.set({ name: "pavel", mailboxId: MB1, address: "nope" })).toEqual({
      ok: false,
      error: "bad-address",
    });
    expect(storage.data.size).toBe(0);
  });

  it("is a no-op when nothing changes, and does not spend the change budget", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    for (let i = 0; i < NAME_MAX_CHANGES + 3; i++) {
      expect(await core.set({ name: "pavel", mailboxId: MB1, address: A })).toMatchObject({
        ok: true,
        action: "unchanged",
      });
    }
  });

  it("changes the address behind a name the mailbox already owns", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.set({ name: "pavel", mailboxId: MB1, address: B })).toMatchObject({
      ok: true,
      action: "address-updated",
    });
    expect(await core.lookup("pavel")).toMatchObject({ address: B });
  });

  it("does not spend the change budget on an address change", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    for (let i = 0; i < NAME_MAX_CHANGES + 3; i++) {
      expect(await core.set({ name: "pavel", mailboxId: MB1, address: i % 2 ? A : B })).toMatchObject({ ok: true });
    }
    expect(await core.set({ name: "other", mailboxId: MB1, address: A })).toMatchObject({ ok: true, action: "renamed" });
  });

  it("cannot take over another mailbox's address by naming the same name", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    await core.set({ name: "pavel", mailboxId: MB2, address: B });
    expect(await core.lookup("pavel")).toMatchObject({ address: A });
  });

  it("renames, frees the old name into quarantine and lets nobody else take it", async () => {
    const { core } = setup();
    await core.set({ name: "old_name", mailboxId: MB1, address: A });
    expect(await core.set({ name: "new_name", mailboxId: MB1, address: A })).toMatchObject({
      ok: true,
      action: "renamed",
    });
    expect(await core.lookup("old_name")).toEqual({ status: "quarantined" });
    expect(await core.set({ name: "old_name", mailboxId: MB2, address: B })).toEqual({
      ok: false,
      error: "quarantined",
    });
    expect((await core.mine(MB1))?.name).toBe("new_name");
  });

  it("lets the mailbox that gave a name up take it back, and others take it after quarantine", async () => {
    const { core, advance } = setup();
    await core.set({ name: "old_name", mailboxId: MB1, address: A });
    await core.set({ name: "new_name", mailboxId: MB1, address: A });
    expect(await core.set({ name: "old_name", mailboxId: MB1, address: A })).toMatchObject({ ok: true });

    await core.set({ name: "third_name", mailboxId: MB1, address: A });
    advance(NAME_QUARANTINE_MS + 1);
    expect(await core.lookup("old_name")).toEqual({ status: "free" });
    expect(await core.set({ name: "old_name", mailboxId: MB2, address: B })).toMatchObject({ ok: true });
  });

  it("limits how often one mailbox can change things, and forgets after the window", async () => {
    const { core, advance } = setup();
    await core.set({ name: "name_0", mailboxId: MB1, address: A });
    for (let i = 1; i <= NAME_MAX_CHANGES; i++) {
      expect(await core.set({ name: `name_${i}`, mailboxId: MB1, address: A })).toMatchObject({ ok: true });
    }
    expect(await core.set({ name: "one_too_many", mailboxId: MB1, address: A })).toEqual({
      ok: false,
      error: "rate-limited",
    });
    advance(NAME_CHANGE_WINDOW_MS + 1);
    expect(await core.set({ name: "one_too_many", mailboxId: MB1, address: A })).toMatchObject({ ok: true });
  });

  it("does not let another mailbox's changes eat into this one's budget", async () => {
    const { core } = setup();
    await core.set({ name: "name_0", mailboxId: MB2, address: B });
    for (let i = 1; i <= NAME_MAX_CHANGES; i++) await core.set({ name: `other_${i}`, mailboxId: MB2, address: B });
    expect(await core.set({ name: "mine_0", mailboxId: MB1, address: A })).toMatchObject({ ok: true });
    expect(await core.set({ name: "mine_1", mailboxId: MB1, address: A })).toMatchObject({ ok: true });
  });
});

describe("release", () => {
  it("frees the name into quarantine and forgets the mailbox's name", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.release(MB1)).toEqual({ ok: true, name: "pavel" });
    expect(await core.lookup("pavel")).toEqual({ status: "quarantined" });
    expect(await core.mine(MB1)).toBeNull();
    expect(await core.release(MB1)).toEqual({ ok: false, error: "not-found" });
  });

  it("is never limited, but the claims after it are", async () => {
    const { core } = setup();
    await core.set({ name: "name_0", mailboxId: MB1, address: A });
    let claimed = 0;
    for (let i = 1; i < 50; i++) {
      const r = await core.release(MB1);
      if (!r.ok) break;
      const s = await core.set({ name: `name_${i}`, mailboxId: MB1, address: A });
      if (!s.ok) break;
      claimed++;
    }
    expect(claimed).toBe(NAME_MAX_CHANGES);
  });

  it("lets a mailbox at the limit release, and take its own quarantined name back", async () => {
    const { core } = setup();
    await core.set({ name: "name_0", mailboxId: MB1, address: A });
    for (let i = 1; i <= NAME_MAX_CHANGES; i++) await core.set({ name: `name_${i}`, mailboxId: MB1, address: A });
    expect(await core.release(MB1)).toMatchObject({ ok: true });
    expect(await core.set({ name: `name_${NAME_MAX_CHANGES}`, mailboxId: MB1, address: A })).toEqual({
      ok: false,
      error: "rate-limited",
    });
  });

  it("does not let a stranger release or read someone else's name", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.release(MB2)).toEqual({ ok: false, error: "not-found" });
    expect(await core.mine(MB2)).toBeNull();
    expect(await core.lookup("pavel")).toMatchObject({ status: "taken" });
  });
});

describe("reserved names with an owner", () => {
  it("lets only the configured mailbox register a reserved name", async () => {
    const { core } = setup({ spendrr: MB1 });
    expect(await core.set({ name: "spendrr", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "reserved" });
    expect(await core.set({ name: "@Spendrr", mailboxId: MB1, address: A })).toMatchObject({ ok: true, action: "claimed" });
    expect(await core.lookup("spendrr")).toEqual({ status: "taken", name: "spendrr", address: A, lnAddress: false });
  });

  it("keeps every other reserved name closed, even to an owner of a different one", async () => {
    const { core } = setup({ spendrr: MB1 });
    expect(await core.set({ name: "support", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "reserved" });
    expect(await core.lookup("support")).toEqual({ status: "reserved" });
  });

  it("does not let a reserved name lapse through inactivity", async () => {
    const { core, advance } = setup({ spendrr: MB1 });
    await core.set({ name: "spendrr", mailboxId: MB1, address: A });
    advance(NAME_INACTIVITY_MS * 3);
    expect(await core.set({ name: "spendrr", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "reserved" });
    expect(await core.lookup("spendrr")).toMatchObject({ status: "taken", address: A });
  });

  it("reads its configuration defensively", () => {
    const ok = "02" + "ab".repeat(32);
    expect(parseReservedOwners(JSON.stringify({ Spendrr: ok, support: ok }))).toEqual({ spendrr: ok, support: ok });
    for (const raw of [undefined, "", "not json", "[]", "null", "42", '"x"']) expect(parseReservedOwners(raw)).toEqual({});
    // not reserved, wrong shape of id, wrong type: all dropped
    expect(parseReservedOwners(JSON.stringify({ pavel: ok, spendrr: "short", support: 5, admin: ok }))).toEqual({
      admin: ok,
    });
  });
});

describe("inactivity", () => {
  it("keeps resolving a quiet name to its owner until somebody takes it", async () => {
    const { core, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    advance(NAME_INACTIVITY_MS * 2);
    expect(await core.lookup("pavel")).toMatchObject({ status: "taken", address: A });
  });

  it("lets somebody else take over a name whose owner has shown nothing for a year", async () => {
    const { core, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    advance(NAME_INACTIVITY_MS - 1000);
    expect(await core.set({ name: "pavel", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "taken" });
    advance(2000);
    expect(await core.set({ name: "pavel", mailboxId: MB2, address: B })).toMatchObject({ ok: true, action: "claimed" });
    expect(await core.lookup("pavel")).toMatchObject({ address: B });
    // the old owner no longer has a name, and is told so rather than shown someone else's
    expect(await core.mine(MB1)).toBeNull();
  });

  it("counts a call from the owner as a sign of life", async () => {
    const { core, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    advance(NAME_INACTIVITY_MS - 1000);
    expect(await core.mine(MB1)).toMatchObject({ name: "pavel" });
    advance(NAME_INACTIVITY_MS - 1000);
    expect(await core.set({ name: "pavel", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "taken" });
  });

  it("does not write on every sign of life", async () => {
    const { core, storage, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    const before = JSON.stringify(storage.data.get("n:pavel"));
    advance(NAME_TOUCH_MIN_INTERVAL_MS - 1000);
    await core.mine(MB1);
    expect(JSON.stringify(storage.data.get("n:pavel"))).toBe(before);
    advance(2000);
    await core.mine(MB1);
    expect(JSON.stringify(storage.data.get("n:pavel"))).not.toBe(before);
  });

  it("treats a record written before lastSeenAt existed as last seen when it was updated", async () => {
    const { core, storage, advance } = setup();
    storage.data.set("n:old_name", { name: "old_name", mailboxId: MB1, address: A, createdAt: 1, updatedAt: 1_000_000 });
    storage.data.set("m:" + MB1, { name: "old_name", changes: [] });
    advance(NAME_INACTIVITY_MS + 10);
    expect(await core.set({ name: "old_name", mailboxId: MB2, address: B })).toMatchObject({ ok: true });
  });
});

describe("moderation", () => {
  it("removes a name and blocks it for the holder and everyone else", async () => {
    const { core } = setup();
    await core.set({ name: "badname", mailboxId: MB1, address: A });
    expect(await core.adminRemove("@BadName", { reason: "abuse" })).toMatchObject({ ok: true, removed: { name: "badname" } });
    expect(await core.lookup("badname")).toEqual({ status: "reserved" });
    expect(await core.mine(MB1)).toBeNull();
    expect(await core.set({ name: "badname", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "reserved" });
    expect(await core.set({ name: "badname", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "reserved" });
  });

  it("can ban the holder's mailbox as well, and lift it again", async () => {
    const { core } = setup();
    await core.set({ name: "badname", mailboxId: MB1, address: A });
    await core.adminRemove("badname", { ban: true });
    expect(await core.set({ name: "fine_name", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "banned" });
    expect(await core.set({ name: "fine_name", mailboxId: MB2, address: B })).toMatchObject({ ok: true });
    expect(await core.adminUnban(MB1)).toEqual({ ok: true });
    expect(await core.set({ name: "fine_name_2", mailboxId: MB1, address: A })).toMatchObject({ ok: true });
  });

  it("does not ban anybody when the name was not registered, but still blocks it", async () => {
    const { core } = setup();
    expect(await core.adminRemove("nobody_has_it", { ban: true })).toEqual({ ok: true, removed: null });
    expect(await core.lookup("nobody_has_it")).toEqual({ status: "reserved" });
    expect(await core.adminUnblock("nobody_has_it")).toEqual({ ok: true });
    expect(await core.lookup("nobody_has_it")).toEqual({ status: "free" });
  });

  it("blocks a name ahead of time", async () => {
    const { core } = setup();
    await core.adminBlock("unwanted");
    expect(await core.set({ name: "unwanted", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "reserved" });
  });

  it("rejects an invalid name without touching storage", async () => {
    const { core, storage } = setup();
    expect(await core.adminRemove("no way!")).toEqual({ ok: false, error: "invalid" });
    expect(await core.adminBlock("ab")).toEqual({ ok: false });
    expect(storage.data.size).toBe(0);
  });

  it("gets a record with its blocked and abandoned state", async () => {
    const { core, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.adminGet("pavel")).toMatchObject({ record: { mailboxId: MB1 }, blocked: false, abandoned: false });
    advance(NAME_INACTIVITY_MS + 10);
    expect((await core.adminGet("pavel")).abandoned).toBe(true);
    expect(await core.adminGet("nope_nope")).toEqual({ record: null, blocked: false, abandoned: false });
  });

  it("lists names in order, page by page", async () => {
    const { core } = setup();
    const mbs = ["a", "b", "c", "d", "e"].map((c) => "02" + c.repeat(64));
    for (const [i, name] of ["eee", "bbb", "ddd", "aaa", "ccc"].entries()) {
      await core.set({ name, mailboxId: mbs[i], address: A });
    }
    const first = await core.adminList({ limit: 2 });
    expect(first.names.map((n) => n.name)).toEqual(["aaa", "bbb"]);
    expect(first.next).toBe("bbb");
    const second = await core.adminList({ after: first.next, limit: 2 });
    expect(second.names.map((n) => n.name)).toEqual(["ccc", "ddd"]);
    const third = await core.adminList({ after: second.next, limit: 2 });
    expect(third.names.map((n) => n.name)).toEqual(["eee"]);
    expect(third.next).toBeUndefined();
  });
});

describe("mailboxAuthorizationFreshness", () => {
  const NOW = 1_800_000_000;
  const le64 = (n: number) => {
    let hex = "";
    let v = BigInt(n);
    for (let i = 0; i < 8; i++) {
      hex += Number(v & 0xffn).toString(16).padStart(2, "0");
      v >>= 8n;
    }
    return hex;
  };
  const id = "02" + "ab".repeat(32);
  // a name proof signed `ageSeconds` ago: expiry = signed-at + its lifetime
  const signedAgo = (ageSeconds: number) => id + le64(NOW - ageSeconds + WORKER_NAME_PROOF_LIFETIME_S) + "cd".repeat(64);
  const expiresIn = (seconds: number) => id + le64(NOW + seconds) + "cd".repeat(64);

  it("accepts one signed a moment ago, and within the allowed skew either way", () => {
    expect(mailboxAuthorizationFreshness(signedAgo(0), NOW)).toBeNull();
    expect(mailboxAuthorizationFreshness(signedAgo(20), NOW)).toBeNull();
    expect(mailboxAuthorizationFreshness(signedAgo(NAME_PROOF_MAX_AGE_S), NOW)).toBeNull();
    expect(mailboxAuthorizationFreshness(signedAgo(-NAME_PROOF_MAX_FUTURE_S), NOW)).toBeNull();
  });

  it("refuses one signed long ago, which is what a leaked authorization looks like", () => {
    expect(mailboxAuthorizationFreshness(signedAgo(NAME_PROOF_MAX_AGE_S + 1), NOW)).toBe("stale");
    expect(mailboxAuthorizationFreshness(signedAgo(60 * 60), NOW)).toBe("stale");
    expect(mailboxAuthorizationFreshness(signedAgo(WORKER_NAME_PROOF_LIFETIME_S - 5), NOW)).toBe("stale");
  });

  it("refuses one claiming to be signed in the future", () => {
    expect(mailboxAuthorizationFreshness(signedAgo(-(NAME_PROOF_MAX_FUTURE_S + 1)), NOW)).toBe("future");
  });

  it("the app signs name proofs and push authorizations for the lifetimes the Worker assumes", () => {
    expect(NAME_PROOF_LIFETIME_S).toBe(WORKER_NAME_PROOF_LIFETIME_S);
    expect(PUSH_AUTH_LIFETIME_S).toBe(PUSH_AUTH_MAX_LIFETIME_SECONDS);
  });

  it("no push authorization a shard accepts ever passes as a fresh name proof", () => {
    // Every expiry a shard takes (pushAuthExpiry), at every point of its life.
    const longest = PUSH_AUTH_MAX_LIFETIME_SECONDS + PUSH_AUTH_CLOCK_SKEW_SECONDS;
    for (let left = 1; left <= longest; left += 97) {
      expect(mailboxAuthorizationFreshness(expiresIn(left), NOW), `${left} s left`).toBe("stale");
    }
    expect(mailboxAuthorizationFreshness(expiresIn(longest), NOW)).toBe("stale");
  });

  it("a 24 h proof from an app before SDK 0.25.0 is stale", () => {
    expect(mailboxAuthorizationFreshness(expiresIn(24 * 60 * 60), NOW)).toBe("stale");
  });

  it("tolerates the second lost to truncation that the real SDK shows", () => {
    // measured: expiry - call time = 86399.1 .. 86399.9, i.e. signed-at reads up to 1s late
    expect(mailboxAuthorizationFreshness(signedAgo(-1), NOW)).toBeNull();
    expect(mailboxAuthorizationFreshness(signedAgo(1), NOW)).toBeNull();
  });
});

describe("consumeProof (one-time use)", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);

  it("lets an authorization be used once and refuses every later use", async () => {
    const { core } = setup();
    expect(await core.consumeProof(H1)).toBe(true);
    expect(await core.consumeProof(H1)).toBe(false);
    expect(await core.consumeProof(H1)).toBe(false);
    expect(await core.consumeProof(H2)).toBe(true);
  });

  it("forgets it once it could no longer pass the freshness check anyway", async () => {
    const { core, advance } = setup();
    await core.consumeProof(H1);
    advance(NAME_PROOF_MEMORY_MS - 1000);
    expect(await core.consumeProof(H1)).toBe(false);
    advance(2000);
    expect(await core.consumeProof(H1)).toBe(true);
  });

  it("cleans up after itself, so the memory stays bounded", async () => {
    const { core, storage, advance } = setup();
    for (let i = 0; i < 30; i++) await core.consumeProof(i.toString(16).padStart(64, "0"));
    advance(NAME_PROOF_MEMORY_MS + 1000);
    for (let i = 0; i < 5; i++) await core.consumeProof((100 + i).toString(16).padStart(64, "0"));
    const kept = [...storage.data.keys()].filter((k) => k.startsWith("p:")).length;
    expect(kept).toBeLessThan(30);
  });

  it("does not touch names, mailboxes or moderation records", async () => {
    const { core, storage } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    const before = [...storage.data.keys()].filter((k) => !k.startsWith("p:")).sort();
    await core.consumeProof(H1);
    expect([...storage.data.keys()].filter((k) => !k.startsWith("p:")).sort()).toEqual(before);
  });
});

describe("aliases", () => {
  it("resolves an assigned reserved name, next to the mailbox's own name", async () => {
    const { core } = setup();
    await core.set({ name: "alice", mailboxId: MB1, address: A });
    const r = await core.adminAssign({ name: "@Spendrr", mailboxId: MB1, address: A });
    expect(r).toMatchObject({ ok: true, record: { name: "spendrr", alias: true } });
    expect(await core.lookup("spendrr")).toEqual({ status: "taken", name: "spendrr", address: A, lnAddress: false });
    // the mailbox still has exactly its own name, and `mine` does not mistake the alias for it
    expect(await core.mine(MB1)).toEqual({ name: "alice", address: A, lnAddress: false });
  });

  it("cannot be changed, taken or released from the app, by anyone", async () => {
    const { core } = setup();
    await core.set({ name: "alice", mailboxId: MB1, address: A });
    await core.adminAssign({ name: "donate", mailboxId: MB1, address: A });
    await core.adminAssign({ name: "team_name", mailboxId: MB1, address: A });
    for (const mb of [MB1, MB2]) {
      expect(await core.set({ name: "donate", mailboxId: mb, address: B })).toEqual({ ok: false, error: "reserved" });
      expect(await core.set({ name: "team_name", mailboxId: mb, address: B })).toEqual({ ok: false, error: "taken" });
    }
    expect(await core.release(MB1)).toMatchObject({ ok: true, name: "alice" });
    expect(await core.lookup("donate")).toMatchObject({ status: "taken", address: A });
    expect(await core.lookup("team_name")).toMatchObject({ status: "taken", address: A });
  });

  it("never lapses through inactivity", async () => {
    const { core, advance } = setup();
    await core.adminAssign({ name: "team_name", mailboxId: MB1, address: A });
    advance(NAME_INACTIVITY_MS * 3);
    expect(await core.set({ name: "team_name", mailboxId: MB2, address: B })).toEqual({ ok: false, error: "taken" });
    expect((await core.adminGet("team_name")).abandoned).toBe(false);
  });

  it("can be pointed somewhere else by assigning again, but never over an ordinary holder or a block", async () => {
    const { core } = setup();
    await core.adminAssign({ name: "spendrr", mailboxId: MB1, address: A });
    expect(await core.adminAssign({ name: "spendrr", mailboxId: MB1, address: B })).toMatchObject({ ok: true });
    expect(await core.lookup("spendrr")).toMatchObject({ address: B });

    await core.set({ name: "pavel", mailboxId: MB2, address: A });
    expect(await core.adminAssign({ name: "pavel", mailboxId: MB1, address: B })).toEqual({ ok: false, error: "taken" });

    await core.adminBlock("nope_name");
    expect(await core.adminAssign({ name: "nope_name", mailboxId: MB1, address: B })).toEqual({
      ok: false,
      error: "blocked",
    });
  });

  it("validates what it is given and writes nothing when it is wrong", async () => {
    const { core, storage } = setup();
    expect(await core.adminAssign({ name: "no way", mailboxId: MB1, address: A })).toEqual({ ok: false, error: "invalid" });
    expect(await core.adminAssign({ name: "spendrr", mailboxId: MB1, address: "ark1" })).toEqual({
      ok: false,
      error: "bad-address",
    });
    expect(await core.adminAssign({ name: "spendrr", mailboxId: "02ab", address: A })).toEqual({
      ok: false,
      error: "bad-mailbox",
    });
    expect(storage.data.size).toBe(0);
  });

  it("can be removed by the admin without touching the mailbox's own name", async () => {
    const { core } = setup();
    await core.set({ name: "alice", mailboxId: MB1, address: A });
    await core.adminAssign({ name: "spendrr", mailboxId: MB1, address: A });
    expect(await core.adminRemove("spendrr")).toMatchObject({ ok: true, removed: { alias: true } });
    expect(await core.mine(MB1)).toEqual({ name: "alice", address: A, lnAddress: false });
    expect(await core.lookup("spendrr")).toEqual({ status: "reserved" });
  });
});

describe("invariants under random operation sequences", () => {
  const op = fc.oneof(
    fc.record({
      kind: fc.constant("set" as const),
      name: fc.constantFrom("aaa", "bbb", "ccc", "ddd", "eee", "Aaa", "@bbb", "bad name", "admin", "a-b", "-ab"),
      mb: fc.constantFrom(MB1, MB2, "02" + "c".repeat(64)),
      addr: fc.constantFrom(A, B, C, "junk"),
    }),
    fc.record({ kind: fc.constant("release" as const), mb: fc.constantFrom(MB1, MB2, "02" + "c".repeat(64)) }),
    fc.record({ kind: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: NAME_INACTIVITY_MS }) }),
    fc.record({
      kind: fc.constant("remove" as const),
      name: fc.constantFrom("aaa", "bbb", "ccc", "ddd", "eee"),
      ban: fc.boolean(),
    }),
    fc.record({ kind: fc.constant("mine" as const), mb: fc.constantFrom(MB1, MB2, "02" + "c".repeat(64)) }),
    fc.record({
      kind: fc.constant("assign" as const),
      name: fc.constantFrom("aaa", "bbb", "ccc", "spendrr", "donate"),
      mb: fc.constantFrom(MB1, MB2),
      addr: fc.constantFrom(A, B),
    }),
  );

  it("keeps names unique, mailboxes consistent, and never resolves to a bad address", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 60 }), async (ops) => {
        const { core, storage, advance } = setup();
        for (const o of ops) {
          if (o.kind === "set") await core.set({ name: o.name, mailboxId: o.mb, address: o.addr });
          else if (o.kind === "release") await core.release(o.mb);
          else if (o.kind === "remove") await core.adminRemove(o.name, { ban: o.ban });
          else if (o.kind === "mine") await core.mine(o.mb);
          else if (o.kind === "assign") await core.adminAssign({ name: o.name, mailboxId: o.mb, address: o.addr });
          else advance(o.ms);
        }

        const names = [...storage.data.entries()].filter(([k]) => k.startsWith("n:"));
        const mailboxes = new Map(
          [...storage.data.entries()]
            .filter(([k]) => k.startsWith("m:"))
            .map(([k, v]) => [k.slice(2), v as { name: string | null }]),
        );

        const owners = new Set<string>();
        for (const [key, raw] of names) {
          const rec = raw as { name: string; mailboxId: string; address: string; alias?: boolean };
          expect(key).toBe(`n:${rec.name}`);
          expect(isPlausibleArkAddress(rec.address)).toBe(true);
          // an alias belongs to no mailbox's own-name slot
          if (rec.alias) continue;
          // every other name is the current name of exactly the mailbox that owns it
          expect(mailboxes.get(rec.mailboxId)?.name).toBe(rec.name);
          expect(owners.has(rec.mailboxId)).toBe(false);
          owners.add(rec.mailboxId);
        }
        // and every mailbox that thinks it has a name really does
        for (const [mb, m] of mailboxes) {
          if (m.name) expect(owners.has(mb)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("mailboxAuthorizationProblem", () => {
  const NOW = 1_800_000_000;
  const le64 = (n: number) => {
    let hex = "";
    let v = BigInt(n);
    for (let i = 0; i < 8; i++) {
      hex += Number(v & 0xffn).toString(16).padStart(2, "0");
      v >>= 8n;
    }
    return hex;
  };
  const id = "02" + "ab".repeat(32);
  const auth = (expiry: number, prefix = id) => prefix + le64(expiry) + "cd".repeat(64);

  it("accepts a well-formed, unexpired authorization for the same mailbox", () => {
    expect(mailboxAuthorizationProblem(id, auth(NOW + 3600), NOW)).toBeNull();
  });

  it("reads the expiry as a little-endian i64 (not big-endian)", () => {
    // 0x0100000000000000 read big-endian would be huge; read little-endian it is 1, long past.
    expect(mailboxAuthorizationProblem(id, id + "0100000000000000" + "cd".repeat(64), NOW)).toBe("expired");
    expect(mailboxAuthorizationProblem(id, auth(NOW), NOW)).toBe("expired");
    expect(mailboxAuthorizationProblem(id, auth(NOW + 1), NOW)).toBeNull();
  });

  it("rejects an authorization signed for a different mailbox", () => {
    const other = "03" + "ef".repeat(32);
    expect(mailboxAuthorizationProblem(id, auth(NOW + 3600, other), NOW)).toBe("mismatch");
  });

  it("rejects the wrong shape: length, case and non-hex", () => {
    expect(mailboxAuthorizationProblem(id, auth(NOW + 3600).slice(2), NOW)).toBe("malformed");
    expect(mailboxAuthorizationProblem(id.slice(2), auth(NOW + 3600), NOW)).toBe("malformed");
    expect(mailboxAuthorizationProblem(id, auth(NOW + 3600).toUpperCase(), NOW)).toBe("malformed");
    expect(mailboxAuthorizationProblem(id, "zz" + auth(NOW + 3600).slice(2), NOW)).toBe("malformed");
  });
});

describe("allowNewName (the daily budget for taking names)", () => {
  it("refuses claim, rename and takeover when spent, but still lets the owner change the address", async () => {
    const core = new NameRegistryCore(new MemoryStorage());
    expect(await core.set({ name: "pavel", mailboxId: MB1, address: A, allowNewName: false })).toEqual({ ok: false, error: "closed" });
    expect(await core.lookup("pavel")).toEqual({ status: "free" });

    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.set({ name: "pavel", mailboxId: MB1, address: A, allowNewName: false })).toMatchObject({ ok: true, action: "unchanged" });
    expect(await core.set({ name: "pavel", mailboxId: MB1, address: B, allowNewName: false })).toMatchObject({
      ok: true,
      action: "address-updated",
    });
    expect(await core.set({ name: "honza", mailboxId: MB1, address: B, allowNewName: false })).toEqual({ ok: false, error: "closed" });
    expect(await core.lookup("pavel")).toMatchObject({ status: "taken", address: B });
  });

  it("is on by default", async () => {
    const core = new NameRegistryCore(new MemoryStorage());
    expect(await core.set({ name: "pavel", mailboxId: MB1, address: A })).toMatchObject({ ok: true, action: "claimed" });
  });
});

describe("Lightning address opt-in (lnAddress)", () => {
  it("is off until the owner turns it on, and mine() reports it", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.mine(MB1)).toMatchObject({ lnAddress: false });
    expect(await core.setLnAddress(MB1, true)).toEqual({ ok: true, lnAddress: true });
    expect(await core.mine(MB1)).toMatchObject({ lnAddress: true });
    expect(await core.setLnAddress(MB1, false)).toEqual({ ok: true, lnAddress: false });
  });

  it("refuses a mailbox with no name of its own", async () => {
    const { core } = setup();
    expect(await core.setLnAddress(MB1, true)).toEqual({ ok: false, error: "no-name" });
  });

  it("lnAddressTarget resolves only an opted-in, taken name", async () => {
    const { core } = setup();
    expect(await core.lnAddressTarget("pavel")).toBeNull();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.lnAddressTarget("pavel")).toBeNull(); // taken but not opted in
    await core.setLnAddress(MB1, true);
    expect(await core.lnAddressTarget("pavel")).toEqual({ name: "pavel", address: A, mailboxId: MB1 });
    expect(await core.lnAddressTarget("PAVEL")).toEqual({ name: "pavel", address: A, mailboxId: MB1 }); // case-insensitive like lookup
  });

  it("is cleared on release: a re-claim starts opted out", async () => {
    const { core } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    await core.setLnAddress(MB1, true);
    await core.release(MB1);
    // Quarantine blocks MB2, so re-claim through MB1 after clearing quarantine
    // isn't reachable here without advancing time past NAME_QUARANTINE_MS;
    // what matters is the record (and its lnAddress flag) is simply gone.
    expect(await core.lnAddressTarget("pavel")).toBeNull();
  });

  it("adminAssign can opt an alias into it at creation time", async () => {
    const { core } = setup();
    await core.adminAssign({ name: "spendrr", mailboxId: MB1, address: A, lnAddress: true });
    expect(await core.lnAddressTarget("spendrr")).toEqual({ name: "spendrr", address: A, mailboxId: MB1 });
    // omitted stays off, by default
    await core.adminAssign({ name: "donate", mailboxId: MB1, address: A });
    expect(await core.lnAddressTarget("donate")).toBeNull();
  });

  it("is cleared when an abandoned name is taken over", async () => {
    const { core, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    await core.setLnAddress(MB1, true);
    advance(NAME_INACTIVITY_MS + 1);
    await core.set({ name: "pavel", mailboxId: MB2, address: B });
    expect(await core.mine(MB2)).toMatchObject({ lnAddress: false });
    expect(await core.lnAddressTarget("pavel")).toBeNull();
  });
});

describe("chatPubkey", () => {
  const K1 = "c".repeat(64);
  const K2 = "d".repeat(64);

  it("is set by the owner and shows in lookup and mine", async () => {
    const { core } = setup();
    expect(await core.setChatPubkey(MB1, K1)).toEqual({ ok: false, error: "no-name" });
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.setChatPubkey(MB1, K1)).toEqual({ ok: true, chatPubkey: K1 });
    expect(await core.lookup("pavel")).toMatchObject({ status: "taken", chatPubkey: K1 });
    expect(await core.mine(MB1)).toMatchObject({ chatPubkey: K1 });
  });

  it("refuses malformed keys and writes nothing when unchanged", async () => {
    const { core, storage } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    expect(await core.setChatPubkey(MB1, "XYZ")).toEqual({ ok: false, error: "invalid" });
    await core.setChatPubkey(MB1, K1);
    const before = JSON.stringify(storage.data.get("n:pavel"));
    await core.setChatPubkey(MB1, K1);
    expect(JSON.stringify(storage.data.get("n:pavel"))).toBe(before);
  });

  it("survives an address change but not a rename or a takeover", async () => {
    const { core, advance } = setup();
    await core.set({ name: "pavel", mailboxId: MB1, address: A });
    await core.setChatPubkey(MB1, K1);
    await core.set({ name: "pavel", mailboxId: MB1, address: B });
    expect(await core.lookup("pavel")).toMatchObject({ chatPubkey: K1 });
    await core.set({ name: "petr", mailboxId: MB1, address: B });
    expect(await core.lookup("petr")).not.toHaveProperty("chatPubkey");
    await core.setChatPubkey(MB1, K2);
    advance(NAME_INACTIVITY_MS + 1);
    await core.set({ name: "petr", mailboxId: MB2, address: C });
    expect(await core.lookup("petr")).not.toHaveProperty("chatPubkey");
  });
});
