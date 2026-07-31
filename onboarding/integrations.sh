#!/bin/bash
# integrations.sh — the optional-integrations walkthrough.
#
#   integrations.sh            show every optional integration: what it unlocks,
#                              whether it's connected, and how to connect it
#
# Why this exists: qmd and the calendar CLI were only ever *detected*. A missing
# one printed a single note mid-scroll and the copilot carried on degraded, so
# the first a user heard about live recall was often never. Optional must still
# mean explained — a user choosing to skip recall is fine, a user who never knew
# it existed is not.
#
# Read-only and safe to re-run. It installs nothing: every install here is
# software on the user's machine, and that is their call to make, not ours.
# shellcheck source=../cli/common.sh
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/../cli/common.sh"

have() { command -v "$1" >/dev/null 2>&1; }
mark() { if have "$1"; then printf '  [connected] '; else printf '  [ not set ] '; fi; }

echo "" >&2
echo "OPTIONAL INTEGRATIONS — each one is genuinely optional. The copilot runs" >&2
echo "without all of them; this is what each one buys you." >&2
echo "" >&2

# ---- 1. qmd: live recall -----------------------------------------------------
mark qmd >&2
echo "qmd — live recall over your knowledge base" >&2
if have qmd; then
  echo "     Cards can cite anything in your knowledge dir, searched live as people talk." >&2
  # Indexed but unregistered is the silent failure: qmd is present, recall runs,
  # and it finds nothing. doctor checks this too; say it here while it's fixable.
  if [ -n "${KNOWLEDGE_DIR:-}" ] && ! qmd collection list 2>/dev/null | grep -q "$(basename "${KNOWLEDGE_DIR}")"; then
    echo "     WARNING: your knowledge dir is not registered with qmd yet — recall will" >&2
    echo "     find nothing until it is. Fix: ./portable/knowledge.sh init  (or copilot doctor)" >&2
  fi
else
  echo "     WITHOUT IT: the copilot still works, but only from the prep pack built" >&2
  echo "     before the meeting. Nothing outside that pack can be cited mid-meeting." >&2
  echo "     Install:  https://github.com/tobi/qmd    then re-run: copilot onboard integrations" >&2
fi
echo "" >&2

# ---- 2. calendar -------------------------------------------------------------
mark gws >&2
echo "calendar (the local 'gws' CLI) — pick meetings from your real calendar" >&2
if have gws; then
  echo "     'copilot prep list' numbers your upcoming meetings; onboarding preps them all." >&2
else
  echo "     WITHOUT IT: no meeting list, and no auto-prep. You lose the list, not the" >&2
  echo "     copilot — describe any meeting in your own words instead:" >&2
  echo "       copilot prep --text \"1:1 with Dana — renewal pricing\"" >&2
  echo "     gws is a local Google Workspace CLI; this repo does not ship or install it." >&2
fi
echo "" >&2

# ---- 3. notes source (Notion / Obsidian / a folder) --------------------------
# Deliberately NOT presented as a live "Notion integration". The wizard ingests
# a Notion EXPORT reliably; a live connector is used only if the claude session
# already has one. Promising a connector that may not be there is how a user
# ends up waiting for a step that never comes.
if [ -n "${KNOWLEDGE_DIR:-}" ] && [ -d "${KNOWLEDGE_DIR}" ]; then
  printf '  [connected] ' >&2
  echo "notes source — knowledge dir: ${KNOWLEDGE_DIR}" >&2
  n=$(find "${KNOWLEDGE_DIR}" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  echo "     ${n} note file(s) on hand. This is what every card is grounded in — a thin" >&2
  echo "     knowledge dir means few cards, and that is the system working, not failing." >&2
  echo "     Top up anytime:  copilot onboard knowledge" >&2
else
  printf '  [ not set ] ' >&2
  echo "notes source (Obsidian / Notion / any folder of markdown)" >&2
  echo "     THIS IS THE ONE THAT MATTERS. With no notes there is nothing to cite and" >&2
  echo "     the copilot stays silent all meeting." >&2
  echo "     Obsidian or a folder: point the wizard at it." >&2
  echo "     Notion: export to Markdown (Settings > Export), then point the wizard at" >&2
  echo "     the export. A live Notion connector is used only if your claude session" >&2
  echo "     already has one — the export path always works." >&2
  echo "     Start:  copilot onboard knowledge" >&2
fi
echo "" >&2

# ---- 4. permissions ----------------------------------------------------------
# TCC state is not readable from a shell, so this is a reminder, not a check —
# claiming a green check we cannot verify would be worse than saying nothing.
echo "  [  manual ] macOS permissions — Microphone + System Audio Recording, and" >&2
echo "     Screen Recording if you want the copilot to read shared slides." >&2
echo "     Granted during setup; verify in System Settings > Privacy & Security." >&2
echo "" >&2
echo "Re-run this list anytime:  copilot onboard integrations" >&2
echo "Full health sweep:         copilot doctor" >&2
echo "" >&2
