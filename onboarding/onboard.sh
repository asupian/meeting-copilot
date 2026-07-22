#!/bin/bash
# onboard.sh — the Onboarding journey: build the tool, then build what it knows.
#
#   onboard.sh                 guided: knowledge wizard (KB ingest) while the
#                              binaries compile behind it, then permissions,
#                              then a trial on one of YOUR recordings, then
#                              packs prepped for every upcoming meeting
#   onboard.sh replay <file>   the trial alone: transcribe a past meeting
#                              recording, pack it from your KB, replay it
#   onboard.sh knowledge       (re)run the knowledge wizard: ingest your KB,
#                              channels as fallback; re-running tops up
#   onboard.sh import <dir>    distill an existing notes folder (Obsidian, Notion export...)
#
# Thin by design: the engines are setup.sh and portable/knowledge.sh. This
# script only names the journey.
set -euo pipefail
# shellcheck source=../cli/common.sh
source "$(cd "$(dirname "$0")" && pwd)/../cli/common.sh"

replay_recording() { # transcribe a past-meeting recording, pack it from the KB, replay it
  local rec="$1" title attendees tmp fixture pack
  [ -f "$rec" ] || { echo "replay: no such file: $rec" >&2; return 1; }
  [ -x "$ROOT/capture/meetingtap" ] || { echo "replay: capture binary missing — run ./setup.sh first" >&2; return 1; }
  tmp="$(mktemp -d)"; fixture="$tmp/fixture.jsonl"; pack="$tmp/prep-pack.md"
  printf 'Meeting title? ' >&2; read -r title
  printf 'Who attended (names, comma-separated)? ' >&2; read -r attendees
  echo "replay: transcribing on-device (~8x realtime — a 30-min meeting takes ~4 min)..." >&2
  "$ROOT/capture/meetingtap" --file "$rec" --out "$fixture"
  [ -s "$fixture" ] || { echo "replay: transcription produced nothing — is that file an audio/video recording?" >&2; return 1; }
  echo "replay: building a prep pack for it from your knowledge dir..." >&2
  printf 'Meeting: %s\nAttendees: %s\n(a past meeting, replayed as a trial)\n' "${title:-past meeting}" "${attendees:-unknown}" |
    "$ROOT/portable/knowledge.sh" pack --paste --out "$pack"
  echo "" >&2
  echo "replay: running it through the brain. Cards cite YOUR facts; a meeting" >&2
  echo "replay: that never touches what you hold ends with zero cards — that is it working." >&2
  node "$ROOT/brain/brain-loop.mjs" --replay "$fixture" --prep "$pack" --title "${title:-Trial replay}"
}

case "${1:-}" in
  "")
    # The slow compiles start NOW, in the background, so they finish under the
    # wizard. Same flags as setup.sh, which later finds the binaries built and
    # skips straight to cert + bundles + the permissions self-test.
    BUILD_LOG="$(mktemp -t copilot-build)"
    BUILD_PID=""
    if command -v swiftc >/dev/null 2>&1 && { [ ! -f "$ROOT/capture/meetingtap" ] || [ ! -f "$ROOT/capture/screentap" ]; }; then
      (
        cd "$ROOT/capture"
        [ -f meetingtap ] || swiftc -O -parse-as-library -o meetingtap meetingtap.swift \
          -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
        [ -f screentap ] || swiftc -O -o screentap screentap.swift
      ) > "$BUILD_LOG" 2>&1 &
      BUILD_PID=$!
      echo "capture binaries compiling in the background (log: $BUILD_LOG)" >&2
    fi
    # The main event: connect + ingest the knowledge base (wizard needs claude).
    if ! command -v claude >/dev/null 2>&1; then
      echo "claude CLI not found — running the build first; install claude, then: copilot onboard knowledge" >&2
    elif [ ! -f "$CONF" ]; then
      "$ROOT/portable/knowledge.sh" setup
    else
      echo "config found — knowledge wizard skipped (top up anytime: copilot onboard knowledge)" >&2
    fi
    # Build tail: wait out the compiles, then cert + bundles + the two Allow
    # dialogs, with the user back at the keyboard.
    if [ -n "$BUILD_PID" ]; then
      wait "$BUILD_PID" || { echo "background build FAILED — log tail:" >&2; tail -20 "$BUILD_LOG" >&2; exit 1; }
    fi
    "$ROOT/setup.sh"
    # Trial on the user's OWN material: transcribe a past recording, replay it
    # against the fresh knowledge dir. Skippable with Enter.
    if [ -t 0 ] && [ -f "$CONF" ]; then
      echo "" >&2
      printf 'Try it on one of YOUR meetings? Path to a recording (Zoom/Meet export, mp4/m4a) — Enter to skip: ' >&2
      read -r REC
      if [ -n "$REC" ]; then replay_recording "$REC" || echo "(trial failed — everything else is unaffected)" >&2; fi
    fi
    # Prep ahead on the user's behalf: a pack for every upcoming meeting.
    if [ -f "$CONF" ]; then
      echo "" >&2
      echo "prepping your upcoming meetings from the new knowledge dir..." >&2
      "$ROOT/prep/prep.sh" --all ||
        echo "(no calendar data — prep before each meeting: copilot prep --pick)" >&2
    fi
    echo "" >&2
    echo "MEETING-READY. At meeting time:  copilot live   (packs are already built; re-prep anytime: copilot prep list)" >&2
    ;;
  replay) shift; replay_recording "${1:?usage: onboard.sh replay <recording-file>}" ;;
  knowledge) exec "$ROOT/portable/knowledge.sh" setup ;;
  import)    shift; exec "$ROOT/portable/knowledge.sh" import "$@" ;;
  *) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
