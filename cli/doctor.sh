#!/bin/bash
# doctor.sh — one read-only health sweep of everything the copilot needs.
# No model calls, no writes, ~2s. `copilot doctor` before a meeting beats
# discovering a dead dependency during one.
set -uo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
FAIL=0
ok()   { printf 'ok    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAIL=1; }

# OS + required deps
OSVER="$(sw_vers -productVersion 2>/dev/null || echo 0)"
[ "${OSVER%%.*}" -ge 26 ] 2>/dev/null && ok "macOS $OSVER" || bad "macOS $OSVER — 26+ required (on-device transcriber)"
command -v node   >/dev/null 2>&1 && ok "node $(node -v)" || bad "node missing (brew install node)"
command -v claude >/dev/null 2>&1 && ok "claude CLI" || bad "claude CLI missing — the brain runs on it (https://claude.com/claude-code)"
command -v swiftc >/dev/null 2>&1 && ok "swiftc" || bad "swiftc missing (xcode-select --install)"
# Optional deps
command -v qmd >/dev/null 2>&1 && ok "qmd (live recall)" || warn "qmd missing — live recall off (optional; https://github.com/tobi/qmd)"
command -v gws >/dev/null 2>&1 && ok "gws (calendar picker)" || warn "gws missing — prep uses --pick/--paste instead of the meeting list"

# Build products + signing
[ -x "$ROOT/capture/meetingtap" ] && [ -x "$ROOT/capture/screentap" ] && ok "capture binaries built" || bad "capture binaries missing — run ./setup.sh"
[ -d "$ROOT/capture/meetingtap.app" ] && ok "app bundles present" || bad "app bundles missing — run ./setup.sh"
security find-identity -v -p codesigning 2>/dev/null | grep -qE "meeting-copilot-dev|jarvis-dev" \
  && ok "signing cert (permissions survive rebuilds)" || warn "no signing cert — permissions re-prompt after every rebuild"
[ -x "$ROOT/panel/CardPanel" ] && ok "panel binary built" || warn "panel binary missing — start.sh builds it on first run"

# Config + knowledge
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  source "$CONF"
  [ -n "${USER_NAME:-}" ] && [ -n "${ORG_DOMAIN:-}" ] && ok "config: $USER_NAME @ $ORG_DOMAIN" || bad "config incomplete — run: copilot onboard knowledge"
  KDIR="${KNOWLEDGE_DIR:-$HOME/.meeting-copilot/knowledge}"
  if [ -d "$KDIR" ]; then
    NFACTS="$(find "$KDIR" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
    [ "$NFACTS" -gt 0 ] && ok "knowledge dir: $NFACTS md file(s) at $KDIR" || warn "knowledge dir empty — cards need held facts (copilot onboard knowledge)"
  else
    bad "knowledge dir missing: $KDIR"
  fi
  if [ -n "${KNOWLEDGE_SYNCED_AT:-}" ]; then
    THEN="$(date -ju -f "%Y-%m-%dT%H:%M:%SZ" "$KNOWLEDGE_SYNCED_AT" +%s 2>/dev/null || echo 0)"
    DAYS=$(( ($(date -u +%s) - THEN) / 86400 ))
    [ "$DAYS" -le 7 ] && ok "knowledge synced ${DAYS}d ago" || warn "knowledge synced ${DAYS}d ago — refresh: copilot prep <n> --refresh"
  else
    warn "never synced — cards cite only what's on file"
  fi
  # recall index coverage (mirrors the start.sh check, read-only)
  if command -v qmd >/dev/null 2>&1 && [ -d "${KDIR:-}" ]; then
    covered=0
    for c in $(qmd collection list 2>/dev/null | sed -n 's/^\([^ ]*\) (qmd:\/\/.*/\1/p'); do
      cpath="$(qmd collection show "$c" 2>/dev/null | sed -n 's/^ *Path: *//p')"
      case "$cpath" in "$KDIR"|"$KDIR"/*) covered=1; break ;; esac
    done
    [ "$covered" = 1 ] && ok "qmd indexes the knowledge dir" || warn "knowledge dir not qmd-registered — recall will find nothing (start.sh registers it)"
  fi
else
  bad "no config — run: copilot onboard  (or ./portable/knowledge.sh init)"
fi

# Prep + runtime
NPACKS="$(ls "$PREP_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')"
if [ "$NPACKS" -gt 0 ]; then
  if MATCH="$(node "$ROOT/cli/events.mjs" match "$PREP_DIR" "${PREP_LOOKAHEAD_H:-12}" 2>/dev/null)"; then
    ok "$NPACKS pack(s); next up: $(basename "$MATCH")"
  else
    warn "$NPACKS pack(s), none in the current window — copilot prep list"
  fi
else
  warn "no prep packs yet — copilot prep list"
fi
lsof -ti:8787 >/dev/null 2>&1 && warn "port 8787 in use — a copilot may already be running (start.sh clears it)" || ok "port 8787 free"
[ -f "$HOME/.meeting-copilot/feedback-history.jsonl" ] \
  && ok "feedback history: $(wc -l < "$HOME/.meeting-copilot/feedback-history.jsonl" | tr -d ' ') vote(s) shaping the bar" \
  || ok "feedback history: empty (bar unshaped)"
echo ""
echo "note: mic/system-audio/screen permissions can't be read from here — ./selftest.sh proves the audio tap live."
[ "$FAIL" = 0 ] && echo "DOCTOR: healthy (warnings above, if any, degrade features — they don't block)" || echo "DOCTOR: FAILURES above block the copilot"
exit "$FAIL"
