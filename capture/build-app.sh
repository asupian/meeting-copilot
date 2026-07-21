#!/bin/bash
# Package the compiled capture binaries into signed .app bundles with stable
# TCC identities (io.meetingcopilot.meetingtap / io.meetingcopilot.screentap) so macOS
# mic / system-audio / screen-recording grants persist.
#
# IDEMPOTENT ON PURPOSE: re-signing mints a new code identity (ad-hoc signatures
# have no stable requirement), and every new identity invalidates the TCC grant
# — the permission dialog comes back even though Settings shows the app enabled.
# So each bundle is only rebuilt when its binary actually changed. For grants
# that survive even real rebuilds, create a self-signed code-signing cert named
# "meeting-copilot-dev" in Keychain Access (Certificate Assistant > Create a
# Certificate > Certificate Type: Code Signing); this script picks it up
# automatically ("jarvis-dev" is honored as a legacy cert name).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

[ -f meetingtap ] || { echo "build the binary first (see README step 1)"; exit 1; }

SIGN_ID="-"
for CERT in meeting-copilot-dev jarvis-dev; do
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT"; then
    SIGN_ID="$CERT"
    echo "signing with stable identity: $CERT (TCC grants survive rebuilds)"
    break
  fi
done

# codesign embeds the signature into the bundled binary, so it never byte-matches
# the loose one. Compare against a stamp of the SOURCE binary's hash instead.
srcsha() { shasum -a 256 < "$1" | cut -d" " -f1; }
unchanged() { [ -f "$2" ] && [ "$(srcsha "$1")" = "$(cat "$2" 2>/dev/null)" ]; }

# ---------- meetingtap.app (mic + system audio) ----------
if unchanged meetingtap meetingtap.app/Contents/.source-sha; then
  echo "meetingtap.app current — skipping (preserves its TCC grant)"
else
  APP=meetingtap.app
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  cp meetingtap "$APP/Contents/MacOS/meetingtap"

  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>meetingtap</string>
  <key>CFBundleIdentifier</key><string>io.meetingcopilot.meetingtap</string>
  <key>CFBundleName</key><string>meetingtap</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.4</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>meetingtap captures your microphone to transcribe meetings for the live meeting copilot.</string>
  <key>NSAudioCaptureUsageDescription</key><string>meetingtap captures system audio (other meeting participants) to transcribe meetings.</string>
</dict>
</plist>
PLIST

  codesign --force --sign "$SIGN_ID" --identifier io.meetingcopilot.meetingtap \
    --entitlements /dev/stdin "$APP" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
ENT

  srcsha meetingtap > "$APP/Contents/.source-sha"
  echo "built and signed: $DIR/$APP"
fi

# ---------- screentap.app (screen recording / OCR) ----------
if [ -f screentap ]; then
  if unchanged screentap screentap.app/Contents/.source-sha; then
    echo "screentap.app current — skipping (preserves its TCC grant)"
  else
    APP2=screentap.app
    rm -rf "$APP2"
    mkdir -p "$APP2/Contents/MacOS"
    cp screentap "$APP2/Contents/MacOS/screentap"

    cat > "$APP2/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>screentap</string>
  <key>CFBundleIdentifier</key><string>io.meetingcopilot.screentap</string>
  <key>CFBundleName</key><string>screentap</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

    codesign --force --sign "$SIGN_ID" --identifier io.meetingcopilot.screentap "$APP2"
    srcsha screentap > "$APP2/Contents/.source-sha"
    echo "built and signed: $DIR/$APP2"
  fi
fi
