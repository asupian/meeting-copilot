#!/usr/bin/env node
// brain-loop.mjs — replay driver + minimal live loop over the shared brain core.
//
// Watches a transcript.jsonl, and every ~45 s of meeting time sends the new
// lines (plus a rolling summary and the cards already shown, for dedup) to a
// clean, tool-free `claude -p` transform whose system prompt is the operating
// contract + the prep pack. The model returns strict JSON: stay silent, or one
// grounded card {question, why, source}. Silence is the default.
//
// The plumbing (system-prompt assembly, the model call, JSON extraction) lives
// in lib.mjs and is shared with live.mjs; this file owns only the replay/tick
// scheduling and the card budget.
//
// Modes:
//   --live [transcript.jsonl]   follow a live capture (default: ~/.meeting-copilot/current/transcript.jsonl)
//   --replay <fixture.jsonl>    deterministic offline replay (accelerated), prints + saves cards
//
// Flags:
//   --prep <prep-pack.md>       prep pack to load (default: ~/.meeting-copilot/current/prep-pack.md)
//   --contract <contract.md>    operating contract (default: alongside this script)
//   --tick <sec>                meeting-time window per brain call (default 45)
//   --cap <n>                   max cards per 30 min (default 3)
//   --cards-out <file>          in replay, also append emitted cards here as JSONL
//   --model <alias>             claude model (default: inherit)
//   --dry-run                   skip the model; print the batches that WOULD be sent

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSystem, streamBrain, asrCaveat, renderTemplate, USER_NAME } from "./lib.mjs";
import { parseFacts, matchWindow, matchGuard } from "./matcher.mjs";
import { makeAmbient, finishAmbient } from "./ambient.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

const CURRENT = join(homedir(), ".meeting-copilot", "current");
const replayFile = val("--replay", null);
const liveFile = has("--live") ? (val("--live", null) || join(CURRENT, "transcript.jsonl")) : null;
const prepPath = val("--prep", join(CURRENT, "prep-pack.md"));
const contractPath = val("--contract", join(HERE, "contract.md"));
const TICK_SEC = Number(val("--tick", 45));
const CAP = Number(val("--cap", 3));
const MIN_GAP_SEC = Number(val("--min-gap", 180)); // don't let early chatter starve a late card
const cardsOut = val("--cards-out", null);
const traceOut = val("--trace", null);   // per-tick {atSec, action, question, summary} — makes a bad card reconstructible
const model = val("--model", null);
const dryRun = has("--dry-run");
// --fast: the low-latency path. A local matcher finds candidate facts (0.17ms);
// only those go to the model, with a short contract and no extended thinking.
// ~2.5s to a visible question instead of 12-19s. See matcher.mjs.
const FAST = has("--fast");
const narrowPath = val("--narrow-contract", join(HERE, "..", "experimental", "contract-narrow.md"));
const WINDOW_SEC = Number(val("--window", 25));
const RECALL_GAP = Number(val("--recall-gap", 20)); // don't re-ask about the same fact
// Ambient listener (commitments + unanswered questions) and disclosure guard.
const AMBIENT = has("--ambient");
const EXTERNALS = has("--externals");             // external attendees: arm the guard
const STAGING_ROOT = val("--staging-root", null); // write staging files under this knowledge root
const DIGEST_OUT = val("--digest-out", null);
const MEETING_TITLE = val("--title", "replay");

if (!replayFile && !liveFile) {
  console.error("usage: brain-loop.mjs (--live [file] | --replay <fixture>) [--prep f] [--dry-run]");
  process.exit(1);
}

let SYSTEM;
try { SYSTEM = loadSystem(contractPath, prepPath); }
catch (e) { console.error(`brain-loop: ${e.message}`); process.exit(1); }
const PREP_TEXT = existsSync(prepPath) ? readFileSync(prepPath, "utf8") : "";

// ---- brain calls: clean, tool-free, single-turn, via the shared stream core ----
async function callBrain(userText) {
  if (dryRun) return { action: "silent", _dry: true };
  const { json, raw } = await streamBrain({ system: SYSTEM, user: userText, model });
  if (!json) {
    if (raw) console.error("brain: unparseable model output:", raw.slice(0, 200));
    else console.error("brain: claude -p produced no output");
    return { action: "silent", _error: true };
  }
  return json;
}

