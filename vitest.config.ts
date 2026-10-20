import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (which uses plain `defineConfig` from "vite"
// and wouldn't know about the `test` field) — this only runs the pure-logic
// fuzz/unit tests under tests/, never touches the WASM wallet or a browser.
export default defineConfig({
  plugins: [react()],
  define: {
    __NETWORK__: JSON.stringify("bitcoin"),
    __REGTEST_ARK_URL__: JSON.stringify(""),
    __REGTEST_ESPLORA_URL__: JSON.stringify(""),
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
