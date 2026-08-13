# For AI agents

You have been pointed at this repo and asked to install or operate it.
Follow this file exactly; it is written for you.

**What this is:** a live meeting copilot for macOS. It transcribes meetings
on-device, compares what's said against the user's own notes ("the knowledge
dir"), and shows the user one grounded question at a time on a floating
panel. It keeps no recording.

## Preconditions — check these first

```bash
./copilot doctor
```

Read-only, ~2 seconds, tells you exactly what's missing. Requirements:

| Requirement | Check | If missing |
|---|---|---|
| macOS 26+ | `sw_vers -productVersion` | Hard stop — the on-device transcriber ships with macOS 26. |
| node | `node -v` | `brew install node` |
| swiftc | `swiftc --version` | `xcode-select --install` (HUMAN may need to approve/password) |
| Claude Code CLI, logged in | `claude --version` | Install from claude.com/claude-code; **login is a HUMAN step** |
| gws CLI (optional) | `command -v gws` | Without it, the calendar meeting-picker is unavailable; prep still works via `copilot prep --text "<describe the meeting>"` |
| qmd (optional) | `command -v qmd` | Without it, live recall over the knowledge dir is off |

`./copilot onboard integrations` prints what each optional piece unlocks, whether
it is connected, and how to connect it. Read-only; it installs nothing.

## Install — one command, HUMAN must be present

```bash
./copilot onboard
```

**Check the exit code.** `onboard` exits 0 only when there is a knowledge base to
cite; otherwise it prints `NOT READY —` with the reason and the one command that
fixes it, and exits 1. Do not report a successful install on a non-zero exit: the
binaries can be built and the copilot still have nothing to say.

What happens, and where the human is required (you cannot do these parts):

1. Capture binaries compile in the background. No interaction.
2. A claude session asks the HUMAN where their notes live (Obsidian / Notion
   / a folder) and ingests them as the knowledge dir. These are the human's
   answers — hand control back for this conversation.
3. The build finishes: signing cert, app bundles, then a live self-test.
   macOS shows **two permission dialogs** (Microphone, System Audio
   Recording) — the HUMAN must click Allow. You cannot grant TCC permissions.
4. Optional trial: the human may provide a path to a past meeting recording
   (Enter skips).
5. Prep packs auto-build for upcoming calendar meetings (skipped gracefully
   when the gws CLI is absent).

Do NOT run `npm install` or add any dependency — this repo is deliberately
zero-dependency (plain node, plain bash, plain Swift) and must stay that way.

## Verify the install

```bash
./copilot doctor          # expect: "DOCTOR: healthy"
./test/unit.sh            # ~2s, no network: pure-helper checks
./test/live-checks.sh     # ~90s, NO model cost: full live-brain behavior against a fake model
./test/replay-gate.sh     # ~60s, ONE real claude call: the end-to-end proof (1 card citing $42,500)
```

## Operate

```bash
./copilot prep list       # upcoming meetings, numbered (needs the gws CLI)
./copilot prep 2          # build the briefing pack for meeting 2
./copilot prep --text "1:1 with Dana — renewal pricing"   # no calendar needed
./copilot live            # at meeting time — picks the right pack itself; Ctrl-C ends + digests
./copilot doctor          # any time something seems off
```

`prep --text` takes free text in any shape — args, a pipe, or a prompt — and a
bare title is a complete input. Use it whenever the calendar is not connected;
it is the primary path for a new user, not a fallback.

Logs and the meeting digest live in `~/.meeting-copilot/sessions/<timestamp>/`.
The transcript is deleted when the meeting ends (by design); pass
`--keep-session` to `copilot live` if the user asks to keep it. `perf.json`
survives that cleanup on purpose — it holds per-call latency, prompt size and
concurrency, never meeting content. Read it first for any "it got slow / it
hung" report; the end-of-meeting log line summarises it as early -> late latency.
Model calls are killed after `COPILOT_CALL_TIMEOUT_MS` (default 90s).

## Invariants — do not violate these when changing code

- Any change under `brain/` or to a contract lands ONLY after
  `./test/replay-gate.sh` passes; substantive contract changes also need
  `./test/trigger-checks.sh` (6 fixtures, real model calls).
- Zero dependencies, forever. No package managers.
- `portable/KNOWLEDGE.md` (layout/tiers) and `brain/recall.mjs` (path
  regexes) are a matched pair — change both or neither.
- Do not touch the signing/permissions design in `capture/` and
  `capture/build-app.sh` — a wrong move silently breaks macOS permissions.
- This is a public repo. Never commit secrets, absolute home paths, or an
  employer's internal hostnames, domains or URLs. Real identity belongs in
  `~/.meeting-copilot/config`, which is outside the repo.

Common user questions (cost, consent, uninstall, defaults): the FAQ section of
`README.md`. Maintainer-level context: `.claude/CLAUDE.md`. Mechanisms:
`HOW-IT-WORKS.md`.
