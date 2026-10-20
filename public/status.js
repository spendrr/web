// Status page (public/status.html). Reads the status Worker's snapshot
// (status/logic.ts, PublicSnapshot) and draws it. That Worker runs on another
// Cloudflare account, so its answer is checked against fixed lists and only
// ever reaches the page through textContent: the worst a taken-over status
// account can do here is show a wrong status, never its own words.
"use strict";

const STATUS_URL = "https://spendrr-status.spendrr-info.workers.dev/v1/status";
const REFRESH_MS = 60 * 1000;
// The Worker checks every minute; older than this and the page says so
// instead of showing the last known state as current.
const STALE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 90;
const MOBILE_DAYS = 30;
// A day bar turns red from this much downtime, amber below it.
const RED_DOWN_MS = 30 * 60 * 1000;

const COMPONENTS = [
  { id: "ark", name: "Ark server", hint: "by Second. Payments, coin refresh" },
  { id: "chain", name: "Blockchain data", hint: "mempool.second.tech, fallback mempool.space" },
  { id: "lnaddr", name: "Lightning address", hint: "name@spendrr.app" },
  { id: "push", name: "Payment notifications", hint: "Push" },
  { id: "spendrr", name: "Spendrr server", hint: "Backups, names" },
];
const STATUSES = ["ok", "degraded", "down", "unknown"];
const PILL = { ok: "Operational", degraded: "Degraded", down: "Down", unknown: "No data" };
const MARK = { ok: "✓", degraded: "!", down: "!", unknown: "?" };

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const isTime = (n) => Number.isSafeInteger(n) && n > 0;

// The snapshot with only what this page knows about, or null if it is not one.
function parseSnapshot(raw) {
  if (!raw || raw.v !== 2 || !isTime(raw.checkedAt) || !isTime(raw.dataFrom) || typeof raw.components !== "object") return null;
  const components = {};
  for (const c of COMPONENTS) {
    const v = raw.components[c.id];
    if (!v || !STATUSES.includes(v.status) || !isTime(v.since)) return null;
    components[c.id] = { status: v.status, since: v.since };
  }
  const incidents = (Array.isArray(raw.incidents) ? raw.incidents : []).filter(
    (i) =>
      i &&
      COMPONENTS.some((c) => c.id === i.c) &&
      (i.s === "degraded" || i.s === "down") &&
      isTime(i.from) &&
      (i.to === null || (isTime(i.to) && i.to >= i.from)) &&
      (i.r === undefined || (i.r === true && i.to !== null)),
  );
  const knownFrom = {};
  for (const c of COMPONENTS) {
    const t = raw.knownFrom && raw.knownFrom[c.id];
    if (isTime(t) && t < raw.dataFrom) knownFrom[c.id] = t;
  }
  // Optional: older snapshots have no round time.
  const nextRoundAt = isTime(raw.nextRoundAt) ? raw.nextRoundAt : null;
  return { checkedAt: raw.checkedAt, dataFrom: raw.dataFrom, knownFrom, components, incidents, nextRoundAt };
}

const fmtTime = (ms) => new Date(ms).toISOString().slice(11, 16);
const fmtDate = (ms) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const fmtPct = (v) => (v >= 100 ? "100" : v.toFixed(2)) + "%";

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// Downtime and degraded time of one component inside [from, to).
function badTime(snap, id, from, to, now) {
  let down = 0;
  let degraded = 0;
  for (const i of snap.incidents) {
    if (i.c !== id) continue;
    const t = overlap(i.from, i.to ?? now, from, to);
    if (i.s === "down") down += t;
    else degraded += t;
  }
  return { down, degraded };
}

// Since when a component's state is known: the first check, or earlier from
// logs entered by hand (a known start, or a recorded incident).
function knownFrom(snap, id) {
  let from = snap.knownFrom[id] ?? snap.dataFrom;
  for (const i of snap.incidents) if (i.r && i.c === id) from = Math.min(from, i.from);
  return from;
}

function dayInfo(snap, id, ago, now) {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS - ago * DAY_MS;
  const from = Math.max(dayStart, knownFrom(snap, id));
  const to = Math.min(dayStart + DAY_MS, now);
  if (to <= from) return { dayStart, covered: 0 };
  const { down, degraded } = badTime(snap, id, from, to, now);
  return { dayStart, covered: to - from, down, degraded };
}

