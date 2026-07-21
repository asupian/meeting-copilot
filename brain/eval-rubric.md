# Brain-loop eval rubric

Grades a run of the live-meeting brain loop: the ordered set of cards it emitted
for one meeting, against that meeting's transcript and prep pack. The grader gets
the prep pack, the full transcript, and the emitted cards (JSONL). It must open
those artifacts and quote from them — a criterion satisfied by a vibes-check is a
failed criterion.

Two failure directions matter equally: firing junk (precision) and missing the
one card that mattered (recall). Grade both.

## Per-card criteria (each emitted card must pass ALL)

For every card, the grader quotes the evidence or fails it.

- **C1 Source resolves.** Find the card's `source` in the prep pack. PASS if a
  line in the pack states that fact (quote it). FAIL if the source is not in the
  pack or the pack says something different (quote the mismatch). No card may rest
  on a fact the pack does not contain.
- **C2 Triggered by the transcript.** Quote the transcript line(s) the card
  responds to, with their timestamp. PASS if the card plausibly fires within ~90s
  of that moment. FAIL if nothing in the transcript up to the card's `atSec`
  relates, or the moment had already passed by minutes (stale).
- **C3 Sanctioned trigger.** Name which of the four it is: contradiction /
  unraised-open-thread / decision-without-data / unhit-prep-goal-late. FAIL if it
  is generic advice ("could ask about the timeline") that fits any meeting.
- **C4 Informs, does not prescribe.** PASS if the card names a question or
  surfaces a fact. FAIL if it scripts the user's position ("the right call is",
  "accept X / retire Y"), pre-frames ("this is the hinge"), or drafts a
  substantive stance without quoting their prior words. Quote the offending phrase
  on FAIL.
- **C5 Not a repeat.** FAIL if a materially equivalent card appears earlier in the
  set, or if the transcript shows the point was already raised before the card
  fired.

- **C6 No falsifiable live-state premise.** If the card asserts anything about the
  room — someone is absent / OOO / not owning a thread / "nobody has raised this"
  — check the transcript up to that card. FAIL if the transcript shows that person
  speaking, being handed the floor, or being thanked, or shows the thread already
  raised. Quote the line. The prep pack is a pre-meeting snapshot; the transcript
  overrides it on live state. (Numbers, dates, statuses and commitments from the
  pack are NOT live state and do not fall under this rule.)

A card that fails any of C1-C6 is a false positive.

## Set-level criteria

- **S1 Silence discipline.** Count cards per rolling 30-min window. PASS if <=3 in
  every window. FAIL with the window and count if exceeded.
- **S2 Recall — the big miss.** Independently scan the transcript for moments where
  a grounded card SHOULD have fired: a spoken claim that contradicts a specific
  prep-pack number/status, or a topic that squarely maps to a pre-flagged open
  thread in the pack that went unraised. List each such moment (quote transcript +
  the pack fact). For each, PASS if the loop emitted a card within ~90s, FAIL
  (miss) otherwise. This is the most important criterion: a quiet loop that misses
  the one contradiction is worse than one extra silent tick.
- **S3 Confidentiality.** FAIL if any card surfaces a fact the prep pack marked
  [CONFIDENTIAL] / [SENSITIVE].

## Output format (mandate)

```
SCORE: <emitted> cards, <fp> false positives (C1-C5), <miss> misses (S2)
Cards:
  #<n> [<atSec>s] "<question>" — PASS  (C1 quote: "...", C3: <trigger>)
  #<n> [<atSec>s] "<question>" — FAIL C4  (offending phrase: "...")
Misses (S2):
  [<ts>] transcript: "<quote>" + pack: "<fact>" — no card fired
Verdict: <one line — is this loop shippable for real meetings, and the single
         highest-value fix to the contract or prep pack>
```

## No-fire list (grader must not raise these)

- Style nits on the `question` wording if it still informs-not-prescribes.
- Cards that stayed silent correctly — silence is the default, not a miss, UNLESS
  S2 identifies a specific grounded moment that was skipped.
- The prep pack's own quality (that is a separate eval). Grade the cards given the
  pack as-is; only note pack gaps if they caused a miss.
- Speculative "it could have also asked X" where X is not grounded in a specific
  pack fact. Self-check every S2 miss against C1: if you could not write the
  `source`, it is not a miss.
