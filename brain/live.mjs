#!/usr/bin/env node
// live.mjs — low-latency live serving of suggestion cards.
//
// Latency design (speech -> visible question):
//   1. fs.watch on transcript.jsonl. No polling, no fixed tick.
//   2. Debounce ~1.2s of silence (a conversational beat) then check. A long
//      monologue still gets checked every --max-wait seconds.
//   3. One streamed `claude -p` call at a time. Speech arriving mid-call is
//      coalesced into the next check rather than spawning a parallel call
//      (parallel invocations also trip auth contention).
//   4. The question is pushed to the panel token-by-token as it streams, so it
//      appears at first-token rather than after the full JSON.
//
// Serves the panel over plain HTTP + Server-Sent Events (no dependencies):
//   GET  /            panel HTML
//   GET  /events      SSE stream: thinking | partial | card | silent
//   POST /feedback    {cardId, vote:"up"|"down"|"dismiss"} -> appended to
//                     feedback.jsonl AND consumed live: negative votes tighten
//                     the card cadence and raise the bar for similar cards
//                     (feedback only ever TIGHTENS — see feedbackGap/feedbackBlock)
//
// Usage: node brain/live.mjs [--transcript f] [--prep f] [--port 8787]

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync, watch, appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSystem, streamBrain, partialString, asrCaveat, CONFIG, USER_NAME } from "./lib.mjs";
import { parseFacts, matchGuard, matchWindow } from "./matcher.mjs";
import { makeAmbient, finishAmbient } from "./ambient.mjs";
import { makeRecall } from "./recall.mjs";
import { resolveOrigin, loadSheetMap } from "./origins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const has = (f) => argv.includes(f);

const CURRENT = join(homedir(), ".meeting-copilot", "current");
const TRANSCRIPT = val("--transcript", join(CURRENT, "transcript.jsonl"));
// Screen OCR feed from screentap: {"t","text","names"} per material change.
const SCREEN_FILE = val("--screen-file", join(CURRENT, "screen.jsonl"));
// The pack lives OUTSIDE current/: run.sh re-links current to a fresh session
// dir each start, which stranded packs written inside it.
const PREP = val("--prep", join(homedir(), ".meeting-copilot", "prep-pack.md"));
// contract.md is the eval-validated bar. experimental/contract-fast.md trades
// extended thinking for a visible `scan` field (~2s to first word instead of
// ~13s) but its bar is NOT yet validated — on the one fixture we have it either
// over-fires or goes mute depending on wording. Opt in with:
//   --contract experimental/contract-fast.md --think 0   (paths resolve against your cwd)
const CONTRACT = val("--contract", join(HERE, "contract.md"));
const PORT = Number(val("--port", 8787));
const DEBOUNCE_MS = Number(val("--debounce", 900));
const MAX_WAIT_MS = Number(val("--max-wait", 15)) * 1000;
const CAP = Number(val("--cap", 20));   // opine freely; the model is still the bar
const MIN_GAP_SEC = Number(val("--min-gap", 0));  // removed by default — the model self-limits
const MODEL = val("--model", null);
// null = inherit the model default (thinking on). --think 0 disables it: much
// faster to first word, but only usable with a contract that makes the model do
// its cross-referencing explicitly (see experimental/contract-fast.md).
const THINK = argv.includes("--think") ? Number(val("--think", 0)) : null;
const FEEDBACK = join(CURRENT, "feedback.jsonl");
// Ambient listener + disclosure guard. Ambient is on by default: it is silent
// during the meeting and only materializes as the end-of-meeting digest and
// _staging raw-signal files. --no-staging keeps the digest but skips the repo.
const AMBIENT_ON = !has("--no-ambient");
const NO_STAGING = has("--no-staging");
// Live recall: cross-reference the room against ALL of the knowledge dir's
// records via the local qmd search engine, off the card critical path.
// --no-recall disables it.
const RECALL_ON = !has("--no-recall");
const QMD_BIN = val("--qmd", "qmd");
// Chart vision: OCR can't see a chart's SHAPE, only its labels. When a slide
// settles, one vision pass reads the saved frame image and describes any
// charts (metric, direction, inflections); the read feeds the next checks.
// PRIVACY: this sends the slide IMAGE through claude -p — the same trust
// boundary the transcript text already crosses. --no-vision disables it.
const VISION_ON = !has("--no-vision");
// The "me" channel is the MIC. Three modes for what the mic means:
//   --headphones : mic is reliably the user (no speaker echo). Keep every mic line.
//   --room       : in-person / no call. Mic is unidentified room audio ("Mic"),
//                  kept but never attributed to the user.
//   default (ptt): a live call played through speakers. The mic is then a garbled
//                  ECHO of the remote side (which the system-audio tap already has
//                  cleanly) PLUS the user's own voice, with no way to tell them apart
//                  by audio. So the user marks their own turns: they hold the panel's
//                  "hold to talk" button while speaking. Mic lines inside a held
//                  window are the user; mic lines outside it are echo and get dropped.
const HEADPHONES = has("--headphones");
const MODE = HEADPHONES ? "headphones" : has("--room") ? "room" : "ptt";
// The knowledge root: where recall searches, the roster lives, and the digest
// lands. Resolution: --knowledge flag > KNOWLEDGE_DIR in ~/.meeting-copilot/
// config > the portable default. --staging-root is a back-compat alias.
const KNOWLEDGE_ROOT = val("--knowledge",
  val("--staging-root", CONFIG.KNOWLEDGE_DIR || join(homedir(), ".meeting-copilot", "knowledge")));

