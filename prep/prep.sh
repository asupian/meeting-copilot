#!/bin/bash
# prep.sh — the Meeting-prep journey: pick a meeting, build + view prep packs.
#
#   prep.sh [list]         upcoming meetings, numbered (needs the gws CLI)
#   prep.sh <n>            build the pack for meeting n -> ~/.meeting-copilot/prep/
#   prep.sh --pick         no-gws fallback: interactive pack --next, then archive
#   prep.sh show [name]    view the newest pack, or one matched by name
#
# Thin by design: the engines are portable/knowledge.sh (events + pack) and
# cli/events.mjs (list, stems, JSON). Packs are stored per meeting as
# <date>[-HHMM]-<slug>.md; every build also refreshes the legacy single
# prep-pack.md so plain ./start.sh keeps working.
set -euo pipefail
# shellcheck source=../cli/common.sh
source "$(cd "$(dirname "$0")" && pwd)/../cli/common.sh"

fetch_events() { # events JSON for the lookahead window, or exit with the fallback hint
  "$ROOT/portable/knowledge.sh" events "$LOOKAHEAD" || {
    echo "prep: interactive fallback: copilot prep --pick" >&2
    exit 1
  }
}

SUB="${1:-list}"
case "$SUB" in
  list)
    fetch_events | node "$ROOT/cli/events.mjs" list
    ;;
  --pick)
    # No-gws path: the existing interactive pack builder, then archive the
    # result into the per-meeting store (date-only stem — no start time known).
    "$ROOT/portable/knowledge.sh" pack --next
    if STEM="$(node "$ROOT/cli/events.mjs" pack-stem < "$LEGACY_PACK" 2>/dev/null)"; then
      mkdir -p "$PREP_DIR"
      cp "$LEGACY_PACK" "$PREP_DIR/$STEM.md"
      echo "prep: archived -> $PREP_DIR/$STEM.md" >&2
    fi
    ;;
  show)
    shift
    NAME="${1:-}"
    if [ -n "$NAME" ]; then
      PACK="$(find_pack "$NAME")" || exit 1
    else
      PACK="$(ls -t "$PREP_DIR"/*.md 2>/dev/null | head -1 || true)"
      [ -n "$PACK" ] || PACK="$LEGACY_PACK"
      [ -s "$PACK" ] || { echo "prep: no packs yet — start with: copilot prep list" >&2; exit 1; }
    fi
    echo "== $PACK" >&2
    cat "$PACK"
    ;;
  ''|*[!0-9]*)
    sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1
    ;;
  *)
    EVENTS="$(fetch_events)"
    STEM="$(node "$ROOT/cli/events.mjs" stem "$SUB" <<<"$EVENTS")"
    OUT="$PREP_DIR/$STEM.md"
    mkdir -p "$PREP_DIR"
    node "$ROOT/cli/events.mjs" json "$SUB" <<<"$EVENTS" |
      "$ROOT/portable/knowledge.sh" pack --paste --out "$OUT"
    cp "$OUT" "$LEGACY_PACK"   # write-through: plain ./start.sh finds the latest pack
    echo "prep: pack -> $OUT (and $LEGACY_PACK)" >&2
    ;;
esac
