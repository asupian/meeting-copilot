# meeting-copilot

Live meeting copilot: sits in a meeting, transcribes on-device (Swift), and a
Node brain running `claude -p` surfaces ONE grounded question at a time on a
floating panel.

Read first: [README.md](../README.md) (operations + the user-facing FAQ),
[HOW-IT-WORKS.md](../HOW-IT-WORKS.md)
(mechanisms + design principles), [portable/README.md](../portable/README.md)
(the knowledge layer).

## Hard rules

1. **Public repo — nothing personal in the tree.** No secrets, no absolute
   home paths, no employer domains, hostnames or internal URLs, in code,
   docs or comments. Identity is runtime config
   (`~/.meeting-copilot/config`), never committed. Placeholders in contracts
   stay placeholders.
2. **The regression gate.** Any change to `brain/` or a contract lands only
   after `test/replay-gate.sh` passes (real model call, ~30-60s). Baseline:
   1 card at 0:35 citing the $42,500 SOW anchor.
3. **Grounded or silent.** Every card cites a held fact; a meeting can end
   with zero cards; a generic "good question" is a bug. Cards name the
   question, never the user's position.
4. **Don't touch the TCC/signing design casually** (capture/, build-app.sh):
   app-bundle launch + stable cert is hard-won; regressions cost silent
   permission failures. See `setup.sh` step 4 and `capture/build-app.sh`.
5. **Zero dependencies stays.** The brain is plain Node, the panel plain
   HTML, capture plain Swift. No npm packages, no frameworks.
6. **The knowledge dir is the contract.** Layout/tiers in
   portable/KNOWLEDGE.md match recall.mjs's path regexes; changing either
   side means changing both.

## Layout

```
copilot    the front door CLI: pure router to the journey modules + config
AGENTS.md  install/operate instructions for AI agents pointed at the repo
onboarding/ prep/ live/   the three journey modules: one thin script + README each
cli/       events.mjs (calendar helpers), common.sh (shared plumbing), doctor.sh
capture/   Swift: meetingtap (audio->transcript), screentap (window OCR), TCC bundles
brain/     Node: live.mjs (check loop) + server.mjs (HTTP/SSE) + feedback.mjs
           (vote lifecycle) + lib.mjs (buildCheckUser shared with brain-loop),
           contracts, matcher, recall, ambient, origins
panel/     floating NSPanel + index.html (the whole UI)
portable/  knowledge layer: format spec, intake wizard, import/sync/pack prompts
docs/      README assets (panel screenshot)
media/     demo.mp4 — source of record for the README's embedded player
test/      replay-gate.sh + trigger-checks.sh (model-cost) · live-checks.sh +
           unit.sh + shim/claude (deterministic, zero-cost) · fixtures
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
- Brain provider (2026-08-28): `--provider codex` / `MODEL_PROVIDER="codex"` /
  `COPILOT_PROVIDER` env runs the brain on `codex exec` (ChatGPT subscription
  login) instead of `claude -p`. One dispatch point: lib.mjs streamBrain →
  streamClaude/streamCodex over a shared streamCli core (settle-once, timeout,
  stderr tail). The WHOLE journey is provider-aware, not just live: shell
  resolution is brain_bin() (common.sh; knowledge.sh + setup.sh carry local
  copies — they don't source common.sh), knowledge.sh headless() branches
  (claude --allowedTools vs codex workspace-write sandbox scoped to the
  knowledge dir + --add-dir), interactive wizard/sync launch $(brain_bin),
  onboarding/doctor gate on the CONFIGURED provider (knowledge_state returns
  no-brain, not no-claude; with codex, a missing claude is a warn). Codex MCP
  integrations are the USER'S own ~/.codex config, not claude connectors.
  Sandboxed-HOME tests of codex paths need CODEX_HOME=~/.codex or auth 401s.
  Codex pack build verified spec-conformant 2026-08-28 (triggers, header,
  Numbers-on-file sections). Codex has no --system-prompt (contract rides atop the prompt
  turn), no token deltas (onDelta fires once, cards appear whole), and gets
  `--ephemeral -s read-only --ignore-user-config -C tmpdir` so no session
  files persist and no repo AGENTS.md leaks into checks; vision attaches the
  frame via `-i` instead of the Read tool. Unknown provider values throw.
  Coverage: test/shim/codex twins test/shim/claude (same canned card, codex
  JSONL wire); live-checks.sh reruns per provider (PROVIDER=<p> runs one) —
  claude runs everything, the codex pass keeps only the provider-boundary
  scenarios (wire parse + embedded-contract prompt, ambient call); the
  downstream scenarios (feedback, cleanup, whitelist, timeout) are
  claude_only-gated as provider-independent. `COPILOT_PROVIDER=codex
  test/replay-gate.sh` is the codex model-cost gate — same fixture, same
  1-card/$42,500 baseline (verified 2026-08-28 on both). Prompt greps in
  live-checks must go through check_part: codex captures embed the contract,
  whose TEXT names blocks like QUESTIONS STILL OPEN — a raw grep matches the
  rulebook, not the input.
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
- `.gitignore` ignores `*.jsonl` EXCEPT `test/fixtures/**` — the replay gate
  depends on that exception.
- Prompt assembly is SHARED (lib.mjs buildCheckUser) between live.mjs and
  brain-loop.mjs — never let them diverge again (a replay-only elapsed-% hint
  once made fixtures easier than live). Live gets % from the pack's
  "Scheduled: N minutes" line; replay from the fixture span.
- live.mjs writes trace.jsonl per check (prompt + raw + verdict) — the only
  way a bad live card is reconstructible; deleted with the transcript unless
  --keep-session. A dead model call broadcasts brainDown (never fake silence).
- test/live-checks.sh + test/unit.sh are the zero-cost regression net (claude
  shimmed via test/shim/claude); run them for live.mjs/panel/lib changes.
- The README demo (media/) is a STAGED meeting recorded through the real
  pipeline: live.mjs + panel + a scripted `claude` shim (same stream-json
  contract as test/shim/claude) driving deterministic cards, in a Zoom-style
  HTML scene with the live panel iframed in. GitHub never renders committed
  .mp4 blobs — the README embeds a user-attachments upload (manual drag-drop
  into a comment box; re-upload + swap the URL when the video changes).
- Never replay fixtures by appending them to live.mjs's transcript: the
  elapsed clock anchors to the fixture's old timestamps and the model judges
  a 32-hour meeting. brain-loop.mjs / review-server.mjs are the replay paths;
  for deterministic live.mjs tests, shim `claude` on PATH (capture stdin =
  user prompt, emit canned stream_event lines).
