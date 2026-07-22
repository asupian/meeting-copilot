# meeting-copilot

Live meeting copilot: sits in a meeting, transcribes on-device (Swift), and a
Node brain running `claude -p` surfaces ONE grounded question at a time on a
floating panel. Extracted from a private repo for public release; not yet
generic, not yet published.

Read first: [README.md](../README.md) (operations), [HOW-IT-WORKS.md](../HOW-IT-WORKS.md)
(mechanisms + design principles), [portable/README.md](../portable/README.md)
(the knowledge layer). Current backlog and session context: [.claude/HANDOFF.md](HANDOFF.md).

## Hard rules

1. **Private remote only.** The scrub is done and the owner decided
   (2026-07-21): the repo lives on a PRIVATE GitHub remote. Never make it
   public or push its content anywhere else without the owner's explicit
   say-so.
2. **The regression gate.** Any change to `brain/` or a contract lands only
   after `test/replay-gate.sh` passes (real model call, ~30-60s). Baseline:
   1 card at 0:35 citing the $42,500 SOW anchor.
3. **Grounded or silent.** Every card cites a held fact; a meeting can end
   with zero cards; a generic "good question" is a bug. Cards name the
   question, never the user's position.
4. **Don't touch the TCC/signing design casually** (capture/, build-app.sh):
   app-bundle launch + stable cert is hard-won; regressions cost silent
   permission failures. See README "Signing & permissions".
5. **Zero dependencies stays.** The brain is plain Node, the panel plain
   HTML, capture plain Swift. No npm packages, no frameworks.
6. **The knowledge dir is the contract.** Layout/tiers in
   portable/KNOWLEDGE.md match recall.mjs's path regexes; changing either
   side means changing both.

## Layout

```
copilot    the front door CLI: pure router to the journey modules + config
onboarding/ prep/ live/   the three journey modules: one thin script + README each
cli/       events.mjs (calendar picker helpers) + common.sh (shared plumbing)
capture/   Swift: meetingtap (audio->transcript), screentap (window OCR), TCC bundles
brain/     Node: live.mjs (server), contracts, matcher, recall, ambient, origins
panel/     floating NSPanel + index.html (the whole UI)
portable/  knowledge layer: format spec, intake wizard, import/sync/pack prompts
test/      replay-gate.sh + fixtures (the one place .jsonl is committed)
```

## Runtime facts

- Knowledge root: `--knowledge` flag > `KNOWLEDGE_DIR` in
  `~/.meeting-copilot/config` > `~/.meeting-copilot/knowledge`.
- Session data: `~/.meeting-copilot/sessions/`, never the repo.
- Per-meeting prep packs: `~/.meeting-copilot/prep/<date>[-HHMM]-<slug>.md`
  (written by `copilot prep <n>`); the legacy single
  `~/.meeting-copilot/prep-pack.md` stays the default and is refreshed on
  every build (write-through), so plain `./start.sh` keeps working.
- Card feedback: 👍/👎/dismiss → `POST /feedback` → session `feedback.jsonl`
  + live modulation in live.mjs (feedbackGap/feedbackBlock — tighten-only;
  exact no-op with zero votes, which is what keeps the replay gate meaningful).
  Negatives persist to `~/.meeting-copilot/feedback-history.jsonl` (200-line
  cap) and seed the next meeting's prompt bar (30-day window, max 10).
- NO transcription retention: live.mjs deletes the session's transcript.jsonl
  / screen.jsonl / frame.png after the digest unless `--keep-session` (only
  the session defaults — explicit --transcript paths are never deleted).
  review-server replays and fixture-making need `--keep-session`.
- Config keys added 2026-07-22: `PREP_LOOKAHEAD_H`, `KNOWLEDGE_SYNCED_AT`
  (stamped by sync; prep/live warn past 7 days), `KNOWLEDGE_MERGED_AT`.
- Detection taxonomy: cards carry `type` ∈ {collision, gap, reinforce}
  (lib.mjs CARD_TYPES; contract defines classes+modes+ladder collision > gap
  > reinforce). live.mjs whitelists — invalid/missing type = no label, never
  guessed; SSE carries it as `cardType` (`type` is the SSE event kind); panel
  shows the .dtype chip (red/amber/green).
- `test/trigger-checks.sh` = rubric-tier fixtures, one per detection mode the
  binary gate doesn't cover (win-gloss, goal-drift, trend-gloss, relitigation,
  load, recurrence), asserting anchor AND class; run for substantive contract
  changes. Fixtures must ISOLATE their mode — a second live card in the same
  beat gets out-laddered (that's how win-gloss failed once).
- `dropped` mode (unanswered question resurfaced) is live.mjs-only (ambient
  state -> QUESTIONS STILL OPEN block); not covered by brain-loop fixtures —
  verify via the claude shim.
- Headless `claude -p` cannot reliably reach MCP tools — anything needing
  integrations runs in an interactive session (see portable/README.md).
