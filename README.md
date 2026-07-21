# meeting-copilot

Sits in a live meeting, listens to the audio, watches the meeting window, and
hands you ONE grounded question at a time — each resting on a specific fact
from your own notes. It never speaks for you: cards name the question, never
the answer (the rule: inform, don't prescribe). A meeting can end with zero
cards; that's the tool working, not failing.

Everything heavy runs on-device (transcription, OCR). The reasoning runs
through your existing Claude Code login — no API key.

Mechanisms + design principles: [HOW-IT-WORKS.md](HOW-IT-WORKS.md). The
knowledge layer (what the copilot knows): [portable/README.md](portable/README.md).
Design rationale and history live in the original home repo (not distributed).

## See it work in two minutes (no permissions, no mic)

Replaying a committed fixture through the real brain needs only `node` and a
logged-in `claude`:

```bash
node brain/brain-loop.mjs \
  --replay test/fixtures/rivertech/fixture.jsonl \
  --prep   test/fixtures/rivertech/prep-pack.md \
  --title  "Vendor Sync"
```

The fixture is a vendor renewal call where the vendor says the engagement is
"thirty five thousand flat" — but the prep pack holds the agreed SOW at
$42,500. About 30-60s in (one real model call per ~45s of meeting time) you
should see the copilot's one card: a question about which number is current,
citing the SOW fact. A second, softer card gets suppressed by the card
budget. That is the whole product in miniature: grounded collision in,
one question out, silence otherwise.

`./test/replay-gate.sh` runs the same replay with pass/fail assertions — it
is the regression gate for any change to `brain/`.

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

## Quick start

One-time:

```bash
./setup.sh
```

That's the whole build: it gates on macOS 26 (the on-device transcriber's
floor), checks dependencies (swiftc, node, claude, optionally qmd), compiles
the capture binaries, offers to create the self-signed signing cert (so
permission grants survive rebuilds), bundles + signs the apps, and runs a
live permissions self-test — click Allow on the two dialogs.

Then build the knowledge dir — the facts the copilot grounds its cards in:

```bash
./portable/knowledge.sh setup    # guided intake wizard (~10-15 min), or:
./portable/knowledge.sh init     # bare config now, import/sync later
```

Each meeting:

```bash
./portable/knowledge.sh pack --next   # prep pack for the next calendar meeting
./start.sh                            # capture + brain + panel; Ctrl-C = digest
```

First screentap launch prompts once for Screen Recording. `start.sh` also
refreshes the qmd recall index and backgrounds the embedding pass.

## What it surfaces

Live, on the panel:

| Section | What it is |
|---|---|
| **NOW** | current topic + whether it advances/risks a stated goal (▲/▼ + grounded note) |
| **SUGGESTIONS** | the cards: question + why + src (clickable — the original Sheet/email/Slack when resolvable via `origins.mjs`, the knowledge file as fallback) + ⚠ risk / ✦ win stakes + follow-up questions. A badge shows how the anchor was found (`pack` / `kw` / `vec` / `kw+vec`). |
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

Card grounding is the one unbending rule: every card cites a specific fact —
the prep pack or a `[truth]`-tier record (goals, financials, evidence,
initiative logs). Triggers: contradiction, unraised open thread, decision
forming without data, unhit prep goal late, relevant fact in view — including
WINS the room is glossing past ("largest quarter on record — worth naming?").

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
- Transcripts and frames live in `~/.meeting-copilot/sessions/` (never the
  repo). Only digest-derived raw signals land in the knowledge dir.

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
--debounce MS       beat detection (default 900)
--think N           cap/disable extended thinking (faster to first token,
                    but the quality bar is unvalidated without thinking)
```

## Testing without a meeting

```bash
./test/replay-gate.sh                  # the regression gate: replay + assertions
./selftest.sh                          # plays a phrase, verifies the system-audio tap
./capture/screentap --file img.png     # OCR one image, no permissions needed
node brain/brain-loop.mjs --replay ... # replay any transcript fixture (see top)
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
