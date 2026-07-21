#!/bin/bash
# Start live capture + on-device transcription and stream the transcript to the
# terminal. Ctrl-C stops both. Transcripts are ephemeral working files (not in
# the repo): ~/.meeting-copilot/sessions/<ts>/, symlinked at .../current.
#
#   ./run.sh                 on-device (default; audio never leaves the Mac)
#   ./run.sh --deepgram      cloud ASR with per-speaker labels in group calls
#                            (needs: security add-generic-password -s deepgram -a $USER -w <KEY>)
#
# Why `open` and not a direct exec: a Core Audio system-audio tap requires the
# System Audio Recording permission attributed to the launching app's identity.
# Launched via `open`, meetingtap.app runs as its own process (io.meetingcopilot.meetingtap)
# and uses its own grant. Launched as a child of a shell, it would inherit the
# shell's identity and the tap would capture silence.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/capture/meetingtap.app"
SCREEN_APP="$DIR/capture/screentap.app"
# The OCR roster comes from the knowledge dir (same resolution as live.mjs).
# shellcheck disable=SC1090
[ -f "${HOME}/.meeting-copilot/config" ] && source "${HOME}/.meeting-copilot/config"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-${HOME}/.meeting-copilot/knowledge}"

# --no-screen skips the screen-OCR feed; everything else passes to meetingtap.
SCREEN=1
ARGS=()
for a in "$@"; do case "$a" in --no-screen) SCREEN=0 ;; *) ARGS+=("$a") ;; esac; done
set -- ${ARGS[@]+"${ARGS[@]}"}

SESSION_DIR="${HOME}/.meeting-copilot/sessions/$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$SESSION_DIR"
TRANSCRIPT="$SESSION_DIR/transcript.jsonl"
touch "$TRANSCRIPT"
ln -sfn "$SESSION_DIR" "${HOME}/.meeting-copilot/current"
echo "meeting-copilot: transcript -> $TRANSCRIPT" >&2

# Deepgram path (opt-in fallback): PCM is piped to the cloud streamer as a child
# process. Note the system-audio tap needs meetingtap's own grant, so run this
# only after the on-device path has been launched once via `open` to establish it.
if [ "${1:-}" = "--deepgram" ]; then
  shift
  exec "$APP/Contents/MacOS/meetingtap" --pcm "$@" | node "$DIR/stream/deepgram-stream.mjs" "$TRANSCRIPT"
fi

# On-device path: launch the app as its own process, then tail the transcript.
open -n "$APP" --args --out "$TRANSCRIPT" "$@"

# Screen OCR feed (slides, shared docs, participant tiles). Pixels never leave
# the Mac; only extracted text lands in screen.jsonl. Roster = every tracked
# name in the knowledge dir's people/ (index.yaml when present, else `name:`
# frontmatter in each profile), so tile names OCR to canonical spellings.
if [ "$SCREEN" = 1 ] && [ -d "$SCREEN_APP" ]; then
  SCREENFILE="$SESSION_DIR/screen.jsonl"
  touch "$SCREENFILE"
  if [ -f "$KNOWLEDGE_DIR/people/index.yaml" ]; then
    sed -n 's/^ name: //p' "$KNOWLEDGE_DIR/people/index.yaml" | tr -d "'" > "$SESSION_DIR/roster.txt"
  else
    grep -h '^name:' "$KNOWLEDGE_DIR"/people/*/profile.md 2>/dev/null |
      sed -e 's/^name: *//' -e 's/["'"'"']//g' > "$SESSION_DIR/roster.txt" || true
  fi
  open -n "$SCREEN_APP" --args --out "$SCREENFILE" --roster "$SESSION_DIR/roster.txt"
  echo "meeting-copilot: screen OCR -> $SCREENFILE (first run: grant Screen Recording to screentap in System Settings, then restart)" >&2
elif [ "$SCREEN" = 1 ]; then
  echo "meeting-copilot: screentap.app not built (capture/build-app.sh) — running audio-only" >&2
fi

cleanup() { pkill -x meetingtap 2>/dev/null || true; pkill -x screentap 2>/dev/null || true; }
trap cleanup EXIT INT TERM
echo "meeting-copilot: capturing (Ctrl-C to stop)" >&2
# Follow the transcript; -F survives the file being (re)created.
tail -n +1 -F "$TRANSCRIPT"
