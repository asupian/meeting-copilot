# meeting-copilot

Sits in a live meeting, listens to the audio, watches the meeting window, and
hands you ONE grounded question at a time — each resting on a specific fact
from your own notes. It never speaks for you: cards name the question, never
the answer (the rule: inform, don't prescribe). A meeting can end with zero
cards; that's the tool working, not failing.

Everything heavy runs on-device (transcription, OCR). The reasoning runs
through your existing Claude Code login — no API key.

## Principles

1. **The freshest version of what you know, in the room.** The prep pack and
   live recall pull your most current held facts into the meeting — the point
   is to close the gap between what you know and what you can summon under
   pressure. The room still outranks the record: retrieved facts arrive
   dated, phrased as "I have X on file — is that current?", never as
   corrections.
2. **It watches for collisions, drift — and wins.** Factual contradictions
   with your records; risks the room is glossing past (a concerning trend on
   the chart in view, a warning already written in your notes); drift against
   the goals you brought in; and good news worth naming out loud. Each fires
   only when it rests on a specific held fact — grounded or silent.
3. **Intelligence, not a recording.** It records nothing: audio and pixels
   are processed on-device, in real time, into text signals and one question
   at a time, and the working transcript is deleted when the meeting ends
   (recording, if you want it, is another tool's job). What persists is
   derived intelligence only — the digest's commitments in your knowledge dir
   and your card votes. `--keep-session` retains the transcript for replay
   tooling; the exceptions to "nothing leaves" are under Privacy posture.

Mechanisms + design principles: [HOW-IT-WORKS.md](HOW-IT-WORKS.md). The
knowledge layer (what the copilot knows): [portable/README.md](portable/README.md).
Design rationale and history live in the original home repo (not distributed).

## Architecture

```mermaid
flowchart LR
  subgraph capture [capture — on-device]
    MIC[mic + system audio<br/>meetingtap.app] --> TX[transcript.jsonl]
    SCR[meeting-window OCR<br/>screentap.app] --> SJ[screen.jsonl + frame.png]
  end
  subgraph brain [brain — live.mjs on :8787]
    TX --> CHK[model check<br/>claude -p, streamed]
    SJ --> CHK
    PACK[prep pack] --> CHK
    RECALL[qmd recall<br/>keyword + vector] --> CHK
    SJ --> VIS[chart vision<br/>1 pass / slide]
    VIS --> CHK
    TX --> AMB[ambient extractor<br/>commitments + questions]
    SJ --> AMB
  end
  CHK --> PANEL[panel<br/>CardPanel]
  AMB --> DIGEST[digest + knowledge-dir<br/>write-back]
```

- **capture/** — Swift, all on-device. `meetingtap` taps the mic (AVAudioEngine)
  and system audio (Core Audio process tap) and transcribes with macOS 26's
  SpeechAnalyzer; channel `me` = mic, `them` = everyone else. `screentap` finds
  the meeting window (Meet/Zoom/Webex browser tab, the Zoom app, or a Drive
  recording playback), OCRs it with Apple Vision every ~4s, and emits slide
  text + participant-tile names + the latest frame.
- **brain/** — Node, zero dependencies. `live.mjs` debounces conversational
  beats, runs one streamed `claude -p` call at a time (existing login, no API
  key), and serves the panel over HTTP + SSE. `recall.mjs` cross-references the
  room against ALL of your knowledge dir's records (BM25 + vector via the
  local `qmd` engine, off the critical path). `ambient.mjs` quietly extracts
  commitments and unanswered questions for the end-of-meeting digest.
- **panel/** — NSPanel + WKWebView; floats over fullscreen meetings without
  stealing focus (never activate the app — that yanks the user out of the
  meeting's Space). All UI lives in `panel/index.html`, served fresh by live.mjs.

## The three journeys

The `copilot` command is the front door, organized by what you're doing rather
than by which binary does it. Each journey lives in its own directory as a
thin script plus a README; every underlying engine still works on its own.

| Journey | Command | Module |
|---|---|---|
| **Onboard** — build the tool, then build what it knows | `copilot onboard [knowledge \| import <dir>]` | [onboarding/](onboarding/) → `setup.sh`, then the `portable/` knowledge wizard |
| **Prep** — pick a meeting, build + view prep packs | `copilot prep [list \| <n> \| --pick \| show [name]]` | [prep/](prep/) → `portable/knowledge.sh`, `cli/events.mjs`; packs in `~/.meeting-copilot/prep/` |
| **Live** — run the copilot in the meeting | `copilot live [name] [flags]` | [live/](live/) → `start.sh` (capture + brain + panel), pack picked by name or start time |

`copilot prep list` numbers your upcoming meetings (via the `gws` CLI when
installed); `copilot prep 2` builds a pack for meeting 2 and stores it per
meeting. `copilot live` with no arguments picks the pack whose start time
brackets now. `copilot config set PREP_LOOKAHEAD_H 24` widens the calendar
window (default 12h).

## Quick start

One guided command, under 5 minutes of your attention:

```bash
./copilot onboard
```

While the capture binaries compile in the background, a short claude session
connects your knowledge: it confirms who you are (derived from git config,
one keystroke), asks where your notes live — an Obsidian vault (it looks for
one first), Notion, or any folder of markdown — and ingests them as the
copilot's knowledge dir. No notes anywhere? It falls back to connecting your
channels (calendar, email, Slack, docs) and auto-building from the last 30
days. Then the build finishes: signing cert (so permission grants survive
rebuilds), app bundles, and a live self-test — click Allow on the two
dialogs.

Two closing moves, both automatic: it offers a **trial on one of your own
recordings** (point it at a Zoom/Meet export; transcribed on-device, packed
from your new knowledge dir, replayed through the brain — cards cite YOUR
facts, and zero cards is a normal outcome), and then it **preps every
upcoming meeting on your behalf** — a pack per calendar event, so at meeting
time the only command left is `copilot live`.

Every card the copilot ever shows must cite a fact from that dir; re-running
`copilot onboard knowledge` tops it up, `copilot onboard replay <file>`
re-runs the trial. (`./setup.sh` is the build alone.)

That's meeting-ready. Each meeting:

```bash
./copilot prep list   # upcoming meetings, numbered
./copilot prep 1      # build the pack for meeting 1  (legacy: knowledge.sh pack --next)
./copilot live        # capture + brain + panel; Ctrl-C = digest  (legacy: ./start.sh)
```

Keep the knowledge dir fresh — the biggest lever on card quality:

```bash
./portable/knowledge.sh sync     # weekly: pull the last N days from integrations
./copilot onboard import <dir>   # distill another notes folder (Obsidian, Notion export...)
./portable/knowledge.sh merge    # fold past meetings' signals into truth records
```

A hand-written prep pack works with zero knowledge dir — the format is the
contract, the prompts are conveniences ([portable/README.md](portable/README.md)).

First screentap launch prompts once for Screen Recording. `start.sh` also
refreshes the qmd recall index and backgrounds the embedding pass.

## What it surfaces

Live, on the panel:

| Section | What it is |
|---|---|
| **NOW** | current topic + whether it advances/risks a stated goal (▲/▼ + grounded note) |
| **SUGGESTIONS** | the cards: question + why + src (clickable — the original Sheet/email/Slack when resolvable via `origins.mjs`, the knowledge file as fallback) + ⚠ risk / ✦ win stakes + follow-up questions. Two chips: the detection class (red `collision` / amber `gap` / green `reinforce`) and how the anchor was found (`pack` / `kw` / `vec` / `kw+vec`). |
| **TOPICS** | held facts the conversation AND slides are touching (code matcher, ~1ms) |
| **SPEAKER** | active speaker — largest standalone tile label, falling back to transcript-confirmed speakers |
| **SLIDES** | the model's 1–2 sentence read of the current slide ("summarizing…" while in flight; includes chart shapes from the vision pass) |
| **CHECKING** | which records recall is pulling right now |
| **AUDIO** | live transcript (partials stream in ~0.2s) |
| **guard** | amber warning when conversation or slides approach an `[INTERNAL]`/`[SENSITIVE]` fact with externals present |

End of meeting (Ctrl-C): digest of commitments — spoken AND slide-stated
("Resolve open threads (DRI: Parker)[ETA: 4/27]" counts) — plus questions that
never got answered, written back into the knowledge dir as raw signals
(staging inboxes when the layout has them, else a dated `meetings/` file).

Cards carry 👍/👎/dismiss buttons. Votes are consumed live, in one direction
only: recent negatives widen the gap between cards and raise the bar for
similar candidates; upvotes only offset negatives — feedback never makes the
copilot chattier. Negative votes also carry across meetings: the last 30 days
of downvoted questions seed the next meeting's bar from the first check
(see HOW-IT-WORKS "The feedback loop").

## What it detects

Three card classes, each shown as a colored chip on the card:

| Chip | Class | Fires when |
|---|---|---|
| red | **collision** | the room disagrees with the record: a stated number/status/date/owner against a held fact, a held `[trend]` read the wrong way ("activation's fine" vs three straight declines), a settled decision being reopened, a proposed date against a held deadline |
| amber | **gap** | something needed is missing and its window closes with the meeting: a decision forming without the held data, a prep goal untouched late, a question raised earlier and dropped, an unraised blocker, a commitment forming toward someone with open overdue items on file, a `[recurring]` topic treated as fresh |
| green | **reinforce** | nothing is wrong: a held fact worth putting on the table, a glossed win worth naming ("104% against a 95% target — worth calling out the team?") |

One card per check. When several compete in one beat, the ladder decides:
collision > gap > reinforce — ranked by decay (a collision is the catch of
record; a gap dies with the meeting; a reinforcement can land a beat later).
The ladder ranks simultaneous cards, it is not a bar: a lone reinforce fires.

Card grounding stays the one unbending rule: every card cites a specific fact —
the prep pack or a `[truth]`-tier record (goals, financials, evidence,
initiative logs). Alongside the cards run the continuous monitors: goal bearing
(▲/▼ on the NOW strip), the disclosure guard, TOPICS fact-matching, and the
ambient commitment/question listener that becomes the digest.

## Mic modes

The "me" channel is the mic. On speakers the mic hears the whole call as echo
(the system tap already has that audio cleanly), so the default is push-to-talk:

| Mode | Flag | Behavior |
|---|---|---|
| push-to-talk | (default) | mic dropped as echo EXCEPT while holding the panel's "hold to talk" pill — those windows are you |
| headphones | `--headphones` | every mic line is you (no echo possible) |
| in-person | `--room` | mic kept as unattributed room audio |

## Privacy posture

- Audio and pixels are processed **on-device** (SpeechAnalyzer, Vision OCR).
- What leaves the Mac — all through the authenticated claude session:
  transcript TEXT, slide OCR TEXT, and the one pixel exception: the slide
  frame image for the chart-vision pass (one image per settled slide;
  `--no-vision` disables it).
- `[SENSITIVE]`/`[CONFIDENTIAL]` knowledge lines never surface in cards;
  recall drops them when externals are present; the guard warns on approach.
- No transcription is retained: the working transcript, screen feed and
  latest frame live in `~/.meeting-copilot/sessions/` during the meeting and
  are deleted at Ctrl-C (pass `--keep-session` to keep them — needed for
  `review-server` replays and fixture-making). The digest and feedback files
  remain. Only digest-derived raw signals land in the knowledge dir.

## Flags (start.sh passes unknowns through to live.mjs)

```
--prep <file>       specific prep pack (default ~/.meeting-copilot/prep-pack.md)
--headphones/--room mic mode (see above)
--no-screen         disable the screen OCR feed entirely
--no-vision         screen text yes, but never send the frame image
--no-recall         prep pack only; no whole-knowledge-dir retrieval
--no-staging        digest only; don't write the knowledge dir
--externals         force-arm the disclosure guard
--cap N             max cards per 30 min (default 20; model self-limits)
--keep-session      keep the transcript/screen feed after the meeting
                    (default: deleted at Ctrl-C — no transcription retained)
--debounce MS       beat detection (default 900)
--think N           cap/disable extended thinking (faster to first token,
                    but the quality bar is unvalidated without thinking)
```

## Testing without a meeting

```bash
./test/replay-gate.sh                  # the regression gate: replay + assertions
./selftest.sh                          # plays a phrase, verifies the system-audio tap
./capture/screentap --file img.png     # OCR one image, no permissions needed
node brain/brain-loop.mjs --replay test/fixtures/rivertech/fixture.jsonl \
  --prep test/fixtures/rivertech/prep-pack.md   # replay a fixture through the real brain
node brain/review-server.mjs           # watch a replay with cards popping at their timestamps
```

`meetingtap --file call.mp4 --out t.jsonl --anchor <iso>` turns any recording
into a fixture (~8x realtime, no permissions). Replaying a recording of a
real meeting exercises the whole stack — screentap treats the playback
window as the meeting window. `brain/eval-rubric.md` + `eval-workflow.js`
grade a replay's cards across precision / recall / prescription lenses.

Known ASR weakness: large currency figures transcribe wrong (`110000` for
"$11 million"). The contract forbids contradictions built on a 10x/100x spoken
currency gap; percentages, dates and statuses are reliable. OCR'd digits are
trusted except O/0 and l/1 swaps. `./run.sh --deepgram` is the opt-in cloud
path that buys diarization + correct currency ($0.41/audio-hour).

## Files

```
copilot             the front door: routes to the three journey modules + config
onboarding/ prep/ live/   one thin script + README per journey (the engines stay below)
cli/                events.mjs (calendar picker helpers) + common.sh (shared plumbing)
setup.sh            one-time: OS gate, deps, build, cert, bundles, permissions
start.sh            one command: capture + brain + panel; Ctrl-C stops + digests
run.sh              capture only (meetingtap + screentap + roster generation)
portable/           the knowledge layer: format spec, intake wizard, pack builder
brain/live.mjs      the server: checks, recall, vision, ambient, SSE, /open
brain/contract*.md  the operating rules the model is held to
brain/matcher.mjs   code-side fact matching (topics, guard, fast path)
brain/recall.mjs    whole-knowledge-dir retrieval (kw + vec) and the precision gate
brain/origins.mjs   provenance descriptors -> real Sheet/Gmail/Slack links
brain/ambient.mjs   commitments/questions -> digest + knowledge-dir write-back
capture/*.swift     meetingtap (audio) + screentap (screen) + TCC app bundles
panel/index.html    the whole UI; CardPanel.swift is just the floating window
experimental/       contracts that work but whose quality bar isn't validated
test/               replay-gate.sh + the rivertech fixture
```
