// Shared brain plumbing: system-prompt assembly + a streaming model call.
// The streaming call is what makes the panel feel live: the question text is
// pushed to the surface as tokens arrive, instead of waiting for the full JSON.

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// The card taxonomy, ladder order. The contract defines them; live.mjs
// whitelists the model's `type` against this; the panel colors its chip by it.
export const CARD_TYPES = ["collision", "gap", "reinforce"];

// Card-budget defaults, side by side so the two drivers can't drift unseen.
// They are DELIBERATELY different: replay is the conservative regression
// surface; live opines more freely because the model plus the panel's
// feedback loop are the bar there. The asymmetry has a measured cost — in a
// dense meeting replay starved its sharpest anchor (5 attempts, never shown)
// while live surfaced it — which is what the starvation bypass in
// brain-loop.mjs compensates for.
export const CARD_CAPS = {
  replay: { cap: 3, minGapSec: 180 },
  live:   { cap: 20, minGapSec: 0 },
};

// One check's user prompt, shared by live.mjs and brain-loop.mjs so replay
// and live meetings show the model the SAME shape. A divergence here means
// fixtures pass while live behaves differently — it happened once: replay
// carried an elapsed-% hint (feeding the goal-late trigger) that live never
// sent. preBlocks land after the shown-cards section (live: feedback);
// postBlocks after the transcript delta (live: screen, recall, open
// questions). Both drivers change together or not at all.
// How many past cards ride in the prompt. `surfaced` grows all meeting and every
// entry is re-serialized into EVERY check — with --cap 20/30min a two-hour
// meeting puts 40+ questions in front of the model on every call, and the prompt
// only ever gets longer. Capping the tail bounds that growth.
// The tradeoff is real and one-directional: the model can only avoid repeating
// cards it can still see, so past this many the oldest questions become
// repeatable. 15 is chosen to sit above the practical card count of a normal
// meeting, so nothing is dropped in the common case.
export const SHOWN_CARDS_IN_PROMPT = 15;

// The rolling summary is contracted to ONE paragraph, but the model drifts to
// appending instead of rewriting ("Pre-meeting chatter gave way to..." was
// still the opening clause 15 minutes in), and an accreting summary is the
// other unbounded term in prompt growth (measured 2026-08-11: 1272 -> 6516
// chars over 16 min, latency 3.1x). The instruction says rewrite; this cap is
// the defensive floor under it, applied where the summary is adopted so both
// drivers stay identical. Cut at a word break: a mid-word cut reads as
// transcription garbage and the model quotes it back.
export const SUMMARY_MAX_CHARS = 700;
export function capSummary(s) {
  if (!s || s.length <= SUMMARY_MAX_CHARS) return s;
  const cut = s.lastIndexOf(" ", SUMMARY_MAX_CHARS);
  return s.slice(0, cut > SUMMARY_MAX_CHARS / 2 ? cut : SUMMARY_MAX_CHARS) + " …";
}

export function buildCheckUser({ elapsedSec, scheduledSec = null, summary, shownCards, delta, preBlocks = [], postBlocks = [] }) {
  const pct = scheduledSec ? Math.round((elapsedSec / scheduledSec) * 100) : null;
  const recent = shownCards.slice(-SHOWN_CARDS_IN_PROMPT);
  const elided = shownCards.length - recent.length;
  const shown = recent.length
    ? (elided ? `(${elided} earlier card(s) elided)\n` : "") +
      recent.map((c, i) => `${elided + i + 1}. ${c.question}`).join("\n")
    : "(none yet)";
  return [
    `Meeting elapsed: ~${Math.round(elapsedSec / 60)} min${pct != null ? ` (~${pct}% if scheduled length holds)` : ""}.`,
    ``,
    `Rolling summary so far:\n${summary}`,
    ``,
    `Cards already shown to ${USER_NAME} (do NOT repeat these or minor variants):\n${shown}`,
    ...preBlocks.flatMap((b) => (b ? [``, b] : [])),
    ``,
    `New transcript since last check:\n${delta}${asrCaveat(delta)}`,
    ...postBlocks.flatMap((b) => (b ? [``, b] : [])),
    ``,
    `Decide: stay silent, or surface ONE grounded card. Always return the \`now\` object (current topic, confirmed speakers, goal bearing) and an updated one-paragraph rolling summary — REWRITE the summary each time, compressing older ground to make room; do not append. Keep it under ~80 words.`,
    ``,
    // Without extended thinking the model drifts to prose; this holds it to JSON.
    `Respond with ONLY the JSON object. Begin your reply with { and end with }. No prose before or after, no markdown fences.`,
  ].join("\n");
}