// ---- fast path ----
const FACTS = FAST ? parseFacts(PREP_TEXT) : [];
if (FAST) {
  if (!existsSync(narrowPath)) { console.error(`brain-loop: narrow contract not found: ${narrowPath}`); process.exit(1); }
  console.error(`brain-loop: FAST mode — ${FACTS.length} facts indexed, ${FACTS.filter(f=>f.triggerPhrases.length).length} with triggers`);
  if (FACTS.length && !FACTS.some(f => f.triggerPhrases.length)) {
    console.error("brain-loop: WARNING no (triggers: ...) in the prep pack — recall will suffer. Rebuild the pack.");
  }
}
const NARROW = FAST ? renderTemplate(readFileSync(narrowPath, "utf8")) : "";

async function callBrainNarrow(candidates, windowText) {
  const facts = candidates.map((c, i) => `${i + 1}. ${c.fact.text}`).join("\n");
  const system = `${NARROW}\n\nCANDIDATE FACTS the matcher found:\n${facts}`;
  // Without this the fast path re-asks the same question every time the matcher
  // re-touches a fact; there is no rolling summary here to remember for it.
  const shown = surfaced.length
    ? `\nAlready shown to ${USER_NAME} (never repeat these or minor variants):\n${surfaced.map((c, i) => `${i + 1}. ${c.question}`).join("\n")}\n`
    : "";
  const user = `Recent speech:\n${windowText}\n${shown}\nDecide. JSON only.`;
  // The matcher already did the search — skip extended thinking.
  const { json } = await streamBrain({ system, user, model, thinkTokens: 0 });
  return json ?? { action: "silent", _error: true };
}

// ---- state ----
let rollingSummary = "(meeting just started)";
const surfaced = [];              // {question, why, source, atSec}
const cardTimes = [];             // epoch-sec of emitted cards, for the cap
const collisionTimes = [];        // contradictions/decisions — one slot per 30min is reserved for them

function windowOfCards(nowSec, spanSec) {
  return cardTimes.filter((t) => nowSec - t <= spanSec).length;
}

function buildUserText(deltaLines, meetingElapsedSec, meetingTotalGuessSec) {
  const delta = deltaLines
    .map((l) => `${l.ch === "me" ? USER_NAME : "Them"}: ${l.text}`)
    .join("\n");
  const shown = surfaced.length
    ? surfaced.map((c, i) => `${i + 1}. ${c.question}`).join("\n")
    : "(none yet)";
  const pct = meetingTotalGuessSec
    ? Math.round((meetingElapsedSec / meetingTotalGuessSec) * 100)
    : null;
  return [
    `Meeting elapsed: ~${Math.round(meetingElapsedSec / 60)} min${pct != null ? ` (~${pct}% if scheduled length holds)` : ""}.`,
    ``,
    `Rolling summary so far:\n${rollingSummary}`,
    ``,
    `Cards already shown to ${USER_NAME} (do NOT repeat these or minor variants):\n${shown}`,
    ``,
    `New transcript since last check:\n${delta}${asrCaveat(delta)}`,
    ``,
    `Decide: stay silent, or surface ONE grounded card. Also return an updated one-paragraph rolling summary.`,
    ``,
    `Respond with ONLY the JSON object. Begin your reply with { and end with }. No prose before or after, no markdown fences.`,
  ].join("\n");
}

function emitCard(card, atSec) {
  const line = { ...card, atSec, atClock: new Date(atSec * 1000).toISOString() };
  surfaced.push({ ...card, atSec });
  cardTimes.push(atSec);
  // Terminal surface (v0): a compact three-line card.
  const rule = "─".repeat(60);
  process.stdout.write(
    `\n${rule}\n💡 ${card.question}\n   why: ${card.why}\n   src: ${card.source}\n${rule}\n`
  );
  if (cardsOut) appendFileSync(cardsOut, JSON.stringify(line) + "\n");
}