function renderOverall(snap, now, failed) {
  const box = $("overall");
  box.replaceChildren();
  let mark = "unknown";
  let title;
  let sub = "";
  if (!snap) {
    title = failed ? "Status unavailable" : "Collecting the first data";
    sub = failed ? "The status could not be loaded. Try again in a minute." : "Checks started a moment ago.";
  } else if (now - snap.checkedAt > STALE_MS) {
    title = "Status unknown";
    sub = `Last check ${fmtDur(now - snap.checkedAt)} ago, at ${fmtTime(snap.checkedAt)} UTC.`;
  } else {
    const down = COMPONENTS.filter((c) => snap.components[c.id].status === "down");
    const degraded = COMPONENTS.filter((c) => snap.components[c.id].status === "degraded");
    const unknown = COMPONENTS.filter((c) => snap.components[c.id].status === "unknown");
    const since = (list) => Math.min(...list.map((c) => snap.components[c.id].since));
    if (down.length) {
      mark = "down";
      title = down.length === 1 ? `${down[0].name} down` : "Outage";
      sub = `Since ${fmtTime(since(down))} UTC. Your funds are safe.`;
    } else if (degraded.length) {
      mark = "degraded";
      title = degraded.length === 1 ? `${degraded[0].name} degraded` : "Partly degraded";
      sub = `Since ${fmtTime(since(degraded))} UTC. Your funds are safe.`;
    } else if (unknown.length) {
      title = "Collecting data";
      sub = `Last check ${fmtTime(snap.checkedAt)} UTC.`;
    } else {
      mark = "ok";
      title = "All systems operational";
      sub = `Last check ${fmtTime(snap.checkedAt)} UTC.`;
    }
  }
  const text = el("div");
  text.append(el("p", "st-overall-title", title), el("p", "st-overall-sub", sub));
  const markEl = el("div", `st-mark st-mark--${mark}`, MARK[mark]);
  markEl.setAttribute("aria-hidden", "true");
  box.append(markEl, text);
}

function renderServices(snap, now) {
  const box = $("services");
  box.replaceChildren();
  const stale = !snap || now - snap.checkedAt > STALE_MS;
  for (const c of COMPONENTS) {
    const status = stale ? "unknown" : snap.components[c.id].status;
    const row = el("div", "st-svc");

    const head = el("div", "st-svc-head");
    const name = el("span", "st-svc-name", c.name);
    name.append(el("span", "st-svc-hint", c.hint));
    head.append(name, el("span", `st-pill st-pill--${status}`, PILL[status]));
    row.append(head);

    const bars = el("div", "st-bars");
    const sums = { [DAYS]: { covered: 0, down: 0 }, [MOBILE_DAYS]: { covered: 0, down: 0 } };
    for (let ago = DAYS - 1; ago >= 0; ago--) {
      const d = snap ? dayInfo(snap, c.id, ago, now) : { covered: 0 };
      for (const n of [DAYS, MOBILE_DAYS]) {
        if (ago < n && d.covered) {
          sums[n].covered += d.covered;
          sums[n].down += d.down;
        }
      }
      let cls = d.covered === 0 ? "none" : d.down >= RED_DOWN_MS ? "down" : d.down > 0 || d.degraded > 0 ? "warn" : "";
      if (ago >= MOBILE_DAYS) cls += " old";
      const bar = el("i", cls.trim());
      bar.dataset.c = c.id;
      bar.dataset.ago = String(ago);
      bars.append(bar);
    }
    row.append(bars);

    for (const n of [DAYS, MOBILE_DAYS]) {
      const axis = el("div", `st-axis st-axis--${n === DAYS ? "wide" : "narrow"}`);
      const s = sums[n];
      const up = s.covered ? `${fmtPct(100 * (1 - s.down / s.covered))} uptime` : "No data yet";
      axis.append(el("span", "", `${n} days ago`), el("span", "st-up", up), el("span", "", "Today"));
      row.append(axis);
    }
    box.append(row);
  }
}

// Ark rounds: when the next one is due. The server moves the time forward
// after each round, so a time slightly in the past means one is running.
const ROUND_RUNNING_MS = 3 * 60 * 1000;
// Mainnet round_interval; only scales the pie, the countdown is exact.
const ROUND_INTERVAL_MS = 60 * 60 * 1000;
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderRound() {
  const box = $("round");
  const time = $("st-round");
  const now = Date.now();
  const snap = current;
  if (!snap || !snap.nextRoundAt || now - snap.checkedAt > STALE_MS || snap.components.ark.status === "down") {
    box.hidden = true;
    return;
  }
  const left = snap.nextRoundAt - now;
  let text;
  if (left > 0) text = fmtClock(left);
  else if (-left < ROUND_RUNNING_MS) text = "Starting";
  else text = `Overdue ${fmtDur(-left)}`;
  time.textContent = text;
  // The pie drains as the round approaches; overdue it is full and amber.
  const late = left <= -ROUND_RUNNING_MS;
  const frac = late ? 1 : Math.min(1, Math.max(0, left / ROUND_INTERVAL_MS));
  const ring = $("st-ring");
  ring.style.setProperty("--pie", `${Math.round(frac * 360)}deg`);
  ring.classList.toggle("st-pie--late", late);
  box.hidden = false;
}

