#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APPIMAGE_NAME="Coopanion-0.2.4-linux-x64.AppImage"
DOWNLOAD="$ROOT/_downloads/$APPIMAGE_NAME"
DOWNLOAD_URL="https://github.com/Pal-AI-Lab/Coopanion/releases/download/v0.2.4/$APPIMAGE_NAME"
EXPECTED_SHA="f3c2b9a6de36ca99091a00becde7b5e01dc1167180ac96dbda89723904a93618"
APP_DIR="$ROOT/app/linux"
APPIMAGE="$APP_DIR/Coopanion.AppImage"
PROVIDER_SCRIPT="$ROOT/scripts/configure-opencode-provider.cjs"

usage() {
  echo "Usage: bash \"$0\" [--force]"
}

configure_opencode() {
  if [[ ! -x "$APPIMAGE" ]]; then
    return 0
  fi
  if [[ ! -f "$PROVIDER_SCRIPT" ]]; then
    echo "Provider migration script is missing: $PROVIDER_SCRIPT" >&2
    return 1
  fi

  echo "Applying OpenCodeGo provider compatibility..."
  mkdir -p "$ROOT/.tmp/appimage"
  CORTICO_COMPANION_DATA="$ROOT/data" \
    ELECTRON_RUN_AS_NODE=1 \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    TMPDIR="$ROOT/.tmp/appimage" \
    "$APPIMAGE" "$PROVIDER_SCRIPT"
}

sha256_of() {
  sha256sum "$1" | awk '{print $1}'
}

case "${1:-}" in
  "")
    FORCE=0
    ;;
  --force)
    FORCE=1
    ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer must be run on Linux."
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64)
    ;;
  *)
    echo "This package is for Linux x64. Detected: $(uname -m)"
    exit 1
    ;;
esac

for command in curl sha256sum awk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command"
    exit 1
  fi
done

if [[ -x "$APPIMAGE" && "$FORCE" -ne 1 ]]; then
  echo "Coopanion.AppImage is already installed."
  configure_opencode || echo "Warning: provider migration will be retried at launch."
  echo "Use --force to replace it:"
  echo "  bash \"$ROOT/Install-Coopanion-Linux.sh\" --force"
  exit 0
fi

if [[ ! -f "$DOWNLOAD" ]] || [[ "$(sha256_of "$DOWNLOAD")" != "$EXPECTED_SHA" ]]; then
  rm -f "$DOWNLOAD" "$DOWNLOAD.part"
  mkdir -p "$(dirname "$DOWNLOAD")"
  echo "Downloading Coopanion 0.2.4 for Linux x64..."
  if ! curl --fail --location --retry 3 --output "$DOWNLOAD.part" "$DOWNLOAD_URL"; then
    rm -f "$DOWNLOAD.part"
    echo "Download failed."
    exit 1
  fi
  ACTUAL_SHA="$(sha256_of "$DOWNLOAD.part")"
  if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    rm -f "$DOWNLOAD.part"
    echo "Checksum mismatch."
    echo "Expected: $EXPECTED_SHA"
    echo "Actual:   $ACTUAL_SHA"
    exit 1
  fi
  mv "$DOWNLOAD.part" "$DOWNLOAD"
fi

mkdir -p "$APP_DIR"
if [[ -e "$APPIMAGE" ]]; then
  BACKUP_DIR="$APP_DIR/backups"
  mkdir -p "$BACKUP_DIR"
  BACKUP_PATH="$BACKUP_DIR/Coopanion.AppImage.$(date +%Y%m%d-%H%M%S)"
  mv "$APPIMAGE" "$BACKUP_PATH"
  echo "Previous installation moved to $BACKUP_PATH"
fi

cp "$DOWNLOAD" "$APPIMAGE"
chmod 755 "$APPIMAGE"

if [[ ! -x "$APPIMAGE" ]]; then
  echo "Installation completed without an executable AppImage: $APPIMAGE"
  exit 1
fi

configure_opencode || echo "Warning: provider migration will be retried at launch."

echo
echo "Coopanion 0.2.4 for Linux x64 is installed."
echo "Start it with:"
echo "  bash \"$ROOT/Start-Coopanion-Linux.sh\""
echo
echo "The private profile repository may request GitHub authentication on first launch."
