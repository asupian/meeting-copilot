# portable/ — the knowledge layer

The copilot's value is grounding: every card cites a fact it holds. Those
facts live in a knowledge directory — one folder of plain markdown. This
folder is how any user builds one from what they already have: a format spec,
a guided intake wizard, and prompts that import existing notes or extract
from connected integrations.

## Pieces

| File | What it is |
|---|---|
| `KNOWLEDGE.md` | The format spec: layout, truth-vs-context tiers, writing rules. The public contract; matches `recall.mjs`'s gate as shipped (zero code change). |
| `prompts/setup-wizard.md` | Guided intake: collects identity + domains, probes which integrations are connected, ALWAYS pulls in existing sources via import/sync first (written artifacts are the mandatory base), then optionally interviews the user for head-only priors (reads on people, unwritten numbers) — targeted at the gaps the pull-in left. Re-running tops up instead of restarting. |
| `prompts/import-knowledge.md` | One-time: distill an existing notes system (Obsidian, Notion export, any folder) into the layout. Source is never modified. |
| `prompts/sync-knowledge.md` | Repeatable: extract from connected integrations (calendar, email, meeting transcripts, docs) into the layout. Calendar-scoped so it never sweeps a whole mailbox. |
| `prompts/build-prep-pack.md` | Per-meeting: `brain/prep-pack-instructions.md` genericized — placeholders for name/domain/knowledge dir, graceful degradation when profiles or tools are missing. |
| `knowledge.sh` | Wrapper: `setup` / `init` / `import` / `sync` / `pack`. Fills the `{{PLACEHOLDER}}`s from `~/.meeting-copilot/config` and picks the execution mode. |

## The execution-mode split (learned from build-prep-pack.sh)

Headless `claude -p` can't reliably reach MCP integrations — server names
differ per session, so an allowlist silently fails. The wrapper therefore
runs:

- **headless, file tools only**: `import`, and `pack --person/--paste`
  (meeting details embedded in the prompt) — unattended-safe.
- **interactive `claude`**: `sync`, and `pack --next` — these need the user's
  connected calendar/email/notes tools, and the user approves each tool once.

## Typical user journey

```bash
./knowledge.sh setup                   # guided: interview -> priors -> import/sync offers
./knowledge.sh sync                    # weekly: last 7 days from integrations
../copilot prep list                   # upcoming meetings, numbered
../copilot prep 2                      # pack for meeting 2 -> ~/.meeting-copilot/prep/<date>-<slug>.md
../copilot live                        # picks the pack whose start time brackets now
```

`copilot prep <n>` pipes the chosen calendar event through `knowledge.sh pack
--paste` and stores the pack per meeting; every build also refreshes the
legacy single `~/.meeting-copilot/prep-pack.md`, so the pre-copilot flow
(`./knowledge.sh pack --next` then `../start.sh`) works unchanged.

(`init` / `import` remain for users who'd rather skip the wizard and write or
seed the dir directly.)

A hand-written knowledge dir (or even just a hand-written prep pack) is fully
supported — the prompts are conveniences, the format is the contract.

## Runtime wiring (done)

`live.mjs` resolves the knowledge root as `--knowledge` flag >
`KNOWLEDGE_DIR` in `~/.meeting-copilot/config` > `~/.meeting-copilot/knowledge`
(`--staging-root` kept as a back-compat alias), and uses it for recall's qmd
cwd, the speaker roster (`people/index.yaml`, falling back to `name:` in
`people/*/profile.md` frontmatter), and card source links. `start.sh` runs
`qmd update`/`qmd embed` inside that dir. The digest writes `_staging` inboxes
when they exist (original layout) and `meetings/YYYY-MM-DD-<slug>.md`
otherwise.
