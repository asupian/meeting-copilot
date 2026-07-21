# experimental/

Contracts that work mechanically but whose QUALITY BAR is not yet validated —
they have not passed a graded replay against `brain/eval-rubric.md` on more
than the one committed fixture. The shipped pair is `brain/contract.md` (cards)
and `brain/contract-ambient.md` (digest); everything here is opt-in.

- `contract-fast.md` — trades extended thinking (~13s to first word) for an
  explicit `scan` field (~2s). Speed verified; the silence bar either
  over-fires or goes mute depending on wording. Opt in:
  `node brain/live.mjs --contract experimental/contract-fast.md --think 0`
- `contract-narrow.md` — the judge prompt for the matcher-driven fast path
  (`brain-loop.mjs --fast`), which sends the model only the facts a local
  matcher flagged. Same status: fast, bar untuned.

Promotion path: grade replays of several real meetings with
`brain/eval-rubric.md` + `brain/eval-workflow.js`; move the file back into
`brain/` only when it matches contract.md's precision.
