#!/bin/bash
# replay-gate.sh — the regression gate for brain changes.
#
# Replays the Rivertech fixture (a stranger's meeting: vendor states $35K
# against a prep-pack SOW of $42,500) through the real brain and asserts the
# contradiction card fires. Model wording varies run to run; the gate checks
# substance, not phrasing:
#   1. at least one card was emitted
#   2. some card carries the $42,500 figure (the pack anchor)
#
# Run before landing any change to brain/ or the contracts. Costs one or two
# real `claude -p` calls (~30-60s). Baseline behavior (2026-07-21): exactly
# 1 card, fired at the 0:35 pricing line; a second (payment-schedule) card
# suppressed by min-gap.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)/cards.jsonl"

# Preflight: with a dead login the gate fails as "no cards emitted",
# which reads as a brain regression and sends you debugging the wrong layer
# (seen 2026-08-11: expired OAuth refresh while `auth status` said loggedIn).
# The gate runs on whichever provider COPILOT_PROVIDER selects (default
# claude; `COPILOT_PROVIDER=codex ./test/replay-gate.sh` is the codex gate —
# same fixture, same baseline), so probe THAT provider's login.
GATE_PROVIDER="${COPILOT_PROVIDER:-claude}"
("$DIR/../cli/doctor.sh" --probe 2>/dev/null || true) | grep -q "ok    $GATE_PROVIDER live probe" \
  || { echo "GATE ABORT: $GATE_PROVIDER CLI cannot complete a live call — fix login first ($GATE_PROVIDER auth/login; verify: COPILOT_PROVIDER=$GATE_PROVIDER copilot doctor --probe)" >&2; exit 2; }

node "$DIR/../brain/brain-loop.mjs" \
  --replay "$DIR/fixtures/rivertech/fixture.jsonl" \
  --prep "$DIR/fixtures/rivertech/prep-pack.md" \
  --cards-out "$OUT" --title "Vendor Sync" >&2

[ -s "$OUT" ] || { echo "GATE FAIL: no cards emitted" >&2; exit 1; }
grep -q "42,500\|42500" "$OUT" || { echo "GATE FAIL: no card cites the \$42,500 SOW anchor" >&2; cat "$OUT" >&2; exit 1; }
echo "GATE PASS: $(wc -l < "$OUT" | tr -d ' ') card(s), SOW anchor cited" >&2
