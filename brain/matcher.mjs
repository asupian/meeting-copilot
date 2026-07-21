// matcher.mjs — do the cross-reference in code, not in the model.
//
// The slow path asks the model to find which prep-pack fact (if any) the speech
// collides with. That search is what forces extended thinking, and thinking is
// ~10s of latency. Here we find candidate facts locally (free, instant) and hand
// the model only those, so its remaining job — judge and phrase — needs no
// thinking at all.
//
// Recall is the whole risk: a fact we fail to match is a card that never fires,
// silently. So match generously (cheap) and let the model be the precision gate.

const STOP = new Set(`a an the and or but if then than that this these those of in on at to for with
from by as is are was were be been being it its it's we our us you your they them their he she his
her i me my do does did doing have has had having will would could should can may might must not no
through update thing point time way need needs needed make makes making take takes taking come comes
so up out about into over after before again once here there when where why how all any both each
few more most other some such only own same too very just now also what which who whom get got go
going going-to going-to-be gonna wanna kind sort like really actually basically um uh yeah okay ok
right well think know see said say says thing things lot lots much many one two three first second`
  .split(/\s+/).filter(Boolean));

// A glanceable topic name from a fact bullet: strip markdown/gate tags, take the
// clause before the first — : or (, cap it. "**Vendor Renewal**: At Risk"
// -> "Vendor Renewal".
function shortLabel(body) {
  let t = body.replace(/\[(INTERNAL|SENSITIVE|CONFIDENTIAL)\]/gi, "").replace(/\*\*/g, "")
    .replace(/^(Open threads with them:|Pre-flagged unraised:)\s*/i, "").trim();
  t = t.split(/\s+[—–-]\s+|:\s|\s*\(/)[0].trim();
  const words = t.split(/\s+/);
  if (words.length > 6) t = words.slice(0, 6).join(" ") + "…";
  return t.replace(/["']/g, "").slice(0, 48) || body.slice(0, 40);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%$.\s-]/g, " ").replace(/\s+/g, " ").trim();

// Percentages, dollar amounts, and magnitude words survive transcription in
// different ways; capture each so a spoken "91%" can meet a held "81%".
function numbersIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.add(`pct:${m[1]}`);
  for (const m of text.matchAll(/\$\s?(\d+(?:\.\d+)?)\s*([mkb]|million|thousand|billion)?/gi)) {
    out.add(`usd:${m[1]}${(m[2] || "").toLowerCase()[0] || ""}`);
  }
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(m|k|million|thousand)\b/gi)) {
    out.add(`num:${m[1]}${m[2].toLowerCase()[0]}`);
  }
  return out;
}

function termsIn(text) {
  const t = norm(text);
  const out = new Set();
  for (const w of t.split(" ")) {
    const bare = w.replace(/^[-.]+|[-.]+$/g, "");
    if (bare.length < 3 || STOP.has(bare)) continue;
    if (/^\d+$/.test(bare)) continue;          // bare digits handled by numbersIn
    out.add(bare);
  }
  return out;
}

/**
 * Parse a prep pack into facts. A fact is a bullet under one of the sections the
 * brain is allowed to build a card from. `triggers:` lines (written by the
 * prep-pack builder) add vocabulary the words themselves do not contain — the
 * semantic work is done offline, where latency does not matter.
 */
export function parseFacts(packText) {
  const facts = [];
  const lines = packText.split("\n");
  let section = null;
  // Both header forms: "Numbers on file" is the portable pack spec
  // (portable/prompts/build-prep-pack.md); "Numbers jarvis holds" is the
  // legacy pack wording, kept until the old packs are gone.
  const WANTED = /^##\s*(Numbers on file|Numbers jarvis holds|Open initiative threads|Prep goals)/i;
  const ANY_H2 = /^##\s+/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ANY_H2.test(line)) { section = WANTED.test(line) ? line.replace(/^##\s*/, "").trim() : null; continue; }
    // Attendee open threads are facts too, but never live-state ones.
    const attendeeThread = /^-\s*Open threads with them:/i.test(line);
    if (!section && !attendeeThread) continue;
    if (!/^\s*-\s+/.test(line)) continue;

    const text = line.replace(/^\s*-\s+/, "").trim();
    if (!text || /^none/i.test(text)) continue;

    // An optional `(triggers: a, b, c)` group supplies semantic vocabulary. It may
    // sit anywhere in the line; strip it from the body so it cannot double-count.
    let triggers = [];
    const tm = text.match(/\(triggers:\s*([^)]+)\)/i);
    const body = tm ? (text.slice(0, tm.index) + text.slice(tm.index + tm[0].length)).replace(/\s+/g, " ").trim() : text;
    if (tm) triggers = tm[1].split(",").map((s) => norm(s).trim()).filter(Boolean);

    const gated = /\[SENSITIVE\]|\[CONFIDENTIAL\]/i.test(body);
    const internal = /\[INTERNAL\]/i.test(body);
    facts.push({
      label: shortLabel(body),
      id: `f${facts.length + 1}`,
      section: section || "Attendee open threads",
      text: body,
      gated,
      internal,
      terms: new Set([...termsIn(body), ...triggers.flatMap((t) => [...termsIn(t)])]),
      numbers: numbersIn(body),
      triggerPhrases: triggers,
    });
  }
  return facts;
}

