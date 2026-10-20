// Spendrr payment push relay (docs/payment-push-relay.md). Holds one Ark
// SubscribeMailbox stream per registered mailbox and pokes the Worker when a
// payment lands. Node 24 LTS, no dependencies; runs as a systemd service
// (scripts/push-relay/).
//
// Environment:
//   RELAY_TOKEN        bearer the Worker sends (PUSH_RELAY_TOKEN there)
//   HOOK_SECRET        signs the pokes (PUSH_RELAY_HOOK_SECRET there)
//   HOOK_URL           default https://spendrr.app/api/push/hook
//   ARK_SERVER         default https://ark.second.tech
//   PORT               default 8788, always on 127.0.0.1
//   DB_PATH            default /var/lib/spendrr-relay/relay.db
import { createServer } from "node:http";
import { apiHandler, drainApiCounts } from "./api.ts";
import { HookBatcher } from "./hook.ts";
import { Store } from "./store.ts";
import { StreamManager } from "./streams.ts";

const env = process.env;
const token = env.RELAY_TOKEN ?? "";
const secret = env.HOOK_SECRET ?? "";
if (token.length < 32 || secret.length < 32) {
  console.error("RELAY_TOKEN and HOOK_SECRET must be set (32+ characters)");
  process.exit(1);
}
const port = Number(env.PORT ?? 8788);
const PRUNE_AFTER_S = 2 * 24 * 60 * 60;
// Opening thousands of streams at once after a restart would look like a
// flood to the Ark server: this many per tick.
const OPEN_PER_TICK = 50;
const OPEN_TICK_MS = 1000;

const store = new Store(env.DB_PATH ?? "/var/lib/spendrr-relay/relay.db");
const hook = new HookBatcher({ url: env.HOOK_URL ?? "https://spendrr.app/api/push/hook", secret });
const streams = new StreamManager({
  arkServer: env.ARK_SERVER ?? "https://ark.second.tech",
  store,
  // The shard comes from the registration: the Worker routes the poke by it.
  onPayment: (id) => {
    const shard = store.get(id)?.shard;
    if (shard) hook.add(id, shard);
  },
});

const server = createServer((req, res) => {
  apiHandler({ store, streams, hook, token })(req, res).catch((e: unknown) => {
    console.error("api error", e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`relay listening on 127.0.0.1:${port}`));

// Resume every stream that still has a valid authorization, a few at a time.
const nowS = () => Math.floor(Date.now() / 1000);
const resume = store.all().filter((r) => r.expiresAt > nowS());
console.log(`resuming ${resume.length} streams`);
const ramp = setInterval(() => {
  for (const reg of resume.splice(0, OPEN_PER_TICK)) streams.ensure(reg);
  if (resume.length === 0) clearInterval(ramp);
}, OPEN_TICK_MS);

// Once a minute: close streams whose authorization ran out, forget the ones
// nobody renewed, and say how things stand.
setInterval(() => {
  const closed = streams.closeExpired();
  const pruned = store.prune(nowS() - PRUNE_AFTER_S);
  for (const id of pruned.ids) streams.stop(id);
  const s = streams.stats();
  console.log(
    `streams open ${s.open}/${s.watched}, refused ${s.refused}, sessions ${s.sessions}, ${streams.drainCounters()}, ` +
      `api ${drainApiCounts()}, expired ${closed}, pruned ${pruned.count}, pokes sent ${hook.sent} failed ${hook.failed} deferred ${hook.deferred} waiting ${hook.waiting}`,
  );
}, 60_000);

const shutdown = () => {
  console.log("shutting down");
  clearInterval(ramp);
  streams.stopAll();
  void hook.drain().finally(() => {
    store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
