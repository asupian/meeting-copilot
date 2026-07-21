#!/bin/bash
# One-time setup: environment gate, dependency checks, capture build, signing
# cert, then a live permissions self-test. No API key needed: transcription
# runs on-device (macOS 26 SpeechAnalyzer) and the brain uses your existing
# Claude Code login.
#
# The self-test launches meetingtap.app via `open` so the System Audio
# Recording permission attaches to the app's own identity
# (io.meetingcopilot.meetingtap) — the first launch prompts for Microphone and
# System Audio Recording; click Allow (or enable meetingtap in System
# Settings > Privacy & Security under both lists).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

say()  { echo "$*" >&2; }
die()  { say ""; say "SETUP FAILED: $*"; exit 1; }

say "meeting-copilot setup"
say "====================="
say ""

# ---------- 1. macOS gate ----------
# On-device transcription is macOS 26's SpeechAnalyzer; there is no fallback
# ASR path. Fail here, plainly, rather than let the self-test fail obscurely.
OSVER="$(sw_vers -productVersion)"
if [ "${OSVER%%.*}" -lt 26 ] 2>/dev/null; then
  die "macOS 26 or newer required (this Mac runs ${OSVER}).
The transcriber is Apple's SpeechAnalyzer, which ships with macOS 26 — on
older systems there is nothing for the capture layer to call."
fi
say "macOS ${OSVER} — ok"

# ---------- 2. dependencies ----------
command -v swiftc >/dev/null 2>&1 ||
  die "swiftc not found. Install the Xcode Command Line Tools first:
  xcode-select --install"
command -v node >/dev/null 2>&1 ||
  die "node not found. The brain is plain Node (no packages):
  brew install node   (or https://nodejs.org)"
HAVE_CLAUDE=1
command -v claude >/dev/null 2>&1 || {
  HAVE_CLAUDE=0
  say "WARNING: claude CLI not found. Capture will work, but the brain (the"
  say "         part that surfaces cards) runs on Claude Code. Install it and"
  say "         log in: https://claude.com/claude-code"
}
command -v qmd >/dev/null 2>&1 ||
  say "note: qmd not installed — live recall over your knowledge dir stays off (optional; https://github.com/tobi/qmd)"
say "dependencies — ok"

# ---------- 3. build the capture binaries (if missing) ----------
cd "$DIR/capture"
if [ ! -f meetingtap ]; then
  say "building meetingtap (audio capture + on-device transcription)..."
  swiftc -O -parse-as-library -o meetingtap meetingtap.swift \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist ||
    die "meetingtap build failed (see errors above)"
fi
if [ ! -f screentap ]; then
  say "building screentap (meeting-window OCR)..."
  swiftc -O -o screentap screentap.swift ||
    die "screentap build failed (see errors above)"
fi
say "capture binaries — ok"

# ---------- 4. signing cert (stable TCC identity) ----------
# Re-signing with an ad-hoc signature mints a new code identity on every
# rebuild, and every new identity invalidates the mic/system-audio grants.
# A self-signed cert named meeting-copilot-dev keeps the identity stable so
# permissions survive rebuilds. Skipped when a usable cert already exists;
# declining just means re-approving permissions after each rebuild.
if security find-identity -v -p codesigning 2>/dev/null | grep -qE "meeting-copilot-dev|jarvis-dev"; then
  say "signing cert — ok (found)"
elif [ -t 0 ]; then
  printf 'No signing cert found. Create a self-signed "meeting-copilot-dev" cert in your\nlogin keychain so permissions survive rebuilds? [Y/n] ' >&2
  read -r REPLY
  case "${REPLY:-Y}" in
    [Yy]*|"")
    CERTTMP="$(mktemp -d)"
    trap 'rm -rf "$CERTTMP"' EXIT
    cat > "$CERTTMP/cert.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = meeting-copilot-dev
[ext]
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
basicConstraints = critical,CA:FALSE
CNF
    # Config-file form on purpose: stock LibreSSL lacks -addext.
    if openssl req -x509 -newkey rsa:2048 -keyout "$CERTTMP/key.pem" \
         -out "$CERTTMP/cert.pem" -days 3650 -nodes -config "$CERTTMP/cert.cnf" 2>/dev/null &&
       openssl pkcs12 -export -out "$CERTTMP/cert.p12" -inkey "$CERTTMP/key.pem" \
         -in "$CERTTMP/cert.pem" -passout pass:meeting-copilot 2>/dev/null &&
       security import "$CERTTMP/cert.p12" -k "${HOME}/Library/Keychains/login.keychain-db" \
         -P meeting-copilot -T /usr/bin/codesign >/dev/null; then
      # Trust it for code signing (may pop a confirmation dialog — approve it).
      security add-trusted-cert -p codeSign \
        -k "${HOME}/Library/Keychains/login.keychain-db" "$CERTTMP/cert.pem" 2>/dev/null ||
        say "note: could not mark the cert trusted automatically. If signing fails below, open Keychain Access > login > meeting-copilot-dev > Trust > Code Signing: Always Trust."
      say "signing cert — created (meeting-copilot-dev). macOS may ask once to allow codesign to use it: click Always Allow."
    else
      say "WARNING: cert creation failed — continuing with ad-hoc signing (permissions will re-prompt after rebuilds)."
    fi
    rm -rf "$CERTTMP"; trap - EXIT
    ;;
    *) say "skipped — ad-hoc signing (permissions will re-prompt after rebuilds)." ;;
  esac
else
  say "note: no signing cert and not a terminal — ad-hoc signing (permissions will re-prompt after rebuilds)."
fi

# ---------- 5. app bundles ----------
./build-app.sh || die "app bundling failed (see errors above)"
cd "$DIR"

# ---------- 6. permissions self-test ----------
say ""
say "Microphone + System Audio Recording permission, then a live self-test."
say "A dialog should appear for each permission. Click Allow."
say ""
"$DIR/selftest.sh"
RC=$?
say ""
if [ $RC -eq 0 ]; then
  say "SETUP COMPLETE."
  [ "$HAVE_CLAUDE" = 1 ] || say "Still needed: install Claude Code and log in (https://claude.com/claude-code)."
  if [ ! -f "${HOME}/.meeting-copilot/config" ]; then
    say "Next: build your knowledge dir — ./portable/knowledge.sh setup   (guided, ~10-15 min)"
    say "      or the bare minimum:      ./portable/knowledge.sh init"
  fi
  say "Then start a meeting with: ./start.sh"
else
  say "Not working yet. Open System Settings > Privacy & Security and confirm"
  say "'meetingtap' is enabled under BOTH Microphone and System Audio Recording,"
  say "then re-run this script. If meetingtap is not listed, click + and add:"
  say "  $DIR/capture/meetingtap.app"
fi
exit $RC