// Push-to-talk windows (ptt mode only). A held button opens a window; release
// closes it. A mic line whose timestamp falls in any window (+/- grace, for ASR
// segment slop) is the user; otherwise it is echo of the remote side.
let talking = false;
let talkOpenedAt = null;
const talkWindows = [];              // {start, end} epoch ms
// Asymmetric grace. Lead: you sometimes press a beat AFTER you start talking, so
// catch a final whose timestamp lands just before the press. Trail: kept small on
// purpose -- you release when you are DONE, so a wide trailing pad would just let
// the remote echo back in (the exact thing ptt exists to stop). It only absorbs
// the ASR emit-lag on the last word you were saying at release.
const TALK_LEAD_MS = 2500;
const TALK_TRAIL_MS = 750;
const TALK_MAX_MS = 180000;          // safety: auto-release a stuck-open window
function micIsUser(ts) {
  if (MODE !== "ptt") return true;   // headphones/room handled by resolveWho
  if (talking) return true;          // window open now -> this mic line is the user
  for (const w of talkWindows)
    if (ts >= w.start - TALK_LEAD_MS && ts <= w.end + TALK_TRAIL_MS) return true;
  return false;
}
// Who a line belongs to, and whether to keep it. Returns null to DROP (echo).
function resolveWho(l) {
  if (l.ch !== "me") return "Them";
  if (MODE === "headphones") return USER_NAME;
  if (MODE === "room") return "Mic";
  return micIsUser(Date.parse(l.t) || Date.now()) ? USER_NAME : null;  // ptt
}
function setTalking(on) {
  if (on === talking) return;
  if (on) { talking = true; talkOpenedAt = Date.now(); }
  else {
    talking = false;
    if (talkOpenedAt) {
      talkWindows.push({ start: talkOpenedAt, end: Date.now() });
      if (talkWindows.length > 300) talkWindows.shift();
    }
    talkOpenedAt = null;
  }
  broadcast({ type: "talk", on: talking });
}

