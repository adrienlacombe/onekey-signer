#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIMULATOR_DIR="${ONEKEY_SIMULATOR_DIR:-$ROOT_DIR/.external/onekey-docker}"
SIMULATOR_REPO="${ONEKEY_SIMULATOR_REPO:-https://github.com/Johnwanzi/onekey-docker.git}"

mkdir -p "$(dirname "$SIMULATOR_DIR")"

if [ -d "$SIMULATOR_DIR/.git" ]; then
  echo "Updating OneKey simulator in $SIMULATOR_DIR"
  git -C "$SIMULATOR_DIR" fetch --depth 1 origin main
  git -C "$SIMULATOR_DIR" checkout main
  git -C "$SIMULATOR_DIR" merge --ff-only FETCH_HEAD
else
  echo "Cloning OneKey simulator into $SIMULATOR_DIR"
  git clone --depth 1 "$SIMULATOR_REPO" "$SIMULATOR_DIR"
fi

echo "OneKey simulator ready:"
echo "  dir:    $SIMULATOR_DIR"
echo "  bridge: http://localhost:21333"
echo "  vnc:    http://localhost:6088"
