// Minimal browser-global polyfills so lib modules written for the browser
// (src/lib/i18n.ts reads localStorage/navigator.language at import time) can
// be imported directly under Node without pulling in a full jsdom environment.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

if (typeof globalThis.navigator === "undefined" || !globalThis.navigator.language) {
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "en-US" },
    configurable: true,
  });
}
