#!/bin/bash
# start.sh — one command to run the meeting copilot: capture + brain + panel.
# Ctrl-C stops everything cleanly (and fires the end-of-meeting digest).
#
#   ./start.sh                         # default prep pack, staging on
#   ./start.sh --prep <file>           # a specific prep pack
#   ./start.sh --no-staging            # test run: digest only, don't write the repo
#   ./start.sh --externals             # arm the disclosure guard
# Any extra flags are passed through to brain/live.mjs.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# The knowledge dir: what recall searches and where the digest lands. live.mjs
# resolves the same value itself; start.sh only needs it for the index refresh.
# shellcheck disable=SC1090
[ -f "${HOME}/.meeting-copilot/config" ] && source "${HOME}/.meeting-copilot/config"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-${HOME}/.meeting-copilot/knowledge}"
PREP="${HOME}/.meeting-copilot/prep-pack.md"
RUN_ARGS=()
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --prep) PREP="$2"; shift 2 ;;
    --no-screen) RUN_ARGS+=("--no-screen"); shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done

# One instance at a time: clear any stragglers so ports/permissions are clean.
pkill -x CardPanel 2>/dev/null; pkill -f 'brain/live.mjs' 2>/dev/null; pkill -x meetingtap 2>/dev/null; pkill -x screentap 2>/dev/null
lsof -ti:8787 2>/dev/null | xargs kill 2>/dev/null
sleep 0.5

# Build the panel binary if it's missing (gitignored — not committed).
if [ ! -x "$DIR/panel/CardPanel" ]; then
  echo "start: building the panel (one-time)..." >&2
  swiftc -O -o "$DIR/panel/CardPanel" "$DIR/panel/CardPanel.swift" || { echo "start: panel build failed" >&2; exit 1; }
fi

if [ ! -s "$PREP" ]; then
  echo "start: no prep pack at $PREP" >&2
  echo "  build one first:  ./portable/knowledge.sh pack --next" >&2
  echo "  or point at one:  ./start.sh --prep <file>" >&2
  exit 1
fi
echo "start: prep pack -> $PREP" >&2

# Freshen the recall index so it reflects today's knowledge dir. qmd's index is
# GLOBAL and collection-based: a folder is searchable only once registered as a
# collection, and `qmd update` re-indexes every registered collection (cwd is
# irrelevant). If nothing registered lives under the knowledge dir, recall
# would silently find nothing — register it here, loudly, one time.
# Best-effort: skip when recall is off, qmd is absent, or the knowledge dir is
# missing; never block or fail the meeting on it.
extra=" ${PASS[*]+${PASS[*]}} "
case "$extra" in
  *" --no-recall "*) : ;;
  *) if command -v qmd >/dev/null 2>&1 && [ -d "$KNOWLEDGE_DIR" ]; then
       covered=0
       for c in $(qmd collection list 2>/dev/null | sed -n 's/^\([^ ]*\) (qmd:\/\/.*/\1/p'); do
         cpath="$(qmd collection show "$c" 2>/dev/null | sed -n 's/^ *Path: *//p')"
         case "$cpath" in "$KNOWLEDGE_DIR"|"$KNOWLEDGE_DIR"/*) covered=1; break ;; esac
       done
       if [ "$covered" = 0 ]; then
         echo "start: knowledge dir not indexed by qmd — registering it as collection 'knowledge'..." >&2
         (cd "$KNOWLEDGE_DIR" && qmd collection add . --name knowledge >/dev/null 2>&1) ||
           echo "start: registration failed — recall will find nothing. Register manually: (cd ${KNOWLEDGE_DIR} && qmd collection add . --name <name>)" >&2
       fi
       echo "start: refreshing recall index (qmd update)..." >&2
       qmd update >/dev/null 2>&1 || echo "start: qmd update failed; recall will use the last index" >&2
       # Embeddings feed the semantic (vec) channel. Incremental runs are seconds,
       # but never block the meeting on it: background it and let vec sharpen as
       # it lands. Until then vec quietly serves the previous vectors.
       nohup qmd embed >/tmp/copilot-qmd-embed.log 2>&1 &
     fi ;;
esac

cleanup() {
  trap - INT TERM     # a second Ctrl-C shouldn't re-enter this
  echo "" >&2
  echo "start: stopping (flushing digest)..." >&2
  # Capture and panel can stop immediately.
  pkill -x meetingtap 2>/dev/null
  pkill -x screentap 2>/dev/null
  pkill -x CardPanel 2>/dev/null
  # live.mjs writes the digest + staging on SIGINT — its final extraction is a
  # model call that can take several seconds, so WAIT for it to exit on its own
  # (up to ~15s) rather than cutting it off. Only hard-kill if it hangs.
  if [ -n "${LIVE_PID:-}" ]; then
    kill -INT "$LIVE_PID" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$LIVE_PID" 2>/dev/null || break; sleep 0.5; done
    kill "$LIVE_PID" 2>/dev/null
  fi
  echo "start: stopped. digest -> ~/.meeting-copilot/current/digest.md" >&2
  exit 0
}
trap cleanup INT TERM

# 1) capture: mic + system audio -> transcript.jsonl; screen OCR -> screen.jsonl
"$DIR/run.sh" ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} >/tmp/copilot-capture.log 2>&1 &
# wait for the transcript symlink to appear
for _ in $(seq 1 20); do [ -e "${HOME}/.meeting-copilot/current/transcript.jsonl" ] && break; sleep 0.25; done

# 2) brain + panel server on :8787
node "$DIR/brain/live.mjs" --prep "$PREP" ${PASS[@]+"${PASS[@]}"} &
LIVE_PID=$!
# wait for the server to answer
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:8787/" && break; sleep 0.25; done

# 3) the floating panel (top-right; drag the top strip to move it)
"$DIR/panel/CardPanel" "http://127.0.0.1:8787" >/tmp/copilot-panel.log 2>&1 &

echo "start: running. Panel is top-right. Ctrl-C here to stop and get the digest." >&2
# A sleep-loop is reliably interrupted by the INT trap on every bash; `wait` is
# not, in some non-interactive contexts.
while kill -0 "$LIVE_PID" 2>/dev/null; do sleep 1; done
