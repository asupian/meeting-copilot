#!/bin/bash
# trigger-checks.sh — rubric-tier checks for the detection modes the binary
# gate does NOT cover, one fixture per mode, asserting the card's CLASS
# (collision / gap / reinforce) as well as its anchor.
#
# Run alongside replay-gate.sh for SUBSTANTIVE contract changes (the gate
# alone only proves the rivertech collision didn't break). Costs ~6-12 real
# `claude -p` calls (~4-8 min). Like the gate, asserts substance not phrasing.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
FAIL=0

check() { # check <fixture> <title> <anchor-regex> <type-regex>
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
  elif ! grep -qE "\"type\":\"($4)\"" "$out"; then
    echo "TRIGGER FAIL: $1 — no card typed ($4)" >&2; cat "$out" >&2; FAIL=1
  else
    echo "TRIGGER PASS: $1 — $(wc -l < "$out" | tr -d ' ') card(s), anchor cited, type ok" >&2
  fi
}

# fixture              title                    anchor                                                       expected class
check win-gloss    "Q2 Support Review"      "104"                                                        "reinforce"
check goal-drift   "Weekly Vendor Ops Sync" "atalink|18,000|18000"                                       "gap"
check trend-gloss  "Metrics Monthly"        "activation.*(decline|27|drop)|27%.*activation|3rd consecutive" "collision|gap"
check relitigation "Platform Weekly"        "kafka|06-18|june 18|queue eval"                             "collision"
check load         "Sprint Planning"        "parker|overdue|billing|rate.?limit"                         "gap"
check recurrence   "EMEA Expansion Sync"    "residency|4 meetings|recurring"                             "collision|gap"

[ "$FAIL" = 0 ] && echo "TRIGGER CHECKS: all pass" >&2
exit "$FAIL"
