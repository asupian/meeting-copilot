#!/bin/bash
# onboard.sh — the Onboarding journey: build the tool, then build what it knows.
#
#   onboard.sh                 guided: knowledge wizard (KB ingest) while the
#                              binaries compile behind it, then permissions,
#                              then a trial on one of YOUR recordings, then
#                              packs prepped for every upcoming meeting
#   onboard.sh replay <file>   the trial alone: transcribe a past meeting
#                              recording, pack it from your KB, replay it
#   onboard.sh integrations    what each optional piece (qmd, calendar, notes
#                              source) unlocks, whether it's connected, how to
#                              connect it. Read-only, installs nothing.
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
    # Say what the optional pieces ARE before asking for anything. They used to
    # be detected silently, so a user could finish onboarding never knowing live
    # recall or the meeting list existed — which is the complaint this closes.
    "$ROOT/onboarding/integrations.sh" || true
    # The main event: connect + ingest the knowledge base (wizard needs the
    # brain CLI — claude by default, codex when MODEL_PROVIDER or the
    # COPILOT_PROVIDER env var is set to codex; with codex, claude is not
    # needed at all and integrations come from the user's own codex MCP config).
    # Every branch that does NOT end with a usable knowledge dir is recorded, so
    # the summary at the bottom can refuse to say MEETING-READY. It used to say
    # it unconditionally: a missing brain CLI skipped the wizard with one line
    # mid-scroll, and onboarding still signed off — leaving compiled binaries,
    # no knowledge base, and a user who thinks they are done.
    BRAIN="$(brain_bin)"
    BRAIN_URL="https://claude.com/claude-code"
    [ "$BRAIN" = codex ] && BRAIN_URL="https://github.com/openai/codex"
    KSTATE=ok
    if ! command -v "$BRAIN" >/dev/null 2>&1; then
      KSTATE=no-brain
      echo "" >&2
      echo "STOP: the $BRAIN CLI is not installed. It is not optional — it IS the brain," >&2
      echo "so nothing can run without it, knowledge base included. Compiling the capture" >&2
      echo "binaries anyway so that part is done, but this is a TWO-STEP install now:" >&2
      echo "  1. install + log in:  $BRAIN_URL" >&2
      echo "  2. come back and run: copilot onboard knowledge" >&2
      echo "" >&2
    elif ! "$ROOT/cli/doctor.sh" --probe 2>/dev/null | grep -q "ok    $BRAIN live probe"; then
      # The CLI is installed but a real call fails (expired OAuth refresh, dead
      # network). Local auth-status reads cannot catch this — they keep saying
      # logged-in. Without the probe, onboarding burns the
      # wizard on a dead brain and the failure surfaces as three unrelated-
      # looking errors downstream.
      KSTATE=brain-dead
      echo "" >&2
      echo "STOP: the $BRAIN CLI is installed but a live call FAILED — the brain cannot" >&2
      echo "answer, so the knowledge wizard would die mid-session. Most common cause is an" >&2
      echo "expired login:  $([ "$BRAIN" = codex ] && echo "codex login" || echo "claude auth login")   then re-run:  copilot onboard knowledge" >&2
      echo "" >&2
    elif [ ! -f "$CONF" ]; then
      # set -e would abort onboarding mid-way if the wizard exits non-zero,
      # dropping the user out with no summary and no idea where they stand.
      # Catch it, keep going, and report it at the end instead.
      if [ -t 0 ]; then
        "$ROOT/portable/knowledge.sh" setup || KSTATE=wizard-failed
      else
        # The wizard is an interactive claude session only a human at a real
        # terminal can hold. Headless (an agent driving), exec-ing it would
        # die and set -e would kill the whole install — defer it instead.
        echo "no terminal — knowledge wizard deferred; the build continues." >&2
        echo "HUMAN: run in your own terminal when ready:  copilot onboard knowledge" >&2
      fi
      # The wizard writes the config, and common.sh sourced it before it existed.
      if [ -f "$CONF" ]; then
        # shellcheck disable=SC1090
        source "$CONF"
      fi
    else
      echo "config found — knowledge wizard skipped (top up anytime: copilot onboard knowledge)" >&2
    fi
    # A config file is not a knowledge base. An empty knowledge dir produces a
    # copilot that runs, stays silent all meeting, and looks broken — so it is
    # not "ready" either, and it is worth saying while the wizard is one command
    # away rather than at meeting time. (wizard-failed is kept: it says WHY the
    # knowledge dir is missing, which knowledge_state alone cannot know.)
    if [ "$KSTATE" = ok ]; then KSTATE="$(knowledge_state)"; fi
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
        echo "(no calendar connected — prep each meeting by describing it: copilot prep --text \"...\")" >&2
    fi
    # "MEETING-READY" used to be asserted, not checked. doctor is read-only and
    # ~2s, and it is the difference between a user who knows what they're missing
    # and one who finds out mid-meeting.
    echo "" >&2
    echo "final health check:" >&2
    "$ROOT/cli/doctor.sh" || true
    echo "" >&2
    # Sign-off tells the truth or refuses to sign. Non-zero exit so a script or
    # an agent driving the install can tell the difference too.
    case "$KSTATE" in
      ok)
        echo "MEETING-READY. At meeting time:  copilot live   (packs are already built; re-prep anytime: copilot prep list)" >&2
        ;;
      no-brain)
        echo "NOT READY — capture binaries are built, but there is no brain and no knowledge base." >&2
        echo "  1. install + log in:  $BRAIN_URL" >&2
        echo "  2. then run:          copilot onboard knowledge" >&2
        exit 1
        ;;
      brain-dead)
        echo "NOT READY — the $BRAIN CLI is installed but a live call fails (expired login" >&2
        echo "or dead network); every brain call would fail the same way at meeting time." >&2
        echo "  1. re-login:  $([ "$BRAIN" = codex ] && echo "codex login" || echo "claude auth login")    (verify: copilot doctor --probe)" >&2
        echo "  2. then run:  copilot onboard knowledge" >&2
        exit 1
        ;;
      wizard-failed)
        echo "NOT READY — the knowledge wizard did not finish, so there is nothing for the" >&2
        echo "copilot to cite. Everything else (binaries, permissions) is done." >&2
        echo "  retry:  copilot onboard knowledge" >&2
        exit 1
        ;;
      no-config|no-knowledge-dir)
        echo "NOT READY — no knowledge dir. Cards are grounded in your notes; with no notes" >&2
        echo "there is nothing to ground them in." >&2
        echo "  fix:  copilot onboard knowledge" >&2
        exit 1
        ;;
      empty-knowledge)
        echo "NOT READY — your knowledge dir has no notes in it." >&2
        echo "The copilot will run and stay silent all meeting, which looks like a bug and" >&2
        echo "is not one: it only speaks from what you hold." >&2
        echo "  fix:  copilot onboard knowledge     (or: copilot onboard import <notes-dir>)" >&2
        exit 1
        ;;
    esac
    ;;
  replay) shift; replay_recording "${1:?usage: onboard.sh replay <recording-file>}" ;;
  knowledge) exec "$ROOT/portable/knowledge.sh" setup ;;
  integrations) exec "$ROOT/onboarding/integrations.sh" ;;
  import)    shift; exec "$ROOT/portable/knowledge.sh" import "$@" ;;
  *) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
