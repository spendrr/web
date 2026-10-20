import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  acceptReport,
  applyProbes,
  COMPONENTS,
  HISTORY_MS,
  REPORT_STALE_MS,
  ROUNDS_STALLED_MS,
  toPublic,
  type ProbeResults,
  type State,
} from "../status/logic";
import type { StatusReport } from "../status/report";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 14, 0);
const NEXT_ROUND = T0 + 30 * MIN;
const allUp: ProbeResults = {
  ark: { up: true, nextRoundAt: NEXT_ROUND },
  chainPrimary: 900_000,
  chainFallback: 900_000,
  spendrr: { up: true, lnaddrOk: true },
  reportsExpected: false,
};
const arkDown: ProbeResults = { ...allUp, ark: { up: false, nextRoundAt: null } };
const noSpendrr = (r: ProbeResults): ProbeResults => ({ ...r, spendrr: undefined });
const goodReport = (at: number): StatusReport => ({
  v: 1,
  at,
  lnNode: true,
  lnRefusing: false,
  lnInvoicesFailing: false,
  relay: true,
  pushConfigured: true,
  names: true,
  backups: true,
});

function run(rounds: ProbeResults[], start: State | null = null, t = T0): State {
  let s = start;
  rounds.forEach((r, i) => (s = applyProbes(s, r, t + i * MIN)));
  return s as State;
}

describe("next round time", () => {
  it("goes public, and is cleared while Ark is down", () => {
    expect(toPublic(run([allUp])).nextRoundAt).toBe(NEXT_ROUND);
    expect(toPublic(run([allUp, arkDown])).nextRoundAt).toBeNull();
  });
});

