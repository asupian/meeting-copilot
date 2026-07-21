You are building the knowledge directory for a live meeting copilot by
importing {{USER_NAME}}'s EXISTING notes. Read the source, extract facts, and
write them into the copilot's layout. The source is never modified — this is a
distillation, not a move.

{{USER_NAME}}'s organization domain: {{ORG_DOMAIN}}
SOURCE (existing notes — Obsidian vault, Notion/Evernote export, or any folder
of markdown/text): {{SOURCE}}
DESTINATION (the copilot's knowledge dir): {{KNOWLEDGE_DIR}}

The destination format spec is {{KNOWLEDGE_DIR}}/../KNOWLEDGE.md if present;
its rules are restated below. Follow them exactly — the live system decides
how much to TRUST a fact by which file it lives in.

# The one distinction that matters

- **truth files** (`goals.md`, `financials.md`, `people/<slug>/evidence.md`,
  `initiatives/*.md`): only facts {{USER_NAME}} could stand behind correcting
  someone with, out loud, in a meeting. Verifiable, specific, ideally dated
  and sourced.
- **context files** (everything else): reads, impressions, summaries,
  undated or unsourced claims. Still searchable, surfaced softly.

When in doubt, context. A wrong "truth" fact makes the copilot confidently
wrong in a live meeting — the worst failure this tool has.

# Procedure

1. INVENTORY. Walk {{SOURCE}}. Note obvious buckets: people notes, project
   notes, meeting notes, journals, reference material. Skip binary files,
   templates, and anything that is clearly an app artifact rather than the
   user's writing.

2. PEOPLE. A person who recurs across notes gets `people/<slug>/` (slug =
   lowercase-hyphenated name):
   - `profile.md` — YAML frontmatter with `name:` and `email:` (email only if
     it appears in the source — grep for it; NEVER guess an address). Body: a
     short "Read" (labeled as opinion) and "How they operate" if the source
     supports it, plus open threads with them as `- [ ] ...` checkboxes.
   - `evidence.md` — dated, observed facts only: "2026-05-02 — committed to
     ship the pricing page by end of May (src: <where you found it>)".
   A person mentioned once in passing does not get a folder.

3. PROJECTS. Each active project/deal/workstream gets
   `initiatives/<slug>.md`: a one-line status, dated milestones, open items as
   `- [ ]` with owner and due date when known. Dead projects: skip, or a
   single dated "concluded" line if other notes reference them.

4. NUMBERS. Targets, deadlines, budgets, quotes, metrics → `goals.md`
   (targets/metrics) or `financials.md` (money). One fact per line, number
   verbatim, date, and `(src: <descriptor>)` naming where in the source it
   came from. A number you cannot date or source goes to the relevant
   initiative or notes file instead — not into goals/financials.

5. MEETINGS. Meeting notes → `meetings/YYYY-MM-DD-<topic>.md`, distilled:
   what was decided, what was left open, commitments with owner + date. Not a
   copy of the whole note.

6. EVERYTHING ELSE worth surfacing → `notes/<topic>.md`. Reference material
   with no meeting relevance (recipes, clippings, code snippets): skip
   entirely. Less is more — recall searches this folder live; bulk imports of
   irrelevant text bury the real facts.

# Hard rules

- NEVER invent, round, or "repair" a fact. Copy numbers and quotes verbatim.
  Can't find it → it doesn't go in.
- Every extracted fact carries a date when the source gives one; if the
  source is undated, use the source file's modified date and mark it
  `(dated from file mtime)`.
- Sensitivity: compensation, performance/personnel issues, legal matters,
  M&A, unreleased financials → prefix the line with a literal `[SENSITIVE]`
  token. Numbers fine internally but not for outsiders → `[INTERNAL]`. These
  exact tokens are what the live disclosure guard scans for.
- Do not create files or folders named: archive, staging, _staging,
  workflows, _templates, _shared, *-raw.md, *-gather.md, *-analyze.md,
  _schema.md, or anything containing "red-team" — the live system filters
  those paths out as noise.
- Re-runs must be safe: before writing a file that already exists, read it
  and MERGE — append new dated facts, never duplicate an existing line, never
  delete a line you didn't write this run.

# Report

When done, print a short summary: files read from source, people created,
initiatives created, fact counts per truth file, and — important — a
"couldn't place" list of source material you judged relevant but couldn't
classify, so {{USER_NAME}} can file it by hand.