async function tick(deltaLines, elapsedSec, totalGuessSec) {
  if (deltaLines.length === 0) return;
  const nowSec = elapsedSec; // meeting-time seconds; cap windows use the same clock
  const userText = buildUserText(deltaLines, elapsedSec, totalGuessSec);
  if (dryRun) {
    process.stdout.write(`\n[tick @${Math.round(elapsedSec / 60)}m] would send ${deltaLines.length} lines:\n${userText}\n`);
    return;
  }
  const out = await callBrain(userText);
  if (out.summary) rollingSummary = out.summary;
  if (traceOut) {
    appendFileSync(traceOut, JSON.stringify({
      atSec: nowSec, action: out.action ?? "error",
      question: out.question ?? null, summary: out.summary ?? null,
      lines: deltaLines.map((l) => l.text),
    }) + "\n");
  }
  if (out.action === "card" && out.question) {
    const lastCardSec = cardTimes.length ? cardTimes[cardTimes.length - 1] : -Infinity;
    if (nowSec - lastCardSec < MIN_GAP_SEC) {
      console.error(`brain: card suppressed (min-gap ${MIN_GAP_SEC}s): ${out.question.slice(0, 60)}`);
      return;
    }
    if (windowOfCards(nowSec, 30 * 60) >= CAP) {
      console.error(`brain: card suppressed (cap ${CAP}/30min reached): ${out.question.slice(0, 60)}`);
      return;
    }
    emitCard(
      { question: out.question, type: out.type || "", why: out.why || "", source: out.source || "" },
      nowSec
    );
  }
}

// ---- fast replay: matcher decides when the model wakes ----
async function runReplayFast(file) {
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((l) => !l.partial);   // finals only, offline
  const t0 = Date.parse(lines[0].t);
  console.error(`replay(fast): ${lines.length} lines, window ${WINDOW_SEC}s${EXTERNALS ? ", guard ARMED" : ""}${AMBIENT ? ", ambient on" : ""}`);
  let calls = 0, lastTopId = null, lastCallSec = -1e9;
  const ambient = AMBIENT ? makeAmbient({ model }) : null;
  const guardShown = new Set();   // one nudge per gated fact per meeting

  for (let i = 0; i < lines.length; i++) {
    // Disclosure guard: pure code, instant, never counts against the card budget.
    if (EXTERNALS) {
      for (const g of matchGuard(lines.slice(0, i + 1), FACTS, { windowSec: WINDOW_SEC })) {
        if (guardShown.has(g.fact.id)) continue;
        guardShown.add(g.fact.id);
        const sec = Math.round((Date.parse(lines[i].t) - t0) / 1000);
        console.error(`⚠ guard [${Math.floor(sec/60)}m${String(sec%60).padStart(2,"0")}s] approaching internal-only territory: ${g.fact.text.slice(0, 80)}`);
        if (cardsOut) appendFileSync(cardsOut, JSON.stringify({ type: "guard", atSec: sec, fact: g.fact.text, via: g.why }) + "\n");
      }
    }
    if (ambient) { ambient.ingest(lines[i]); await ambient.flush(); }
    const cands = matchWindow(lines.slice(0, i + 1), FACTS, { windowSec: WINDOW_SEC });
    if (!cands.length) continue;
    const nowSec = Math.round((Date.parse(lines[i].t) - t0) / 1000);
    if (cands[0].fact.id === lastTopId && nowSec - lastCallSec < RECALL_GAP) continue;
    lastTopId = cands[0].fact.id; lastCallSec = nowSec; calls++;

    const windowText = lines.slice(0, i + 1)
      .filter((l) => Date.parse(lines[i].t) - Date.parse(l.t) <= WINDOW_SEC * 1000)
      .map((l) => `${l.ch === "me" ? USER_NAME : "Them"}: ${l.text}`).join("\n");

    if (dryRun) { console.error(`  [${nowSec}s] would call: ${cands.map(c=>c.fact.text.slice(0,40)).join(" | ")}`); continue; }
    const out = await callBrainNarrow(cands, windowText);
    if (traceOut) appendFileSync(traceOut, JSON.stringify({ atSec: nowSec, action: out.action ?? "error", question: out.question ?? null, candidates: cands.map(c=>c.fact.text) }) + "\n");
    if (out.action !== "card" || !out.question) continue;

    // Not all cards are equal. A contradiction is a live number colliding right
    // now; an unraised thread can wait minutes. Without this, a soft card that
    // fired 26 minutes early eats the budget and the collision is thrown away.
    const isCollision = out.trigger === "contradiction" || out.trigger === "decision";
    const lastCard = cardTimes.length ? cardTimes[cardTimes.length - 1] : -Infinity;
    const gap = isCollision ? Math.min(60, MIN_GAP_SEC) : MIN_GAP_SEC;
    if (nowSec - lastCard < gap) { console.error(`brain: suppressed (min-gap ${gap}s, ${out.trigger}): ${out.question.slice(0,45)}`); continue; }

    const inWindow = windowOfCards(nowSec, 30 * 60);
    const collisionsInWindow = collisionTimes.filter((t) => nowSec - t <= 30 * 60).length;
    // One slot per 30 minutes is reserved for a collision. A soft card may never
    // take the last slot; a collision may take it even at cap.
    const atCap = isCollision
      ? inWindow >= CAP && collisionsInWindow >= 1
      : inWindow >= CAP - 1;
    if (atCap) { console.error(`brain: suppressed (cap, ${out.trigger}): ${out.question.slice(0,45)}`); continue; }

    if (isCollision) collisionTimes.push(nowSec);
    emitCard({ question: out.question, why: out.why || "", source: out.source || "", trigger: out.trigger || "?" }, nowSec);
  }
  console.error(`\nreplay(fast): done. ${calls} model call(s), ${surfaced.length} card(s).`);
  if (ambient) {
    const { digest, files } = await finishAmbient(ambient, {
      title: MEETING_TITLE, cards: surfaced, stagingRoot: STAGING_ROOT,
    });
    if (DIGEST_OUT) { appendFileSync(DIGEST_OUT, digest); console.error(`digest -> ${DIGEST_OUT}`); }
    else process.stdout.write("\n" + digest);
    for (const f of files) console.error(`staging -> ${f}`);
  }
}

