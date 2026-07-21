#!/bin/bash
# build-prep-pack.sh [--next | --person "<name>" | --granola "<meeting-id>"] [--out <file>]
#
# Assembles the static prep pack for a meeting by running a headless claude -p
# agent over the repo. Calendar data is fetched HERE via the authenticated gws
# CLI and embedded into the prompt — the headless agent gets no MCP tools at
# all. (MCP server names differ per session, so an allowlist of them silently
# fails; gws + repo files are stable. Prior-meeting context comes from
# people/{slug}/evidence.md, which ANALYZE keeps current from Granola.)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
CURRENT="${HOME}/.meeting-copilot/current"

TARGET="next"
OUT="${HOME}/.meeting-copilot/prep-pack.md"   # stable: run.sh re-links current/ per session
ON_DATE=""
TITLE_MATCH=""
FORWARD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --next) TARGET="next"; shift ;;
    --person) TARGET="person: $2"; shift 2 ;;
    --granola) TARGET="granola meeting id: $2"; shift 2 ;;
    --on) ON_DATE="$2"; shift 2 ;;          # YYYY-MM-DD: a specific (possibly past) meeting
    --title) TITLE_MATCH="$2"; shift 2 ;;   # substring to pick among that day's events
    --forward) FORWARD=1; shift ;;          # prep a past-dated event as if it were upcoming (no time-scope)
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# --on DATE: a specific day's meeting (past or future), picked by --title substring.
if [ -n "$ON_DATE" ]; then
  NOW="${ON_DATE}T00:00:00-07:00"
  END="${ON_DATE}T23:59:59-07:00"
  EVENT_JSON="$(gws calendar events list --params "{\"calendarId\":\"primary\",\"timeMin\":\"$NOW\",\"timeMax\":\"$END\",\"singleEvents\":true,\"orderBy\":\"startTime\",\"maxResults\":30}" 2>/dev/null | TITLE_MATCH="$TITLE_MATCH" node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try { j = JSON.parse(s); } catch { process.exit(2); }
      const want = (process.env.TITLE_MATCH || "").toLowerCase();
      for (const e of j.items || []) {
        if (want && !(e.summary || "").toLowerCase().includes(want)) continue;
        const humans = (e.attendees || []).filter(a => !a.self && !a.resource);
        if (!humans.length) continue;
        const out = {
          title: e.summary || "(untitled)",
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          organizer: e.organizer?.email,
          attendees: humans.map(a => ({ email: a.email, name: a.displayName || null, response: a.responseStatus })),
          description: (e.description || "").replace(/<[^>]+>/g, " ").slice(0, 600),
        };
        process.stdout.write(JSON.stringify(out, null, 1));
        process.exit(0);
      }
      process.exit(3);
    });')" || { echo "build-prep-pack: no matching meeting on ${ON_DATE}" >&2; exit 1; }
  TARGET="this specific meeting (already resolved from the calendar — do NOT try to call any calendar tool):
$EVENT_JSON"
  # A past meeting gets an as-of-date scope: a card that 'contradicts' an old
  # statement with data that did not exist yet is worthless.
  TODAY="$(date +%Y-%m-%d)"
  if [[ "$ON_DATE" < "$TODAY" && "$FORWARD" = "0" ]]; then
    TARGET="$TARGET

*** CRITICAL — TIME SCOPE ***
This meeting happened on ${ON_DATE}. The repo contains data from AFTER that date.
Only include facts, numbers, statuses and open threads that were TRUE AS OF ${ON_DATE}.
Prefer facts explicitly dated on or before ${ON_DATE}; EXCLUDE anything dated after;
if a fact's date is unclear, leave it out rather than guess. This matters more
than pack completeness."
  fi
  echo "build-prep-pack: resolved: $(node -e 'const e=JSON.parse(process.argv[1]);console.log(e.title+" @ "+e.start+", "+e.attendees.length+" attendees")' "$EVENT_JSON")" >&2
fi

