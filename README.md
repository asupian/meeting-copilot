# meeting-copilot

A quiet assistant that sits in your meetings. It listens, watches the shared
screen, and — only when the conversation collides with something you know —
hands you ONE question worth asking. It never speaks for you, and a meeting
that ends with zero questions is the tool working, not failing.

Everything heavy happens on your Mac: audio and screen become text on-device,
nothing is recorded, and the reasoning runs through your existing Claude Code
login. No API key, no accounts, no dependencies to install.

![The panel mid-meeting: one card, the fact it rests on, and the live strips underneath](docs/panel.png)

**Questions before you install — cost per meeting, consent, what breaks
without the optional pieces, how to uninstall? Jump to the [FAQ](#faq).**

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

A Mac on macOS 26 or newer (the on-device transcriber ships with 26 — this is
a hard stop), [Claude Code](https://claude.com/claude-code) installed and
logged in on any paid plan, a folder of notes worth citing, and about 10
minutes.

## Install

```bash
git clone https://github.com/asupian/meeting-copilot.git
cd meeting-copilot
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

## FAQ

**What does it cost me per meeting?** It runs on your Claude Code
subscription — no API key, no separate billing. One `claude -p` call per
conversational beat, one at a time, each ~10–25s. A busy hour is roughly
100–250 calls (estimated from the cadence, not measured). Read your real
numbers after a meeting: `perf.json` in the session dir holds call count and
prompt size, and no meeting content.

**Which plan, and which model?** Any paid plan. Pro is fine for a couple of
meetings a day; if Claude Code is already your main work tool, you want Max.
The model is whatever your Claude Code default is — the live path passes no
`--model`. Extended thinking stays on: it is the ~6–15s latency floor, and
it's what makes the model cross-reference instead of pattern-match.

**Will I hit a rate limit mid-meeting?** Possibly, on a heavy day. It fails
loud, not silent: the panel shows "brain unreachable" and capture keeps
running, so you still get the digest. `--cap 8` and `--min-gap 120` put a
hard ceiling on one meeting.

**Do I have to tell people?** This is not legal advice, and "it deletes
itself" is not a defense. Wiretap law is about intercepting, not keeping the
file, and two-party-consent states (CA, FL, IL, PA, WA and others) read as
everyone consents. Most employers also have a policy. One sentence up front
covers it: *"I run a local assistant that reads my own notes against the
conversation. Nothing is recorded or stored."*

**Is my meeting text used for training?** Your account setting, not ours to
promise. Consumer plans (Free/Pro/Max) train on chats and coding sessions
unless you opt out; Team, Enterprise and API do not, by default. Check
Settings → Privacy before your first real meeting. Note what leaves the Mac:
audio and pixels stay on-device, but transcript excerpts, slide text and
facts from your notes go to Anthropic on every call.

**Will it show on a screen share?** Yes, if you share the whole desktop.
Share the meeting-app window instead and it won't.

**What are `gws` and `qmd`? Do I need them?** Neither is required.
[`qmd`](https://github.com/tobi/qmd) is a local search index — without it,
cards can only cite the briefing built before the meeting, not your whole
notes folder searched live. Worth installing. `gws` is a personal Google
Workspace CLI, **not a public tool** — its only job is reading your calendar
for `prep list`. Skip it and describe the meeting yourself:
`./copilot prep --text "1:1 with Dana — renewal pricing"`. A bare title is a
complete input. `./copilot onboard integrations` shows what's connected.

What you cannot skip is notes. No notes, nothing to cite, silent all meeting.

**Which meeting apps?** The Zoom app, or any browser window titled as a
Google Meet, Zoom, Webex or Teams call. Unsupported apps cost you the SLIDES
strip, not the copilot — `--no-screen` and everything else still runs.

**English only?** Yes. The transcriber is pinned to `en_US` in
`capture/meetingtap.swift`. A one-line change, untested elsewhere.

**Isn't a 6–15s card too late?** For fast round-robin standups, yes — don't
run it there. Meeting topics run minutes, not seconds, so 12 seconds into a
pricing argument the room is still on pricing. A 2-second card that
pattern-matches "sounds risky" is noise you'd learn to ignore.

**What shape do my notes need to be in?** Plain markdown in a folder;
`./copilot onboard knowledge` distills what you already have without
modifying it, and auto-detects Obsidian vaults. Notion needs no API token —
export to Markdown and point the wizard at the export. Two rules from
[portable/KNOWLEDGE.md](portable/KNOWLEDGE.md) carry most of the value: facts
you want cited live go in a truth-tier file (recall injects max 5, max 2 from
context tier), and a person's `profile.md` matches only on exact keywords —
facts you want caught by meaning go in their `evidence.md`.

**Can I stop it writing digests into my notes?** `--no-staging` keeps the
digest on screen and writes nothing back. `--knowledge <path>` (or
`KNOWLEDGE_DIR` in `~/.meeting-copilot/config`) moves the whole root. Nothing
is ever overwritten.

**What if my notes are thin?** Few cards, possibly zero. That's the design —
no fact, no card. Stale is caught explicitly: `prep` and `live` warn once the
knowledge dir passes 7 days. `./portable/knowledge.sh sync` tops it up.

**What's the push-to-talk key?** There's no key — `hold to talk` is a button
on the panel. Your mic is the messy channel: on speakers it hears you *and* a
garbled echo of everyone else, so you mark your own turns. Three modes, and
picking wrong degrades rather than crashes:

| Mode | When | The mic means |
|---|---|---|
| push-to-talk (default) | call on speakers | you, only while you hold the button |
| `--headphones` | call on headphones | always you |
| `--room` | in person, no call | everyone, never attributed to you |

On headphones without `--headphones`, everything you say is silently dropped.
On speakers with it, the echo gets labelled as you.

**What are the defaults?** `--cap 20` cards per 30 min, `--min-gap 0`
(the model self-limits), 900ms beat debounce, 15s max mid-monologue. Quiet
comes from the grounding rule and your 👎 votes, which tighten the bar for the
rest of the meeting and seed the next one. Votes only tighten, never loosen.

**How do I uninstall it?** `rm -rf ~/.meeting-copilot` and the repo folder
(the built app bundles live inside it), then remove `meetingtap` and
`screentap` from System Settings → Privacy & Security. If `setup.sh` made a
cert: `security delete-certificate -c "meeting-copilot-dev"
~/Library/Keychains/login.keychain-db`. No daemons, no `/Applications` entry,
no npm packages.

**Is this maintained? Are PRs welcome?** Built for one person's daily
meetings, shared because it works. Issues and PRs welcome, no SLA. Two hard
rules if you send one: zero dependencies, ever; and any change under `brain/`
or to a contract needs `./test/replay-gate.sh` to pass.

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