describe("status logic", () => {
  it("starts unknown and takes the first observation as is", () => {
    const s = run([noSpendrr(allUp)]);
    expect(s.components.ark.status).toBe("ok");
    expect(s.components.chain.status).toBe("ok");
    // Not observed yet: no data is shown as no data, never as ok.
    expect(s.components.spendrr.status).toBe("unknown");
    expect(s.components.push.status).toBe("unknown");
    expect(s.components.lnaddr.status).toBe("unknown");
    expect(s.incidents).toEqual([]);
  });

  it("one failed probe is not an incident, two in a row are, dated at the first", () => {
    expect(run([allUp, arkDown, allUp]).incidents).toEqual([]);
    const two = run([allUp, arkDown, arkDown]);
    expect(two.components.ark).toMatchObject({ status: "down", since: T0 + MIN });
    expect(two.incidents).toContainEqual({ c: "ark", s: "down", from: T0 + MIN, to: null });
  });

  it("recovery closes the incident at the first good observation", () => {
    const s = run([allUp, arkDown, arkDown, arkDown, allUp, allUp]);
    expect(s.components.ark.status).toBe("ok");
    expect(s.incidents.find((i) => i.c === "ark")).toEqual({ c: "ark", s: "down", from: T0 + MIN, to: T0 + 4 * MIN });
  });

  it("leaves down when the next two observations differ from it, even from each other", () => {
    const stalled: ProbeResults = { ...allUp, ark: { up: true, nextRoundAt: T0 - ROUNDS_STALLED_MS - MIN } };
    // Down, then stalled rounds, then fine: two in a row away from down.
    const s = run([allUp, arkDown, arkDown, stalled, allUp]);
    expect(s.components.ark).toMatchObject({ status: "ok", since: T0 + 3 * MIN });
    // One more failure is not an incident again, and the Lightning address follows Ark.
    const t = run([arkDown], s, T0 + 5 * MIN);
    expect(t.components.ark.status).toBe("ok");
    expect(t.components.lnaddr.status).toBe("ok");
  });

  it("reaches down only through down every time: degraded then down is degraded", () => {
    const stalled: ProbeResults = { ...allUp, ark: { up: true, nextRoundAt: T0 - ROUNDS_STALLED_MS - MIN } };
    const s = run([allUp, stalled, arkDown]);
    expect(s.components.ark).toMatchObject({ status: "degraded", since: T0 + MIN });
    expect(s.components.lnaddr.status).toBe("ok");
    const t = run([arkDown], s, T0 + 3 * MIN);
    expect(t.components.ark).toMatchObject({ status: "down", since: T0 + 2 * MIN });
    expect(t.components.lnaddr).toMatchObject({ status: "down", since: T0 + 2 * MIN });
  });

  it("rounds whose next time stays in the past are degraded, not down", () => {
    const stalled: ProbeResults = { ...allUp, ark: { up: true, nextRoundAt: T0 - ROUNDS_STALLED_MS - MIN } };
    expect(run([allUp, stalled, stalled]).components.ark.status).toBe("degraded");
    const unknownNext: ProbeResults = { ...allUp, ark: { up: true, nextRoundAt: null } };
    expect(run([allUp, unknownNext, unknownNext]).components.ark.status).toBe("ok");
  });

  it("chain: degraded on the fallback or when the primary lags, down without both", () => {
    const lag: ProbeResults = { ...allUp, chainPrimary: 899_997 };
    expect(run([allUp, lag, lag]).components.chain.status).toBe("degraded");
    const fallback: ProbeResults = { ...allUp, chainPrimary: null };
    expect(run([allUp, fallback, fallback]).components.chain.status).toBe("degraded");
    const none: ProbeResults = { ...fallback, chainFallback: null };
    expect(run([allUp, none, none]).components.chain.status).toBe("down");
  });

  it("the Lightning address goes down with Ark, even between Spendrr probes", () => {
    const s = run([allUp, noSpendrr(arkDown), noSpendrr(arkDown)]);
    expect(s.components.lnaddr.status).toBe("down");
    expect(s.components.spendrr.status).toBe("ok");
    // And comes back with it.
    const back = run([noSpendrr(allUp), noSpendrr(allUp)], s, T0 + 3 * MIN);
    expect(back.components.lnaddr.status).toBe("ok");
  });

  it("a Spendrr failure seen once is not counted again on the minutes in between", () => {
    const bad: ProbeResults = { ...allUp, spendrr: { up: false, lnaddrOk: false } };
    const s = run([allUp, bad, noSpendrr(allUp), noSpendrr(allUp), noSpendrr(allUp)]);
    expect(s.components.spendrr.status).toBe("ok");
    expect(s.components.lnaddr.status).toBe("ok");
    expect(s.incidents).toEqual([]);
    const twice = run([allUp, bad, noSpendrr(allUp), bad]);
    expect(twice.components.spendrr.status).toBe("down");
    expect(twice.components.lnaddr.status).toBe("down");
  });

  describe("with the app's report", () => {
    const expected = (r: ProbeResults): ProbeResults => ({ ...r, reportsExpected: true });

    // One report before each of the rounds given, then the round itself.
    function withReports(rounds: [ProbeResults, StatusReport | null][]): State {
      let s: State | null = null;
      rounds.forEach(([r, report], i) => {
        const t = T0 + i * MIN;
        if (report) s = acceptReport(s, { ...report, at: t - 1000 }, t - 1000);
        s = applyProbes(s, r, t);
      });
      return s as unknown as State;
    }

    it("push: ok with the relay, degraded without, down without VAPID", () => {
      const ok = withReports([[expected(allUp), goodReport(0)]]);
      expect(ok.components.push.status).toBe("ok");
      const noRelay = { ...goodReport(0), relay: false };
      const s = withReports([[expected(allUp), goodReport(0)], [expected(allUp), noRelay], [expected(allUp), noRelay]]);
      expect(s.components.push.status).toBe("degraded");
      const noVapid = { ...goodReport(0), pushConfigured: false };
      const down = withReports([[expected(allUp), goodReport(0)], [expected(allUp), noVapid], [expected(allUp), noVapid]]);
      expect(down.components.push.status).toBe("down");
    });

    it("one report counts once, however many minutes it is reused", () => {
      const noRelay = { ...goodReport(0), relay: false };
      const s = withReports([
        [expected(allUp), goodReport(0)],
        [expected(allUp), noRelay],
        [expected(noSpendrr(allUp)), null],
        [expected(noSpendrr(allUp)), null],
      ]);
      expect(s.components.push.status).toBe("ok");
    });

    it("push is down once reports stop arriving", () => {
      let s = withReports([[expected(allUp), goodReport(0)]]);
      const late = T0 + REPORT_STALE_MS + 2 * MIN;
      s = applyProbes(s, expected(noSpendrr(allUp)), late);
      s = applyProbes(s, expected(noSpendrr(allUp)), late + MIN);
      expect(s.components.push).toMatchObject({ status: "down", since: late });
    });

    it("without a configured key, a missing report says nothing", () => {
      const s = run([allUp, noSpendrr(allUp)], null);
      const later = applyProbes(applyProbes(s, noSpendrr(allUp), T0 + REPORT_STALE_MS + MIN), noSpendrr(allUp), T0 + REPORT_STALE_MS + 2 * MIN);
      expect(later.components.push.status).toBe("unknown");
    });

    it("the Lightning address follows node, kill switch and failing invoices", () => {
      for (const bad of [{ lnNode: false }, { lnRefusing: true }, { lnInvoicesFailing: true }]) {
        const report = { ...goodReport(0), ...bad };
        const s = withReports([[expected(allUp), goodReport(0)], [expected(allUp), report], [expected(allUp), report]]);
        expect(s.components.lnaddr.status).toBe("down");
      }
    });

    it("spendrr is degraded when names or backups fail", () => {
      const report = { ...goodReport(0), backups: false };
      const s = withReports([[expected(allUp), goodReport(0)], [expected(allUp), report], [expected(allUp), report]]);
      expect(s.components.spendrr.status).toBe("degraded");
    });

    it("an older or replayed report is ignored", () => {
      let s = acceptReport(null, goodReport(T0), T0);
      s = acceptReport(s, { ...goodReport(T0), relay: false }, T0 + MIN);
      expect(s.report?.report.relay).toBe(true);
      expect(s.report?.receivedAt).toBe(T0);
    });
  });

  it("drops incidents older than the history window, keeps open ones", () => {
    let s = run([allUp, arkDown, arkDown, allUp, allUp]);
    s = applyProbes(s, allUp, T0 + HISTORY_MS + 10 * MIN);
    expect(s.incidents).toEqual([]);
  });

  it("the public snapshot has no text and no extra fields", () => {
    const snap = toPublic(run([allUp, arkDown, arkDown]));
    expect(Object.keys(snap).sort()).toEqual(["checkedAt", "components", "dataFrom", "incidents", "knownFrom", "nextRoundAt", "v"]);
    for (const i of snap.incidents) expect(Object.keys(i).sort()).toEqual(["c", "from", "s", "to"]);
  });

  it("hand-recorded incidents come first, flagged, and age out with the history", () => {
    const recorded = [{ c: "ark" as const, s: "down" as const, from: T0 - 3 * 60 * MIN, to: T0 - 10 * MIN, r: true as const }];
    const snap = toPublic(run([allUp, arkDown, arkDown]), recorded);
    expect(snap.incidents[0]).toEqual(recorded[0]);
    expect(snap.incidents.slice(1).every((i) => !("r" in i))).toBe(true);
    const later = applyProbes(run([allUp]), allUp, T0 + HISTORY_MS);
    expect(toPublic(later, recorded).incidents).toEqual([]);
  });

  it("a hand-recorded known start counts only if it is earlier than the checks", () => {
    const s = run([allUp]);
    expect(toPublic(s, [], { ark: T0 - 60 * MIN }).knownFrom).toEqual({ ark: T0 - 60 * MIN });
    expect(toPublic(s, [], { ark: T0 + MIN }).knownFrom).toEqual({});
  });

  it("random probe and report sequences keep the invariants", () => {
    const round = fc.record({
      probes: fc.record({
        ark: fc.record({ up: fc.boolean(), nextRoundAt: fc.option(fc.integer({ min: T0 - 60 * MIN, max: T0 + 60 * MIN }), { nil: null }) }),
        chainPrimary: fc.option(fc.integer({ min: 899_990, max: 900_000 }), { nil: null }),
        chainFallback: fc.option(fc.integer({ min: 899_990, max: 900_000 }), { nil: null }),
        spendrr: fc.option(fc.record({ up: fc.boolean(), lnaddrOk: fc.boolean() }), { nil: undefined }),
        reportsExpected: fc.constant(true),
      }),
      report: fc.option(
        fc.record({
          lnNode: fc.boolean(),
          lnRefusing: fc.boolean(),
          lnInvoicesFailing: fc.boolean(),
          relay: fc.boolean(),
          pushConfigured: fc.boolean(),
          names: fc.boolean(),
          backups: fc.boolean(),
        }),
        { nil: null },
      ),
      gapMin: fc.integer({ min: 1, max: 20 }),
    });
    fc.assert(
      fc.property(fc.array(round, { minLength: 1, maxLength: 150 }), (rounds) => {
        let s: State | null = null;
        let t = T0;
        for (const { probes, report, gapMin } of rounds) {
          t += gapMin * MIN;
          if (report) s = acceptReport(s, { v: 1, at: t - 1000, ...report }, t - 1000);
          s = applyProbes(s, probes as ProbeResults, t);
        }
        const st = s as unknown as State;
        for (const c of COMPONENTS) {
          const status = st.components[c].status;
          const open = st.incidents.filter((i) => i.c === c && i.to === null);
          // An open incident exactly when degraded or down, and of that status.
          expect(open.length).toBe(status === "degraded" || status === "down" ? 1 : 0);
          if (open[0]) expect(open[0].s).toBe(status);
          const mine = st.incidents.filter((i) => i.c === c);
          for (let k = 1; k < mine.length; k++) expect(mine[k].from).toBeGreaterThanOrEqual(mine[k - 1].to as number);
        }
        // Ark confirmed down means the Lightning address was confirmed down with it.
        if (st.components.ark.status === "down") expect(st.components.lnaddr.status).toBe("down");
      }),
    );
  });
});
