#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ZIP_NAME="Coopanion-0.2.4-mac-arm64.zip"
ZIP="$ROOT/_downloads/$ZIP_NAME"
DOWNLOAD_URL="https://github.com/Pal-AI-Lab/Coopanion/releases/download/v0.2.4/$ZIP_NAME"
EXPECTED_SHA="aec1495ba0370ff881ba82d76bb94390777a0a2f43693851023f23e7841b8ce7"
MAC_DIR="$ROOT/app/macos"
DEST="$MAC_DIR/Coopanion.app"

configure_opencode() {
  if [[ ! -x "$DEST/Contents/MacOS/Coopanion" ]]; then
    return 0
  fi
  echo "Applying OpenCodeGo provider compatibility..."
  CORTICO_COMPANION_DATA="$ROOT/data" \
    ELECTRON_RUN_AS_NODE=1 \
    "$DEST/Contents/MacOS/Coopanion" "$ROOT/scripts/configure-opencode-provider.cjs"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer must be run on macOS."
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This package is for Apple Silicon (arm64). Detected: $(uname -m)"
  exit 1
fi

if [[ ! -f "$ZIP" ]]; then
  mkdir -p "$ROOT/_downloads"
  echo "Downloading Coopanion 0.2.4 for Apple Silicon..."
  curl --fail --location --retry 3 --output "$ZIP.part" "$DOWNLOAD_URL"
  mv "$ZIP.part" "$ZIP"
fi

ACTUAL_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "Checksum mismatch."
  echo "Expected: $EXPECTED_SHA"
  echo "Actual:   $ACTUAL_SHA"
  exit 1
fi

if [[ -e "$DEST" && "${1:-}" != "--force" ]]; then
  echo "Coopanion.app is already installed."
  configure_opencode || echo "Warning: provider migration will be retried at launch."
  echo "Use --force to replace it:"
  echo "  bash \"$ROOT/Install-Coopanion-macOS.command\" --force"
  exit 0
fi

mkdir -p "$MAC_DIR"
TMP_DIR="$(mktemp -d "$MAC_DIR/.install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

ditto -x -k "$ZIP" "$TMP_DIR"
APP_SOURCE="$(find "$TMP_DIR" -maxdepth 3 -type d -name "Coopanion.app" -print -quit)"
if [[ -z "$APP_SOURCE" ]]; then
  echo "Coopanion.app was not found in the release archive."
  exit 1
fi

if [[ ! -x "$APP_SOURCE/Contents/MacOS/Coopanion" ]]; then
  echo "The Coopanion executable is missing from the release archive."
  exit 1
fi

if [[ -e "$DEST" ]]; then
  BACKUP_DIR="$MAC_DIR/backups"
  mkdir -p "$BACKUP_DIR"
  mv "$DEST" "$BACKUP_DIR/Coopanion.app.$(date +%Y%m%d-%H%M%S)"
fi

ditto "$APP_SOURCE" "$DEST"
chmod +x "$DEST/Contents/MacOS/Coopanion"
chmod +x "$ROOT/Start Coopanion.command" 2>/dev/null || true
configure_opencode || echo "Warning: provider migration will be retried at launch."

echo
echo "Coopanion 0.2.4 for Apple Silicon is installed."
echo "Start it with: $ROOT/Start Coopanion.command"
echo
echo "If macOS blocks the app, Control-click Coopanion.app in Finder,"
echo "choose Open, then confirm Open."
