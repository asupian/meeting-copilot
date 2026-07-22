#!/bin/bash
# trigger-checks.sh — rubric-tier checks for the detection triggers the binary
# gate does NOT cover: win-reinforcement, unhit-prep-goal-late, and a [trend]
# fact colliding with an optimistic room.
#
# Run alongside replay-gate.sh for SUBSTANTIVE contract changes (the gate
# alone only proves contradiction detection didn't break). Costs ~3-6 real
# `claude -p` calls (~2-4 min). Like the gate, asserts substance not phrasing:
# each fixture must produce >=1 card citing its pack anchor.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
FAIL=0

check() { # check <fixture> <title> <anchor-regex>
  local out="$TMP/$1.jsonl"
  echo "── $1" >&2
  node "$DIR/../brain/brain-loop.mjs" \
    --replay "$DIR/fixtures/$1/fixture.jsonl" \
    --prep "$DIR/fixtures/$1/prep-pack.md" \
    --cards-out "$out" --title "$2" >&2
  if [ ! -s "$out" ]; then
    echo "TRIGGER FAIL: $1 — no card emitted" >&2; FAIL=1
  elif ! grep -qiE "$3" "$out"; then
    echo "TRIGGER FAIL: $1 — no card cites the anchor ($3)" >&2; cat "$out" >&2; FAIL=1
  else
    echo "TRIGGER PASS: $1 — $(wc -l < "$out" | tr -d ' ') card(s), anchor cited" >&2
  fi
}

check win-gloss   "Q2 Support Review"     "104"
check goal-drift  "Weekly Vendor Ops Sync" "atalink|18,000|18000"
check trend-gloss "Metrics Monthly"        "activation.*(decline|27|drop)|27%.*activation|3rd consecutive"

[ "$FAIL" = 0 ] && echo "TRIGGER CHECKS: all pass" >&2
exit "$FAIL"
