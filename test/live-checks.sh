#!/bin/bash
# live-checks.sh — deterministic checks of live.mjs behavior, ZERO model calls.
# The claude shim (test/shim/claude) plays the model; HOME is a throwaway
# sandbox; ~60-90s total. Covers what the replay gate structurally cannot:
# feedback modulation, the dropped-question block, typed cards on the wire,
# brain-down surfacing, the ephemeral-session cleanup, feedback history.
#
# Run after changes to live.mjs, panel wire formats, or lib.mjs streamBrain.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
SANDBOX="$(mktemp -d)"
export HOME="$SANDBOX/home"
CUR="$HOME/.meeting-copilot/current"
TX="$CUR/transcript.jsonl"
CAP="$SANDBOX/prompts"
PORT=8899
FAIL=0
LIVE=""; SSE=""

pass() { echo "PASS  $*" >&2; }
fail() { echo "FAIL  $*" >&2; FAIL=1; }
cleanup() { [ -n "$LIVE" ] && kill "$LIVE" 2>/dev/null; [ -n "$SSE" ] && kill "$SSE" 2>/dev/null; }
trap cleanup EXIT

start_live() { # start_live [extra live.mjs flags...] — fresh sandbox session
  cleanup; LIVE=""; SSE=""
  mkdir -p "$CUR"; : > "$TX"
  rm -f "$CAP".user.* "$SANDBOX/sse.log" "$CUR"/trace.jsonl "$CUR"/feedback.jsonl
  : > "$CUR/digest.md"
  PROMPT_CAPTURE="$CAP" PATH="$DIR/shim:$PATH" node "$ROOT/brain/live.mjs" --port "$PORT" \
    --no-recall --no-staging --headphones \
    --prep "$ROOT/test/fixtures/rivertech/prep-pack.md" "$@" 2> "$SANDBOX/live.log" &
  LIVE=$!
  sleep 1
  curl -s -N "http://127.0.0.1:$PORT/events" > "$SANDBOX/sse.log" & SSE=$!
}

say_line() { # say_line <text> [iso-time] — append one transcript line
  node -e 'console.log(JSON.stringify({t:process.argv[2]||new Date().toISOString(),ch:"them",text:process.argv[1]}))' \
    "$1" "${2:-}" >> "$TX"
}

wait_for() { # wait_for <file> <grep-pattern> [tries=20]
  local i; for i in $(seq 1 "${3:-20}"); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}

vote() { curl -s -X POST -H 'content-type: application/json' \
  -d "{\"cardId\":\"$1\",\"vote\":\"$2\"}" "http://127.0.0.1:$PORT/feedback" >/dev/null; }

