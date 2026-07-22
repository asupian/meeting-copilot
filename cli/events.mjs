#!/usr/bin/env node
// events.mjs — helpers over gws calendar-events JSON, for the `copilot` CLI.
// Zero dependencies. Events arrive on stdin (from `knowledge.sh events`).
//
//   list             numbered table of upcoming events
//   json <n>         event n's JSON object (piped into `knowledge.sh pack --paste`)
//   stem <n>         pack filename stem: YYYY-MM-DD[-HHMM]-<slug>
//   pack-stem        stem for an already-built pack (pack markdown on stdin)
//   match <dir> <h>  pick the pack in <dir> whose start time is closest to now
//                    within [now-20min, now+<h>h]; prints its path or nothing
//
// Slugging lives here on purpose: meeting titles carry spaces, emoji and
// slashes, and bash interpolation of raw titles into filenames is how those
// become bugs. ORG_DOMAIN (env, optional) marks external attendees in `list`.

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const [cmd, ...args] = process.argv.slice(2);

const slug = (title) =>
  String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "meeting";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}`;

// gws prints either {items:[...]} or a bare array.
function readEvents(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { die("could not parse events JSON on stdin"); }
  const evs = Array.isArray(parsed) ? parsed : parsed.items || [];
  if (!evs.length) die("no events in the input");
  return evs;
}

function pick(evs, arg) {
  const n = Number.parseInt(arg, 10);
  if (!Number.isInteger(n) || n < 1 || n > evs.length) die(`pick an event 1-${evs.length} (got: ${arg})`);
  return evs[n - 1];
}

function die(msg) { process.stderr.write(`events: ${msg}\n`); process.exit(1); }

function stemOf(ev) {
  // All-day events have start.date, timed ones start.dateTime.
  if (ev.start?.dateTime) {
    const d = new Date(ev.start.dateTime);
    return `${ymd(d)}-${hm(d)}-${slug(ev.summary)}`;
  }
  return `${ev.start?.date || ymd(new Date())}-${slug(ev.summary)}`;
}

function list(evs) {
  const org = (process.env.ORG_DOMAIN || "").toLowerCase();
  for (const [i, ev] of evs.entries()) {
    const att = ev.attendees || [];
    const others = att.filter((a) => !a.self);
    const ext = org && att.some((a) => a.email && !a.email.toLowerCase().endsWith(`@${org}`));
    let when = "all-day ";
    if (ev.start?.dateTime) {
      const s = new Date(ev.start.dateTime), e = ev.end?.dateTime && new Date(ev.end.dateTime);
      when = `${ymd(s)} ${pad(s.getHours())}:${pad(s.getMinutes())}${e ? `–${pad(e.getHours())}:${pad(e.getMinutes())}` : ""}`;
    }
    const flags = [
      others.length ? `${others.length} attendee${others.length > 1 ? "s" : ""}` : "solo",
      ...(ext ? ["external"] : []),
      ...(ev.start?.dateTime ? [] : ["all-day"]),
    ].join(", ");
    process.stdout.write(`${String(i + 1).padStart(2)}) ${when}  ${ev.summary || "(no title)"}  (${flags})\n`);
  }
  process.stdout.write(`\nbuild a pack:  copilot prep <n>\n`);
}

// Parse "YYYY-MM-DD[-HHMM]-<slug>.md" back into a start time. Date-only stems
// (all-day / --pick archives) count as matching the whole day, ranked last.
function stemTime(name) {
  const m = basename(name, ".md").match(/^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2}))?(?=-|$)/);
  if (!m) return null;
  const timed = m[4] !== undefined;
  return { at: new Date(+m[1], +m[2] - 1, +m[3], timed ? +m[4] : 0, timed ? +m[5] : 0), timed };
}

function match(dir, hours) {
  const now = Date.now();
  const lo = now - 20 * 60_000, hi = now + hours * 3_600_000;
  let best = null;
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { process.exit(1); }
  for (const f of files) {
    const t = stemTime(f);
    if (!t) continue;
    const dayMatch = !t.timed && ymd(new Date(now)) === ymd(t.at);
    if (!dayMatch && (t.at.getTime() < lo || t.at.getTime() > hi)) continue;
    const dist = t.timed ? Math.abs(t.at.getTime() - now) : Infinity; // timed always beats date-only
    if (!best || dist < best.dist) best = { f, dist };
  }
  if (!best) process.exit(1);
  process.stdout.write(join(dir, best.f) + "\n");
}

if (cmd === "match") {
  match(args[0], Number(args[1]) || 12);
} else {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    if (cmd === "pack-stem") {
      const m = raw.match(/^# Prep Pack — (.+?) — /m);
      if (!m) die("no '# Prep Pack — <title> — <date>' header on stdin");
      process.stdout.write(`${ymd(new Date())}-${slug(m[1])}\n`);
      return;
    }
    const evs = readEvents(raw);
    if (cmd === "list") list(evs);
    else if (cmd === "json") process.stdout.write(JSON.stringify(pick(evs, args[0]), null, 2) + "\n");
    else if (cmd === "stem") process.stdout.write(stemOf(pick(evs, args[0])) + "\n");
    else die("usage: events.mjs list|json <n>|stem <n>|pack-stem|match <dir> <hours>");
  });
}
