// ambient.mjs — the listener that never interrupts.
//
// Beside the fast collision path runs a minutes-clock loop: every ~150s of
// meeting time, one cheap extraction call pulls out (1) commitments made and
// (2) questions asked / answered. Nothing is shown live. At meeting end the
// state becomes a digest plus raw-signal files in the knowledge dir: _staging
// inboxes when the layout has them, else one meetings/ digest file (see
// writeStaging).

import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamBrain, renderTemplate, USER_NAME } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function makeAmbient({
  contractPath = join(HERE, "contract-ambient.md"),
  model = null,
  meLabel = "Mic",
  headphones = false,
  getVisibleNames = () => [],   // names OCR'd off participant tiles right now
  getScreenText = () => "",     // current slide OCR — slide-stated commitments count
  intervalSec = 150,   // meeting-time between extractions
  minLines = 6,        // don't bother the model with less
} = {}) {
  if (!existsSync(contractPath)) throw new Error(`ambient contract not found: ${contractPath}`);
  const CONTRACT = renderTemplate(readFileSync(contractPath, "utf8"));

  const state = { commitments: [], questions: [], calls: 0, errors: 0 };
  let buffer = [];
  let lastFlushMs = null;
  let baseMs = null;     // meeting start, for mm:ss stamps
  let qSeq = 0;

  const mmss = (ms) => {
    const s = Math.max(0, Math.round((ms - (baseMs ?? ms)) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  function ingest(line) {           // {t, ch, text} — finals only, caller filters
    if (baseMs == null) baseMs = Date.parse(line.t);
    buffer.push(line);
  }

  function isDue(force) {
    if (!buffer.length) return false;
    if (force) return true;
    if (buffer.length < minLines) return false;
    if (lastFlushMs == null) lastFlushMs = Date.parse(buffer[0].t);
    return Date.parse(buffer[buffer.length - 1].t) - lastFlushMs >= intervalSec * 1000;
  }

  async function flush({ force = false } = {}) {
    if (!isDue(force)) return null;
    const chunk = buffer;
    buffer = [];
    lastFlushMs = Date.parse(chunk[chunk.length - 1].t);
    const atEnd = mmss(lastFlushMs);

    const text = chunk
      .map((l) => `[${mmss(Date.parse(l.t))}] ${l.who || (l.ch === "me" ? meLabel : "Them")}: ${l.text}`)
      .join("\n");
    const openQs = state.questions.filter((q) => !q.answered);
    const commitList = state.commitments.length
      ? state.commitments.map((c) => `- ${c.who}: ${c.what}`).join("\n") : "(none)";
    const qList = openQs.length
      ? openQs.map((q) => `${q.id}: ${q.text}`).join("\n") : "(none)";

    const visible = getVisibleNames();
    const rosterLine = visible.length
      ? `\n\nNames visible on the meeting screen right now (canonical spellings; the transcriber garbles names — when a spoken name is close to one of these, use THIS spelling): ${visible.join(", ")}`
      : "";
    const scrn = String(getScreenText() || "").slice(0, 700);
    const screenBlock = scrn
      ? `\n\nON SCREEN NOW (slide OCR — commitments and deadlines WRITTEN on slides count too, e.g. "DRI: Parker [ETA: 4/27]" is a commitment by Parker due 4/27; quote the slide text verbatim):\n${scrn}`
      : "";
    const user = `OPEN COMMITMENTS already extracted:\n${commitList}\n\nOPEN QUESTIONS so far:\n${qList}${rosterLine}${screenBlock}\n\nNEW TRANSCRIPT:\n${text}\n\nExtract. JSON only.`;

    state.calls++;
    const r = await streamBrain({ system: CONTRACT, user, model, thinkTokens: 0 });
    const j = r.json;
    if (!j) { state.errors++; return null; }

    for (const c of j.commitments || []) {
      if (!c?.what || !c?.quote) continue;      // no verbatim quote, no commitment
      state.commitments.push({
        who: c.who || "unattributed", what: c.what, due: c.due || null,
        quote: c.quote, at: atEnd,
      });
    }
    for (const q of j.questions || []) {
      if (!q?.text) continue;
      state.questions.push({
        id: `q${++qSeq}`, text: q.text, by: q.asked_by || "unattributed",
        at: atEnd, answered: false,
      });
    }
    for (const id of j.answered_ids || []) {
      const q = state.questions.find((x) => x.id === id);
      if (q) q.answered = true;
    }
    return j;
  }

  return { ingest, flush, state };
}

// One call for "the meeting ended": final extraction, digest, optional staging
// write-back. Callers decide where the digest goes (file, stdout, panel).
export async function finishAmbient(ambient, { title, cards = [], stagingRoot = null, mode } = {}) {
  await ambient.flush({ force: true });
  const digest = renderDigest(ambient.state, { title, cards });
  const files = stagingRoot ? writeStaging(ambient.state, { title, repoRoot: stagingRoot, mode }) : [];
  return { digest, files };
}

// ---------- digest ----------

export function renderDigest(state, { title = "meeting", cards = [] } = {}) {
  const open = state.questions.filter((q) => !q.answered);
  const lines = [`# Meeting digest — ${title}`, ""];

  lines.push(`## Commitments (${state.commitments.length})`);
  if (!state.commitments.length) lines.push("- none captured");
  for (const c of state.commitments) {
    lines.push(`- [${c.at}] **${c.who}**: ${c.what}${c.due ? ` — due ${c.due}` : ""}`);
    lines.push(`  > "${c.quote}"`);
  }
  lines.push("", `## Questions that never got answered (${open.length})`);
  if (!open.length) lines.push("- none — everything asked was addressed");
  for (const q of open) lines.push(`- [${q.at}] ${q.by}: ${q.text}`);

  const answered = state.questions.length - open.length;
  lines.push("", `## Cards shown (${cards.length})`);
  for (const c of cards) lines.push(`- [${Math.floor(c.atSec / 60)}m] ${c.question}`);
  lines.push("", `*(ambient: ${state.calls} extraction call(s), ${state.errors} error(s); ${state.questions.length} question(s) tracked, ${answered} answered)*`);
  return lines.join("\n") + "\n";
}

// ---------- staging write-back ----------

// Raw signals only: dated file, verbatim quotes, honest attribution, an
// explicit handling note. Interpretation belongs to whatever downstream
// workflow reads the staging files — nothing here touches profiles or
// initiatives.
export function writeStaging(state, { title = "meeting", dateStr, repoRoot, mode = "ptt" }) {
  if (!repoRoot) throw new Error("writeStaging: repoRoot required");
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const written = [];

  const attrNote = mode === "room"
    ? `"Mic" = local microphone (in-person); it hears the whole room, so it is NOT attributed to ${USER_NAME}.`
    : `"${USER_NAME}" = confirmed via ${mode === "ptt" ? "push-to-talk (they held the talk button while speaking)" : "their headphones mic"}, reliable.`;
  const header = (domain) =>
    `# Meeting Copilot — Raw Signals — ${date}\n\n` +
    `**Source:** live meeting-copilot ambient listener (${domain}). Raw signals only — no analysis.\n` +
    `**Attribution limits:** ${attrNote} ` +
    `Named speakers only where the transcript names them; otherwise "unattributed" — do NOT guess.\n\n---\n`;

  const section = [`\n## Meeting: ${title}\n`];
  const attributed = state.commitments.filter((c) => c.who !== "unattributed");
  const unattributed = state.commitments.filter((c) => c.who === "unattributed");
  const open = state.questions.filter((q) => !q.answered);

  // Portable layout (no _staging inboxes): one digest file in meetings/, in
  // the knowledge-dir shape, so the next prep pack reads it as "last meeting".
  const stagingLayout = existsSync(join(repoRoot, "people", "_staging")) ||
    existsSync(join(repoRoot, "projects", "_staging"));
  if (!stagingLayout) {
    if (!state.commitments.length && !open.length) return written;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "meeting";
    const f = join(repoRoot, "meetings", `${date}-${slug}.md`);
    const parts = [header("meetings"), ...section];
    if (state.commitments.length) {
      parts.push(`### Commitments (${state.commitments.length})\n`);
      for (const c of [...attributed, ...unattributed]) {
        parts.push(`- [ ] ${c.who}: ${c.what}${c.due ? ` — due ${c.due}` : ""} (${date})\n  > "${c.quote}"`);
      }
    }
    if (open.length) {
      parts.push(`\n### Questions raised and never answered (${open.length})\n`);
      for (const q of open) parts.push(`- [${q.at}] ${q.by}: ${q.text}`);
    }
    mkdirSync(dirname(f), { recursive: true });
    if (!existsSync(f)) writeFileSync(f, parts.join("\n") + "\n");
    else appendFileSync(f, parts.slice(1).join("\n") + "\n");
    written.push(f);
    return written;
  }

  // people/_staging: commitments by identifiable people — evidence-shaped.
  if (attributed.length) {
    const f = join(repoRoot, "people", "_staging", `${date}-meeting-copilot.md`);
    const body = section.concat(
      attributed.map((c) =>
        `- **${c.who}** committed: ${c.what}${c.due ? ` (due ${c.due})` : ""} — [${c.at}]\n  > "${c.quote}"\n  \`attribution:${c.who === USER_NAME ? (mode === "ptt" ? "push-to-talk" : "direct") : "spoken-name"}, verbatim:yes, source-type:meeting-live\``
      )
    ).join("\n") + "\n";
    if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, header("people") + body); }
    else appendFileSync(f, body);
    written.push(f);
  }

  // projects/_staging: all commitments + dropped questions — execution-shaped.
  if (state.commitments.length || open.length) {
    const f = join(repoRoot, "projects", "_staging", `${date}-meeting-copilot.md`);
    const parts = [...section];
    if (state.commitments.length) {
      parts.push(`### Commitments made in-meeting (${state.commitments.length})\n`);
      for (const c of [...attributed, ...unattributed]) {
        parts.push(`- ${c.who}: ${c.what}${c.due ? ` — due ${c.due}` : ""} [${c.at}]\n  > "${c.quote}"`);
      }
    }
    if (open.length) {
      parts.push(`\n### Questions raised and never answered (${open.length})\n`);
      for (const q of open) parts.push(`- [${q.at}] ${q.by}: ${q.text}`);
    }
    const body = parts.join("\n") + "\n";
    if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, header("projects") + body); }
    else appendFileSync(f, body);
    written.push(f);
  }
  return written;
}
