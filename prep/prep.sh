#!/bin/bash
# prep.sh — the Meeting-prep journey: pick a meeting, build + view prep packs.
#
#   prep.sh [list]              upcoming meetings, numbered (needs the gws CLI)
#   prep.sh <n> [--refresh]     build the pack for meeting n (-> ~/.meeting-copilot/prep/);
#                               --refresh syncs the last day from integrations first
#   prep.sh --all               build packs for EVERY upcoming meeting (skips existing)
#   prep.sh --text ["..."]      NO CALENDAR NEEDED: describe the meeting in your own
#                               words. Any wording works — a title alone is enough.
#                               Args, a pipe, or a prompt if you give neither.
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
    # Lead with the no-calendar path. --pick opens an interactive claude session
    # and was the only thing named here, which sent every gws-less user down the
    # heaviest road for what is usually "I just want to type the meeting in".
    echo "prep: no calendar. Type the meeting instead:  copilot prep --text \"1:1 with Dana — renewal pricing\"" >&2
    echo "prep: (or pick it interactively:  copilot prep --pick)" >&2
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

archive_pack() { # $1 = fallback title text (may be empty) — copy LEGACY_PACK into the per-meeting store
  # The stem normally comes from the pack's own "# Prep Pack — <title> — <date>"
  # header. That used to be the ONLY way in, with stderr thrown away, so a pack
  # whose header came out any other way was silently never archived — the user
  # saw "pack: wrote ..." and then found nothing under `prep show`. Fall back to
  # a slug instead of dropping it on the floor.
  local stem
  [ -s "$LEGACY_PACK" ] || { echo "prep: no pack was written — nothing to archive" >&2; return 1; }
  if ! stem="$(node "$ROOT/cli/events.mjs" pack-stem < "$LEGACY_PACK" 2>/dev/null)"; then
    local slug
    slug="$(printf '%s' "${1:-meeting}" | head -1 | tr '[:upper:]' '[:lower:]' \
            | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-40)"
    [ -n "$slug" ] || slug="meeting"
    stem="$(date +%Y-%m-%d)-$slug"
    echo "prep: pack has no '# Prep Pack — <title> — <date>' header; archiving as $stem" >&2
  fi
  mkdir -p "$PREP_DIR"
  cp "$LEGACY_PACK" "$PREP_DIR/$stem.md"
  echo "prep: archived -> $PREP_DIR/$stem.md" >&2
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
  --text|--paste|--describe)
    # No calendar, no format. The pack builder has always accepted a free-text
    # meeting description (knowledge.sh pack --paste), but the only ways in were
    # a calendar-shaped JSON pipe or an interactive claude session, so a user
    # without gws hit "it required a specific format". This is the plain door:
    # say what the meeting is however you like and a pack comes out.
    shift
    freshness_note; merge_hint
    if [ "$#" -gt 0 ]; then
      TEXT="$*"                       # copilot prep --text "1:1 with Dana" "renewal, pricing"
    elif [ ! -t 0 ]; then
      TEXT="$(cat)"                   # piped or heredoc'd
    else
      # Interactive: multi-line, ended with Ctrl-D. Deliberately says "any
      # wording" — the old prompt listed "title, time, attendees+emails" and
      # read like a required schema when it never was one.
      echo "Describe the meeting in your own words — any wording, a title alone is fine." >&2
      echo "(Useful if you have it: who's in it, what it's about. Ctrl-D when done.)" >&2
      TEXT="$(cat)"
    fi
    [ -n "${TEXT//[[:space:]]/}" ] || { echo "prep: nothing to go on — give a title at least" >&2; exit 1; }
    mkdir -p "$PREP_DIR"
    printf '%s\n' "$TEXT" | "$ROOT/portable/knowledge.sh" pack --paste --out "$LEGACY_PACK"
    archive_pack "$TEXT"
    ;;
  --pick)
    # No-gws path: the existing interactive pack builder, then archive the
    # result into the per-meeting store (date-only stem — no start time known).
    "$ROOT/portable/knowledge.sh" pack --next
    archive_pack ""
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
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1
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
