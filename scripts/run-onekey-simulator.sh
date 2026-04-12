#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIMULATOR_DIR="${ONEKEY_SIMULATOR_DIR:-$ROOT_DIR/.external/onekey-docker}"
MODEL="${1:-${ONEKEY_SIMULATOR_MODEL:-pro-emu}}"

case "$MODEL" in
  pro-emu|1s-emu) ;;
  *)
    echo "Usage: $0 [pro-emu|1s-emu] [--x11]" >&2
    exit 1
    ;;
esac

"$ROOT_DIR/scripts/setup-onekey-simulator.sh"

cd "$SIMULATOR_DIR"
exec bash ./build-emu.sh "$MODEL" "${@:2}"