const SYSTEM = loadSystem(CONTRACT, PREP);
const PREP_TEXT = existsSync(PREP) ? readFileSync(PREP, "utf8") : "";
// Guard facts: [INTERNAL]/[SENSITIVE] lines. Armed when the pack says the
// meeting has externals, or explicitly with --externals.
const FACTS = parseFacts(PREP_TEXT);
const extLine = (PREP_TEXT.match(/^External attendees:\s*(.+)$/im) || [, ""])[1].trim();
const EXTERNALS = has("--externals") || (extLine !== "" && !/^none\b/i.test(extLine));
const MEETING_TITLE = (PREP_TEXT.match(/^# Prep Pack — (.+?) —/m) || [, "meeting"])[1];
const ambient = AMBIENT_ON ? makeAmbient({
  model: MODEL,
  getVisibleNames: () => screenNames,
  getScreenText: () => (screenAtMs && Date.now() - screenAtMs < 90_000 ? screenText : ""),
}) : null;
const guardShown = new Set();
const recentFinals = [];   // last ~60 final lines, for the guard window
const txRing = [];         // last ~10 lines for panel connect-backlog
let lastTopicLabels = [];
// Screen state: what's visible right now (slides/docs) + participant names.
let screenText = "";
let screenGistNow = "";    // interpreted gist for the panel (toolbar noise dropped)
let screenNames = [];
let screenSpeaker = "";    // active speaker: largest standalone-name tile label
let screenAtMs = 0;
let chartRead = "";        // vision pass: what the slide's charts show
let chartReadAtMs = 0;     // the screen state it was read for
let visionInFlight = false;
let visionTimer = null;
let screenOff = false;     // screentap alive but no meeting window on screen
let screenOffReason = "";  // e.g. permission failure, surfaced on the panel
let screenConsumed = 0;
const screenRing = [];     // recent screen lines, folded into topics + guard
if (EXTERNALS) console.error(`live: disclosure guard ARMED (${FACTS.filter(f=>f.gated||f.internal).length} gated/internal fact(s))`);
// Live recall over the whole repo. onStrong is the feather of C: a strong, fresh
// ground-truth hit prompts a card now instead of waiting for the next beat.
// Known sheet name -> spreadsheet ID, for resolving `sheet:` descriptors to
// real Google Sheets URLs on cards.
const SHEET_MAP = loadSheetMap(join(KNOWLEDGE_ROOT, "_shared", "data-sources.md"));
const recall = RECALL_ON ? makeRecall({
  qmdBin: QMD_BIN, cwd: KNOWLEDGE_ROOT, packText: PREP_TEXT, externals: EXTERNALS,
  onStrong: (f) => { console.error(`recall: strong hit -> ${f.short} (${f.score}%)`); scheduleCheck(0); },
}) : null;

// ---------- SSE clients ----------
const clients = new Set();
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

// ---------- meeting state ----------
let consumed = 0;              // transcript lines already sent to the brain
let pending = [];              // lines seen but not yet checked
let firstPendingAt = null;
let inFlight = false;
let dirty = false;             // speech arrived while a call was running
let rollingSummary = "(meeting just started)";
let lastNow = null;            // latest {topic, speakers, slides, goal, bearing, note}
let adoptedSlides = "";        // pinned slide-summary wording for the current screen
let adoptedSlidesAt = 0;
const surfaced = [];
const cardTimes = [];
const cardById = new Map();    // id -> question, so feedback can name what was voted on
const votes = new Map();       // cardId -> {vote, atMs}; latest vote per card wins
let startEpoch = null;
let debounceTimer = null;
let screenKick = false;        // a slide flip may run a check without new speech
let lastCheckDoneAt = 0;

// ---------- capture health ----------
// "listening" must mean "audio is actually flowing", not "SSE is connected".
// Two signals: is the meetingtap process alive, and when did the last transcript
// line arrive. Lines within 10s count as capturing even without the process
// (replay/testing feeds the file directly).
let lastHeardAt = 0;
let captureAlive = false;
let lastBlip = 0;
function heardBlip() {
  const now = Date.now();
  if (now - lastBlip < 700) return;    // throttle: at most ~1 blip/s
  lastBlip = now;
  broadcast({ type: "heard" });
}
function pollCapture() {
  if (talking && talkOpenedAt && Date.now() - talkOpenedAt > TALK_MAX_MS) setTalking(false);
  execFile("pgrep", ["-x", "meetingtap"], (err) => {
    captureAlive = !err;
    const heardAgoS = lastHeardAt ? Math.round((Date.now() - lastHeardAt) / 1000) : null;
    const capturing = captureAlive || (heardAgoS != null && heardAgoS < 10);
    execFile("pgrep", ["-x", "screentap"], (serr) => {
      broadcast({ type: "capture", capturing, heardAgoS, screen: !serr });
    });
  });
}
setInterval(pollCapture, 3000);
setTimeout(pollCapture, 500);

function readNewLines() {
  if (!existsSync(TRANSCRIPT)) return [];
  const all = readFileSync(TRANSCRIPT, "utf8").split("\n").filter((l) => l.trim());
  const fresh = all.slice(consumed).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  consumed = all.length;
  return fresh;
}

function elapsedSec() {
  if (startEpoch == null) return 0;
  return Math.round((Date.now() - startEpoch) / 1000);
}

// ---------- feedback consumers ----------
// Feedback only ever TIGHTENS. Both consumers are exact no-ops with zero votes
// (block absent, gap 0), which is what keeps a feedback-free run — including
// the replay gate — byte-identical to a build without them.
function feedbackGap() {
  // Extra seconds of min-gap from recent negative votes. Upvotes only offset
  // negatives; they never lower the gap below --min-gap and never touch --cap.
  const now = Date.now();
  let net = 0;
  for (const { vote, atMs } of votes.values()) {
    if (now - atMs > 10 * 60_000) continue;              // 10-min recency window
    net += vote === "down" ? 1 : vote === "dismiss" ? 0.5 : -1;
  }
  return net >= 4 ? 180 : net >= 2 ? 90 : 0;
}

function feedbackBlock() {
  // Conditional block, not a contract line: same reasoning as asrCaveat — a
  // rule that only appears when relevant stays salient. Quotes only questions
  // the model itself wrote (newline-stripped, capped), so no user free text
  // reaches the prompt.
  if (!votes.size) return "";
  const q = (id) => String(cardById.get(id) || "").replace(/\s+/g, " ").slice(0, 120);
  const listOf = (v) => [...votes].filter(([, x]) => x.vote === v).map(([id]) => `- "${q(id)}"`);
  const down = listOf("down").slice(-5), dis = listOf("dismiss").slice(-5), up = listOf("up").slice(-3);
  return [
    `FEEDBACK ON EARLIER CARDS (${USER_NAME}'s votes on the cards above, this meeting):`,
    ...(down.length ? [`Downvoted — not worth the interruption:`, ...down] : []),
    ...(dis.length ? [`Dismissed (weak negative):`, ...dis] : []),
    ...(up.length ? [`Upvoted — the bar was right here:`, ...up] : []),
    `Read this as one-directional calibration of your bar: a new candidate that`,
    `resembles a downvoted or dismissed card (same fact, same angle, same kind of`,
    `trigger) must clear a HIGHER bar — surface it only if clearly stronger (a`,
    `harder trigger, a fresher fact, a live collision); when in doubt, stay silent.`,
    `Upvotes are NOT a request for more cards or looser grounding. Feedback never`,
    `lowers the bar: every card still cites a held fact, and silence stays correct.`,
  ].join("\n");
}

function buildUser(lines) {
  const delta = lines.length
    ? lines.map((l) => `${l.who === USER_NAME ? USER_NAME : "Them"}: ${l.text}`).join("\n")
    : "(no new speech — the shared screen changed)";
  const shown = surfaced.length ? surfaced.map((c, i) => `${i + 1}. ${c.question}`).join("\n") : "(none yet)";
  const fbBlock = feedbackBlock();
  const recallBlock = recall ? recall.render() : "";
  // What's visible on the shared screen right now (fresh within ~90s). OCR'd
  // on-device; only the text reaches this prompt.
  const screenFresh = screenAtMs && Date.now() - screenAtMs < 90_000;
  const screenBlock = screenFresh
    ? `ON SCREEN NOW (on-device OCR of the meeting window — shared slides/docs and participant tiles. OCR'd digits are far more reliable than spoken ones, but watch O/0 and l/1 swaps):\n${screenText.slice(0, 900)}` +
      (screenNames.length ? `\nParticipant names visible on screen: ${screenNames.join(", ")} (these people are in the meeting)` : "") +
      (chartRead && chartReadAtMs === screenAtMs ? `\nChart read (vision pass over the slide image): ${chartRead}` : "")
    : "";
  return [
    `Meeting elapsed: ~${Math.round(elapsedSec() / 60)} min.`,
    ``,
    `Rolling summary so far:\n${rollingSummary}`,
    ``,
    `Cards already shown to ${USER_NAME} (do NOT repeat these or minor variants):\n${shown}`,
    ...(fbBlock ? [``, fbBlock] : []),
    ``,
    `New transcript since last check:\n${delta}${asrCaveat(delta)}`,
    ...(screenBlock ? [``, screenBlock] : []),
    ...(recallBlock ? [``, recallBlock] : []),
    ``,
    `Decide: stay silent, or surface ONE grounded card. Always return the \`now\` object (current topic, confirmed speakers, goal bearing) and an updated one-paragraph rolling summary.`,
    ``,
    // Without extended thinking the model drifts to prose; this holds it to JSON.
    `Respond with ONLY the JSON object. Begin your reply with { and end with }. No prose before or after, no markdown fences.`,
  ].join("\n");
}

let cardSeq = 0;

async function check() {
  if (inFlight) { dirty = true; return; }
  if (!pending.length && !screenKick) return;
  screenKick = false;
  const lines = pending;
  pending = [];
  firstPendingAt = null;
  inFlight = true;

  // Cap and min-gap depend only on elapsed time and prior card times, both known
  // BEFORE the model runs. Decide now, so we never stream a question into the
  // panel and then yank it away when the card turns out to be suppressed.
  const nowPre = elapsedSec();
  const lastPre = cardTimes.length ? cardTimes[cardTimes.length - 1] : -Infinity;
  // Recent negative feedback widens the effective gap (never narrows it).
  const gapSec = Math.max(MIN_GAP_SEC, feedbackGap());
  const withinGap = nowPre - lastPre < gapSec;
  const atCap = cardTimes.filter((t) => nowPre - t <= 30 * 60).length >= CAP;
  const canShow = !withinGap && !atCap;

  // Still run the call when suppressed: it keeps the rolling summary current.
  if (canShow) broadcast({ type: "thinking" });
  let lastQ = "";
  let lastTopicPartial = "";

  const { json: parsed, raw, firstTokenMs, totalMs } = await streamBrain({
    system: SYSTEM,
    user: buildUser(lines),
    model: MODEL,
    thinkTokens: THINK,
    onDelta: (acc) => {
      if (canShow) {
        const q = partialString(acc, "question");
        if (q && q !== lastQ) { lastQ = q; broadcast({ type: "partial", question: q }); }
      }
      // The NOW topic streams too — no reason for the strip to wait for the
      // full JSON when the field is already sitting in the accumulator.
      const tp = partialString(acc, "topic");
      if (tp && tp !== lastTopicPartial) { lastTopicPartial = tp; broadcast({ type: "now", partial: true, topic: tp.slice(0, 90) }); }
    },
  });

  inFlight = false;
  lastCheckDoneAt = Date.now();

  // A question the user WATCHED STREAM IN must not silently vanish because the
  // full JSON failed to parse. Salvage the card's flat fields from the raw
  // stream (question + source are the grounding bar; followups/now are lost).
  let json = parsed;
  if (!json && raw) {
    const q = partialString(raw, "question");
    const src = partialString(raw, "source");
    if (q && src) {
      json = {
        action: "card", question: q, source: src,
        why: partialString(raw, "why") || "",
        risk: partialString(raw, "risk") || "",
        win: partialString(raw, "win") || "",
        summary: partialString(raw, "summary") || "",
      };
    }
    console.error(`brain: JSON parse failed (${raw.length} chars) — ${json ? "salvaged card from stream" : "no card fields, dropping"}; tail: ...${raw.slice(-140).replace(/\n/g, " ")}`);
  }

  if (json?.summary) rollingSummary = json.summary;
  // Live readout: current topic, confirmed speakers, goal bearing. Arrives with
  // every response, silent ones included, so the panel tracks the conversation
  // even when no card clears the bar.
  if (json?.now?.topic) {
    // The model re-words the slide summary on every check; pin the wording per
    // slide so the SLIDES row is stable — adopt a new summary only when the
    // screen actually changed since the last adoption.
    let slides = json.now.slides ? String(json.now.slides).slice(0, 500) : "";
    if (slides && screenAtMs) {
      if (adoptedSlidesAt === screenAtMs && adoptedSlides) slides = adoptedSlides;
      else { adoptedSlides = slides; adoptedSlidesAt = screenAtMs; }
    }
    lastNow = {
      topic: String(json.now.topic).slice(0, 90),
      speakers: Array.isArray(json.now.speakers) ? json.now.speakers.slice(0, 6) : [],
      slides,
      goal: json.now.goal || null,
      bearing: ["advances", "risks", "neutral"].includes(json.now.bearing) ? json.now.bearing : "neutral",
      note: String(json.now.note || "").slice(0, 140),
    };
    broadcast({ type: "now", ...lastNow });
  }

  if (json?.action === "card" && json.question) {
    const now = elapsedSec();
    if (!canShow) {
      // Nothing was streamed, so nothing to retract — just log why it was held.
      console.error(`brain: card suppressed (${withinGap ? `${gapSec > MIN_GAP_SEC ? "feedback " : ""}min-gap ${gapSec}s` : `cap ${CAP}/30min`}): ${json.question.slice(0, 50)}`);
    } else {
      // Which channel found the anchor: a recall fact's kw/vec/kw+vec, or the
      // prep pack when the source doesn't trace to the recall working set.
      const anchor = recall?.attribute(json.source);
      // The ORIGINAL artifact behind the fact (Google Doc/Sheet, email, Slack),
      // resolved from provenance descriptors in the cited text. The knowledge
      // file stays as the fallback link — it holds the verbatim quote.
      const origin = resolveOrigin(json.source, SHEET_MAP) ||
                     (anchor ? resolveOrigin(anchor.text, SHEET_MAP) : null) ||
                     resolveOrigin(json.why, SHEET_MAP);
      const card = {
        type: "card",
        id: `c${++cardSeq}`,
        question: json.question,
        why: json.why || "",
        source: json.source || "",
        risk: json.risk || "",
        win: json.win || "",
        followups: Array.isArray(json.followups) ? json.followups.filter((f) => typeof f === "string").slice(0, 3) : [],
        via: anchor ? anchor.via : "pack",
        // Where the src line links: the anchoring record, or the prep pack.
        // Inline paths in the text get their own links panel-side.
        link: anchor ? anchor.path : "PREP",
        origin: origin || undefined,   // {kind, label, url, exact} when resolvable
        atSec: now,
        firstTokenMs,
        totalMs,
      };
      surfaced.push({ question: card.question });
      cardById.set(card.id, card.question);
      cardTimes.push(now);
      broadcast(card);
      const rule = "─".repeat(58);
      const stakes = (card.risk ? `\n   ⚠ risk: ${card.risk}` : "") + (card.win ? `\n   ✦ win: ${card.win}` : "");
      const fups = card.followups.length ? `\n   ↳ then: ${card.followups.join("  |  ")}` : "";
      process.stdout.write(`\n${rule}\n💡 ${card.question}\n   why: ${card.why}\n   src: ${card.source}${stakes}${fups}\n   [via ${card.via}, first token ${firstTokenMs}ms, full ${totalMs}ms]\n${rule}\n`);
    }
  } else {
    broadcast({ type: "silent" });
  }

  if (dirty) { dirty = false; scheduleCheck(0); }
}

function scheduleCheck(delay = DEBOUNCE_MS) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(check, delay);
}

let lastTopicKey = "";
function updateTopics(freshLines = []) {
  const hits = matchWindow(recentFinals.concat(freshLines, screenRing), FACTS, { windowSec: 30, minScore: 1.1, max: 2 });
  const labels = [...new Set(hits.map((h) => h.fact.label))];
  const key = labels.join("|");
  if (key !== lastTopicKey) { lastTopicKey = key; lastTopicLabels = labels; broadcast({ type: "topics", labels }); }
}

function runGuard() {
  if (!EXTERNALS) return;
  // Speech AND screen both count: a slide showing an internal-only number with
  // externals present is exactly the moment to warn.
  for (const g of matchGuard(recentFinals.concat(screenRing), FACTS)) {
    if (guardShown.has(g.fact.id)) continue;
    guardShown.add(g.fact.id);
    console.error(`⚠ guard: approaching internal-only territory: ${g.fact.text.slice(0, 70)}`);
    broadcast({ type: "guard", fact: g.fact.text.replace(/\[(INTERNAL|SENSITIVE|CONFIDENTIAL)\]\s*/gi, ""), via: g.why });
  }
}

// ---------- fuzzy speaker matching ----------
// screentap only reports EXACT full-name hits, but OCR garbles small tile/slide
// text ("Speaker: Jordan Le. Sameer" for "Jordan, Lee, Samir"), so only large
// clean labels matched. Re-match here with tolerance, tiered to stay precise:
// exact full name > capitalized surname > unique first name > edit-distance vs
// capitalized tokens (1 for ≥5 chars, 2 for ≥7). Capitals matter: they keep
// "Lee Park" matchable while "park entrance" stays a phrase.
const ROSTER = (() => {
  try {
    return readFileSync(join(KNOWLEDGE_ROOT, "people", "index.yaml"), "utf8")
      .split("\n").map((l) => l.match(/^ name: (.+)$/)?.[1]?.replace(/'/g, "").trim())
      .filter(Boolean).filter((n) => n.length >= 4 && !/pending/i.test(n));
  } catch {}
  // Portable layout: no index.yaml — read `name:` from each profile's frontmatter.
  try {
    return readdirSync(join(KNOWLEDGE_ROOT, "people"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          return readFileSync(join(KNOWLEDGE_ROOT, "people", d.name, "profile.md"), "utf8")
            .match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
        } catch { return null; }
      })
      .filter(Boolean).filter((n) => n.length >= 4);
  } catch { return []; }
})();
const FIRST_COUNTS = {};
const LAST_COUNTS = {};
for (const n of ROSTER) {
  const parts = n.toLowerCase().split(" ");
  FIRST_COUNTS[parts[0]] = (FIRST_COUNTS[parts[0]] || 0) + 1;
  if (parts.length > 1) { const l = parts[parts.length - 1]; LAST_COUNTS[l] = (LAST_COUNTS[l] || 0) + 1; }
}
// Every exact first/last name on the roster. A token that IS one of these must
// never fuzzy-match a DIFFERENT roster name, however close the spelling — a
// real name at edit distance 1 from another is still someone else.
const KNOWN_TOKENS = new Set(ROSTER.flatMap((n) => n.toLowerCase().split(" ")));

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function namesInText(text) {
  const caps = [...new Set((String(text).match(/\b[A-Z][a-z]+\b/g) || []).map((t) => t.toLowerCase()))];
  const lower = String(text).toLowerCase();
  const out = [];
  for (const name of ROSTER) {
    const nl = name.toLowerCase();
    const parts = nl.split(" ");
    const single = parts.length === 1;   // roster entries like "Jordan" (no surname on file)
    const first = parts[0], last = parts[parts.length - 1];
    let hit = lower.includes(nl);                                              // exact full name
    // Surname alone only when it's UNIQUE on the roster — a surname three
    // people share needs the first name on screen too.
    if (!hit && !single && LAST_COUNTS[last] === 1 && last.length >= 5 && caps.includes(last)) hit = true;
    if (!hit && !single && last.length >= 4 && caps.includes(last) && caps.includes(first)) hit = true;
    if (!hit && FIRST_COUNTS[first] === 1 && first.length >= 4 && caps.includes(first)) hit = true;  // unique first name
    if (!hit) {
      for (const t of caps) {                                                  // OCR-garble tolerance
        if (KNOWN_TOKENS.has(t) && t !== first && t !== last) continue;        // a real name never drifts to another
        const dl = !single && LAST_COUNTS[last] === 1 && last.length >= 5 ? lev(t, last) : 9;
        const df = FIRST_COUNTS[first] === 1 && first.length >= 5 ? lev(t, first) : 9;
        const lim = (w) => (w.length >= 7 ? 2 : 1);
        if (dl <= lim(last) || df <= lim(first)) { hit = true; break; }
      }
    }
    if (hit) out.push(name);
  }
  return out;
}

// Interpret raw OCR into the content someone would say the screen "shows":
// keep sentence-like lines and lines carrying numbers; drop toolbar fragments
// ("Create PR", "1x", "Type / for commands"), lone words, and symbol noise.
function screenGist(rawText, windowTitle = "") {
  const titleTokens = new Set(
    windowTitle.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  );
  const lines = String(rawText).split("\n").map((l) =>
    // Meet's own chrome lives inside the meeting window: the clock and the
    // meeting code ("10:29 | jcq-frdo-mkr") are capture noise, not content.
    l.replace(/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?\b/gi, "")
     .replace(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/g, "")
     .replace(/^[\s|•·-]+|[\s|•·-]+$/g, "").trim()
  ).filter(Boolean);
  const content = lines.filter((l) => {
    if (/https?:\/\/|\.com\/|\.google\.com|\.io\/|\.net\//i.test(l)) return false;   // URLs = chrome
    const words = l.split(/\s+/).filter((w) => /[a-z]/i.test(w));
    // A line that's mostly the window title is the title bar / doc header
    // echoing back ("Business Review: ... - Recording"), not slide content.
    if (titleTokens.size >= 2 && words.length >= 3) {
      const inTitle = words.filter((w) => titleTokens.has(w.toLowerCase().replace(/[^a-z0-9]/g, ""))).length;
      if (inTitle / words.length >= 0.6) return false;
    }
    if (words.length >= 5) return true;                      // sentence-like
    return words.length >= 3 && /[%$]|\d{2,}/.test(l);       // short but carries a figure
  });
  return content.slice(0, 12).join(" · ").slice(0, 2400);
}

// One vision pass per settled slide: read the frame image screentap saves next
// to the feed, describe any charts. Off the card critical path; the result
// rides into subsequent checks' ON SCREEN block.
const FRAME = join(dirname(SCREEN_FILE), "frame.png");
async function runVision() {
  if (!VISION_ON || visionInFlight || !existsSync(FRAME)) return;
  const forAt = screenAtMs;
  if (!forAt || chartReadAtMs === forAt) return;   // already read this slide
  visionInFlight = true;
  try {
    const { json } = await streamBrain({
      system: 'You describe charts in a meeting-slide screenshot. Use the Read tool to open the image path you are given. Respond ONLY with JSON: {"chart":"1-2 sentences: metric, direction/trend, inflection points, rough magnitudes — only what is visibly on the chart"} or {"chart":null} when no chart/graph is visible. Never invent numbers.',
      user: `Read ${FRAME} and report. JSON only.`,
      tools: "Read",
      thinkTokens: 0,
      model: MODEL,
    });
    if (screenAtMs === forAt) {          // slide unchanged while we read
      chartRead = json?.chart ? String(json.chart).slice(0, 300) : "";
      chartReadAtMs = forAt;
      if (chartRead) console.error(`vision: chart read -> ${chartRead.slice(0, 80)}`);
    }
  } finally { visionInFlight = false; }
}

// The screen feed: a new line means the visible text materially changed (slide
// flip, new doc, roster change). Update state, fold into topics/guard/recall.
// It does NOT force a model check on its own — the ON SCREEN block rides along
// with the next speech-triggered check.
function onScreenChange() {
  if (!existsSync(SCREEN_FILE)) return;
  const all = readFileSync(SCREEN_FILE, "utf8").split("\n").filter((l) => l.trim());
  if (all.length <= screenConsumed) return;
  const fresh = all.slice(screenConsumed).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  screenConsumed = all.length;
  if (!fresh.length) return;
  const last = fresh[fresh.length - 1];
  if (last.off) {
    // No meeting window on screen (or capture failing): clear state so the
    // prompt drops its screen block and the panel reports honestly.
    screenText = ""; screenGistNow = ""; screenNames = []; screenAtMs = 0; screenOff = true;
    screenOffReason = last.reason || "";
    broadcast({ type: "screen", off: true, reason: screenOffReason });
    return;
  }
  screenOff = false;
  screenGistNow = screenGist(last.text || "", last.title || "");
  screenText = (last.text || "").replace(/\n/g, " · ");
  // screentap's exact matches + fuzzy re-match over the raw OCR (small tile
  // and slide text garbles; exact-only missed most speakers).
  screenNames = [...new Set([...(last.names || []), ...namesInText(last.text || "")])].slice(0, 6);
  // Active speaker: tile candidates are standalone-name OCR lines sorted by
  // text height — the speaker tile's label renders largest. First candidate
  // that resolves to exactly one roster name wins.
  screenSpeaker = "";
  for (const c of (Array.isArray(last.tiles) ? last.tiles : [])) {
    const m = namesInText(String(c.t || ""));
    if (m.length === 1) { screenSpeaker = m[0]; break; }
  }
  screenAtMs = Date.parse(last.t) || Date.now();
  // Stamp "now" so matchWindow's 30s window sees the flip as current.
  screenRing.push({ t: new Date().toISOString(), text: screenText.slice(0, 800) });
  if (screenRing.length > 4) screenRing.shift();
  recall?.nudge([{ text: screenText.slice(0, 600) }]);
  // Mirror to the panel — same honesty as the live transcript strip, but
  // interpreted: the CONTENT read off the screen (slides, figures, captions),
  // not toolbar noise.
  broadcast({ type: "screen", text: screenGistNow, names: screenNames, speaker: screenSpeaker });
  updateTopics();
  runGuard();
  // A slide flip during silence still deserves a summary (and possibly a card
  // on a presented number). Kick a check, throttled so a fast click-through of
  // slides costs one call, not one per slide.
  if (!inFlight && !pending.length && Date.now() - lastCheckDoneAt > 12_000) {
    screenKick = true;
    scheduleCheck(1500);
  }
  // Vision waits for the slide to settle (~4s without another change).
  clearTimeout(visionTimer);
  visionTimer = setTimeout(() => { runVision().catch(() => { visionInFlight = false; }); }, 4000);
}
if (existsSync(SCREEN_FILE)) watch(SCREEN_FILE, { persistent: false }, onScreenChange);
setInterval(onScreenChange, 3000);   // fs.watch misses appends on macOS; poll catches up

function onTranscriptChange() {
  const raw = readNewLines();
  if (raw.length) { lastHeardAt = Date.now(); heardBlip(); }  // any audio, echo included, proves capture is live
  // Resolve speaker and drop mic echo before anything else sees the line. In ptt
  // mode a mic line outside a held talk-window is the remote side bleeding back
  // through the speakers -- the system-audio tap already has it cleanly.
  const kept = [];
  for (const l of raw) {
    const who = resolveWho(l);
    if (who === null) continue;        // echo -> drop
    l.who = who;
    kept.push(l);
  }
  // Mirror what survived to the panel. A kept me-line is the user (ptt/headphones)
  // or unattributed room audio (room mode); Them is the remote side.
  for (const l of kept) {
    const disp = l.who === USER_NAME ? "you" : l.who === "Mic" ? "mic" : "them";
    const ch = l.who === "Them" ? "them" : "me";
    if (l.partial) broadcast({ type: "partial-line", ch, who: disp, text: l.text });
    else {
      broadcast({ type: "transcript", ch, who: disp, text: l.text });
      txRing.push({ ch, who: disp, text: l.text }); if (txRing.length > 10) txRing.shift();
    }
  }
  const fresh = kept.filter((l) => !l.partial);   // brain + guard + ambient use finals
  if (!fresh.length) return;

  // Topics = the pack-known facts the recent speech AND screen are touching.
  // Free (matcher, ~1ms), continuous. This is literally the copilot's
  // cross-reference, so it shows why a card does or does not fire.
  updateTopics(fresh);
  if (startEpoch == null) startEpoch = Date.parse(fresh[0].t) || Date.now();
  recall?.nudge(fresh);   // background loop picks this up on its own throttle
  for (const l of fresh) {
    ambient?.ingest(l);
    recentFinals.push(l);
  }
  if (recentFinals.length > 60) recentFinals.splice(0, recentFinals.length - 60);
  // Disclosure guard: code-only, instant, own budget (one nudge per fact).
  runGuard();
  if (!pending.length) firstPendingAt = Date.now();
  pending.push(...fresh);
  // Force a check if speech has been continuous past max-wait.
  if (firstPendingAt && Date.now() - firstPendingAt >= MAX_WAIT_MS) scheduleCheck(0);
  else scheduleCheck();
}

// Prime consumed offset so we don't replay a whole existing transcript on start.
if (existsSync(TRANSCRIPT) && !has("--from-start")) {
  consumed = readFileSync(TRANSCRIPT, "utf8").split("\n").filter((l) => l.trim()).length;
}
if (existsSync(TRANSCRIPT)) watch(TRANSCRIPT, { persistent: true }, onTranscriptChange);
else console.error(`live: waiting for ${TRANSCRIPT} to appear...`);
// fs.watch misses some appends on macOS; a slow safety poll catches stragglers.
setInterval(() => { if (existsSync(TRANSCRIPT)) onTranscriptChange(); }, 2000);

// ---------- HTTP + SSE ----------
const panelHtml = () => readFileSync(join(HERE, "..", "panel", "index.html"), "utf8");

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/index.html"))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(panelHtml());
    return;
  }
  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    res.write(`data: ${JSON.stringify({ type: "mode", mode: MODE })}\n\n`);
    for (const l of txRing) res.write(`data: ${JSON.stringify({ type: "transcript", ch: l.ch, who: l.who, text: l.text })}\n\n`);
    if (lastTopicLabels.length) res.write(`data: ${JSON.stringify({ type: "topics", labels: lastTopicLabels })}\n\n`);
    if (recall && recall.sources().length) res.write(`data: ${JSON.stringify({ type: "recall", sources: recall.sources() })}\n\n`);
    if (screenOff) res.write(`data: ${JSON.stringify({ type: "screen", off: true, reason: screenOffReason })}\n\n`);
    else if (screenAtMs && Date.now() - screenAtMs < 90_000)
      res.write(`data: ${JSON.stringify({ type: "screen", text: screenGistNow, names: screenNames, speaker: screenSpeaker })}\n\n`);
    if (lastNow) res.write(`data: ${JSON.stringify({ type: "now", ...lastNow })}\n\n`);
    if (talking) res.write(`data: ${JSON.stringify({ type: "talk", on: true })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST" && req.url === "/talk") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let state = "";
      try { state = String(JSON.parse(body).state || "").toLowerCase(); } catch {}
      setTalking(state === "down");
      res.writeHead(204).end();
    });
    return;
  }
  // Open a cited source. Two whitelisted shapes, nothing else:
  //   {p} — "PREP" or a repo-relative .md that resolves inside the repo, opened
  //         in the editor ("../..", absolute, non-md all rejected).
  //   {u} — an https URL (the fact's original artifact: doc/sheet/email/slack),
  //         opened in the browser. https only; no other scheme reaches `open`.
  if (req.method === "POST" && req.url === "/open") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let target = null;
      try {
        const { p, u } = JSON.parse(body);
        if (u != null) {
          if (/^https:\/\/[^\s]+$/.test(String(u))) target = String(u);
        } else if (String(p || "") === "PREP") target = PREP;
        else {
          const abs = resolve(KNOWLEDGE_ROOT, String(p || "").replace(/:\d+$/, ""));   // strip :line
          if (abs.startsWith(resolve(KNOWLEDGE_ROOT) + "/") && abs.endsWith(".md") && existsSync(abs)) target = abs;
        }
      } catch {}
      if (target) { execFile("open", [target]); res.writeHead(204).end(); }
      else res.writeHead(404).end();
    });
    return;
  }
  if (req.method === "POST" && req.url === "/feedback") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const fb = JSON.parse(body);
        if (typeof fb.cardId === "string" && ["up", "down", "dismiss"].includes(fb.vote)) {
          appendFileSync(FEEDBACK, JSON.stringify({ ...fb, at: new Date().toISOString() }) + "\n");
          // Only cards this session actually surfaced modulate behavior; a
          // stale id (panel reloaded against a restarted server) is logged only.
          if (cardById.has(fb.cardId)) votes.set(fb.cardId, { vote: fb.vote, atMs: Date.now() });
          console.error(`feedback: ${fb.vote} on ${fb.cardId}${cardById.has(fb.cardId) ? "" : " (unknown id — logged, not consumed)"}`);
        }
      } catch {}
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`live: port ${PORT} already in use. Another copilot is running — kill it (lsof -ti:${PORT} | xargs kill) or pass --port.`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  console.error(`live: panel http://127.0.0.1:${PORT}`);
  console.error(`live: watching ${TRANSCRIPT}`);
  console.error(`live: debounce ${DEBOUNCE_MS}ms, max-wait ${MAX_WAIT_MS / 1000}s, cap ${CAP}/30min${AMBIENT_ON ? ", ambient on" : ""}`);
  console.error(`live: mic mode ${MODE}${MODE === "ptt" ? " -- hold the panel's \"talk\" button while you speak (mic is otherwise dropped as speaker echo)" : ""}`);
  console.error(`live: recall ${RECALL_ON ? `on -- ${QMD_BIN} whole-repo, off critical path` : "off"}`);
});

// Ambient extraction runs on its own clock; flush() itself decides if enough
// meeting time (~150s) has accumulated. Fire-and-forget: a failed extraction
// only costs that chunk's signals.
if (ambient) setInterval(() => { ambient.flush().catch(() => ambient.state.errors++); }, 20_000);

// Recall runs its own throttled clock (it only hits qmd when speech has moved and
// the throttle has elapsed). After each tick, mirror the pulled sources to the
// panel so the user can see the whole-repo cross-reference is live.
let lastRecallKey = "";
if (recall) setInterval(async () => {
  await recall.tick().catch(() => recall.state.errors++);
  const src = recall.sources();
  const key = src.join("|");
  if (key !== lastRecallKey) { lastRecallKey = key; broadcast({ type: "recall", sources: src }); }
}, 3000);

// Ctrl-C = end of meeting: final extraction, digest to the session dir and the
// panel, raw signals into the knowledge dir (staging inboxes when they exist,
// else a meetings/ digest file — see writeStaging).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (ambient) {
      let digest = "", files = [];
      try {
        ({ digest, files } = await finishAmbient(ambient, {
          title: MEETING_TITLE,
          cards: surfaced.map((c, i) => ({ ...c, atSec: cardTimes[i] ?? 0 })),
          stagingRoot: NO_STAGING ? null : KNOWLEDGE_ROOT,
          mode: MODE,
        }));
      } catch (e) { console.error(`live: ambient finish failed: ${e.message}`); }
      if (digest) {
        const digestPath = join(dirname(TRANSCRIPT), "digest.md");
        try { appendFileSync(digestPath, digest); console.error(`live: digest -> ${digestPath}`); } catch {}
        process.stdout.write("\n" + digest);
        broadcast({ type: "digest", markdown: digest });
      }
      for (const f of files) console.error(`live: staging -> ${f}`);
      await new Promise((r) => setTimeout(r, 400));   // let the SSE digest land
    }
  } finally { process.exit(0); }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30); // keep alive
