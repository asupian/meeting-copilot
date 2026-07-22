#!/bin/bash
# knowledge.sh — build and maintain the copilot's knowledge directory.
#
#   knowledge.sh setup                     guided intake wizard (interactive claude)
#   knowledge.sh init                      bare config + empty knowledge dir, no wizard
#   knowledge.sh import <source-dir>       distill an existing notes folder (headless)
#   knowledge.sh sync [days]               extract from integrations (interactive claude)
#   knowledge.sh pack [--next | --person "<name>" | --paste] [--out <file>]
#   knowledge.sh merge                     consolidate meeting raw signals into truth records (headless)
#   knowledge.sh events [hours]            upcoming calendar events JSON (needs the gws CLI)
#
# Execution modes, and why:
#   - import + pack(--person/--paste) run `claude -p` HEADLESS with file tools
#     only. Headless agents can't reliably reach MCP integrations (server names
#     differ per session), so anything needing only files runs unattended.
#   - pack(--next) runs HEADLESS too when the `gws` CLI is installed: the
#     script fetches the next 12h of calendar events itself and embeds them
#     in the prompt. Without gws it falls back to an interactive session.
#   - sync (and pack --next without gws) launch `claude` INTERACTIVELY: they
#     need your connected integrations (calendar, email, meeting notes, docs)
#     and you approve each tool the first time it's used.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="${HOME}/.meeting-copilot/config"

usage() { sed -n '3,11p' "$0"; exit 1; }

