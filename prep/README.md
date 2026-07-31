# prep/ — pick a meeting, build its prep pack

The prep pack is the copilot's working memory for one meeting: the vetted
facts, open threads, and goals it may cite live (principle 1 — the freshest
version of what you know, in the room).

```bash
copilot prep list         # upcoming meetings, numbered (12h window; PREP_LOOKAHEAD_H to widen)
copilot prep 2            # build the pack for meeting 2
copilot prep --all        # packs for EVERY upcoming meeting (skips existing; onboarding runs this)
copilot prep show [name]  # view the newest pack, or one matched by name
copilot prep --text "..." # NO CALENDAR NEEDED — just describe the meeting
copilot prep --pick       # no gws CLI? interactive fallback (claude session picks the meeting)
```

## No calendar connected

`--text` is the plain door, and for a new user it is the *primary* path, not a
fallback — no calendar is the default state on day one.

```bash
copilot prep --text "1:1 with Dana — renewal, she wants a discount"
copilot prep --text "Q3 planning"          # a bare title is enough
pbpaste | copilot prep --text              # or pipe an invite in
copilot prep --text                        # or just type it, Ctrl-D to finish
```

Any wording works — there is no format. The text reaches the pack builder as a
free-text description; it extracts what is actually there (people, topic, time)
and writes "none found" for the rest rather than guessing. The pack comes out
thinner than a calendar-resolved one (no attendee emails means no reliable
per-person history), so expect fewer cards. That is the system working, not
failing.

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
