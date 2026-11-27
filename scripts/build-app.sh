#!/usr/bin/env bash
# Build Svara.app from the PySide6 sources with PyInstaller.
#
#   ./scripts/build-app.sh
#
# The speech model is not bundled; it is read from the Hugging Face cache at
# runtime (Settings -> Model cache).
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${SVARA_PYTHON:-/Volumes/personal/conda_envs/sovereign/bin/python3}"

# Compile the ScreenCaptureKit helper so the bundle can record other apps'
# audio without a virtual driver.
mkdir -p assets/bin
if command -v swiftc >/dev/null 2>&1; then
    swiftc -O -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia \
        native/system_audio.swift -o assets/bin/svara-system-audio
else
    echo "warning: swiftc not found; system-audio capture will be unavailable" >&2
fi

# A local identity; note that macOS still keys TCC grants to the built binary,
# so each rebuild of this bundle needs Accessibility re-granted.
SIGN_IDENTITY="${SVARA_SIGN_IDENTITY:-Svara Dev}"
sign_app() {
    if security find-certificate -c "$SIGN_IDENTITY" >/dev/null 2>&1; then
        codesign --force --deep --sign "$SIGN_IDENTITY" dist/Svara.app
    else
        codesign --force --deep --sign - dist/Svara.app
    fi
}

if ! "$PY" -c 'import PyInstaller' >/dev/null 2>&1; then
    "$PY" -m pip install --upgrade pyinstaller
fi

"$PY" -m PyInstaller \
    --noconfirm \
    --clean \
    --name Svara \
    --windowed \
    --icon "$PWD/assets/icon.icns" \
    --osx-bundle-identifier ai.svara.app \
    --paths "$PWD" \
    --add-data "$PWD/assets:assets" \
    --add-binary "$PWD/assets/bin/svara-system-audio:assets/bin" \
    --collect-submodules faster_whisper \
    --collect-data faster_whisper \
    --collect-binaries ctranslate2 \
    --hidden-import av \
    --hidden-import tokenizers \
    --hidden-import onnxruntime \
    --hidden-import sounddevice \
    --hidden-import "pynput.keyboard._darwin" \
    --hidden-import "pynput.mouse._darwin" \
    --hidden-import AppKit \
    --hidden-import Quartz \
    --hidden-import ApplicationServices \
    --exclude-module PySide6.QtWebEngineCore \
    --exclude-module PySide6.QtWebEngineWidgets \
    --exclude-module PySide6.QtWebEngineQuick \
    --exclude-module PySide6.QtPdf \
    --exclude-module PySide6.QtPdfWidgets \
    --exclude-module PySide6.QtQml \
    --exclude-module PySide6.QtQuick \
    --exclude-module PySide6.QtQuickWidgets \
    --exclude-module PySide6.QtMultimedia \
    --exclude-module PySide6.QtMultimediaWidgets \
    --exclude-module PySide6.Qt3DCore \
    --exclude-module tkinter \
    --exclude-module matplotlib \
    --exclude-module torch \
    --exclude-module IPython \
    --distpath dist \
    --workpath build/pyinstaller \
    --specpath build \
    scripts/launch_svara.py

# Signature: local identity; the bundle still needs its TCC grants re-approved
# after every rebuild because Gatekeeper does not trust self-signed apps.
sign_app

# Usage descriptions macOS requires before it will grant Microphone/Automation
# to the bundle (a TCC-protected resource fails silently without them).
PLIST="dist/Svara.app/Contents/Info.plist"
for entry in \
    "NSMicrophoneUsageDescription:Svara records audio locally so it can transcribe your voice." \
    "NSAppleEventsUsageDescription:Svara asks System Events to paste dictated text at the cursor."
do
    key="${entry%%:*}"
    value="${entry#*:}"
    /usr/libexec/PlistBuddy -c "Add :$key string $value" "$PLIST" 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Set :$key $value" "$PLIST"
done
sign_app

echo "built: $PWD/dist/Svara.app"
