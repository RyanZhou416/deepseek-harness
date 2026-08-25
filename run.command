#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

DSH_NODE_BIN_DIR=/usr/local/bin
if [ ! -x "$DSH_NODE_BIN_DIR/node" ] || [ ! -x "$DSH_NODE_BIN_DIR/corepack" ]; then
  printf '%s\n' "Node.js and Corepack were not found in $DSH_NODE_BIN_DIR" >&2
  exit 1
fi
PATH=$DSH_NODE_BIN_DIR:$PATH
export PATH

COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY:-https://registry.npmmirror.com}
npm_config_registry=${npm_config_registry:-$COREPACK_NPM_REGISTRY}
export COREPACK_NPM_REGISTRY npm_config_registry

DSH_COREPACK_SHIMS=${TMPDIR:-/tmp}/dsh-corepack-shims
mkdir -p "$DSH_COREPACK_SHIMS"

corepack enable pnpm --install-directory "$DSH_COREPACK_SHIMS"
PATH=$DSH_COREPACK_SHIMS:$PATH
export PATH

pnpm dsh web
