// worker/backupAuth.ts: the write-token gate on the cloud backup. Without it a
// lookupKey alone let anyone overwrite a backup or replay an old one.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkWriteToken, hashWriteToken } from "../worker/backupAuth";

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);

describe("checkWriteToken", () => {
  it("accepts anything while no token is recorded (new or pre-token backup)", () => {
    expect(checkWriteToken(undefined, null)).toBe("ok");
    expect(checkWriteToken(undefined, "a".repeat(64))).toBe("ok");
  });

  it("once recorded, refuses a missing or different token", () => {
    fc.assert(
      fc.property(hex64, hex64, (stored, other) => {
        expect(checkWriteToken(stored, null)).toBe("forbidden");
        expect(checkWriteToken(stored, stored)).toBe("ok");
        if (other !== stored) expect(checkWriteToken(stored, other)).toBe("forbidden");
      }),
    );
  });

  it("hashes the token, so the stored value is never the token itself", async () => {
    const token = "c".repeat(64);
    const hash = await hashWriteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(await hashWriteToken(token)).toBe(hash);
  });
});
