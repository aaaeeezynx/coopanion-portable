#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
APPIMAGE="$ROOT/app/linux/Coopanion.AppImage"
SYNC_SCRIPT="$ROOT/scripts/sync.cjs"

if [[ ! -x "$APPIMAGE" ]]; then
  echo "Coopanion for Linux is not installed."
  echo "Run this first:"
  echo "  bash \"$ROOT/Install-Coopanion-Linux.sh\""
  exit 1
fi

mkdir -p "$ROOT/.tmp/appimage"

# AppImage extract-and-run avoids a dependency on FUSE/libfuse2.
# Set COOPANION_APPIMAGE_NATIVE=1 to use the normal FUSE mount instead.
if [[ "${COOPANION_APPIMAGE_NATIVE:-0}" != "1" ]]; then
  export APPIMAGE_EXTRACT_AND_RUN=1
  export TMPDIR="$ROOT/.tmp/appimage"
fi

export CORTICO_COMPANION_DATA="$ROOT/data"
export ELECTRON_RUN_AS_NODE=1
"$APPIMAGE" "$SYNC_SCRIPT" launch
status=$?

if [[ $status -ne 0 ]]; then
  echo
  echo "Coopanion exited with code $status."
fi

exit "$status"
