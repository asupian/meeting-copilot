# common.sh — shared plumbing for the journey scripts (sourced, not run).
# Resolves the repo root, loads ~/.meeting-copilot/config, and provides the
# pack-store helpers used by both prep and live.
# shellcheck shell=bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${HOME}/.meeting-copilot/config"
PREP_DIR="${HOME}/.meeting-copilot/prep"
LEGACY_PACK="${HOME}/.meeting-copilot/prep-pack.md"
# shellcheck disable=SC1090
[ -f "$CONF" ] && source "$CONF"
export ORG_DOMAIN="${ORG_DOMAIN:-}"   # cli/events.mjs uses it to flag external meetings
LOOKAHEAD="${PREP_LOOKAHEAD_H:-12}"

find_pack() { # find_pack <name> — exactly one per-meeting pack matching <name>, else fail loudly
  local matches count
  matches="$(find "$PREP_DIR" -maxdepth 1 -name '*.md' 2>/dev/null | grep -i -- "$1" || true)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$count" -eq 1 ]; then printf '%s\n' "$matches"; return 0; fi
  if [ "$count" -eq 0 ]; then echo "no pack matching '$1' in $PREP_DIR" >&2
  else echo "multiple packs match '$1':" >&2; printf '%s\n' "$matches" >&2; fi
  return 1
}
