#!/usr/bin/env bash
# Regenerate assets/icon.icns from assets/icon.png (all macOS icon sizes).
set -euo pipefail
cd "$(dirname "$0")/.."

ICONSET="${TMPDIR:-/tmp}/Svara.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" assets/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" assets/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o assets/icon.icns
echo "wrote assets/icon.icns"
