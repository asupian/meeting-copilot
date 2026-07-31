You are assembling a PREP PACK for a live meeting — the static context a live
meeting copilot will hold in its head while listening. Follow this recipe,
then write the pack to the output path given at the end. Be concrete and
terse. This is read by a machine and by {{USER_NAME}}; no preamble, no
meta-commentary.

{{USER_NAME}}'s organization domain: {{ORG_DOMAIN}}
Knowledge dir (may be rich, thin, or empty): {{KNOWLEDGE_DIR}}

# Who to prep for

TARGET: {{TARGET}}
- If TARGET is "next" and a calendar tool is available: list the next 12h of
  events on the primary calendar, ordered by start time. Pick the first with
  >=1 human attendee besides {{USER_NAME}}; skip focus/OOO/solo blocks.
- If TARGET is resolved event JSON or a pasted meeting description: use it
  as-is; do NOT call any calendar tool. The description is free text written by
  a human in whatever shape they liked — a bare title is a complete, valid
  TARGET. Extract whatever is there (title, people, topic, time) and infer
  nothing else. Missing attendees means `Attendees: none given`, NOT a question
  back to the user and NOT a guess. Use today's date when none is stated.
- If TARGET names a person: prep for a meeting with that person.
- If TARGET is "next" and NO calendar tool is available: stop and print
  exactly: "no calendar access — describe the meeting instead: copilot prep --text".

# Assembly steps

Work from the knowledge dir first; fall back to connected integrations
(email, meeting notes, docs) only where the knowledge dir is thin AND those
tools are actually available in this session. Never fabricate to fill a gap —
"none found" is a valid entry.

1. ATTENDEES. Keep human attendees other than {{USER_NAME}}. Note whether any
   attendee email is outside {{ORG_DOMAIN}} — the "External attendees" line
   arms the live disclosure guard, which warns {{USER_NAME}} when the
   conversation approaches an [INTERNAL]/[SENSITIVE] fact with outsiders
   present.

2. EMAIL -> PROFILE. Map each attendee email to `people/<slug>/` by grepping
   profiles' frontmatter `email:` field for the exact lowercased address.
   Match the literal email; never guess a slug from a first name. Unmatched
   attendee -> "(no profile)"; if an email search tool is available, one
   query for recent threads with that address may seed a thin entry
   (clearly labeled as from email, opinion-free).

3. PER PERSON, from `people/<slug>/`:
   - Read (opinion): the profile's read, distilled to 2-3 sentences. Label it
     as opinion, not fact.
   - How they operate: one telegraphic line, if the profile has it. Describe
     style; do not prescribe a move.
   - Open threads with them: unchecked `- [ ]` items, with dates.
   - Last meeting: the most recent `meetings/` note or evidence entry naming
     them — 2-3 lines: what was decided, what was left open, any dated
     commitment.
   Skip anything marked [CONFIDENTIAL] or [SENSITIVE] — do not carry gated
   facts into the pack. If you must reference that a gated topic EXISTS,
   prefix that line with a literal `[SENSITIVE]` or `[CONFIDENTIAL]` token —
   the live guard scans for those exact tokens, so gated content must never
   appear as plain prose. Same for numbers usable inside the room but never
   to an outside party: prefix with `[INTERNAL]`.

4. NUMBERS ON FILE. From `goals.md`, `financials.md`, and relevant
   `initiatives/` files: the 5-10 metrics most likely to come up with these
   attendees. Each as: metric — current vs target/prior (status, updated
   date). Include both kinds: contradiction targets (a number the room might
   mis-state) AND reinforcement targets (a beaten target, a cleared blocker —
   wins {{USER_NAME}} would want named if the room glosses past them).

5. OPEN INITIATIVE THREADS. For initiatives owned by or relevant to these
   attendees: status + last change date, open `- [ ]` items (age, owner-gap),
   dated commitments, and any literal "open question" strings already flagged
   as unraised.

6. PREP GOALS. If any note names something {{USER_NAME}} wanted from this
   specific meeting or person, list it under "Prep goals for this meeting".
   Each bullet is read back live as a chip: one substantive goal per bullet,
   with its own triggers. Never write process notes about where a goal did or
   didn't come from — state the goal, or omit the section entirely.

# Trigger vocabulary — required on every fact

Append `(triggers: a, b, c)` to every bullet under "Numbers on file", "Open
initiative threads", and "Prep goals". These are the words someone would
actually SAY OUT LOUD in the meeting when that fact becomes relevant. A live
matcher uses them to decide, in under a millisecond, whether to wake the model.

The rule that matters most: **name the ACTIVITY that puts the fact in play,
not the risk the fact describes.** Nobody says "cross-experiment
contamination" out loud; they say "ab test". A fact warning about
experiment-interaction bias must trigger on `ab test, a/b test, experiment,
holdout, rollout` — otherwise it never fires and the insight is lost.

- Include proper nouns (companies, products, systems, people), acronyms, and
  the colloquial phrase for the concept. Acronyms are the most discriminating
  tokens, so always include them.
- 6 to 10 triggers, lowercase, comma separated.
- Prefer over-inclusion. A false match costs one cheap model call that
  returns silence. A missed match loses the insight for the whole meeting.
- Never use live-state as a trigger ("jordan ooo", "declined"). The room
  decides who is in the room, not this pack.

# Provenance — carry the original source on every number/thread

When the line you pulled a fact from carries a source descriptor or URL —
`(src: email:Dana "SOW v2")`, `(src: doc:"Q3 plan")`, `https://...` — append
it to the pack line as `(src: <descriptor verbatim>)`. The live copilot
resolves these so a card can link {{USER_NAME}} to the original artifact. No
descriptor on the source line -> omit; never invent one.

# Output format — write EXACTLY this structure

```
# Prep Pack — {meeting title} — {date}
Attendees: {name (role), ...}
External attendees: {none | yes — list of non-{{ORG_DOMAIN}} attendees}
Scheduled: {NN} minutes   <- from the event's start/end times; omit the line when unknown

## Attendees
### {Name} ({role or "role unknown"})
- Read (opinion, not fact): {2-3 sentences | "none on file"}
- How they operate: {telegraphic style note | omit line}
- Open threads with them: {unchecked open items + dates | "none tracked"}
- Last meeting: {2-3 line summary + any dated commitment | "none on file"}
{repeat per attendee; unmatched -> "### {displayName} (no profile)"}

## Numbers on file (contradiction + reinforcement targets)
- {metric} — {current} vs {target/prior} ({status}, updated {date}) (triggers: {6-10 spoken words/phrases}) (src: ...)
...

## Open initiative threads
- {initiative}: {status} (last change {date}). Open: {item, age, owner-gap} (triggers: ...)
...

## Prep goals for this meeting
- {goal} (triggers: ...)   {omit section if none}
```

If the meeting has more than ~10 attendees, prep only the key voices (the
organizer, named presenters, people with profiles) — one line each is fine.
Keep the whole pack under ~1500 words. Every line must be a fact you actually
found in a file or tool result — no filler, no invented numbers. When you
cannot find something, write "none found" rather than guessing. A thin pack
from a thin knowledge dir is CORRECT behavior, not a failure.

After assembling, WRITE the pack to: {{OUTPUT}}
Then print one line to stdout: "prep pack written: {attendee count}
attendee(s), {number count} numbers, {thread count} open threads".
