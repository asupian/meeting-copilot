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

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync, watch, appendFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSystem, streamBrain, brainInFlight, partialString, buildCheckUser, capSummary, CONFIG, USER_NAME, CARD_TYPES, CARD_CAPS } from "./lib.mjs";
import { parseFacts, matchGuard, matchWindow } from "./matcher.mjs";
import { makeAmbient, finishAmbient } from "./ambient.mjs";
import { makeRecall } from "./recall.mjs";
import { resolveOrigin, loadSheetMap } from "./origins.mjs";
import { makeFeedback } from "./feedback.mjs";
import { makePanelServer } from "./server.mjs";

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
const CAP = Number(val("--cap", CARD_CAPS.live.cap));   // opine freely; the model is still the bar
const MIN_GAP_SEC = Number(val("--min-gap", CARD_CAPS.live.minGapSec));  // removed by default — the model self-limits
const MODEL = val("--model", null);
// null = inherit the model default (thinking on). --think 0 disables it: much
// faster to first word, but only usable with a contract that makes the model do
// its cross-referencing explicitly (see experimental/contract-fast.md).
const THINK = argv.includes("--think") ? Number(val("--think", 0)) : null;
const FEEDBACK = join(CURRENT, "feedback.jsonl");
// Per-check trace: prompt in, raw out, verdict — the only way a bad LIVE card
// is reconstructible (brain-loop has --trace; this is its always-on twin).
// Rides with the session; the ephemeral cleanup deletes it with the
// transcript unless --keep-session.
const TRACE = join(dirname(TRANSCRIPT), "trace.jsonl");
function traceCheck(entry) {
  try { appendFileSync(TRACE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}
// Cross-meeting feedback memory: a compact vote log surviving sessions.
// Consumed as a prompt seed only — never the mechanical gap — so a string of
// bad meetings can't mute a good one.
const FEEDBACK_HISTORY = join(homedir(), ".meeting-copilot", "feedback-history.jsonl");
// No transcription retention by default: the transcript/screen feeds are
// working files, deleted after the digest (the user records meetings through
// other means). --keep-session keeps them, for review-server or fixture-making.
const KEEP_SESSION = has("--keep-session");
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
// "Scheduled: 30 minutes" in the pack header feeds the elapsed-% hint the
// goal-late trigger leans on; packs without the line just omit the hint.
const SCHEDULED_SEC = (() => {
  const m = PREP_TEXT.match(/^Scheduled:\s*(\d+)\s*min/mi);
  return m ? Number(m[1]) * 60 : null;
})();
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

// ---------- panel transport ----------
// server.mjs owns HTTP/SSE mechanics; everything meeting-shaped stays here.
// The callbacks close over state declared below — they only run once the
// server is listening, well after module evaluation.
const { server, broadcast } = makePanelServer({
  port: PORT,
  panelPath: join(HERE, "..", "panel", "index.html"),
  // What a freshly connected panel needs to catch up on.
  snapshot: () => {
    const evs = [{ type: "mode", mode: MODE }];
    for (const l of txRing) evs.push({ type: "transcript", ch: l.ch, who: l.who, text: l.text });
    if (lastTopicLabels.length) evs.push({ type: "topics", labels: lastTopicLabels });
    if (recall && recall.sources().length) evs.push({ type: "recall", sources: recall.sources() });
    if (screenOff) evs.push({ type: "screen", off: true, reason: screenOffReason });
    else if (screenAtMs && Date.now() - screenAtMs < 90_000)
      evs.push({ type: "screen", text: screenGistNow, names: screenNames, speaker: screenSpeaker });
    if (lastNow) evs.push({ type: "now", ...lastNow });
    if (talking) evs.push({ type: "talk", on: true });
    return evs;
  },
  onTalk: (j) => setTalking(String(j?.state || "").toLowerCase() === "down"),
  // Open a cited source. Two whitelisted shapes, nothing else:
  //   {p} — "PREP" or a repo-relative .md that resolves inside the knowledge
  //         root ("../..", absolute, non-md all rejected).
  //   {u} — an https URL (the fact's original artifact); no other scheme
  //         reaches `open`.
  onOpen: (j) => {
    let target = null;
    try {
      const { p, u } = j || {};
      if (u != null) {
        if (/^https:\/\/[^\s]+$/.test(String(u))) target = String(u);
      } else if (String(p || "") === "PREP") target = PREP;
      else {
        const abs = resolve(KNOWLEDGE_ROOT, String(p || "").replace(/:\d+$/, ""));   // strip :line
        if (abs.startsWith(resolve(KNOWLEDGE_ROOT) + "/") && abs.endsWith(".md") && existsSync(abs)) target = abs;
      }
    } catch {}
    if (target) { execFile("open", [target]); return true; }
    return false;
  },
  onFeedback: (j) => {
    const r = fb.vote(j || {});
    if (r) console.error(`feedback: ${j.vote} on ${j.cardId}${r.known ? "" : " (unknown id — logged, not consumed)"}`);
  },
});

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

// Token-overlap similarity for the mid-flight dedup: cheap, no model call.
// Shared ≥4-char tokens over the smaller card's token set; 0.5 splits the
// observed dup pair (~0.58) from unrelated cards (near 0) with margin.
function similarCards(a, b) {
  const toks = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9$%]{4,}/g) || []);
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.5;
}
const cardTimes = [];
// Per-call numbers ONLY — no transcript, no prompt text, no questions. trace.jsonl
// carries the prompts and is deleted at shutdown with the transcript; this array
// is what survives into perf.json so "it got slower and then hung" can be read
// off a meeting afterwards instead of re-argued from memory.
const perfSamples = [];
// Votes in, tighten-only signals out, cross-meeting memory — see feedback.mjs.
const fb = makeFeedback({ userName: USER_NAME, logPath: FEEDBACK, historyPath: FEEDBACK_HISTORY });
let startEpoch = null;
let debounceTimer = null;
let screenKick = false;        // a slide flip may run a check without new speech
let lastCheckDoneAt = 0;
let brainFailures = 0;         // consecutive dead model calls (panel shows brainDown)

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

