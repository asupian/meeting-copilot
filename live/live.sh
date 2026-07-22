#!/bin/bash
# live.sh — the Meeting-copilot journey: run capture + brain + panel.
#
#   live.sh [name] [flags]   run the copilot; pack picked by name, start time,
#                            or the legacy prep-pack.md (flags pass to start.sh)
#   live.sh capture          capture only (run.sh)
#   live.sh selftest         verify the system-audio tap (selftest.sh)
#
# Thin by design: the engine is start.sh (capture/ + brain/ + panel/). This
# script only resolves WHICH prep pack the meeting gets:
#   --prep passthrough > name match > start-time match > start.sh's default.
set -euo pipefail
# shellcheck source=../cli/common.sh
source "$(cd "$(dirname "$0")" && pwd)/../cli/common.sh"

case "${1:-}" in
  capture)  shift; exec "$ROOT/run.sh" "$@" ;;
  selftest) exec "$ROOT/selftest.sh" ;;
esac

# An explicit --prep anywhere wins: hand everything to start.sh untouched.
for a in "$@"; do
  if [ "$a" = "--prep" ]; then exec "$ROOT/start.sh" "$@"; fi
done

# A positional name picks a per-meeting pack by filename substring.
if [ $# -ge 1 ] && [ "${1#-}" = "$1" ]; then
  NAME="$1"; shift
  PACK="$(find_pack "$NAME")" || exit 1
  exec "$ROOT/start.sh" --prep "$PACK" "$@"
fi

# No name: the pack whose start time brackets now (stems carry the time).
if PACK="$(node "$ROOT/cli/events.mjs" match "$PREP_DIR" "$LOOKAHEAD" 2>/dev/null)"; then
  echo "live: matched pack -> $PACK" >&2
  exec "$ROOT/start.sh" --prep "$PACK" "$@"
fi
exec "$ROOT/start.sh" "$@"   # legacy default (prep-pack.md) + start.sh's own error
