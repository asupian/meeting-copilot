# The knowledge directory — what the copilot reads

The copilot is only as good as the facts it holds. Those facts live in ONE
folder of plain markdown (default `~/.meeting-copilot/knowledge/`), read by two
consumers:

1. **The prep-pack builder** (before a meeting) — distills the folder into a
   ~1500-word pack of facts relevant to the attendees.
2. **Live recall** (during a meeting) — full-text + semantic search over the
   whole folder every few seconds, matching what's being said against what you
   have on file.

You can write this folder by hand, import it from an existing notes system
(`prompts/import-knowledge.md`), or let Claude build it from your connected
integrations — calendar, email, meeting transcripts, docs
(`prompts/sync-knowledge.md`). All three compose: import once, sync weekly,
hand-edit anytime.

## Layout — file names carry meaning

Live recall decides how much to trust a hit BY ITS PATH. Two tiers:

| Tier | What qualifies | How the copilot may use it |
|---|---|---|
| **truth** | `goals.md`, `financials.md`, any `evidence.md`, anything under `initiatives/` | Citable fact. May anchor a "the room just contradicted this" card. |
| **context** | everything else (profiles, meeting notes, free notes) | A lead, not a fact. Surfaces as "worth checking", never a correction. |

```
knowledge/
├── goals.md              # truth — targets, metrics, deadlines you'd correct someone on
├── financials.md         # truth — money numbers (budget, quotes, burn, pricing)
├── initiatives/          # truth — one file per project / deal / workstream
│   └── <project>.md      #   status, open items as `- [ ]`, dated milestones
├── people/
│   └── <slug>/
│       ├── profile.md    # context — your read on them, how they operate (opinion)
│       └── evidence.md   # truth — dated, observed facts: commitments, quotes, decisions
├── meetings/
│   └── YYYY-MM-DD-<topic>.md   # context — past meeting notes / distilled transcripts
└── notes/                # context — anything else worth surfacing
```

The tier split is the whole quality mechanism: only put a fact in a truth file
if you'd stand behind correcting someone with it. Opinions and reads go in
profiles and notes — recall will still surface them, softly.

## Writing rules

- **One fact per line.** Recall injects line-level excerpts; a fact buried in a
  paragraph surfaces as mush.
- **Date every fact**: an ISO date (`2026-07-14`) somewhere on the line or in
  the filename. Recall shows the date so a stale fact is visibly stale.
- **Numbers verbatim, with source**: `Vendor quote — $42,500 fixed (2026-07-02)
  (src: email:Dana "SOW v2")`. The `(src: ...)` descriptor is what lets a live
  card link back to the original email/doc instead of your notes file.
- **Open items as checkboxes**: `- [ ] Dana to send revised SOW (due 2026-07-18)`.
  The prep-pack builder harvests unchecked items as "open threads".
- **Trends are one maintained line, token first**: `[trend] NA churn: 3rd
  consecutive monthly rise — 2.1% (May) -> 2.4% (Jun) -> 2.8% (Jul)
  (src: doc:"Churn dashboard")`. Written and updated in place by sync when a
  metric has >=2 dated points (the one exception to append-only) — this is how
  a slow drift becomes a fact the live copilot can collide with an optimistic
  room.
- **Recurrences are one maintained line, token first**: `[recurring] EU data
  residency: unresolved across 4 meetings since 2026-05-12 (last: 2026-07-20)`.
  Maintained by sync/merge when the same item stays unresolved across >=3
  dated notes; removed when it resolves. This is how a chronic topic becomes
  a fact the copilot can raise when the room treats it as fresh.
- **Sensitivity is a literal token, first on the line**:
  - `[SENSITIVE]` / `[CONFIDENTIAL]` — never surfaced when outsiders are in the
    meeting; never carried into a prep pack as plain prose.
  - `[INTERNAL]` — usable in-house, warned about when externals are present.
  Recall greps for these exact tokens; a sensitive fact written without its
  token is unprotected.

## Names to avoid

Recall drops paths matching its noise filter. Don't name files or folders:
`archive/`, `staging/` or `_staging/`, `workflows/`, `_templates/`, `_shared/`,
anything containing `red-team`, or files ending `-raw.md`, `-gather.md`,
`-analyze.md`, `_schema.md`. (These are pipeline-intermediate names in the
original system; the filter ships as-is.)

## Two behaviors worth knowing

- **Truth crowds out context.** Each recall injection carries at most 5 facts,
  max 2 of them context-tier. If you want the copilot to actually cite
  something live, put it in a truth file.
- **Profiles need exact words.** A person's `profile.md` only surfaces on an
  exact-keyword match (semantic-only matches on profile prose are drift and get
  dropped). Facts about a person you want caught by meaning — put them in that
  person's `evidence.md`.

## Indexing

Recall shells out to [`qmd`](https://github.com/tobi/qmd), whose index is
GLOBAL and collection-based: a folder is searchable only after being
registered as a collection. `knowledge.sh setup`/`init` registers the
knowledge dir (as collection `knowledge`), and `start.sh` re-registers if it
finds nothing registered under the dir — so normally there is nothing to do
manually. Registered by hand:

```bash
cd <knowledge-dir> && qmd collection add . --name knowledge && qmd embed
```

`start.sh` runs `qmd update` (~1s, re-index) at launch and backgrounds the
embedding pass, so edits are picked up per meeting. Recall only injects hits
from collections that live UNDER the knowledge dir — anything else indexed on
the machine is ignored, and hit paths are reported relative to the knowledge
dir regardless of collection naming.
