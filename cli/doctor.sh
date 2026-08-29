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
# The configured brain provider decides which CLI is REQUIRED (bad) versus
# merely useful (warn). With MODEL_PROVIDER=codex everything — knowledge,
# prep, live — runs on codex, so a missing claude no longer blocks.
BRAIN="$(brain_bin)"
if command -v claude >/dev/null 2>&1; then
  # `claude auth status` is free (no model call, ~0.2s) and catches the worst
  # first-run trap: binary present, login missing — which otherwise surfaces
  # much later as a silent brain / "no cards emitted".
  AUTHJ="$(claude auth status 2>/dev/null || true)"
  case "$AUTHJ" in
    *'"loggedIn": true'*)  ok "claude CLI (logged in)" ;;
    *'"loggedIn": false'*) [ "$BRAIN" = claude ] && bad "claude CLI not logged in — run: claude auth login" \
                             || warn "claude CLI not logged in (fine: brain provider is $BRAIN)" ;;
    *)                     ok "claude CLI (login state unknown — CLI predates 'auth status')" ;;
  esac
  # --probe: one real model call (~2-5s), on the PROVIDER THE BRAIN USES.
  # Local auth-status reads keep saying logged-in after the refresh token dies
  # server-side — a state where every brain call fails (seen 2026-08-11). Only
  # a live call proves the brain will answer, so onboarding and the replay
  # gate run this; the plain sweep stays model-free.  macOS ships no
  # timeout(1): watchdog.
  if [ "${1:-}" = "--probe" ] && [ "$BRAIN" = claude ]; then
    PROBE_OUT="$(mktemp)"
    claude -p "Reply with exactly: OK" --model claude-haiku-4-5-20251001 >"$PROBE_OUT" 2>&1 &
    PROBE_PID=$!
    ( sleep 30; kill "$PROBE_PID" 2>/dev/null ) & WATCHDOG=$!
    wait "$PROBE_PID" 2>/dev/null; PROBE_RC=$?
    kill "$WATCHDOG" 2>/dev/null; wait "$WATCHDOG" 2>/dev/null
    if [ "$PROBE_RC" = 0 ] && grep -q "OK" "$PROBE_OUT"; then
      ok "claude live probe (a real call round-tripped)"
    else
      bad "claude live probe FAILED — $(head -1 "$PROBE_OUT" 2>/dev/null | cut -c1-120)${PROBE_RC:+ (exit $PROBE_RC)} — try: claude auth login"
    fi
    rm -f "$PROBE_OUT"
  fi
else
  [ "$BRAIN" = claude ] && bad "claude CLI missing — the brain runs on it (https://claude.com/claude-code)" \
    || warn "claude CLI missing (fine: MODEL_PROVIDER=$BRAIN runs everything on $BRAIN)"
fi
if [ "$BRAIN" = "codex" ]; then
  if ! command -v codex >/dev/null 2>&1; then
    bad "MODEL_PROVIDER=codex but codex CLI missing — install it, or: copilot config set MODEL_PROVIDER claude"
  else
    # `codex login status` reads local state, same trap as `claude auth status`:
    # it can say logged-in after the token dies server-side. --probe below is
    # the only proof a live call answers.
    case "$(codex login status 2>&1)" in
      *"Logged in"*) ok "codex CLI (logged in) — live brain provider" ;;
      *)             bad "codex CLI not logged in — run: codex login" ;;
    esac
    if [ "${1:-}" = "--probe" ]; then
      PROBE_OUT="$(mktemp)"
      codex exec "Reply with exactly: OK" --ephemeral --skip-git-repo-check --ignore-user-config \
        -s read-only -C /tmp --color never >"$PROBE_OUT" 2>&1 &
      PROBE_PID=$!
      ( sleep 30; kill "$PROBE_PID" 2>/dev/null ) & WATCHDOG=$!
      wait "$PROBE_PID" 2>/dev/null; PROBE_RC=$?
      kill "$WATCHDOG" 2>/dev/null; wait "$WATCHDOG" 2>/dev/null
      if [ "$PROBE_RC" = 0 ] && grep -q "OK" "$PROBE_OUT"; then
        ok "codex live probe (a real call round-tripped)"
      else
        bad "codex live probe FAILED — $(tail -1 "$PROBE_OUT" 2>/dev/null | cut -c1-120)${PROBE_RC:+ (exit $PROBE_RC)} — try: codex login"
      fi
      rm -f "$PROBE_OUT"
    fi
  fi
fi
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
  if [ -n "${USER_NAME:-}" ] && [ -n "${ORG_DOMAIN:-}" ]; then
    case "$ORG_DOMAIN" in
      *noreply*) warn "config: ORG_DOMAIN is '$ORG_DOMAIN' — a noreply address, so every attendee counts as external. Fix: copilot config set ORG_DOMAIN <your-org.com>" ;;
      *)         ok "config: $USER_NAME @ $ORG_DOMAIN" ;;
    esac
  else
    bad "config incomplete — run: copilot onboard knowledge"
  fi
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