// ~/.meeting-copilot/config — KEY="VALUE" lines written by portable/knowledge.sh
// (USER_NAME, ORG_DOMAIN, KNOWLEDGE_DIR). Missing file -> {}; callers default.
export function loadConfig(path = join(homedir(), ".meeting-copilot", "config")) {
  const cfg = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=("?)(.*)\2\s*$/);
      if (m) cfg[m[1]] = m[3];
    }
  } catch {}
  return cfg;
}

export function loadSystem(contractPath, prepPath) {
  // Fail loudly on a missing contract. Silently falling back to an empty string
  // would run the brain with no silence bar, no lint and no guards — it looks
  // like it works, and every card is junk. A missing prep pack is different: the
  // copilot degrades honestly to "be conservative" and says so.
  if (!existsSync(contractPath)) {
    throw new Error(
      `contract not found: ${contractPath}\n` +
      `  (paths resolve against the current directory; try brain/contract.md)`
    );
  }
  const contract = renderTemplate(readFileSync(contractPath, "utf8"));
  if (!contract.trim()) throw new Error(`contract is empty: ${contractPath}`);

  const prep = existsSync(prepPath)
    ? readFileSync(prepPath, "utf8")
    : "(no prep pack found — operate on transcript alone; be extra conservative)";
  if (!existsSync(prepPath)) console.error(`brain: no prep pack at ${prepPath} — running without one`);
  return `${contract}\n\n===== PREP PACK (what the copilot knows going in) =====\n${prep}`;
}

// One identity read per process. portable/knowledge.sh writes USER_NAME and
// ORG_DOMAIN at setup; with no config the copilot stays generic ("User") instead
// of failing — prompts and staging attribution degrade honestly.
export const CONFIG = loadConfig();
export const USER_NAME = CONFIG.USER_NAME || "User";
export const ORG_DOMAIN = CONFIG.ORG_DOMAIN || "";

// Contracts use {{USER_NAME}} / {{ORG_DOMAIN}} placeholders — the same syntax
// as portable/prompts — filled at load time from the config.
export function renderTemplate(text) {
  return text.replaceAll("{{USER_NAME}}", USER_NAME).replaceAll("{{ORG_DOMAIN}}", ORG_DOMAIN);
}

// On-device speech-to-text mangles large currency figures ("$11 million" -> 110000).
// When such a digit-run appears in the delta, say so inline: a warning that only
// shows up when it is relevant stays salient, unlike a permanent line in the prompt.
const BIG_NUMBER = /\b\d{5,}\b/;
export function asrCaveat(delta) {
  return BIG_NUMBER.test(delta)
    ? "\nNOTE: the lines above came from on-device speech-to-text, which renders large" +
      " currency figures unreliably (it has written 110000 for \"$11 million\"). Treat any" +
      " 5+ digit number above as approximate. Do not build a contradiction on its magnitude."
    : "";
}

// MCP tools leak into the session even with --tools ""; name them so the brain
// stays a pure text transform (no tool latency, no side effects).
const DISALLOW = [
  "mcp__qmd__get", "mcp__qmd__multi_get", "mcp__qmd__query", "mcp__qmd__status",
];

// Pull a (possibly still-streaming) JSON string value out of accumulating text.
// Tolerates an unterminated string so we can render the question as it types.
export function partialString(acc, key) {
  const m = acc.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

export function extractJson(text) {
  const s = text.trim();
  const str = s.startsWith("{") ? s : (s.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!str) return null;
  try { return JSON.parse(str); } catch {}

  // Attempt 2: the FIRST balanced object. The greedy match above spans first
  // "{" to LAST "}", which breaks when prose containing a brace trails the
  // JSON. Walk the string tracking string/escape state and brace depth.
  let inStr = false, esc = false, depth = 0;
  const start = str.indexOf("{");
  for (let i = start; i >= 0 && i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = inStr; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(str.slice(start, i + 1)); } catch {}
      break;
    }
  }

  // Attempt 3: repair a TRUNCATED stream — close an open string, drop a
  // dangling key/comma, unwind open brackets. A cut-off response should
  // salvage its completed fields, not read as "the model said nothing".
  inStr = false; esc = false;
  const stack = [];
  for (const ch of str) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = inStr; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let fixed = str;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*$/, "").replace(/,?\s*"[^"]*"?\s*:\s*$/, "");
  fixed += stack.reverse().join("");
  try { return JSON.parse(fixed); } catch { return null; }
}

/**
 * Run one clean, tool-free brain call, streaming deltas.
 * onDelta(fullAccumulatedText) fires on each token chunk.
 * Resolves with the parsed JSON object (or null), plus timing.
 */
