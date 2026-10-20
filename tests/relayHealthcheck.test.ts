// The push relay's own alert: with the shard sweep at 15 minutes either way,
// a relay outage only shows as late pushes, so the cron reports its health to
// RELAY_HEALTHCHECK_PING_URL on every status-report tick.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { resetRelayHealthForTests } from "../worker/pushRelay";

const PING = "https://hc-ping.test/relay";
const RELAY = {
  PUSH_RELAY_URL: "https://relay.internal",
  PUSH_RELAY_TOKEN: "t",
  PUSH_RELAY_HOOK_SECRET: "s",
  CF_ACCESS_CLIENT_ID: "id",
  CF_ACCESS_CLIENT_SECRET: "secret",
};
// Minute 0: a status-report tick (every 5 minutes).
const REPORT_TICK = Date.UTC(2026, 9, 6, 12, 0);

let calls: string[];
let relayBody: unknown;

beforeEach(() => {
  resetRelayHealthForTests();
  calls = [];
  relayBody = { ok: true, warm: true };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.startsWith(RELAY.PUSH_RELAY_URL)) return new Response(JSON.stringify(relayBody));
    return new Response("ok");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tick = (env: Record<string, unknown>, at = REPORT_TICK) =>
  worker.scheduled({ scheduledTime: at } as never, env as never);
const pings = () => calls.filter((u) => u.startsWith(PING));

describe("relay healthcheck ping", () => {
  it("pings plain while the relay is ok and warm", async () => {
    await tick({ ...RELAY, RELAY_HEALTHCHECK_PING_URL: PING });
    expect(pings()).toEqual([PING]);
  });

  it("pings /fail while the relay is cold, down or unreachable", async () => {
    relayBody = { ok: true, warm: false };
    await tick({ ...RELAY, RELAY_HEALTHCHECK_PING_URL: PING });
    resetRelayHealthForTests();
    relayBody = { ok: false, warm: true };
    await tick({ ...RELAY, RELAY_HEALTHCHECK_PING_URL: PING });
    expect(pings()).toEqual([`${PING}/fail`, `${PING}/fail`]);
  });

  it("only on report ticks, and not at all without the secret or a relay", async () => {
    await tick({ ...RELAY, RELAY_HEALTHCHECK_PING_URL: PING }, REPORT_TICK + 60_000);
    await tick({ ...RELAY });
    await tick({ RELAY_HEALTHCHECK_PING_URL: PING });
    expect(pings()).toEqual([]);
  });
});
