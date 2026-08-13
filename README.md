# meeting-copilot

I kept leaving meetings realising the answer had been sitting in my notes the
whole time. This fixes that.

It listens, reads the shared screen, and when the room says something your notes
contradict, it hands you one question. Not advice. A question you can ask out
loud. Most meetings it says nothing, which is fine: it only speaks when it can
point at something you already wrote down.

Audio and video never leave your Mac, nothing is recorded, and the thinking runs
on your existing Claude Code login.

![The panel, mid-meeting](docs/panel.png)

## What you need

A Mac on macOS 26 or later, because Apple's on-device transcriber ships with
26. Claude Code, logged in, any paid plan. And a folder of notes, the real
requirement: no notes, nothing to cite, silence.

## Install

```bash
git clone https://github.com/asupian/meeting-copilot.git
cd meeting-copilot
./copilot onboard
```

Ten minutes, mostly waiting. It compiles while a short Claude session asks
where your notes live (Obsidian, Notion, any folder) and makes them searchable.
macOS asks permission twice; click Allow both times. Then it briefs itself on
your calendar.

Using an AI agent? Point it at [AGENTS.md](AGENTS.md).

## Using it

```bash
./copilot live
```

A small panel floats over the call. A card gives you the question, the fact
behind it, and a link to its source file. Thumbs-down makes it pickier, now and
later.

Ctrl-C ends it. You get a digest of commitments and unanswered questions,
written into your notes. The transcript is deleted.

```bash
./copilot prep list      # upcoming meetings, numbered
./copilot prep 2         # rebuild briefing 2
```

No calendar? `./copilot prep --text "1:1 with Dana, pricing"`.

## The three cards

- **red, collision.** The room contradicts your records: wrong number, wrong
  date, wrong owner, a settled decision reopened.
- **amber, gap.** Something's missing before the room moves on: your goal
  untouched, your question dropped, a blocker unraised.
- **green, reinforce.** A fact worth tabling, or a win nobody named.

One at a time, red beats amber beats green. No fact, no card.

## Privacy

Audio and pixels stay on your Mac. Text doesn't: transcript lines, slide text
and facts from your notes go to Anthropic on every call, same as any Claude
Code session. Don't point this at a folder you can't send to a model. Tag a
fact `[SENSITIVE]` and it hides while outsiders are present. Transcript and
logs are deleted at the end; the digest and votes survive.

## FAQ

**What does it cost, and which plan?** It rides your Claude Code subscription.
One model call per beat of conversation, one at a time, 10 to 25 seconds each.
Busy hour, call it 100 to 250 calls, though that's my estimate from the timing,
not a measurement; `perf.json` has your real number. Pro covers a couple of
meetings a day. If Claude Code is your main tool already, get Max.

**Will I run out mid-meeting?** Maybe, on a heavy day. It fails loudly: the
panel says "brain unreachable" and capture keeps running, so you still get the
digest.

**Do I have to tell people?** I'm not a lawyer, but "it deletes itself
afterwards" is no defence: wiretap law is about the listening, not the file. In
California, Illinois, Washington and others, assume everyone has to agree, and
your employer likely has a policy. One sentence up front covers it: *"I run a
local assistant that checks my notes against what we're saying. Nothing is
recorded."*

**Does my meeting text train the model?** Your setting, not my promise to make.
Pro and Max train on your sessions unless you opt out under Settings, Privacy.
Team, Enterprise and API don't.

**Will it show when I share my screen?** Only if you share the whole desktop.

**Do I need `qmd` and `gws`?** No, though [qmd](https://github.com/tobi/qmd)
is worth it: without that index a card can only quote the briefing built
beforehand, instead of searching your notes live. `gws` is my own Google
Workspace CLI, not public, and all it does here is read your calendar. Skip it
and use `prep --text`.

**Which apps, which language?** Zoom's app, or a browser window titled as a
Meet, Zoom, Webex or Teams call. Anything else just costs you the slides strip.
English only for now, hardcoded in `capture/meetingtap.swift`.

**Cards take 6 to 15 seconds. Too slow?** For rapid-fire standups, yes.
Otherwise no: topics run for minutes, not seconds.

**How should my notes look?** Plain markdown in a folder.
`./copilot onboard knowledge` reads what you have and never touches the
original. Notion needs no API token, just export to markdown and point at it.
Layout: [portable/KNOWLEDGE.md](portable/KNOWLEDGE.md). Thin notes means few
cards, maybe none. Working as intended.

**Can I stop it writing into my notes?** `--no-staging`, or move the root with
`--knowledge <path>`. It never overwrites.

**Where's the push-to-talk key?** There isn't one. "hold to talk" is a button
on the panel. On speakers your mic picks up you *and* a mangled echo of
everyone else, so you mark your own turns by holding it. Use `--headphones` on
headphones, `--room` in person. Worst case is headphones without the flag:
everything you say is thrown away.

**Defaults?** 20 cards per 30 minutes (`--cap`), no forced gap (`--min-gap`),
900ms of quiet before it thinks. The quiet comes from the grounding rule and
your thumbs-down, not the cap.

**How do I remove it?** Delete `~/.meeting-copilot` and the repo folder, then
drop meetingtap and screentap from System Settings, Privacy & Security. If
setup made a cert: `security delete-certificate -c "meeting-copilot-dev"
~/Library/Keychains/login.keychain-db`. Nothing else was installed.

**Is anyone maintaining this?** I built it for my own meetings and put it up
because it works. Issues and PRs welcome, no promises on timing. Two rules for
a PR: no dependencies ever, and anything touching `brain/` passes the replay
gate.

## More

[HOW-IT-WORKS.md](HOW-IT-WORKS.md) is the mechanism end to end,
[portable/README.md](portable/README.md) the notes layer,
[.claude/CLAUDE.md](.claude/CLAUDE.md) the maintainer rules.

Other flags: `--no-screen`, `--no-vision`, `--no-recall`, `--keep-session`,
`--externals`, `--prep <file>`. Broken? `./copilot doctor` takes two seconds.
