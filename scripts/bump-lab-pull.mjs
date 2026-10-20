#!/usr/bin/env node
// Downloads every tap-recorder chunk (Settings → Záznamník ťuknutí, see
// src/lib/bump/bumpRecorder.ts) into bump-lab-data/ and prints a per-session
// summary. Already-downloaded objects are skipped.
//
//   node scripts/bump-lab-pull.mjs [baseUrl]
//
// Token: BUMP_LAB_TOKEN from the environment, else from .dev.vars.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE = process.argv[2] ?? "https://spendrr.app";
const OUT = "bump-lab-data";

function token() {
  if (process.env.BUMP_LAB_TOKEN) return process.env.BUMP_LAB_TOKEN;
  const line = readFileSync(".dev.vars", "utf8")
    .split("\n")
    .find((l) => l.startsWith("BUMP_LAB_TOKEN="));
  if (!line) throw new Error("BUMP_LAB_TOKEN not found");
  return line.slice("BUMP_LAB_TOKEN=".length).replace(/^"|"$/g, "").trim();
}

const headers = { Authorization: `Bearer ${token()}` };

async function list() {
  const all = [];
  let cursor = null;
  do {
    const res = await fetch(`${BASE}/api/bump/lab/list${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { headers });
    if (!res.ok) throw new Error(`list ${res.status}: ${await res.text()}`);
    const body = await res.json();
    all.push(...body.objects);
    cursor = body.cursor;
  } while (cursor);
  return all;
}

const objects = await list();
let fetched = 0;
for (const o of objects) {
  const path = join(OUT, o.key);
  if (existsSync(path)) continue;
  const res = await fetch(`${BASE}/api/bump/lab/get?key=${encodeURIComponent(o.key)}`, { headers });
  if (!res.ok) {
    console.error(`skip ${o.key}: ${res.status}`);
    continue;
  }
  const body = await res.json();
  body._server = o.meta;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
  fetched++;
}
console.log(`${objects.length} objects, ${fetched} new\n`);

// --- Summary ---------------------------------------------------------------
const root = join(OUT, "v1");
if (!existsSync(root)) process.exit(0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
for (const session of readdirSync(root).sort()) {
  for (const device of readdirSync(join(root, session)).sort()) {
    const dir = join(root, session, device);
    const files = readdirSync(dir).sort();
    const chunks = files.filter((f) => f !== "meta.json").map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const meta = files.includes("meta.json") ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : null;
    if (!chunks.length) continue;
    const first = chunks[0];
    const t = chunks.flatMap((c) => c.motion.t);
    const dts = t.slice(1).map((v, i) => v - t[i]).filter((d) => d > 0);
    const hits = chunks.flatMap((c) => c.hits);
    const hard = hits.filter((h) => h.strength === "hard").length;
    const soft = hits.length - hard;
    const model = first.device?.uaData?.model || (first.device?.ua?.match(/\(([^)]+)\)/)?.[1] ?? "?");
    const lin = chunks.some((c) => c.motion.ax.some((v) => v !== null));
    const compass = chunks.some((c) => c.orient.abs.includes(1) || c.orient.hd.some((v) => v !== null));
    const dur = t.length ? ((t[t.length - 1] - t[0]) / 1000).toFixed(1) : "0";
    const complete = chunks.some((c) => c.final) ? "" : " (INCOMPLETE)";
    console.log(
      `${session} ${device.slice(0, 6)} ${first.deviceName || model}${first.inCase ? " [obal]" : ""}  ${first.gesture}` +
        `  ${dur}s  ${Math.round(1000 / median(dts))}Hz  lin:${lin ? "y" : "n"} compass:${compass ? "y" : "n"}` +
        `  hits ${hard}h/${soft}s  count ${meta?.count ?? "?"}${first.note ? `  "${first.note}"` : ""}${complete}`,
    );
  }
}
