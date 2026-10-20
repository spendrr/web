// Incidents the checks did not see, entered by hand (status/logic.ts,
// RecordedIncident). Only enums and UTC times, like everything the page shows.
// Each with where its times come from.

import type { ComponentId, RecordedIncident } from "./logic.ts";

// 2026-10-05, ark.second.tech "Ark service currently unavailable" (gRPC 14),
// before the status Worker existed. Start: the push relay's minute log, its
// two Ark streams ended with 14 between 13:31:18 and 13:32:18 and stayed down.
// End: a manual check every minute saw GetArkInfo answer again at 16:49:50.
// The Lightning address needs Ark, so the same interval. Second's own
// Lightning side was still down after 16:49 ("no active hold-compatible cln
// node"); when it came back is not known, so it is not recorded.
const ARK_DOWN_FROM = Date.UTC(2026, 9, 5, 13, 32, 18);
const ARK_DOWN_TO = Date.UTC(2026, 9, 5, 16, 49, 50);

export const RECORDED_INCIDENTS: readonly RecordedIncident[] = [
  { c: "ark", s: "down", from: ARK_DOWN_FROM, to: ARK_DOWN_TO, r: true },
  { c: "lnaddr", s: "down", from: ARK_DOWN_FROM, to: ARK_DOWN_TO, r: true },
];

// Since when a component's state is known before the checks began. Ark: the
// push relay held its Ark streams without a break from its first one,
// 2026-10-04 21:03:14 UTC, through the outage above and past the status
// Worker's start; its log shows no other outage (one blip under a minute at
// 11:52, under the two-check rule). Nothing else was measured before.
export const RECORDED_KNOWN_FROM: Partial<Record<ComponentId, number>> = {
  ark: Date.UTC(2026, 9, 4, 21, 3, 14),
};
