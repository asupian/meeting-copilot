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
export function streamBrain({ system, user, model, onDelta, signal, thinkTokens, tools }) {
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

    if (signal) signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });

    child.stdin.write(user);
    child.stdin.end();

    let buf = "";
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
      }
    });

    child.on("close", () => {
      resolve({
        json: extractJson(acc),
        raw: acc,
        firstTokenMs,
        totalMs: Date.now() - t0,
      });
    });
    child.on("error", () => resolve({ json: null, raw: "", firstTokenMs: null, totalMs: Date.now() - t0 }));
  });
}
