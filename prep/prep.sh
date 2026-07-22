#!/bin/bash
# prep.sh — the Meeting-prep journey: pick a meeting, build + view prep packs.
#
#   prep.sh [list]              upcoming meetings, numbered (needs the gws CLI)
#   prep.sh <n> [--refresh]     build the pack for meeting n (-> ~/.meeting-copilot/prep/);
#                               --refresh syncs the last day from integrations first
#   prep.sh --all               build packs for EVERY upcoming meeting (skips existing)
#   prep.sh --pick              no-gws fallback: interactive pack --next, then archive
#   prep.sh show [name]         view the newest pack, or one matched by name
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

freshness_note() {
  # A card grounded in stale knowledge looks confident anyway — say the age
  # out loud at prep time, when there is still time to refresh.
  if [ -z "${KNOWLEDGE_SYNCED_AT:-}" ]; then
    echo "prep: knowledge freshness UNKNOWN — never synced. Refresh: copilot prep <n> --refresh (or knowledge.sh sync)" >&2
    return
  fi
  local then now days
  then="$(date -ju -f "%Y-%m-%dT%H:%M:%SZ" "$KNOWLEDGE_SYNCED_AT" +%s 2>/dev/null || true)"
  [ -n "$then" ] || return 0
  now="$(date -u +%s)"
  days=$(( (now - then) / 86400 ))
  if [ "$days" -gt 7 ]; then
    echo "prep: WARNING — knowledge last synced ${days} days ago; cards will cite ${days}-day-old facts. Refresh: copilot prep <n> --refresh" >&2
  else
    echo "prep: knowledge last synced ${days} day(s) ago" >&2
  fi
}

merge_hint() {
  # Raw meeting signals that never got consolidated are memory the copilot
  # holds but cannot cite as truth. Nudge when any are waiting.
  local kdir="${KNOWLEDGE_DIR:-}" n=0 f
  [ -n "$kdir" ] && [ -d "$kdir" ] || return 0
  while IFS= read -r f; do
    grep -qF "_merged:" "$f" || n=$((n+1))
  done < <(grep -rlF "Meeting Copilot — Raw Signals" \
             "$kdir/meetings" "$kdir/people/_staging" "$kdir/projects/_staging" 2>/dev/null || true)
  [ "$n" -gt 0 ] &&
    echo "prep: ${n} file(s) of raw meeting signals not yet merged into truth records — run: knowledge.sh merge" >&2
  return 0
}

SUB="${1:-list}"
case "$SUB" in
  list)
    freshness_note; merge_hint
    fetch_events | node "$ROOT/cli/events.mjs" list
    ;;
  --all)
    # Prep every upcoming meeting in the lookahead window — used by onboarding
    # to prep ahead on the user's behalf; re-runs skip already-built packs.
    freshness_note; merge_hint
    EVENTS="$(fetch_events)"
    N="$(node "$ROOT/cli/events.mjs" count <<<"$EVENTS")"
    mkdir -p "$PREP_DIR"
    BUILT=0
    for i in $(seq 1 "$N"); do
      STEM="$(node "$ROOT/cli/events.mjs" stem "$i" <<<"$EVENTS")"
      OUT="$PREP_DIR/$STEM.md"
      if [ -s "$OUT" ]; then echo "prep: $STEM — already packed, skipping" >&2; continue; fi
      echo "prep: building pack $i/$N — $STEM" >&2
      if node "$ROOT/cli/events.mjs" json "$i" <<<"$EVENTS" |
           "$ROOT/portable/knowledge.sh" pack --paste --out "$OUT"; then
        BUILT=$((BUILT+1))
      else
        echo "prep: pack for $STEM FAILED — continuing with the rest" >&2
      fi
    done
    # Write-through the NEXT meeting's pack so plain ./start.sh finds it.
    FIRST="$(node "$ROOT/cli/events.mjs" stem 1 <<<"$EVENTS")"
    if [ -s "$PREP_DIR/$FIRST.md" ]; then cp "$PREP_DIR/$FIRST.md" "$LEGACY_PACK"; fi
    echo "prep: $BUILT pack(s) built, $((N - BUILT)) skipped/failed; copilot live picks by start time" >&2
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
    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1
    ;;
  *)
    # A pack is a snapshot: --refresh pulls the last day from integrations
    # first (interactive — tools need approval), so a 9am prep for a 4pm
    # meeting can pick up the morning's email before it freezes.
    if [ "${2:-}" = "--refresh" ]; then
      echo "prep: refreshing knowledge (last 1 day) before building the pack..." >&2
      "$ROOT/portable/knowledge.sh" sync 1
      # Re-read the stamp sync just wrote so the note below tells the truth.
      # shellcheck disable=SC1090
      source "$CONF"
    fi
    freshness_note; merge_hint
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