function renderIncidents(snap, now) {
  const box = $("incidents");
  box.replaceChildren();
  if (!snap) return;
  const list = [...snap.incidents].sort((a, b) => b.from - a.from).slice(0, 20);
  if (!list.length) {
    box.append(el("p", "st-inc-when", `No incidents since ${fmtDate(snap.dataFrom)}.`));
    return;
  }
  for (const i of list) {
    const c = COMPONENTS.find((x) => x.id === i.c);
    const card = el("div", "st-card st-inc");
    const head = el("div", "st-inc-head");
    head.append(
      el("span", "st-inc-title", `${c.name} ${i.s === "down" ? "down" : "degraded"}`),
      i.to === null ? el("span", `st-pill st-pill--${i.s}`, "Ongoing") : el("span", "st-pill st-pill--ok", "Resolved"),
    );
    const when =
      i.to === null
        ? `${fmtDate(i.from)}, since ${fmtTime(i.from)} UTC · ${fmtDur(now - i.from)} so far`
        : `${fmtDate(i.from)}, ${fmtTime(i.from)} to ${fmtTime(i.to)} UTC · ${fmtDur(i.to - i.from)}`;
    card.append(head, el("p", "st-inc-when", when));
    if (i.r) card.append(el("p", "st-inc-when", "Reconstructed from logs and manual checks."));
    box.append(card);
  }
}

let current = null;

function render(snap, failed) {
  current = snap;
  const now = Date.now();
  renderOverall(snap, now, failed);
  renderServices(snap, now);
  renderRound();
  renderIncidents(snap, now);
}

// ---- day tooltip -------------------------------------------------------------

const tip = () => $("st-tip");

function showTip(bar) {
  const t = tip();
  const now = Date.now();
  const ago = Number(bar.dataset.ago);
  const d = current ? dayInfo(current, bar.dataset.c, ago, now) : { dayStart: Math.floor(now / DAY_MS) * DAY_MS - ago * DAY_MS, covered: 0 };
  const lines = [];
  if (!d.covered) lines.push("No data");
  else {
    if (d.down) lines.push(`Down ${fmtDur(d.down)}`);
    if (d.degraded) lines.push(`Degraded ${fmtDur(d.degraded)}`);
    if (!d.down && !d.degraded) lines.push("No downtime");
  }
  const title = d.covered ? `${fmtDay(d.dayStart)} · ${fmtPct(100 * (1 - d.down / d.covered))}` : fmtDay(d.dayStart);
  t.replaceChildren(el("b", "", title), el("span", "", lines.join(", ")));
  t.style.left = "0px"; // measured at full width, not squeezed against an edge
  t.classList.add("on");
  const r = bar.getBoundingClientRect();
  const w = t.offsetWidth;
  t.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  t.style.top = `${Math.max(8, r.top - t.offsetHeight - 8)}px`;
  document.querySelectorAll(".st-bars i.sel").forEach((e) => e.classList.remove("sel"));
  bar.classList.add("sel");
}

function hideTip() {
  tip().classList.remove("on");
  document.querySelectorAll(".st-bars i.sel").forEach((e) => e.classList.remove("sel"));
}

document.addEventListener("pointerover", (e) => {
  if (e.target instanceof Element && e.target.matches(".st-bars i")) showTip(e.target);
});
document.addEventListener("pointerout", (e) => {
  if (e.target instanceof Element && e.target.matches(".st-bars i")) hideTip();
});
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.matches(".st-bars i")) showTip(e.target);
  else hideTip();
});
addEventListener("scroll", hideTip, { passive: true });

// ---- theme -------------------------------------------------------------------

$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("spendrr-status-theme", next);
  } catch {}
});

// ---- loading -----------------------------------------------------------------

async function load() {
  try {
    const res = await fetch(STATUS_URL, { cache: "no-store" });
    if (res.status === 503) return render(null, false);
    if (!res.ok) throw new Error(String(res.status));
    const snap = parseSnapshot(await res.json());
    if (!snap) throw new Error("bad snapshot");
    render(snap, false);
  } catch {
    // Keep showing the last good snapshot: it turns "Status unknown" by itself once stale.
    render(current, current === null);
  }
}

load();
setInterval(load, REFRESH_MS);
setInterval(renderRound, 1000);
