#!/bin/bash
# live-checks.sh — deterministic checks of live.mjs behavior, ZERO model calls.
# The provider shims (test/shim/claude, test/shim/codex) play the model; HOME
# is a throwaway sandbox; ~60-90s per provider. Covers what the replay gate
# structurally cannot: feedback modulation, the dropped-question block, typed
# cards on the wire, brain-down surfacing, the ephemeral-session cleanup,
# feedback history.
#
# The suite reruns once per brain provider (one alone: PROVIDER=codex
# ./test/live-checks.sh). Scenarios that only exercise logic DOWNSTREAM of the
# streamBrain result contract (feedback, cleanup, whitelisting, timeout
# machinery — all provider-independent) run on claude alone; the codex pass
# keeps the scenarios that cross the provider boundary: the wire parse, the
# embedded-contract prompt composition, and the ambient call path.
#
# Run after changes to live.mjs, panel wire formats, or lib.mjs streamBrain.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

if [ -z "${PROVIDER:-}" ]; then
  RC=0
  for p in claude codex; do
    echo "════ provider: $p ════" >&2
    PROVIDER="$p" "$0" || RC=1
    echo "" >&2
  done
  exit "$RC"
fi
SANDBOX="$(mktemp -d)"
export HOME="$SANDBOX/home"
CUR="$HOME/.meeting-copilot/current"
TX="$CUR/transcript.jsonl"
CAP="$SANDBOX/prompts"
PORT=8899
FAIL=0
LIVE=""; SSE=""

pass() { echo "PASS  [$PROVIDER] $*" >&2; }
fail() { echo "FAIL  [$PROVIDER] $*" >&2; FAIL=1; }
claude_only() { [ "$PROVIDER" = claude ]; }
cleanup() { [ -n "$LIVE" ] && kill "$LIVE" 2>/dev/null; [ -n "$SSE" ] && kill "$SSE" 2>/dev/null; }
trap cleanup EXIT

start_live() { # start_live [extra live.mjs flags...] — fresh sandbox session
  cleanup; LIVE=""; SSE=""
  mkdir -p "$CUR"; : > "$TX"
  rm -f "$CAP".user.* "$SANDBOX/sse.log" "$CUR"/trace.jsonl "$CUR"/feedback.jsonl
  : > "$CUR/digest.md"
  PROMPT_CAPTURE="$CAP" PATH="$DIR/shim:$PATH" node "$ROOT/brain/live.mjs" --port "$PORT" \
    --provider "$PROVIDER" --no-recall --no-staging --headphones \
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

# The check-input portion of a captured prompt. Codex captures embed the whole
# contract above a separator (codex has no --system-prompt), and the contract
# TEXT mentions blocks like QUESTIONS STILL OPEN — a grep over the raw capture
# would match the rulebook, not the input. Claude captures are the user turn
# alone and pass through whole.
check_part() {
  if grep -q "^===== CURRENT INPUT =====$" "$1" 2>/dev/null; then
    sed -n '/^===== CURRENT INPUT =====$/,$p' "$1"
  else cat "$1" 2>/dev/null; fi
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
# codex has no --system-prompt: the contract must ride embedded at the top of
# the prompt turn, above the check input (lib.mjs streamCodex).
if [ "$PROVIDER" = codex ]; then
  grep -q "===== CURRENT INPUT =====" "$CAP.user.1" && grep -q "PREP PACK" "$CAP.user.1" \
    && pass "contract + pack embedded in the codex prompt turn" \
    || fail "codex prompt missing the embedded contract/pack"
fi
# Everything below this line in scenario 1 — and scenarios 2, 3, 4, 6 — tests
# logic downstream of the streamBrain result contract: identical for every
# provider, so it runs on claude alone.
if claude_only; then
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
  check_part "$CAP.user.1" | grep -q "PAST meetings" && pass "past downvotes seed the first prompt" \
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
else
  stop_live
fi

# ── 5. dropped-question block: aged ambient question enters late prompts ──
start_live   # ambient ON
node -e '
const t0 = Date.now() - 15*60_000;
const lines=["Welcome.","Pricing first.","What is the margin impact?","Later.","Roadmap.","On track."];
lines.forEach((text,i)=>console.log(JSON.stringify({t:new Date(t0+i*40_000).toISOString(),ch:"them",text})));' >> "$TX"
sleep 24   # ambient flush timer (20s)
say_line "So we are all set on pricing then."
# The post-flush check writes its prompt asynchronously — wait on the block
# itself, not on an SSE event the first check already satisfied. check_part
# scopes the grep to the check input: the contract text mentions the block too.
dropped_in_some_check() {
  local f
  for f in "$CAP".user.*; do
    [ -f "$f" ] && check_part "$f" | grep -q "QUESTIONS STILL OPEN" && return 0
  done
  return 1
}
for i in $(seq 1 30); do dropped_in_some_check && break; sleep 0.5; done
if dropped_in_some_check; then pass "aged open question entered a late prompt"
else fail "dropped block never appeared"; fi
check_part "$CAP.user.1" | grep -q "QUESTIONS STILL OPEN" && fail "dropped block appeared before any flush" || true
stop_live

# ── 6. hung model call -> timeout, and the brain KEEPS WORKING after ──
# The regression: a `claude` that stalls instead of exiting left inFlight stuck
# true forever, so the brain went silent for the rest of the meeting with no
# error anywhere. Reported live as "it hung on me mid-meeting". The second half
# of this check is the real assertion — recovery, not just the timeout firing.
# claude-only: the timeout + inFlight machinery is shared streamCli/live.mjs code.
if claude_only; then
  COPILOT_CALL_TIMEOUT_MS=4000 SHIM_HANG=1 start_live --no-ambient
  say_line "A beat the hung model will never answer."
  wait_for "$SANDBOX/live.log" "TIMED OUT" 24 && pass "hung model call is killed by the timeout" \
    || fail "hung model call never timed out — the meeting-killing bug is back"
  # Same session, model now healthy: a stuck inFlight would eat this silently.
  kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
  mkdir -p "$CUR"; rm -f "$CAP".user.*
  PROMPT_CAPTURE="$CAP" PATH="$DIR/shim:$PATH" node "$ROOT/brain/live.mjs" --port "$PORT" \
    --provider "$PROVIDER" --no-recall --no-staging --headphones --no-ambient \
    --prep "$ROOT/test/fixtures/rivertech/prep-pack.md" 2>> "$SANDBOX/live.log" &
  LIVE=$!
  sleep 1
  curl -s -N "http://127.0.0.1:$PORT/events" > "$SANDBOX/sse2.log" & SSE=$!
  say_line "A beat after the stall."
  wait_for "$SANDBOX/sse2.log" '"type":"card"' && pass "brain still answers after a timed-out call" \
    || fail "brain never recovered from the hung call"
  stop_live
fi

echo "" >&2
[ "$FAIL" = 0 ] && echo "LIVE CHECKS [$PROVIDER]: all pass" >&2 || echo "LIVE CHECKS [$PROVIDER]: FAILURES (see above)" >&2
exit "$FAIL"
