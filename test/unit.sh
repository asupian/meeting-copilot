#!/bin/bash
# unit.sh — fast deterministic checks of the pure helpers: cli/events.mjs
# (list/count/json/stem/pack-stem/match) and `copilot config` round-trips.
# No model, no network, sandboxed HOME; runs in ~2s.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
EV="$DIR/fixtures/sample-events.json"
SANDBOX="$(mktemp -d)"
export HOME="$SANDBOX/home"; mkdir -p "$HOME"
FAIL=0
ok()   { echo "PASS  $*" >&2; }
bad()  { echo "FAIL  $*" >&2; FAIL=1; }
is()   { [ "$1" = "$2" ] && ok "$3" || bad "$3 (got: $1, want: $2)"; }

# events.mjs
is "$(node "$ROOT/cli/events.mjs" count < "$EV")" "4" "count"
is "$(node "$ROOT/cli/events.mjs" stem 1 < "$EV")" "2026-07-22-1400-vendor-sync-q3-sow" "stem: emoji/slash title slugs clean"
is "$(node "$ROOT/cli/events.mjs" stem 3 < "$EV")" "2026-07-23-company-offsite" "stem: all-day omits HHMM"
ORG_DOMAIN=acme.example node "$ROOT/cli/events.mjs" list < "$EV" | grep -q "external" && ok "list: external flag" || bad "list: external flag"
node "$ROOT/cli/events.mjs" json 2 < "$EV" | grep -q '"Focus block"' && ok "json: picks by index" || bad "json: picks by index"
node "$ROOT/cli/events.mjs" stem 9 < "$EV" >/dev/null 2>&1 && bad "stem: out-of-range accepted" || ok "stem: out-of-range rejected"
printf '# Prep Pack — Vendor Sync — 2026-07-22\n' | node "$ROOT/cli/events.mjs" pack-stem | grep -q -- "-vendor-sync$" && ok "pack-stem from header" || bad "pack-stem from header"

# match: time-window pack resolution
P="$SANDBOX/prep"; mkdir -p "$P"
NOW_STEM="$(date "+%Y-%m-%d-%H%M")"; STALE="$(date -v-1d "+%Y-%m-%d-%H%M")"
touch "$P/$NOW_STEM-standup.md" "$P/$STALE-old.md" "$P/$(date "+%Y-%m-%d")-allday.md"
node "$ROOT/cli/events.mjs" match "$P" 12 | grep -q standup && ok "match: timed pack near now wins" || bad "match: timed pack near now"
rm "$P/$NOW_STEM-standup.md"
node "$ROOT/cli/events.mjs" match "$P" 12 | grep -q allday && ok "match: date-only pack as fallback" || bad "match: date-only fallback"
rm "$P/$(date "+%Y-%m-%d")-allday.md"
node "$ROOT/cli/events.mjs" match "$P" 12 >/dev/null 2>&1 && bad "match: stale-only accepted" || ok "match: stale-only rejected"

# copilot config round-trip (bash source AND lib.mjs loadConfig read the same file)
"$ROOT/copilot" config set USER_NAME "Test Person" >/dev/null 2>&1
"$ROOT/copilot" config set PREP_LOOKAHEAD_H 24 >/dev/null 2>&1
"$ROOT/copilot" config set PREP_LOOKAHEAD_H 36 >/dev/null 2>&1
is "$("$ROOT/copilot" config get PREP_LOOKAHEAD_H)" "36" "config: set replaces in place"
is "$("$ROOT/copilot" config get USER_NAME)" "Test Person" "config: values with spaces"
NODE_READ="$(node -e "import(\"$ROOT/brain/lib.mjs\").then(m=>console.log(m.loadConfig(process.env.HOME+\"/.meeting-copilot/config\").PREP_LOOKAHEAD_H))")"
is "$NODE_READ" "36" "config: loadConfig agrees with bash"
"$ROOT/copilot" config set USER_NAME 'has"quote' >/dev/null 2>&1 && bad "config: quote accepted" || ok "config: quotes rejected"
"$ROOT/copilot" config set lower x >/dev/null 2>&1 && bad "config: lowercase key accepted" || ok "config: lowercase key rejected"

echo "" >&2
[ "$FAIL" = 0 ] && echo "UNIT: all pass" >&2 || echo "UNIT: FAILURES" >&2
exit "$FAIL"
