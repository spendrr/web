import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { lazyReady } from "../src/lib/ui/lazyReady";

const Hello = (p: { name: string }) => createElement("b", null, `hi ${p.name}`);

describe("lazyReady", () => {
  it("renders directly once preloaded, without suspending", async () => {
    const C = lazyReady(async () => ({ default: Hello }));
    expect(C.isReady()).toBe(false);
    await C.preload();
    expect(C.isReady()).toBe(true);
    // A suspended lazy component would throw or emit a fallback marker here.
    expect(renderToString(createElement(C, { name: "a" }))).toBe("<b>hi a</b>");
  });

  it("loads the chunk once for repeated preloads", async () => {
    let calls = 0;
    const C = lazyReady(async () => {
      calls++;
      return { default: Hello };
    });
    await Promise.all([C.preload(), C.preload()]);
    await C.preload();
    expect(calls).toBe(1);
  });

  it("a failed load rejects and the next preload retries", async () => {
    let calls = 0;
    const C = lazyReady(async () => {
      calls++;
      if (calls === 1) throw new Error("chunk");
      return { default: Hello };
    });
    await expect(C.preload()).rejects.toThrow("chunk");
    expect(C.isReady()).toBe(false);
    await C.preload();
    expect(C.isReady()).toBe(true);
    expect(calls).toBe(2);
  });
});
