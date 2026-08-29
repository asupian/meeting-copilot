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

# Which CLI is the brain: claude (default) or codex. Mirrors lib.mjs provider
# resolution (COPILOT_PROVIDER env > MODEL_PROVIDER in config > claude); the
# config is RE-READ because it may be written after common.sh sourced it.
brain_bin() {
  local p
  p="${COPILOT_PROVIDER:-$(sed -n 's/^MODEL_PROVIDER="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$CONF" 2>/dev/null | tail -1)}"
  echo "${p:-claude}"
}

knowledge_state() { # -> ok | no-brain | no-config | no-knowledge-dir | empty-knowledge
  # Is there actually something for the copilot to cite? A config file is not a
  # knowledge base and an installed binary is not a brain, but onboarding used
  # to treat both as "done" and sign off MEETING-READY regardless. Kept here so
  # it is one testable answer rather than three ad-hoc checks that drift apart.
  # The brain is whichever provider is configured — with MODEL_PROVIDER=codex,
  # claude is not required at all (knowledge + prep + live all run on codex).
  command -v "$(brain_bin)" >/dev/null 2>&1 || { echo no-brain; return; }
  [ -f "$CONF" ] || { echo no-config; return; }
  # $CONF may have been written after common.sh sourced it (the wizard runs
  # mid-onboard), so re-read rather than trusting the startup snapshot.
  local kdir
  kdir="$(sed -n 's/^KNOWLEDGE_DIR="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$CONF" | tail -1)"
  [ -n "$kdir" ] && [ -d "$kdir" ] || { echo no-knowledge-dir; return; }
  [ -n "$(find "$kdir" -name '*.md' 2>/dev/null | head -1)" ] || { echo empty-knowledge; return; }
  echo ok
}

find_pack() { # find_pack <name> — exactly one per-meeting pack matching <name>, else fail loudly
  local matches count
  matches="$(find "$PREP_DIR" -maxdepth 1 -name '*.md' 2>/dev/null | grep -i -- "$1" || true)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$count" -eq 1 ]; then printf '%s\n' "$matches"; return 0; fi
  if [ "$count" -eq 0 ]; then echo "no pack matching '$1' in $PREP_DIR" >&2
  else echo "multiple packs match '$1':" >&2; printf '%s\n' "$matches" >&2; fi
  return 1
}
