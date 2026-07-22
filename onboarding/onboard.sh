#!/bin/bash
# onboard.sh — the Onboarding journey: install, build knowledge, try a replay.
#
#   onboard.sh                 one-time install (setup.sh: build, cert, permissions)
#   onboard.sh knowledge       guided intake wizard (interactive claude)
#   onboard.sh import <dir>    distill an existing notes folder (Obsidian, Notion export...)
#   onboard.sh demo            replay a committed fixture — no permissions, no mic
#
# Thin by design: the engines are setup.sh, portable/knowledge.sh and
# brain/brain-loop.mjs. This script only names the journey.
set -euo pipefail
# shellcheck source=../cli/common.sh
source "$(cd "$(dirname "$0")" && pwd)/../cli/common.sh"

case "${1:-}" in
  "")
    "$ROOT/setup.sh"
    echo "" >&2
    echo "next: copilot onboard knowledge     build what the copilot knows (guided wizard)" >&2
    echo "      copilot onboard import <dir>  or distill an existing notes folder (Obsidian, Notion export...)" >&2
    echo "      copilot onboard demo          watch a replay first — no permissions, no mic" >&2
    ;;
  knowledge) "$ROOT/portable/knowledge.sh" setup ;;
  import)    shift; "$ROOT/portable/knowledge.sh" import "$@" ;;
  demo)
    echo "demo: replaying a committed vendor-call fixture through the real brain." >&2
    echo "demo: expect ONE card ~30-60s in, citing the \$42,500 SOW — then silence. That IS the product." >&2
    node "$ROOT/brain/brain-loop.mjs" \
      --replay "$ROOT/test/fixtures/rivertech/fixture.jsonl" \
      --prep   "$ROOT/test/fixtures/rivertech/prep-pack.md" \
      --title  "Vendor Sync"
    ;;
  *) sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
