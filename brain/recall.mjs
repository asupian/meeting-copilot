// recall.mjs — the live recall channel: check the room against ALL of the
// knowledge dir's prior records, not just the prep pack.
//
// Design (plan B + a feather of C):
//   B (backbone): a background loop, OFF the card critical path, shells out to the
//     local `qmd` search engine over the whole repo every few seconds, gates the
//     hits, and keeps a small rolling working set. The card path never blocks on
//     a search -- it injects whatever the working set currently holds.
//   C (feather): the loop is event-driven (nudged by new speech, not a fixed
//     tick), and a strong fresh ground-truth hit fires an immediate check instead
//     of waiting for the next conversational beat.
//
// Two retrieval channels run in ONE `qmd query` call (--no-rerank --json
// --explain) and merge by file:
//   kw  -> the query's `lex:` lines (BM25/FTS). Exact terms: names, numbers,
//          statuses. The precision channel -- a mis-stated figure only collides
//          on exact tokens. FTS matching is CONJUNCTIVE (a doc must contain
//          every term in a lex line), so one long keyword line matches almost
//          nothing; we send one short lex line PER RECENT UTTERANCE — words
//          spoken in one breath plausibly co-occur in one file.
//   vec -> the query's `vec:` line (embeddings). Meaning: catches vocabulary
//          mismatch ("bleeding spend on junk inventory" -> the fraud-monitoring
//          initiative line) that BM25 is blind to. The recall channel -- fuzzier, so it
//          never fires an immediate check on its own.
// Per-channel scores come from the --explain traces (ftsScores/vectorScores),
// NOT the fused rank. Scores are NOT comparable across channels, so each has
// its own floor and no cross-scale math. When BOTH channels find the same
// file, that agreement outranks either alone: within a tier the order is
// kw+vec > kw > vec. Every fact carries `via` so a card can be attributed to
// the channel that found its anchor.
//
// The gate is the actual work. Open retrieval over hundreds of docs surfaces the
// knowledge dir's own stale analysis next to current ground truth. So every hit
// is classified:
//   truth   -> goals / financials / evidence / initiative logs. Citable like a
//              pack fact; may anchor a contradiction.
//   context -> briefs, red-teams, profiles, analyze outputs. The knowledge dir's
//              own prior interpretation. A lead, not a fact: soft "worth
//              checking" only, never a contradiction, and may be stale.
// Sensitivity travels with retrieval: with externals in the room, a [SENSITIVE]/
// [CONFIDENTIAL] excerpt is dropped, never surfaced.

import { execFile } from "node:child_process";
import { resolve as resolvePath, sep } from "node:path";

const QMD_DEFAULT = "qmd";

// Pipeline intermediates, not knowledge: verbose, keyword-dense, redundant, and
// stale. The vetted conclusions land in the curated files (repo rule 10), so we
// drop the raw logs entirely and let the destination files speak.
const EXCLUDE_RE = /(_staging\/|\/staging\/|\/archive\/|-raw\.md$|-gather\.md$|-analyze\.md$|red-team|\/_?workflows\/|_schema\.md$|\/_templates\/|\/_shared\/)/i;

// Filler that dilutes a BM25 query. The transcript sentence "how is the
// vendor renewal pacing against the Q3 target" should search as the content
// words "vendor renewal pacing Q3 target", not the whole sentence.
const STOPWORDS = new Set(("the a an is are was were be been being to of in on for and or but with as at by from " +
  "how what why when where who which we i you they he she it this that these those our your their its do does did " +
  "have has had will would should could can about against into over under so then than just now latest feeling think " +
  "trending going get got let us me here there up down out really kind sort like want need see know going gonna yeah " +
  "okay right well actually basically also more most very much many any some all one two").split(/\s+/));
function keywords(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const keep = /\d/.test(raw) ? raw.length >= 2 : raw.length >= 3 && !STOPWORDS.has(raw);
    if (keep && !seen.has(raw)) { seen.add(raw); out.push(raw); }
  }
  return out;
}
// Ground-truth files: the room disagreeing with these is a real collision.
// Paths here are knowledge-root-relative, so initiatives/ may sit at the root
// (portable layout) or nested (legacy layout) — both spellings match.
const TRUTH_RE = /(^|\/)(goals|financials)\.md$|\/evidence\.md$|(^|\/)initiatives\//i;