function droppedBlock() {
  // The one gap mode anchored on the meeting itself: questions the room let
  // drop. Only ambient tracks them; none open (or --no-ambient) is an exact
  // no-op — and brain-loop never builds this block, so the replay gate's
  // prompts stay byte-identical.
  if (!ambient) return "";
  const now = elapsedSec();
  const open = ambient.state.questions.filter((q) => {
    if (q.answered) return false;
    const [m, s] = String(q.at).split(":").map(Number);
    return now - (m * 60 + (s || 0)) > 10 * 60;   // dropped = open for 10+ min
  }).slice(-5);
  if (!open.length) return "";
  return [
    `QUESTIONS STILL OPEN (raised earlier in this meeting, never answered):`,
    ...open.map((q) => `- [${q.at}] ${q.by}: ${String(q.text).replace(/\s+/g, " ").slice(0, 140)}`),
  ].join("\n");
}

function buildUser(lines) {
  const delta = lines.length
    ? lines.map((l) => `${l.who === USER_NAME ? USER_NAME : "Them"}: ${l.text}`).join("\n")
    : "(no new speech — the shared screen changed)";
  // What's visible on the shared screen right now (fresh within ~90s). OCR'd
  // on-device; only the text reaches this prompt.
  const screenFresh = screenAtMs && Date.now() - screenAtMs < 90_000;
  const screenBlock = screenFresh
    ? `ON SCREEN NOW (on-device OCR of the meeting window — shared slides/docs and participant tiles. OCR'd digits are far more reliable than spoken ones, but watch O/0 and l/1 swaps):\n${screenText.slice(0, 900)}` +
      (screenNames.length ? `\nParticipant names visible on screen: ${screenNames.join(", ")} (these people are in the meeting)` : "") +
      (chartRead && chartReadAtMs === screenAtMs ? `\nChart read (vision pass over the slide image): ${chartRead}` : "")
    : "";
  return buildCheckUser({
    elapsedSec: elapsedSec(),
    scheduledSec: SCHEDULED_SEC,
    summary: rollingSummary,
    shownCards: surfaced,
    delta,
    preBlocks: [fb.block()],
    postBlocks: [screenBlock, recall ? recall.render() : "", droppedBlock()],
  });
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
  const gapSec = Math.max(MIN_GAP_SEC, fb.gap());
  const withinGap = nowPre - lastPre < gapSec;
  const atCap = cardTimes.filter((t) => nowPre - t <= 30 * 60).length >= CAP;
  const canShow = !withinGap && !atCap;

  // Still run the call when suppressed: it keeps the rolling summary current.
  if (canShow) broadcast({ type: "thinking" });
  let lastQ = "";
  let lastTopicPartial = "";

  const userPrompt = buildUser(lines);
  const callsAtStart = brainInFlight();
  // The shown-cards dedup list was snapshotted into userPrompt above — a card
  // surfaced by an OVERLAPPING call (peak 2 concurrent) is invisible to this
  // one. Remember where the list stood so the emission path can compare
  // against anything added mid-flight (seen 2026-08-11: three near-identical
  // Albatross cards inside 4 minutes once faster calls raised throughput).
  const surfacedAtStart = surfaced.length;
  // try/finally, not a bare assignment after the await: if the call throws (or
  // ever hangs again) inFlight must still clear. Leaving it stuck true is what
  // silently ends the meeting's brain — every later check returns at the guard
  // on the first line of this function, with nothing shown on the panel.
  let result;
  try {
    result = await streamBrain({
      system: SYSTEM,
      user: userPrompt,
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
  } catch (e) {
    console.error(`brain: model call THREW — ${e?.message || e}`);
    result = { json: null, raw: "", failed: true, timedOut: false, error: e?.message || null, firstTokenMs: null, totalMs: null };
  } finally {
    inFlight = false;
    lastCheckDoneAt = Date.now();
  }
  const { json: parsed, raw, failed, timedOut, error, firstTokenMs, totalMs } = result;

  // Every check, one line: prompt size, latency, how many cards were riding in
  // the prompt, and how many model calls were already running. This is the set
  // of numbers that turns "it got progressively slower" into a measurement.
  const perf = {
    atSec: nowPre,
    promptChars: userPrompt.length,
    outputChars: raw.length,
    surfacedCount: surfaced.length,
    callsAtStart,
    firstTokenMs,
    totalMs,
    timedOut: timedOut || false,
    failed: failed || false,
  };
  perfSamples.push(perf);
  if (timedOut) broadcast({ type: "brainSlow", reason: "timeout" });

  // A dead model must never look like a quiet meeting: surface it on the
  // panel, put the unseen lines back for the next attempt, and don't emit a
  // fake "silent".
  if (failed) {
    brainFailures++;
    console.error(`brain: model call FAILED — nothing returned (check \`claude\` login / network); ${brainFailures} consecutive`);
    broadcast({ type: "brainDown", count: brainFailures });
    traceCheck({ atSec: nowPre, canShow, failed: true, timedOut: perf.timedOut, userPrompt, perf });
    pending = lines.concat(pending);
    return;
  }
  brainFailures = 0;

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
        type: partialString(raw, "type") || "",
        why: partialString(raw, "why") || "",
        risk: partialString(raw, "risk") || "",
        win: partialString(raw, "win") || "",
        summary: partialString(raw, "summary") || "",
      };
    }
    console.error(`brain: JSON parse failed (${raw.length} chars) — ${json ? "salvaged card from stream" : "no card fields, dropping"}; tail: ...${raw.slice(-140).replace(/\n/g, " ")}`);
  }

  traceCheck({ atSec: nowPre, canShow, userPrompt, raw, action: json?.action ?? null, question: json?.question, type: json?.type, perf });

  if (json?.summary) rollingSummary = capSummary(json.summary);
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
    const dupMidFlight = surfaced.slice(surfacedAtStart).some((c) => similarCards(c.question, json.question));
    if (!canShow || dupMidFlight) {
      if (dupMidFlight) {
        console.error(`brain: card suppressed (near-dup surfaced mid-flight): ${json.question.slice(0, 50)}`);
        // Unlike the pre-gated cases, canShow streamed a partial — retract it.
        if (canShow) broadcast({ type: "silent" });
      } else {
        // Nothing was streamed, so nothing to retract — just log why it was held.
        console.error(`brain: ${json.type || "untyped"} card suppressed (${withinGap ? `${gapSec > MIN_GAP_SEC ? "feedback " : ""}min-gap ${gapSec}s` : `cap ${CAP}/30min`}): ${json.question.slice(0, 50)}`);
      }
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
      // The model's detection class, whitelisted. Missing or invalid -> no
      // label at all (the panel shows no chip); never guess one.
      const cardType = CARD_TYPES.includes(json.type) ? json.type : undefined;
      const card = {
        type: "card",
        id: `c${++cardSeq}`,
        cardType,
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
      fb.noteCard(card.id, card.question, cardType);
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

// ---------- start serving ----------
server.listen(PORT, "127.0.0.1", () => {
  console.error(`live: panel http://127.0.0.1:${PORT}`);
  traceCheck({ session: MEETING_TITLE, system: SYSTEM });   // once: makes any later card fully reconstructible
  console.error(`live: watching ${TRANSCRIPT}`);
  console.error(`live: debounce ${DEBOUNCE_MS}ms, max-wait ${MAX_WAIT_MS / 1000}s, cap ${CAP}/30min${AMBIENT_ON ? ", ambient on" : ""}`);
  console.error(`live: mic mode ${MODE}${MODE === "ptt" ? " -- hold the panel's \"talk\" button while you speak (mic is otherwise dropped as speaker echo)" : ""}`);
  console.error(`live: recall ${RECALL_ON ? `on -- ${QMD_BIN} whole-repo, off critical path` : "off"}`);
  // Stale knowledge looks exactly like fresh knowledge on a card — say it here.
  if (CONFIG.KNOWLEDGE_SYNCED_AT) {
    const days = Math.floor((Date.now() - Date.parse(CONFIG.KNOWLEDGE_SYNCED_AT)) / 86_400_000);
    if (days > 7) console.error(`live: WARNING — knowledge last synced ${days} days ago; cards cite what's on file (refresh: copilot prep <n> --refresh)`);
  }
  if (fb.seeded) console.error(`live: feedback history seeded (${fb.seeded} past negative(s) raise the bar)`);
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
    // Numbers-only perf record. Survives the transcript wipe on purpose: it holds
    // latencies, prompt sizes and counts, never meeting content. First-vs-last
    // third is the shape a "progressively slower" report shows up as.
    if (perfSamples.length) {
      const ok = perfSamples.filter((s) => s.totalMs != null && !s.failed);
      const third = Math.max(1, Math.floor(ok.length / 3));
      const mean = (xs, k) => (xs.length ? Math.round(xs.reduce((a, s) => a + s[k], 0) / xs.length) : null);
      const early = ok.slice(0, third), late = ok.slice(-third);
      const summary = {
        calls: perfSamples.length,
        failed: perfSamples.filter((s) => s.failed).length,
        timedOut: perfSamples.filter((s) => s.timedOut).length,
        maxConcurrent: Math.max(0, ...perfSamples.map((s) => s.callsAtStart + 1)),
        early: { totalMs: mean(early, "totalMs"), promptChars: mean(early, "promptChars") },
        late: { totalMs: mean(late, "totalMs"), promptChars: mean(late, "promptChars") },
        samples: perfSamples,
      };
      const slowdown = summary.early.totalMs && summary.late.totalMs
        ? summary.late.totalMs / summary.early.totalMs : null;
      try {
        writeFileSync(join(dirname(TRANSCRIPT), "perf.json"), JSON.stringify(summary, null, 2));
      } catch {}
      console.error(
        `live: ${summary.calls} brain call(s), ${summary.failed} failed, ${summary.timedOut} timed out, peak ${summary.maxConcurrent} concurrent; ` +
        `latency ${summary.early.totalMs}ms -> ${summary.late.totalMs}ms` +
        (slowdown ? ` (${slowdown.toFixed(1)}x)` : "") +
        `, prompt ${summary.early.promptChars} -> ${summary.late.promptChars} chars`
      );
      if (slowdown && slowdown >= 2) {
        console.error("live: WARNING — calls got materially slower over the meeting; perf.json in the session dir has the per-call detail");
      }
    }
    // Session votes -> cross-meeting memory (see feedback.mjs persist).
    const persisted = fb.persist(MEETING_TITLE);
    if (persisted) console.error(`live: feedback history +${persisted} -> ${FEEDBACK_HISTORY}`);
    // No transcription retention: the digest is the meeting's record; the
    // transcript and screen feeds were working files. Delete ONLY the session
    // defaults — an explicitly passed --transcript/--screen-file path is a
    // fixture or replay input, never ours to delete.
    if (!KEEP_SESSION) {
      let removed = 0;
      for (const [p, name] of [[TRANSCRIPT, "transcript.jsonl"], [SCREEN_FILE, "screen.jsonl"], [TRACE, "trace.jsonl"]]) {
        if (p === join(CURRENT, name)) { try { unlinkSync(p); removed++; } catch {} }
      }
      try { unlinkSync(join(CURRENT, "frame.png")); removed++; } catch {}
      // capture.log holds run.sh's transcript tail — it's transcription too.
      try { unlinkSync(join(CURRENT, "capture.log")); removed++; } catch {}
      if (removed) console.error("live: transcript/screen feed deleted — no transcription retained (--keep-session to keep, e.g. for review-server or fixture-making)");
    }
  } finally { process.exit(0); }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30); // keep alive
