// External audit 2026-09-27, M1: a password change must not sign a forged
// address. PBKDF2 at the real iteration count, so few cases.
import { describe, expect, it } from "vitest";
import { computeValueTag, encryptMnemonic, verifyValueTag } from "../src/lib/vault/crypto";
import { rekeyDestinationTag } from "../src/lib/exit/exitDestinationTag";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ATTACKER = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

describe("rekeyDestinationTag", () => {
  it("re-tags an address the old tag vouches for, under the new password", async () => {
    const oldVault = await encryptMnemonic("test mnemonic", "old pass");
    const newVault = await encryptMnemonic("test mnemonic", "new pass");
    const tag = await computeValueTag(ADDRESS, "old pass", oldVault);
    const d = await rekeyDestinationTag(
      { address: ADDRESS, tag },
      { password: "old pass", vault: oldVault },
      { password: "new pass", vault: newVault },
    );
    expect(d.kind).toBe("retag");
    if (d.kind === "retag") expect(await verifyValueTag(ADDRESS, d.tag, "new pass", newVault)).toBe(true);
  });

  it("drops a rewritten address instead of signing it", async () => {
    const oldVault = await encryptMnemonic("test mnemonic", "old pass");
    const newVault = await encryptMnemonic("test mnemonic", "new pass");
    const tag = await computeValueTag(ADDRESS, "old pass", oldVault);
    const d = await rekeyDestinationTag(
      { address: ATTACKER, tag },
      { password: "old pass", vault: oldVault },
      { password: "new pass", vault: newVault },
    );
    expect(d.kind).toBe("clear");
  });

  it("drops an address whose tag was deleted, and ignores no address", async () => {
    const vault = await encryptMnemonic("test mnemonic", "pass");
    const both = { password: "pass", vault };
    expect((await rekeyDestinationTag({ address: ATTACKER, tag: null }, both, both)).kind).toBe("clear");
    expect((await rekeyDestinationTag({ address: null, tag: null }, both, both)).kind).toBe("none");
  });
}, 60_000);
