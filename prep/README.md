# prep/ — pick a meeting, build its prep pack

The prep pack is the copilot's working memory for one meeting: the vetted
facts, open threads, and goals it may cite live (principle 1 — the freshest
version of what you know, in the room).

```bash
copilot prep list         # upcoming meetings, numbered (12h window; PREP_LOOKAHEAD_H to widen)
copilot prep 2            # build the pack for meeting 2
copilot prep --all        # packs for EVERY upcoming meeting (skips existing; onboarding runs this)
copilot prep show [name]  # view the newest pack, or one matched by name
copilot prep --pick       # no gws CLI? interactive fallback (claude session picks the meeting)
```

Packs are stored per meeting as `~/.meeting-copilot/prep/<date>[-HHMM]-<slug>.md`.
The start time in the filename is how `copilot live` later matches a pack with
no calendar access. Every build also refreshes the legacy single
`~/.meeting-copilot/prep-pack.md` (write-through), so the pre-copilot flow
(`knowledge.sh pack --next` + `./start.sh`) works unchanged.

This directory holds only the journey script ([prep.sh](prep.sh)); the engines:

| Piece | Engine |
|---|---|
| calendar fetch | [portable/knowledge.sh](../portable/knowledge.sh) `events` (the local `gws` CLI; headless-safe) |
| pick/slug/time-match | [cli/events.mjs](../cli/events.mjs) |
| pack building | [portable/knowledge.sh](../portable/knowledge.sh) `pack` + [portable/prompts/build-prep-pack.md](../portable/prompts/build-prep-pack.md) |
