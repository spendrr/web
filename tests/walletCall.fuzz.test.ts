// Tests for src/lib/wallet/walletCall.ts — specifically the timeout/failure
// distinction the send flow depends on. withTimeout cannot cancel the call it
// races, so its rejection means "we stopped waiting", never "the money stayed
// put": SendPanel treats it as possibly-sent and clears the form so a slow
// Lightning payment can't be paid twice by a blind second tap. That only
// holds if the classifier is exactly as narrow as it claims — a rejection
// that came *from* the call carries a real verdict and must keep the ordinary
// error handling (form left filled so the user can correct and retry).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isWalletCallTimeout, withTimeout } from "../src/lib/wallet/walletCall";

describe("isWalletCallTimeout", () => {
  it("classifies withTimeout's own expiry as a timeout", async () => {
    await expect(withTimeout(new Promise(() => {}), 1, "Počkej chvíli…")).rejects.toSatisfy(isWalletCallTimeout);
  });

  it("does not classify a rejection that came from the call, whatever its message", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (message) => {
        // Includes the timeout message itself: the tag has to survive a call
        // that happens to reject with the same (translated, widely reused)
        // text, which is why this is a `name` and not a string comparison.
        const failed = withTimeout(Promise.reject(new Error(message)), 60_000, "Počkej chvíli…");
        await expect(failed).rejects.toSatisfy((e: unknown) => !isWalletCallTimeout(e));
      }),
    );
  });

  it("keeps the timeout message intact for callers that only display it", async () => {
    await expect(withTimeout(new Promise(() => {}), 1, "Počkej chvíli…")).rejects.toThrow("Počkej chvíli…");
  });

  it("treats non-Error rejections as not-a-timeout", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        // A thrown string/object has no verdict either way, but defaulting it
        // to "timeout" would silently clear the send form on failures the
        // user could have corrected. Fail towards the ordinary error path.
        if (value instanceof Error) return;
        expect(isWalletCallTimeout(value)).toBe(false);
      }),
    );
  });
});
