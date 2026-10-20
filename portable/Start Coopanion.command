#!/bin/bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_BIN="$ROOT/app/macos/Coopanion.app/Contents/MacOS/Coopanion"
SCRIPT="$ROOT/scripts/sync.cjs"

if [[ ! -x "$APP_BIN" ]]; then
  echo "Coopanion for macOS is not installed."
  echo "Run this first:"
  echo "  bash \"$ROOT/Install-Coopanion-macOS.command\""
  read -r -p "Press Return to close..."
  exit 1
fi

export CORTICO_COMPANION_DATA="$ROOT/data"
export ELECTRON_RUN_AS_NODE=1
"$APP_BIN" "$SCRIPT" launch
status=$?

if [[ $status -ne 0 ]]; then
  echo
  echo "Coopanion exited with code $status."
  read -r -p "Press Return to close..."
fi

exit "$status"