set_conf() { # set_conf KEY VALUE — replace-or-append a KEY="VALUE" line in the config
  local tmp="${CONF}.tmp.$$"
  touch "$CONF"
  awk -v k="$1" -v v="$2" '
    $0 ~ "^" k "=" { print k "=\"" v "\""; done = 1; next }
    { print }
    END { if (!done) print k "=\"" v "\"" }
  ' "$CONF" > "$tmp" && mv "$tmp" "$CONF"
}
[ $# -ge 1 ] || usage
CMD="$1"; shift

# Live recall searches the knowledge dir through qmd, whose index is GLOBAL:
# a folder is only searchable after it is registered as a collection. Without
# this, recall silently finds nothing.
register_recall() { # register_recall <dir>
  local dir="$1" n
  command -v qmd >/dev/null 2>&1 || {
    echo "note: qmd not installed — live recall stays off (https://github.com/tobi/qmd)" >&2
    return 0
  }
  for n in $(qmd collection list 2>/dev/null | sed -n 's/^\([^ ]*\) (qmd:\/\/.*/\1/p'); do
    [ "$(qmd collection show "$n" 2>/dev/null | sed -n 's/^ *Path: *//p')" = "$dir" ] && return 0
  done
  if (cd "$dir" && qmd collection add . --name knowledge >/dev/null 2>&1); then
    echo "recall: registered ${dir} as qmd collection 'knowledge'" >&2
    qmd embed >/dev/null 2>&1 || true
  else
    echo "recall: could not register ${dir} with qmd (name 'knowledge' taken?)." >&2
    echo "recall: register manually: (cd ${dir} && qmd collection add . --name <name> && qmd embed)" >&2
  fi
}

# Calendar fetch via the local gws CLI — headless-safe (no MCP involved).
# Prints the primary calendar's events JSON for the coming <hours>; fails
# (nonzero, no output) when gws is absent, unauthed, or holds no events.
gws_events() { # gws_events <hours>
  command -v gws >/dev/null 2>&1 || return 1
  local now later events
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  later="$(date -u -v+"$1"H +%Y-%m-%dT%H:%M:%SZ)"
  events="$(gws calendar events list --params "{\"calendarId\":\"primary\",\"timeMin\":\"$now\",\"timeMax\":\"$later\",\"singleEvents\":true,\"orderBy\":\"startTime\",\"maxResults\":10,\"fields\":\"items(summary,start,end,attendees(email,displayName,responseStatus,self),eventType,organizer(email))\"}" --format json 2>/dev/null)" || return 1
  printf '%s' "$events" | grep -q '"summary"' || return 1
  printf '%s' "$events"
}

if [ "$CMD" = "setup" ]; then
  # The wizard collects config itself, so it must run WITHOUT the config gate
  # below. Placeholders are filled inline here (fill() needs a sourced config).
  KDIR="${HOME}/.meeting-copilot/knowledge"
  # shellcheck disable=SC1090
  [ -f "$CONF" ] && source "$CONF" && KDIR="${KNOWLEDGE_DIR:-$KDIR}"
  mkdir -p "$KDIR"/{people,initiatives,meetings,notes}
  register_recall "$KDIR"
  SPEC="${HOME}/.meeting-copilot/KNOWLEDGE.md"
  cp -n "$DIR/KNOWLEDGE.md" "$SPEC" 2>/dev/null || true
  PROMPT="$(sed -e "s|{{CONFIG_PATH}}|${CONF}|g" \
                -e "s|{{KNOWLEDGE_DIR}}|${KDIR}|g" \
                -e "s|{{SPEC_PATH}}|${SPEC}|g" \
                -e "s|{{PROMPTS_DIR}}|${DIR}/prompts|g" \
                "$DIR/prompts/setup-wizard.md")"
  echo "setup: opening an interactive claude session — the wizard interviews you (~10-15 min)," >&2
  echo "setup: checks which integrations are connected, and builds ${KDIR}." >&2
  exec claude "$PROMPT"
fi

if [ "$CMD" = "init" ]; then
  mkdir -p "${HOME}/.meeting-copilot/knowledge"/{people,initiatives,meetings,notes}
  if [ ! -f "$CONF" ]; then
    printf 'What is your name (as attendees would say it)? ' ; read -r NAME
    printf 'Your organization email domain (e.g. acme.com; attendees outside it count as external)? ' ; read -r DOMAIN
    cat > "$CONF" <<EOF
USER_NAME="${NAME}"
ORG_DOMAIN="${DOMAIN}"
KNOWLEDGE_DIR="${HOME}/.meeting-copilot/knowledge"
EOF
  fi
  cp -n "$DIR/KNOWLEDGE.md" "${HOME}/.meeting-copilot/KNOWLEDGE.md" 2>/dev/null || true
  # shellcheck disable=SC1090
  source "$CONF"
  register_recall "$KNOWLEDGE_DIR"
  echo "knowledge dir ready: ${KNOWLEDGE_DIR}"
  echo "next: knowledge.sh import <your-notes-dir>  and/or  knowledge.sh sync"
  exit 0
fi

[ -f "$CONF" ] || { echo "no config at $CONF — run: knowledge.sh init" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${USER_NAME:?USER_NAME missing from $CONF}"
: "${ORG_DOMAIN:?ORG_DOMAIN missing from $CONF}"
: "${KNOWLEDGE_DIR:?KNOWLEDGE_DIR missing from $CONF}"
mkdir -p "$KNOWLEDGE_DIR"

# Fill {{PLACEHOLDERS}} in a prompt template. Pure-bash replacement on
# purpose: values may span lines (pasted meetings, embedded calendar JSON),
# which sed's substitute command cannot carry.
fill() { # fill <template> KEY=VALUE...
  local text kv k v
  text="$(cat "$1")"; shift
  for kv in "USER_NAME=$USER_NAME" "ORG_DOMAIN=$ORG_DOMAIN" "KNOWLEDGE_DIR=$KNOWLEDGE_DIR" "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    text="${text//"{{$k}}"/$v}"
  done
  printf '%s' "$text"
}

headless() { # headless <prompt> — file tools only, verified by caller
  claude -p "$1" --allowedTools Read Grep Glob Write Edit --output-format json |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      if(!s.trim()){process.stderr.write("claude -p produced no output (auth? rate limit?)\n");process.exit(1);}
      try{const j=JSON.parse(s);process.stderr.write((j.result||"").trim()+"\n");process.exit(j.is_error?1:0);}
      catch{process.stderr.write("could not parse claude output\n");process.exit(1);}});'
}

case "$CMD" in
  import)
    SRC="${1:?usage: knowledge.sh import <source-dir>}"
    SRC="$(cd "$SRC" && pwd)"
    echo "import: distilling ${SRC} -> ${KNOWLEDGE_DIR}" >&2
    headless "$(fill "$DIR/prompts/import-knowledge.md" "SOURCE=$SRC")"
    ;;
  sync)
    DAYS="${1:-7}"
    echo "sync: opening an interactive claude session (integrations need per-tool approval)." >&2
    echo "sync: it will extract from the last ${DAYS} days into ${KNOWLEDGE_DIR}." >&2
    claude "$(fill "$DIR/prompts/sync-knowledge.md" "LOOKBACK_DAYS=$DAYS")"
    # Stamp freshness so prep/live can say how old the knowledge is. The
    # session already ended, so this marks "last attempted+finished sync".
    set_conf KNOWLEDGE_SYNCED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
  merge)
    # Consolidate raw meeting signals (meetings/ digests, _staging inboxes)
    # into truth-tier records — the step that turns meeting N's output into
    # meeting N+1's held facts. File tools only, so it runs headless.
    echo "merge: consolidating raw meeting signals into ${KNOWLEDGE_DIR} truth records" >&2
    headless "$(fill "$DIR/prompts/merge-signals.md")"
    set_conf KNOWLEDGE_MERGED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
  pack)
    OUT="${HOME}/.meeting-copilot/prep-pack.md"
    TARGET="next"; MODE="interactive"
    while [ $# -gt 0 ]; do
      case "$1" in
        --next)   TARGET="next"; MODE="interactive"; shift ;;
        --person) TARGET="person: $2"; MODE="headless"; shift 2 ;;
        --paste)  [ -t 0 ] && echo "paste the meeting details (title, time, attendees+emails), then Ctrl-D:" >&2
                  TARGET="this pasted meeting description (do NOT call any calendar tool):