// A hung `claude` process used to hang the whole meeting. streamBrain resolved
// only on the child's "close"/"error" events, and live.mjs's check() clears its
// inFlight flag on the line AFTER the await — so a child that never exits (model
// API stall, network black hole, an auth prompt waiting on a tty nobody sees)
// left inFlight stuck true, and every later check returned at the guard. The
// brain went silent for the rest of the meeting with no error on the panel.
// Nothing here may ever leave the promise unsettled. Normal calls run ~10-19s
// with extended thinking on; this is a backstop, not a tuning knob.
export const CALL_TIMEOUT_MS = Number(process.env.COPILOT_CALL_TIMEOUT_MS || 90_000);

// In-flight `claude` children, across every caller (check, vision, ambient).
// Exported for instrumentation: it is the number we could not see when the
// "lots of background calls, then it hung" report came in.
let inFlightCalls = 0;
export function brainInFlight() { return inFlightCalls; }

export function streamBrain({ system, user, model, onDelta, signal, thinkTokens, tools, timeoutMs = CALL_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--system-prompt", system,
      "--exclude-dynamic-system-prompt-sections",
      // Both are needed: --tools "" drops the builtin toolset, --disallowedTools
      // drops MCP servers that attach regardless. Every tool schema left in the
      // prompt is tokens on the critical path — this is the single biggest lever
      // on time-to-first-token. (`tools` opt-in exists for the vision pass,
      // which needs Read to open the slide image.)
      "--tools", tools ?? "",
      "--disallowedTools", ...DISALLOW,
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (model) args.push("--model", model);

    const t0 = Date.now();
    let firstTokenMs = null;
    let acc = "";
    // Extended thinking dominates time-to-first-token (~10.5-12.9s vs ~2s), but it is
    // what makes the model actually cross-reference the utterance against the prep
    // pack. Turning it off with the default contract makes the loop go silent.
    // So: inherit the default (thinking on) unless a caller explicitly opts out.
    const env = thinkTokens == null
      ? process.env
      : { ...process.env, MAX_THINKING_TOKENS: String(thinkTokens) };
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "ignore"], env });
    inFlightCalls++;

    // Exactly one settle, whatever happens: close, error, or timeout. Without
    // this a timeout that fires just as the child exits resolves twice, and the
    // in-flight count drifts negative for the rest of the meeting.
    let done = false;
    let timer = null;
    const settle = (r) => {
      if (done) return;
      done = true;
      inFlightCalls--;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (done) return;
        // SIGKILL, not SIGTERM: the thing we are killing is already not
        // responding, and a zombie holds a model connection open.
        try { child.kill("SIGKILL"); } catch {}
        console.error(`brain: model call TIMED OUT after ${Math.round(timeoutMs / 1000)}s — killed; ${acc.length} char(s) streamed`);
        settle({
          json: extractJson(acc),
          raw: acc,
          // Partial output is still output. Only a call that produced nothing
          // counts as failed, same rule as a dead call below.
          failed: !acc.trim(),
          timedOut: true,
          firstTokenMs,
          totalMs: Date.now() - t0,
        });
      }, timeoutMs);
      timer.unref?.();
    }

    if (signal) signal.addEventListener("abort", () => { try { child.kill("SIGKILL"); } catch {} }, { once: true });

    // A child killed between spawn and write makes stdin throw EPIPE, which is
    // an unhandled rejection, not a failed call. Swallow it — the close handler
    // is what reports the outcome.
    child.stdin.on("error", () => {});
    child.stdin.write(user);
    child.stdin.end();

    let buf = "";
    let errText = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type === "stream_event") {
          const ev = j.event || {};
          if (ev.type === "content_block_delta") {
            const t = ev.delta?.text || "";
            if (t) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              acc += t;
              onDelta?.(acc);
            }
          }
        }
        // A dead call ("Not logged in", rate limit) streams no deltas — its
        // only explanation rides the final result event. Keep it for callers.
        if (j.type === "result" && j.is_error && !errText) errText = String(j.result || "").trim();
      }
    });

    child.on("close", () => {
      settle({
        json: extractJson(acc),
        raw: acc,
        // A real response always streams SOME text; nothing at all means the
        // call itself died (auth expiry, network, spawn failure). Callers must
        // surface this — a dead brain must never look like a quiet meeting.
        failed: !acc.trim(),
        timedOut: false,
        error: errText || null,
        firstTokenMs,
        totalMs: Date.now() - t0,
      });
    });
    child.on("error", (e) => settle({ json: null, raw: "", failed: true, timedOut: false, error: e?.message || "claude could not be spawned", firstTokenMs: null, totalMs: Date.now() - t0 }));
  });
}