# --next: resolve the meeting ourselves, deterministically.
if [ "$TARGET" = "next" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  END="$(date -u -v+12H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+12 hours' +%Y-%m-%dT%H:%M:%SZ)"
  EVENT_JSON="$(gws calendar events list --params "{\"calendarId\":\"primary\",\"timeMin\":\"$NOW\",\"timeMax\":\"$END\",\"singleEvents\":true,\"orderBy\":\"startTime\",\"maxResults\":15}" 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try { j = JSON.parse(s); } catch { process.exit(2); }
      for (const e of j.items || []) {
        if (e.eventType && e.eventType !== "DEFAULT") continue;
        const humans = (e.attendees || []).filter(a => !a.self && !a.resource);
        if (!humans.length) continue;                       // solo/focus blocks
        if ((e.status || "") === "cancelled") continue;
        const out = {
          title: e.summary || "(untitled)",
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          organizer: e.organizer?.email,
          attendees: humans.map(a => ({ email: a.email, name: a.displayName || null, response: a.responseStatus })),
          description: (e.description || "").replace(/<[^>]+>/g, " ").slice(0, 600),
        };
        process.stdout.write(JSON.stringify(out, null, 1));
        process.exit(0);
      }
      process.exit(3);                                      // no candidate meeting
    });')" || {
      rc=$?
      if [ "$rc" = "3" ]; then echo "build-prep-pack: no upcoming meeting with human attendees in the next 12h" >&2
      else echo "build-prep-pack: gws calendar fetch failed (VPN? auth? try: gws calendar events list ...)" >&2; fi
      exit 1
    }
  TARGET="this specific meeting (already resolved from the calendar — do NOT try to call any calendar tool):
$EVENT_JSON"
  echo "build-prep-pack: next meeting resolved: $(node -e 'console.log(JSON.parse(process.argv[1]).title + " @ " + JSON.parse(process.argv[1]).start)' "$EVENT_JSON")" >&2
fi

PROMPT="$(sed -e "s|{{OUTPUT}}|${OUT}|g" "$DIR/prep-pack-instructions.md")

=========== TARGET (overrides the '# Who to prep for' section above) ===========
TARGET: ${TARGET}

You have NO calendar, Granola, or search tools in this session — only file tools
over the repo at ${REPO}. For 'Last meeting' context use
people/{slug}/evidence.md (ANALYZE keeps it current from meeting transcripts);
say 'from evidence log' rather than pretending it came from a transcript.
If the meeting has more than ~10 attendees, prep only the key voices (tier 0/1
profiles, the organizer, and named presenters) — one line each is fine."

echo "build-prep-pack: assembling -> ${OUT}" >&2
ERRLOG="$(mktemp)"
claude -p "$PROMPT" \
  --allowedTools Read Grep Glob Write \
  --output-format json \
  2>"$ERRLOG" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      if(!s.trim()){process.stderr.write("build-prep-pack: claude -p produced NO output (rate limit? auth?)\n");process.exit(1);}
      try{const j=JSON.parse(s);process.stderr.write((j.result||"").trim()+"\n");
        process.exit(j.is_error?1:0);}
      catch(e){process.stderr.write("build-prep-pack: could not parse claude output\n");process.exit(1);}
    });' || { echo "build-prep-pack: agent failed. claude stderr tail:" >&2; tail -3 "$ERRLOG" >&2; rm -f "$ERRLOG"; exit 1; }
rm -f "$ERRLOG"

# The agent's own report is not proof. Verify the artifact.
if [ ! -s "$OUT" ] || [ "$(wc -c < "$OUT")" -lt 500 ]; then
  echo "build-prep-pack: FAILED — no usable pack at ${OUT}" >&2
  exit 1
fi
if ! grep -q "(triggers:" "$OUT"; then
  echo "build-prep-pack: WARNING — pack has no (triggers: ...) annotations; live matcher recall will suffer" >&2
fi
echo "build-prep-pack: wrote ${OUT} ($(wc -w < "$OUT") words, $(grep -c '(triggers:' "$OUT" || true) facts with triggers)" >&2