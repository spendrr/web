import { describe, expect, it } from "vitest";
import { swipeDismisses } from "../src/lib/ui/swipeAway";

describe("swipeDismisses", () => {
  it("dismisses a long slow drag in either direction", () => {
    expect(swipeDismisses(90, 900)).toBe(true);
    expect(swipeDismisses(-90, 900)).toBe(true);
  });
  it("dismisses a short quick flick", () => {
    expect(swipeDismisses(40, 50)).toBe(true);
  });
  it("keeps a short slow drag and a tap", () => {
    expect(swipeDismisses(40, 600)).toBe(false);
    expect(swipeDismisses(3, 40)).toBe(false);
  });
});
