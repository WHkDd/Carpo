#!/usr/bin/env bash
# Applies the hidden flag to .VolumeIcon.icns inside a DMG so Finder doesn't
# show it. Tauri's bundle_dmg.sh copies the icon but never marks it invisible.
#
# Usage: fix_dmg_volume_icon.sh <path/to/file.dmg>
set -euo pipefail

DMG="${1:?Usage: $0 <path/to/file.dmg>}"
WORK=$(mktemp -d)
WRITABLE="$WORK/writable.dmg"
MOUNT="$WORK/mount"
mkdir -p "$MOUNT"

cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "[fix-dmg] converting to read-write: $DMG"
hdiutil convert "$DMG" -format UDRW -o "$WRITABLE" -quiet

hdiutil attach "$WRITABLE" -mountpoint "$MOUNT" -quiet -nobrowse -noverify

ICON="$MOUNT/.VolumeIcon.icns"
if [ -f "$ICON" ]; then
  chflags hidden "$ICON"
  # SetFile is in Xcode CLT; ignore if absent (chflags is sufficient)
  SetFile -a V "$ICON" 2>/dev/null || true
  echo "[fix-dmg] hidden flags applied to .VolumeIcon.icns"
else
  echo "[fix-dmg] warning: .VolumeIcon.icns not found — nothing to hide"
fi

hdiutil detach "$MOUNT" -quiet

FIXED="${DMG%.dmg}_fixed.dmg"
hdiutil convert "$WRITABLE" -format UDZO -imagekey zlib-level=9 -o "$FIXED" -quiet
mv "$FIXED" "$DMG"

echo "[fix-dmg] done: $DMG"
