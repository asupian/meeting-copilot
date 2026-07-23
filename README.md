# meeting-copilot

A quiet assistant that sits in your meetings. It listens, watches the shared
screen, and — only when the conversation collides with something you know —
hands you ONE question worth asking. It never speaks for you, and a meeting
that ends with zero questions is the tool working, not failing.

Everything heavy happens on your Mac: audio and screen become text on-device,
nothing is recorded, and the reasoning runs through your existing Claude Code
login. No API key, no accounts, no dependencies to install.

**Setting this up with an AI agent? Point it at [AGENTS.md](AGENTS.md) —
it has the exact steps and knows which parts need a human.**

## Principles

1. **The freshest version of what you know, in the room.** Before each
   meeting it builds a briefing from your own notes; during the meeting it
   searches everything you have on file. The room still outranks the record:
   facts arrive dated, as "I have X on file — is that current?", never as
   corrections.
2. **It watches for collisions, drift — and wins.** Contradictions with your
   records, risks the room is glossing past, drift against your goals, and
   good news nobody is naming. Each fires only when it rests on a specific
   fact you hold — grounded or silent.
3. **Intelligence, not a recording.** Audio and pixels become text in real
   time and the working transcript is deleted when the meeting ends
   (recording is another tool's job). What persists is derived: the digest of
   commitments, and your votes on cards.

## What you need

A Mac on macOS 26 or newer, [Claude Code](https://claude.com/claude-code)
installed and logged in, and about 10 minutes.

## Install

```bash
./copilot onboard
```

One guided command. While it compiles in the background, a short Claude
session asks where your notes live (Obsidian, Notion, or any folder) and
turns them into the copilot's knowledge — or builds knowledge from your
calendar, email, and Slack if you have no notes. Then two macOS permission
dialogs (click Allow), an optional trial run on a recording of a past
meeting, and it pre-builds a briefing for each upcoming meeting.

## Daily use

```bash
./copilot live        # at meeting time — that's the whole command
```

A small panel floats over your meeting. Mostly it stays quiet. When a card
appears, it's one question, the fact it rests on, and a link to the original
source. Vote cards up or down — negative votes make it quieter and pickier,
in this meeting and the next ones. Ctrl-C ends the meeting: you get a digest
of commitments made and questions that never got answered, written into your
notes. The transcript is deleted.

Briefings refresh themselves at install and can be rebuilt anytime:

```bash
./copilot prep list   # upcoming meetings, numbered
./copilot prep 2      # rebuild the briefing for meeting 2 (--refresh pulls last-day email first)
```

## What it detects

Three kinds of card, color-coded on the panel:

| Chip | Class | Fires when |
|---|---|---|
| red | **collision** | the room disagrees with your records: a wrong number, status, date or owner; a known trend read the wrong way; a settled decision being reopened; a date that conflicts with a deadline you hold |
| amber | **gap** | something needed is missing before the room moves on: a decision forming without the data you hold, your meeting goal untouched late, your question dropped unanswered, an unraised blocker, someone overcommitting against open items on file, a chronic topic treated as fresh |
| green | **reinforce** | nothing is wrong: a fact worth putting on the table, or a win nobody has named |

One card per check; when several compete, collision > gap > reinforce.
Every card cites a specific fact from your files — no fact, no card.

## Privacy

- Audio and pixels are processed on-device; what leaves the Mac is text (plus
  one optional image per slide for chart-reading), through your own claude
  session. `--no-vision` stops the image; `--deepgram` is an explicit opt-in
  that sends audio to a cloud transcriber.
- Facts you mark `[SENSITIVE]` never surface when outsiders are present; a
  guard warns you when conversation approaches them.
- No transcription is retained: transcript, screen text and logs holding them
  are deleted at meeting end. `--keep-session` keeps them (needed for replay
  tooling). The digest and your card votes are what survive.

## When something's off

```bash
./copilot doctor      # 2-second health check: deps, build, permissions, knowledge, packs
```

Each meeting's logs live in `~/.meeting-copilot/sessions/<timestamp>/`. The
self-test (`./selftest.sh`) proves the audio tap live. If the panel says
"brain unreachable", your `claude` login or network died mid-meeting.

## Going deeper

| Doc | What's in it |
|---|---|
| [AGENTS.md](AGENTS.md) | exact install/operate steps for AI agents |
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | mechanisms and design principles, end to end |
| [onboarding/](onboarding/) · [prep/](prep/) · [live/](live/) | the three journeys, one page each |
| [portable/README.md](portable/README.md) | the knowledge layer: format, ingestion, sync |
| [.claude/CLAUDE.md](.claude/CLAUDE.md) | maintainer rules (regression gate, invariants) |

Useful flags (`copilot live` passes them through): `--headphones` / `--room`
(mic modes), `--no-screen`, `--no-vision`, `--no-recall`, `--keep-session`,
`--externals` (arm the disclosure guard), `--cap N`, `--prep <file>`.

Test without a meeting: `./test/unit.sh` (2s), `./test/live-checks.sh` (~90s,
no model cost), `./test/replay-gate.sh` (one real model call — the regression
gate for any brain change).