$(cat)"; MODE="headless"; shift ;;
        --out)    OUT="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
      esac
    done
    mkdir -p "$(dirname "$OUT")"; rm -f "$OUT"
    # Embedded-calendar path: with the gws CLI on PATH, resolve --next right
    # here and run headless. (Headless claude -p cannot reliably reach MCP
    # calendar tools — the reason --next otherwise needs an interactive
    # session — but a local CLI needs no MCP.)
    LOOKAHEAD="${PREP_LOOKAHEAD_H:-12}"
    if [ "$TARGET" = "next" ] && command -v gws >/dev/null 2>&1; then
      if EVENTS="$(gws_events "$LOOKAHEAD")"; then
        TARGET="next — the coming ${LOOKAHEAD}h of calendar events are embedded below (already fetched; do NOT call any calendar tool). Pick per the \"next\" rule:
$EVENTS"
        MODE="headless"
        echo "pack: calendar fetched via the gws CLI — running headless." >&2
      else
        echo "pack: no gws calendar data (no events, or CLI not authed) — falling back to interactive claude." >&2
      fi
    fi
    PROMPT="$(fill "$DIR/prompts/build-prep-pack.md" "TARGET=$TARGET" "OUTPUT=$OUT")"
    if [ "$MODE" = "headless" ]; then headless "$PROMPT"; else
      echo "pack: --next needs your calendar integration; opening interactive claude." >&2
      claude "$PROMPT"
    fi
    # The agent's own report is not proof. Verify the artifact.
    if [ ! -s "$OUT" ] || [ "$(wc -c < "$OUT")" -lt 300 ]; then
      echo "pack: FAILED — no usable pack at ${OUT}" >&2; exit 1
    fi
    grep -q "(triggers:" "$OUT" ||
      echo "pack: WARNING — no (triggers: ...) annotations; live matcher recall will suffer" >&2
    echo "pack: wrote ${OUT} ($(wc -w < "$OUT") words, $(grep -c '(triggers:' "$OUT" || true) facts with triggers)" >&2
    ;;
  events)
    HOURS="${1:-${PREP_LOOKAHEAD_H:-12}}"
    gws_events "$HOURS" || {
      echo "events: no calendar data — the gws CLI is missing, unauthed, or holds no events in the next ${HOURS}h." >&2
      echo "events: interactive fallback: knowledge.sh pack --next" >&2
      exit 1
    }
    ;;
  *) usage ;;
esac