// Rarer terms discriminate better: a term in every fact tells us nothing.
function inverseFrequency(facts) {
  const df = new Map();
  for (const f of facts) for (const t of f.terms) df.set(t, (df.get(t) || 0) + 1);
  return (t) => 1 / (1 + Math.log(1 + (df.get(t) || 0)));
}

/**
 * Which facts does this speech touch?
 * Returns [{fact, score, why}] above threshold, best first, capped.
 */
export function match(speech, facts, { max = 3, minScore = 0.9 } = {}) {
  if (!facts.length) return [];
  const idf = inverseFrequency(facts);
  const sTerms = termsIn(speech);
  const sNums = numbersIn(speech);
  const normSpeech = norm(speech);

  // How many facts share each term? A term in many facts is generic.
  const df = new Map();
  for (const f of facts) for (const t of f.terms) df.set(t, (df.get(t) || 0) + 1);

  const scored = [];
  for (const f of facts) {
    if (f.gated) continue;                      // never a candidate, ever
    let score = 0;
    let distinctive = false;                    // a rare term, a trigger, or a number
    const hits = [];

    for (const t of sTerms) {
      if (!f.terms.has(t)) continue;
      score += idf(t); hits.push(t);
      // Acronyms (SOW, RFP, QPS, SLA) are often the MOST distinctive tokens in
      // a domain and are only 3 characters. Rarity, not length, is the signal.
      if ((df.get(t) || 0) <= 2 && t.length >= 3) distinctive = true;
    }
    // A shared trigger phrase is strong evidence the topic matches — but match on
    // WORD BOUNDARIES, not substrings, or a 2-letter trigger like "ai" fires
    // inside "again"/"maintain" and the guard/topics scream on nothing.
    for (const p of f.triggerPhrases) {
      if (!p) continue;
      const re = new RegExp(`(?:^|\\W)${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\W|$)`);
      if (re.test(normSpeech)) { score += 1.2; hits.push(`"${p}"`); distinctive = true; }
    }
    // Any number of the same kind means the speech is talking quantities about
    // this fact — the highest-value collision, whether or not the values agree.
    for (const n of sNums) {
      const kind = n.split(":")[0];
      if ([...f.numbers].some((fn) => fn.split(":")[0] === kind)) { score += 0.8; hits.push(n); distinctive = true; }
      if (f.numbers.has(n)) { score += 0.4; }   // exact same number: probably agreement
    }
    // Generic word overlap alone is never enough. Without a distinctive signal
    // the "match" is noise, and a noisy candidate wastes a model call and can
    // manufacture a card out of nothing.
    if (distinctive && score >= minScore) scored.push({ fact: f, score: Number(score.toFixed(2)), why: hits.slice(0, 6) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max);
}


/**
 * Match over a rolling window of recent speech rather than one utterance.
 * "Have we gotten feedback from Rivertech..." and "...did we hear that explicitly
 * from them?" are 14 seconds apart; the entity is in the first, the claim in the
 * second. A single-utterance matcher sees neither.
 *
 * lines: [{t, text}] most recent last. windowSec: how far back to look.
 */
export function matchWindow(lines, facts, { windowSec = 25, ...opts } = {}) {
  if (!lines.length) return [];
  const endMs = Date.parse(lines[lines.length - 1].t);
  const recent = lines.filter((l) => endMs - Date.parse(l.t) <= windowSec * 1000);
  return match(recent.map((l) => l.text).join(" "), facts, opts);
}


/**
 * Disclosure guard: does recent speech approach a fact the user must not say out
 * loud in this room? Matches ONLY [INTERNAL] / [SENSITIVE] / [CONFIDENTIAL]
 * facts — the ones match() deliberately never surfaces as card candidates.
 * Pure code, no model call: a guard that costs nothing can afford to be jumpy,
 * because its output is a quiet amber note, not an interruption.
 */
export function matchGuard(lines, facts, { windowSec = 25 } = {}) {
  const guarded = facts
    .filter((f) => f.gated || f.internal)
    .map((f) => ({ ...f, gated: false }));   // un-gate the copies so match() will look at them
  return matchWindow(lines, guarded, { windowSec, max: 2, minScore: 1.8 });
}