// ---- replay: deterministic, accelerated by meeting-time windows ----
async function runReplay(file) {
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!lines.length) { console.error("replay: empty fixture"); return; }
  const t0 = Date.parse(lines[0].t);
  const tN = Date.parse(lines[lines.length - 1].t);
  const totalGuess = Math.max(TICK_SEC, Math.round((tN - t0) / 1000));
  console.error(`replay: ${lines.length} lines over ~${Math.round((tN - t0) / 60000)} min, tick=${TICK_SEC}s`);
  let batch = [];
  let windowStart = t0;
  for (const l of lines) {
    const ts = Date.parse(l.t);
    if (ts - windowStart >= TICK_SEC * 1000 && batch.length) {
      // Stamp the tick at the LAST line in the batch (when the triggering
      // utterance was actually spoken), not the window start — otherwise a card
      // can appear to fire before the line it responds to.
      const lastTs = Date.parse(batch[batch.length - 1].t);
      await tick(batch, Math.round((lastTs - t0) / 1000), totalGuess);
      batch = [];
      windowStart = ts;
    }
    batch.push(l);
  }
  if (batch.length) await tick(batch, Math.round((tN - t0) / 1000), totalGuess);
  console.error(`\nreplay: done. ${surfaced.length} card(s) surfaced.`);
}

// ---- live: follow the file, fire on wall-clock ticks ----
function runLive(file) {
  console.error(`live: following ${file} (tick ${TICK_SEC}s, cap ${CAP}/30min). Ctrl-C to stop.`);
  let offset = 0;      // lines consumed
  let startEpoch = null;
  const readNew = () => {
    if (!existsSync(file)) return [];
    const all = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const fresh = all.slice(offset).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    offset = all.length;
    return fresh;
  };
  let pending = [];
  let busy = false;    // the brain call is async now; never overlap two ticks
  const loop = async () => {
    if (busy) return;
    const fresh = readNew();
    if (fresh.length && startEpoch == null) startEpoch = Math.floor(Date.parse(fresh[0].t) / 1000);
    pending.push(...fresh);
    if (pending.length) {
      const batch = pending;
      pending = [];
      const elapsed = startEpoch != null ? Math.floor(Date.now() / 1000) - startEpoch : 0;
      busy = true;
      try { await tick(batch, elapsed, null); } finally { busy = false; }
    }
  };
  setInterval(loop, TICK_SEC * 1000);
}

if (replayFile) (FAST ? runReplayFast : runReplay)(replayFile);
else runLive(liveFile);
