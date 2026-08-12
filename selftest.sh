#!/bin/bash
# End-to-end proof without a meeting: transcribe on-device for ~12 s while a known
# phrase plays through the speakers, then verify it landed on the "them" (system
# audio) channel — proving the Core Audio tap, not just the mic. No API key.
#
# Launches meetingtap.app via `open` so the system-audio tap runs under the app's
# own identity (io.meetingcopilot.meetingtap) and its System Audio Recording grant.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/capture/meetingtap.app"
OUT="${HOME}/.meeting-copilot/selftest.jsonl"
rm -f "$OUT"; mkdir -p "$(dirname "$OUT")"

open -n "$APP" --args --sys-only --duration 12 --out "$OUT"
echo "selftest: playing test phrase through speakers..." >&2
sleep 2
say "the quick brown fox jumps over the lazy dog"
say "meeting copilot self test complete"
sleep 6

# The app flushes the transcript when it exits at --duration; polling instead
# of racing it keeps the printout below from showing an empty file on a pass.
for _ in 1 2 3 4 5 6 7 8; do
  grep -qi "brown fox" "$OUT" 2>/dev/null && break
  sleep 1
done

echo "selftest: transcript contents:" >&2
cat "$OUT" 2>/dev/null >&2
if grep -qi "brown fox" "$OUT" 2>/dev/null; then
  echo "selftest: PASS (phrase transcribed from the system-audio tap)" >&2
  exit 0
else
  echo "selftest: FAIL — no system audio captured." >&2
  echo "Enable 'meetingtap' under System Settings > Privacy & Security >" >&2
  echo "System Audio Recording (and Microphone), then re-run. If it is not" >&2
  echo "listed, launch it once: open '$APP'" >&2
  exit 1
fi
