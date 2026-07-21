// origins.mjs — resolve a fact's ORIGINAL artifact (Google Doc, email, Slack
// thread, sheet) from the provenance descriptors the knowledge dir's evidence
// lines carry.
//
// The curated files cite where each fact came from, but as descriptors,
// not links: `sheet:Q2-roadmap`, `email:Jordan "Roadmap review"`, `slack:#adops ...`.
// A card should hand the user the real artifact, not the index file, so this
// maps descriptor -> URL, honestly tiered:
//   explicit URL   -> exact
//   sheet:NAME     -> exact   (name -> spreadsheet ID via _shared/data-sources.md)
//   email:...      -> Gmail search on subject/sender; lands on the thread
//   slack:#chan .. -> Slack search with the query prefilled; best-effort,
//                     needs SLACK_BASE in ~/.meeting-copilot/config (the
//                     workspace URL) — without it slack: stays plain text
//   granola:/doc:/meeting: -> unresolvable for now; caller falls back to the
//                             knowledge file (which holds the verbatim quote).
//
// Every branch degrades to null when its integration is absent; the caller
// then keeps the plain-text src line, which is always honest.

import { readFileSync, existsSync } from "node:fs";
import { CONFIG } from "./lib.mjs";

// e.g. SLACK_BASE="https://yourco.enterprise.slack.com" (or yourco.slack.com)
const SLACK_BASE = (CONFIG.SLACK_BASE || "").replace(/\/+$/, "");

// data-sources.md lists known sheets as table rows: | Name | `ID` | notes |
export function loadSheetMap(dataSourcesPath) {
  const map = [];
  if (!dataSourcesPath || !existsSync(dataSourcesPath)) return map;
  const text = readFileSync(dataSourcesPath, "utf8");
  for (const m of text.matchAll(/^\|\s*([^|]+?)\s*\|\s*`([A-Za-z0-9_-]{25,})`/gm)) {
    map.push({ name: m[1].toLowerCase(), id: m[2] });
  }
  return map;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function sheetUrl(ref, sheetMap) {
  const want = norm(ref);
  if (!want) return null;
  // "q2 roadmap" should match "Q2 2026 product roadmap": every token present.
  // Refs often carry trailing noise ("sheet:Q1-roadmap 4/20 refresh"), so retry
  // with trailing tokens dropped until something matches.
  let tokens = want.split(" ");
  while (tokens.length) {
    const hit = sheetMap.find((s) => {
      const hay = norm(s.name);
      return tokens.every((t) => hay.includes(t));
    });
    if (hit) return `https://docs.google.com/spreadsheets/d/${hit.id}`;
    tokens = tokens.slice(0, -1);
  }
  return null;
}

function gmailUrl(ref) {
  // email:Sender "Subject"  |  email:"Subject" (Sender  |  email:free text
  const subject = (ref.match(/"([^"]{4,90})"/) || [])[1];
  const q = subject ? `subject:"${subject}"` : ref.replace(/["()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!q) return null;
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`;
}

function slackUrl(ref) {
  // slack:#channel Person Name 2026-06-05 ... -> search prefilled with
  // in:#channel + the person tokens. Dates dropped: Slack's search syntax for
  // dates is fussy and a near-miss hides the thread entirely.
  if (!SLACK_BASE) return null;
  const m = ref.match(/^#([a-z0-9_-]+)\s*(.*)$/i);
  if (!m) return null;
  const person = (m[2] || "").replace(/\d{4}-\d{2}-\d{2}.*$/, "").replace(/[|()"]/g, " ").replace(/\s+/g, " ").trim();
  const q = `in:#${m[1]}${person ? " " + person : ""}`;
  return `${SLACK_BASE}/search?query=${encodeURIComponent(q)}`;
}

// Find the first resolvable origin in a fact's text. Returns
// {kind, label, url, exact} or null.
export function resolveOrigin(text, sheetMap = []) {
  if (!text) return null;
  const s = String(text);

  const url = s.match(/https?:\/\/[^\s)"'`\]]+/);
  if (url) {
    let u = url[0].replace(/[.,;]+$/, "");
    const host = (u.match(/^https?:\/\/([^/]+)/) || [, ""])[1];
    return { kind: "url", label: host, url: u, exact: true };
  }

  const sheet = s.match(/\bsheet:([A-Za-z0-9 _-]+)/);
  if (sheet) {
    const u = sheetUrl(sheet[1], sheetMap);
    if (u) return { kind: "sheet", label: `sheet: ${sheet[1].trim().replace(/\s+\d.*$/, "")}`, url: u, exact: true };
  }

  const email = s.match(/\bemail:\s*([^|\n]{3,120})/);
  if (email) {
    const u = gmailUrl(email[1].trim());
    if (u) return { kind: "email", label: "email", url: u, exact: false };
  }

  const slack = s.match(/\bslack:(#[a-z0-9_-]+[^|\n]{0,60})/i);
  if (slack) {
    const u = slackUrl(slack[1].trim());
    if (u) return { kind: "slack", label: slack[1].trim().split(/\s+/)[0], url: u, exact: false };
  }

  return null;   // granola:/meeting:/doc: unresolvable -> caller keeps the file link
}
