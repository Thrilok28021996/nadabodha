#!/usr/bin/env bash
# Build a tiny local "Svara Dev.app" that runs the package from this repo with
# the sovereign interpreter. The bundle binary never changes when Python code
# changes, so its TCC (Accessibility/Microphone) grant is not invalidated by
# ordinary edits — unlike rebuilding the PyInstaller bundle every time.
#
# Use dist/Svara.app for the self-contained build; use this dev bundle while
# iterating.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="$PWD"
PY="${SVARA_PYTHON:-/Volumes/personal/conda_envs/sovereign/bin/python3}"
APP="dist/Svara Dev.app"

python3 - "$APP" <<'PY'
import shutil
import sys
from pathlib import Path

app = Path(sys.argv[1])
if app.exists():
    shutil.rmtree(app)
(app / "Contents" / "MacOS").mkdir(parents=True)
(app / "Contents" / "Resources").mkdir(parents=True)
PY

cp assets/icon.icns "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Svara Dev</string>
    <key>CFBundleDisplayName</key><string>Svara Dev</string>
    <key>CFBundleIdentifier</key><string>ai.svara.dev</string>
    <key>CFBundleExecutable</key><string>SvaraDev</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSMicrophoneUsageDescription</key><string>Svara records audio locally so it can transcribe your voice.</string>
    <key>NSAppleEventsUsageDescription</key><string>Svara asks System Events to paste dictated text at the cursor.</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/SvaraDev" <<LAUNCH
#!/bin/sh
REPO="\${SVARA_REPO:-$REPO}"
PY="\${SVARA_PYTHON:-$PY}"
cd "\$REPO" || exit 1
exec "\$PY" -m svara "\$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/SvaraDev"

codesign --force --deep --sign "${SVARA_SIGN_IDENTITY:-Svara Dev}" "$APP"

echo "built: $APP"
echo "launcher sha256: $(shasum -a 256 "$APP/Contents/MacOS/SvaraDev" | cut -d' ' -f1)"
