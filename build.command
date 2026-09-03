#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

DSH_MACOS_RUNTIME_HELPER=$SCRIPT_DIR/scripts/fork-macos-runtime.sh
if [ ! -r "$DSH_MACOS_RUNTIME_HELPER" ]; then
  printf '%s\n' "ERROR: Missing macOS runtime helper $DSH_MACOS_RUNTIME_HELPER." >&2
  exit 1
fi
. "$DSH_MACOS_RUNTIME_HELPER"
dsh_prepare_macos_toolchain "$SCRIPT_DIR"

pnpm install
pnpm run build