const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
const SENSITIVE_RE = /\[(SENSITIVE|CONFIDENTIAL)\]/i;
const INTERNAL_RE = /\[(INTERNAL)\]/i;
const DOMAIN_FILES = new Set(["goals", "financials", "context", "market", "competitors", "role", "voice"]);

// Parse `qmd query --json --explain` output into structured hits carrying each
// channel's own score (0-100). The fused rank is discarded on purpose: the
// gate reasons per channel, and RRF's blend has no stable scale.
export function parseQueryJson(stdout) {
  let arr;
  try { arr = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const hits = [];
  for (const d of arr) {
    const path = String(d.file || "").replace(/^qmd:\/\//, "");
    if (!path) continue;
    const snippet = String(d.snippet || "");
    const line = Number((snippet.match(/^@@ -(\d+)/m) || [])[1] || 1);
    const content = snippet.replace(/^@@ .+ @@.*$/m, "").replace(/\s+/g, " ").trim();
    const kw = Math.round(Math.max(0, ...(d.explain?.ftsScores || [])) * 100);
    const vecScore = Math.round(Math.max(0, ...(d.explain?.vectorScores || [])) * 100);
    hits.push({ path, line, title: String(d.title || ""), content, kw, vecScore });
  }
  return hits;
}

function classify(hit) {
  return TRUTH_RE.test(hit.path) ? "truth" : "context";
}

function newestDate(text) {
  const ds = text.match(DATE_RE);
  return ds && ds.length ? ds.sort().at(-1) : null;
}
function pathDate(path) {                // staging/brief files date-stamp the filename
  const m = path.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function shortSource(path) {
  const parts = path.split("/");
  const base = parts.at(-1).replace(/\.md$/, "");
  // people/<slug>/evidence -> "<slug> evidence"; company/goals -> "company goals".
  if (parts.length >= 2 && (base === "evidence" || base === "profile" || DOMAIN_FILES.has(base))) return `${parts.at(-2)} ${base}`;
  return base;
}

export function makeRecall({
  qmdBin = QMD_DEFAULT,
  cwd,
  packText = "",
  externals = false,
  onStrong = () => {},
  minScore = 70,      // kw floor (qmd's own % relevance). Loose on purpose: noise
                      // dirs are already excluded, and the model is the precision
                      // backstop (it must still judge relevance and cite), so more
                      // real candidates beats a tight floor that cuts ground truth.
  vecMinScore = 55,   // vec floor -- its own scale. Observed on the full index:
                      // real semantic catches land 56-59%, chatter noise ~51%.
                      // 55 splits them; below it vec matches *something* for any
                      // sentence, which is exactly the fuzziness to keep out.
  strongScore = 88,   // a kw truth hit this strong fires an immediate check
  strongBothScore = 80, // ...or a kw truth hit this strong that vec also found
  maxSet = 5,
  maxContext = 2,     // stale leads can't crowd out ground truth
  throttleMs = 8000,  // never hit qmd more often than this
  timeoutMs = 4000,   // startup collection-map calls
  vecTimeoutMs = 10000, // the query call embeds the vec line; measured ~1.6s total
  vec = true,         // the semantic channel can be disabled independently
} = {}) {
  // Terms already in the pack: skip re-surfacing what the model already sees.
  const packTerms = new Set(
    packText.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 4)
  );

  let workingSet = [];
  let recentTexts = [];    // rolling window of recent line text, for the query
  let dirty = false;
  let lastRunAt = 0;
  let running = false;
  const state = { calls: 0, errors: 0, lastSources: [] };

  // Feed the recent transcript. The query is built at tick time from a rolling
  // window, so a single-line batch between ticks doesn't starve it.
  function nudge(finals) {
    for (const l of finals) if (l.text?.trim()) recentTexts.push(l.text);
    if (recentTexts.length > 6) recentTexts = recentTexts.slice(-6);
    if (finals.length) dirty = true;
  }

  // A pack fact already covers this hit if most of its distinctive terms are
  // in the pack. Cheap dedup so the model isn't shown the same fact twice.
  function coveredByPack(hit) {
    const terms = [...new Set(hit.content.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 5))];
    if (terms.length < 4) return false;
    const inPack = terms.filter((t) => packTerms.has(t)).length;
    return inPack / terms.length > 0.72;
  }

  // Apply each channel's floor: a sub-floor score counts as "that channel did
  // not find it". A hit below both floors is dropped entirely.
  function applyFloors(hits) {
    const out = [];
    for (const h of hits) {
      const kw = h.kw >= minScore ? h.kw : 0;
      const vecScore = h.vecScore >= vecMinScore ? h.vecScore : 0;
      if (!kw && !vecScore) continue;
      out.push({ ...h, kw, vecScore });
    }
    return out;
  }

  const viaOf = (f) => (f.kw && f.vecScore ? "kw+vec" : f.kw ? "kw" : "vec");
  // Within a tier: agreement first, then kw-only (precision), then vec-only
  // (fuzzy), each by its own channel's score. No cross-scale arithmetic.
  const viaRank = { "kw+vec": 2, kw: 1, vec: 0 };
  const tierSort = (a, b) =>
    viaRank[b.via] - viaRank[a.via] || Math.max(b.kw, b.vecScore) - Math.max(a.kw, a.vecScore);

  function gate(merged) {
    const scored = [];
    for (const h of merged) {
      if (EXCLUDE_RE.test(h.path)) continue;    // pipeline intermediates, not knowledge
      if (SENSITIVE_RE.test(h.content) && externals) continue;   // never surface with externals present
      const weight = classify(h);
      if (weight === "context" && coveredByPack(h)) continue;    // truth is always worth showing, even if the pack hints it
      // Vec-only hits on people profiles are semantic drift ("monitoring,
      // checks" prose reads like anyone's profile) — a person's file needs the
      // exact-words channel to count. Evidence files (truth tier) unaffected.
      if (weight === "context" && !h.kw && /^people\//.test(h.path)) continue;
      scored.push({
        source: `${h.path}:${h.line}`,
        path: h.path,
        short: shortSource(h.path),
        weight,
        via: viaOf(h),
        kw: h.kw,
        vecScore: h.vecScore,
        date: pathDate(h.path) || newestDate(h.content),
        internal: INTERNAL_RE.test(h.content),
        text: h.content.slice(0, 280),
      });
    }
    // Truth first, then a capped tail of context, so stale leads never crowd out
    // ground truth.
    const truth = scored.filter((f) => f.weight === "truth").sort(tierSort);
    const context = scored.filter((f) => f.weight === "context").sort(tierSort).slice(0, maxContext);
    return [...truth, ...context].slice(0, maxSet);
  }

  function runQmd(args, timeout) {
    return new Promise((resolve) => {
      execFile(qmdBin, args, { cwd, timeout, maxBuffer: 4 << 20 }, (err, stdout) => {
        if (err && !stdout) { state.errors++; return resolve(null); }
        resolve(stdout || "");
      });
    });
  }

  // qmd's index is GLOBAL — one index, every registered collection — and a
  // search returns hits as "collection-name/relative/path" regardless of cwd.
  // Two things are therefore NOT automatic and are done here:
  //   scope    — only hits from collections whose folder lives under the
  //              knowledge root count; anything else on the machine's index
  //              (another project, someone's notes) is not meeting knowledge.
  //   normalize — hit paths become knowledge-root-relative, so the tier rules
  //              (goals.md, people/..., initiatives/...) and the panel's /open
  //              link resolution work for any collection naming.
  // Learned once at startup: collection name -> prefix relative to the root
  // ("" when the collection IS the root, "people" when it is root/people).
  let colMap;   // undefined = not loaded yet; null = qmd unavailable
  async function loadCollectionMap() {
    const list = await runQmd(["collection", "list"], timeoutMs);
    if (list == null) return null;
    const names = [...list.matchAll(/^(\S+)\s+\(qmd:\/\//gm)].map((m) => m[1]);
    const map = new Map();
    const root = resolvePath(cwd || ".");
    for (const name of names) {
      const show = await runQmd(["collection", "show", name], timeoutMs);
      const p = (show || "").match(/^\s*Path:\s*(.+?)\s*$/m)?.[1];
      if (!p) continue;
      const cp = resolvePath(p);
      if (cp === root) map.set(name, "");
      else if (cp.startsWith(root + sep)) map.set(name, cp.slice(root.length + 1).split(sep).join("/"));
    }
    if (map.size === 0) {
      console.error(`recall: no qmd collection under ${root} — recall will find nothing.`);
      console.error(`recall: register once with: (cd ${root} && qmd collection add . --name knowledge && qmd embed)`);
    }
    return map;
  }

  function scopeAndNormalize(hits) {
    if (!colMap || !colMap.size) return [];   // unscoped hits are not knowledge
    const out = [];
    for (const h of hits) {
      const i = h.path.indexOf("/");
      const col = i < 0 ? h.path : h.path.slice(0, i);
      if (!colMap.has(col)) continue;         // a collection outside the root
      const prefix = colMap.get(col);
      const rest = i < 0 ? "" : h.path.slice(i + 1);
      out.push({ ...h, path: prefix ? (rest ? `${prefix}/${rest}` : prefix) : rest });
    }
    return out;
  }

  async function tick() {
    if (running || !dirty) return;
    if (Date.now() - lastRunAt < throttleMs) return;
    running = true;
    dirty = false;
    lastRunAt = Date.now();
    // FTS matching is CONJUNCTIVE: a doc must contain EVERY term in a lex
    // line, and there is no OR — one stray non-stopword ("ever", "confirm")
    // kills the whole line. So per utterance we send the full keyword line
    // (rarely matches, but high precision when it does) plus consecutive
    // keyword BIGRAMS as the conjunctive-safe fallback: two adjacent spoken
    // content words co-occurring in one file is still exact-words evidence.
    // Each hit's kw score is the max over whichever lists matched it.
    // Most recent utterance first: the cap must never cut what was just said
    // in favor of older chatter.
    const lexSeen = new Set();
    for (const t of recentTexts.slice(-3).reverse()) {
      const kws = keywords(t).slice(0, 12);
      if (kws.length >= 2) lexSeen.add(kws.join(" "));
      for (let i = 0; i < kws.length - 1; i++) lexSeen.add(`${kws[i]} ${kws[i + 1]}`);
    }
    const lexLines = [...lexSeen].slice(0, 12).map((q) => `lex: ${q}`);
    const vecQ = recentTexts.join(" ").slice(-300).trim();
    const queryDoc = [...lexLines, ...(vec && vecQ ? [`vec: ${vecQ}`] : [])].join("\n");
    try {
      if (queryDoc) {
        if (colMap === undefined) colMap = await loadCollectionMap();
        state.calls++;
        // Scope server-side too (-c): keeps other collections' hits from
        // eating the result budget before the client-side filter sees them.
        const scopeArgs = colMap ? [...colMap.keys()].flatMap((n) => ["-c", n]) : [];
        const out = colMap && colMap.size
          ? await runQmd(["query", queryDoc, "--no-rerank", "--explain", "--json", ...scopeArgs], vecTimeoutMs)
          : null;   // nothing registered under the root — searching would only leak
        if (out != null) {
          const gated = gate(applyFloors(scopeAndNormalize(parseQueryJson(out))));
          const prevTruth = new Set(workingSet.filter((f) => f.weight === "truth").map((f) => f.source));
          workingSet = gated;
          state.lastSources = gated.map((f) => `${f.short}·${f.via}`);
          // Feather of C: a strong, NEW ground-truth hit prompts a card now.
          // Keyword-gated on purpose: vec similarity alone is too fuzzy to
          // interrupt on, but vec agreement lowers the kw bar.
          const fresh = gated.find((f) => f.weight === "truth" && !prevTruth.has(f.source) &&
            (f.kw >= strongScore || (f.kw >= strongBothScore && f.vecScore > 0)));
          if (fresh) onStrong(fresh);
        }
      }
    } finally { running = false; }
  }

  // The block injected into the card prompt. Empty when nothing survived the gate.
  function render() {
    if (!workingSet.length) return "";
    const lines = workingSet.map((f) => {
      const tier = f.weight === "truth" ? "truth" : `context${f.date ? " " + f.date : ""}`;
      return `- [${tier} ${f.via}] ${f.source} — ${f.text}`;
    });
    return "Live from the user's records, matched on the last exchange (kw = exact words, " +
      "vec = similar meaning only — double-check a vec-only line really is about what was said; " +
      "kw+vec = both agree, the strongest signal; cite the path in `source`):\n" + lines.join("\n");
  }

  // Attribute a fired card to the channel that found its anchor: the contract has
  // the model cite the file path in `source`, so match working-set paths against
  // it. Returns null when the card rests on the prep pack instead.
  function attribute(sourceText) {
    if (!sourceText) return null;
    const s = String(sourceText).toLowerCase();
    for (const f of workingSet) {
      const base = f.path.split("/").at(-1).toLowerCase();
      if (s.includes(f.path.toLowerCase()) || (base.length > 6 && s.includes(base))) return f;
    }
    return null;
  }

  return { nudge, tick, render, attribute, workingSet: () => workingSet, sources: () => state.lastSources, state };
}