stop_live() { kill -INT "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null; LIVE=""; }

# ── 1. typed card on the wire + feedback modulation + ephemeral + history ──
start_live --no-ambient
say_line "First beat about the SOW."
wait_for "$SANDBOX/sse.log" '"id":"c1"' || fail "no first card"
grep -q '"cardType":"collision"' "$SANDBOX/sse.log" && pass "typed card reaches SSE as cardType" \
  || fail "cardType missing on SSE"
vote c1 down
say_line "Second beat, different topic."
wait_for "$SANDBOX/sse.log" '"id":"c2"' || fail "no second card"
vote c2 down
say_line "Third beat inside the widened gap."
wait_for "$SANDBOX/live.log" "feedback min-gap 90s" \
  && pass "2 distinct downvotes -> third card suppressed (feedback min-gap 90s)" \
  || fail "feedback modulation did not suppress"
vote c99 down   # unknown id: logged, never consumed
grep -q "unknown id" <(sleep 0.5; cat "$SANDBOX/live.log") && pass "stale cardId excluded from modulation" \
  || fail "unknown cardId not handled"
stop_live
[ -f "$TX" ] && fail "transcript survived ephemeral cleanup" || pass "transcript deleted at shutdown"
[ -f "$CUR/trace.jsonl" ] && fail "trace survived ephemeral cleanup" || pass "trace deleted at shutdown"
grep -q '"vote":"down"' "$HOME/.meeting-copilot/feedback-history.jsonl" 2>/dev/null \
  && grep -q '"type":"collision"' "$HOME/.meeting-copilot/feedback-history.jsonl" \
  && pass "feedback history persisted with card type" || fail "feedback history missing/typeless"

# ── 2. history seeds the next session's first prompt ──
start_live --no-ambient
say_line "Fresh meeting, first beat."
wait_for "$SANDBOX/sse.log" '"type":"card"' || fail "no card in session 2"
grep -q "PAST meetings" "$CAP.user.1" && pass "past downvotes seed the first prompt" \
  || fail "history seed absent from prompt"
stop_live

# ── 3. bogus type never reaches the wire ──
rm -f "$HOME/.meeting-copilot/feedback-history.jsonl"
SHIM_CARD_TYPE=banana start_live --no-ambient
say_line "A beat."
wait_for "$SANDBOX/sse.log" '"type":"card"' || fail "no card in bogus-type run"
grep -q '"cardType"' "$SANDBOX/sse.log" && fail "bogus type leaked to SSE" \
  || pass "invalid type -> no label (never guessed)"
stop_live

# ── 4. dead model -> brainDown, never fake silence ──
SHIM_DEAD=1 start_live --no-ambient
say_line "A beat the dead model will eat."
wait_for "$SANDBOX/sse.log" '"type":"brainDown"' && pass "dead model surfaces as brainDown on SSE" \
  || fail "dead model looked like silence"
grep -q '"type":"silent"' "$SANDBOX/sse.log" && fail "dead model ALSO emitted silent" || true
stop_live

# ── 5. dropped-question block: aged ambient question enters late prompts ──
start_live   # ambient ON
node -e '
const t0 = Date.now() - 15*60_000;
const lines=["Welcome.","Pricing first.","What is the margin impact?","Later.","Roadmap.","On track."];
lines.forEach((text,i)=>console.log(JSON.stringify({t:new Date(t0+i*40_000).toISOString(),ch:"them",text})));' >> "$TX"
sleep 24   # ambient flush timer (20s)
say_line "So we are all set on pricing then."
# The post-flush check writes its prompt asynchronously — wait on the block
# itself, not on an SSE event the first check already satisfied.
for i in $(seq 1 30); do grep -lq "QUESTIONS STILL OPEN" "$CAP".user.* 2>/dev/null && break; sleep 0.5; done
if grep -lq "QUESTIONS STILL OPEN" "$CAP".user.* 2>/dev/null; then pass "aged open question entered a late prompt"
else fail "dropped block never appeared"; fi
grep -q "QUESTIONS STILL OPEN" "$CAP.user.1" && fail "dropped block appeared before any flush" || true
stop_live

# ── 6. hung model call -> timeout, and the brain KEEPS WORKING after ──
# The regression: a `claude` that stalls instead of exiting left inFlight stuck
# true forever, so the brain went silent for the rest of the meeting with no
# error anywhere. Reported live as "it hung on me mid-meeting". The second half
# of this check is the real assertion — recovery, not just the timeout firing.
COPILOT_CALL_TIMEOUT_MS=4000 SHIM_HANG=1 start_live --no-ambient
say_line "A beat the hung model will never answer."
wait_for "$SANDBOX/live.log" "TIMED OUT" 24 && pass "hung model call is killed by the timeout" \
  || fail "hung model call never timed out — the meeting-killing bug is back"
# Same session, model now healthy: a stuck inFlight would eat this silently.
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
mkdir -p "$CUR"; rm -f "$CAP".user.*
PROMPT_CAPTURE="$CAP" PATH="$DIR/shim:$PATH" node "$ROOT/brain/live.mjs" --port "$PORT" \
  --no-recall --no-staging --headphones --no-ambient \
  --prep "$ROOT/test/fixtures/rivertech/prep-pack.md" 2>> "$SANDBOX/live.log" &
LIVE=$!
sleep 1
curl -s -N "http://127.0.0.1:$PORT/events" > "$SANDBOX/sse2.log" & SSE=$!
say_line "A beat after the stall."
wait_for "$SANDBOX/sse2.log" '"type":"card"' && pass "brain still answers after a timed-out call" \
  || fail "brain never recovered from the hung call"
stop_live

echo "" >&2
[ "$FAIL" = 0 ] && echo "LIVE CHECKS: all pass" >&2 || echo "LIVE CHECKS: FAILURES (see above)" >&2
exit "$FAIL"
