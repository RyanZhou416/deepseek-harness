#!/bin/sh

# Shared runtime preparation for the fork's macOS launchers. This file is
# sourced by the .command entry points and intentionally performs no work on
# its own.

DSH_COREPACK_FALLBACK_VERSION=0.34.5

dsh_macos_runtime_error() {
  printf '%s\n' "ERROR: $*" >&2
  return 1
}

dsh_node_version_supported() {
  DSH_NODE_VERSION_VALUE=$1
  case "$DSH_NODE_VERSION_VALUE" in
    ''|.*|*.|*..*|*[!0-9.]*) return 1 ;;
  esac
  if [ "${#DSH_NODE_VERSION_VALUE}" -gt 32 ]; then
    return 1
  fi

  DSH_NODE_VERSION_OLD_IFS=$IFS
  IFS=.
  set -- $DSH_NODE_VERSION_VALUE
  IFS=$DSH_NODE_VERSION_OLD_IFS
  if [ "$#" -ne 3 ]; then
    return 1
  fi

  DSH_NODE_VERSION_MAJOR=$1
  DSH_NODE_VERSION_MINOR=$2
  DSH_NODE_VERSION_PATCH=$3
  case "$DSH_NODE_VERSION_MAJOR$DSH_NODE_VERSION_MINOR$DSH_NODE_VERSION_PATCH" in
    *[!0-9]*) return 1 ;;
  esac

  if [ "$DSH_NODE_VERSION_MAJOR" -eq 22 ]; then
    [ "$DSH_NODE_VERSION_MINOR" -ge 19 ]
    return
  fi
  [ "$DSH_NODE_VERSION_MAJOR" -ge 24 ]
}

dsh_exact_numeric_semver() {
  DSH_SEMVER_VALUE=$1
  case "$DSH_SEMVER_VALUE" in
    ''|.*|*.|*..*|*[!0-9.]*) return 1 ;;
  esac
  if [ "${#DSH_SEMVER_VALUE}" -gt 64 ]; then
    return 1
  fi

  DSH_SEMVER_OLD_IFS=$IFS
  IFS=.
  set -- $DSH_SEMVER_VALUE
  IFS=$DSH_SEMVER_OLD_IFS
  if [ "$#" -ne 3 ]; then
    return 1
  fi
  for DSH_SEMVER_COMPONENT do
    case "$DSH_SEMVER_COMPONENT" in
      0|[1-9]|[1-9][0-9]*) ;;
      *) return 1 ;;
    esac
  done
}

dsh_prepare_macos_node() {
  if command -v node >/dev/null 2>&1; then
    :
  elif [ -x /opt/homebrew/bin/node ]; then
    PATH=/opt/homebrew/bin:$PATH
    export PATH
  elif [ -x /usr/local/bin/node ]; then
    PATH=/usr/local/bin:$PATH
    export PATH
  else
    dsh_macos_runtime_error \
      'Node.js was not found in PATH, /opt/homebrew/bin, or /usr/local/bin.'
    return 1
  fi

  if ! DSH_NODE_VERSION=$(node --version 2>/dev/null); then
    dsh_macos_runtime_error 'Failed to read the Node.js version.'
    return 1
  fi
  DSH_NODE_VERSION=${DSH_NODE_VERSION#v}
  if ! dsh_node_version_supported "$DSH_NODE_VERSION"; then
    dsh_macos_runtime_error \
      "Node.js $DSH_NODE_VERSION is unsupported; install ^22.19.0 or >=24.0.0 (Node.js 23 is unsupported)."
    return 1
  fi
}

dsh_prepare_macos_private_runtime() {
  if ! DSH_RUNTIME_USER_ID=$(id -u 2>/dev/null); then
    DSH_RUNTIME_USER_ID=user
  fi
  case "$DSH_RUNTIME_USER_ID" in
    *[!A-Za-z0-9_-]*)
      dsh_macos_runtime_error 'The current user id cannot form a private runtime path.'
      return 1
      ;;
  esac

  DSH_RUNTIME_TEMP_BASE=${TMPDIR:-/tmp}
  DSH_RUNTIME_PRIVATE_DIR=$DSH_RUNTIME_TEMP_BASE/dsh-runtime-$DSH_RUNTIME_USER_ID
  if [ -L "$DSH_RUNTIME_PRIVATE_DIR" ]; then
    dsh_macos_runtime_error \
      "Refusing the symlinked private runtime directory $DSH_RUNTIME_PRIVATE_DIR."
    return 1
  fi
  if ! (umask 077 && mkdir -p "$DSH_RUNTIME_PRIVATE_DIR"); then
    dsh_macos_runtime_error \
      "Failed to create the private runtime directory $DSH_RUNTIME_PRIVATE_DIR."
    return 1
  fi
  if ! chmod 700 "$DSH_RUNTIME_PRIVATE_DIR"; then
    dsh_macos_runtime_error \
      "Failed to protect the private runtime directory $DSH_RUNTIME_PRIVATE_DIR."
    return 1
  fi

  DSH_COREPACK_HOME=$DSH_RUNTIME_PRIVATE_DIR/corepack-$DSH_COREPACK_FALLBACK_VERSION
  DSH_COREPACK_SHIMS=$DSH_RUNTIME_PRIVATE_DIR/corepack-shims
  COREPACK_HOME=${COREPACK_HOME:-$DSH_RUNTIME_PRIVATE_DIR/corepack-cache}
  npm_config_cache=${npm_config_cache:-$DSH_RUNTIME_PRIVATE_DIR/npm-cache}
  if ! (umask 077 && mkdir -p \
    "$DSH_COREPACK_HOME" \
    "$DSH_COREPACK_SHIMS" \
    "$COREPACK_HOME" \
    "$npm_config_cache"); then
    dsh_macos_runtime_error 'Failed to create the private package-manager directories.'
    return 1
  fi
  export COREPACK_HOME npm_config_cache
}

dsh_read_expected_pnpm_version() {
  DSH_MACOS_REPOSITORY_ROOT=$1
  DSH_MACOS_PACKAGE_JSON=$DSH_MACOS_REPOSITORY_ROOT/package.json
  if [ ! -f "$DSH_MACOS_PACKAGE_JSON" ]; then
    dsh_macos_runtime_error "Missing package.json under $DSH_MACOS_REPOSITORY_ROOT."
    return 1
  fi
  if ! DSH_PACKAGE_MANAGER=$(node -e '
const { readFileSync } = require("node:fs")
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"))
if (typeof manifest.packageManager !== "string") process.exit(65)
process.stdout.write(manifest.packageManager)
' "$DSH_MACOS_PACKAGE_JSON"); then
    dsh_macos_runtime_error 'Failed to read packageManager from package.json.'
    return 1
  fi
  case "$DSH_PACKAGE_MANAGER" in
    pnpm@?*) DSH_EXPECTED_PNPM_VERSION=${DSH_PACKAGE_MANAGER#pnpm@} ;;
    *)
      dsh_macos_runtime_error \
        "Expected packageManager to pin pnpm, got $DSH_PACKAGE_MANAGER."
      return 1
      ;;
  esac
  if ! dsh_exact_numeric_semver "$DSH_EXPECTED_PNPM_VERSION"; then
    dsh_macos_runtime_error \
      "packageManager must pin an exact pnpm x.y.z version, got $DSH_PACKAGE_MANAGER."
    return 1
  fi
}

dsh_prepare_macos_corepack() {
  COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY:-https://registry.npmmirror.com}
  npm_config_registry=${npm_config_registry:-$COREPACK_NPM_REGISTRY}
  export COREPACK_NPM_REGISTRY npm_config_registry

  dsh_prepare_macos_private_runtime || return 1

  if command -v corepack >/dev/null 2>&1; then
    :
  elif [ -x "$DSH_COREPACK_HOME/node_modules/.bin/corepack" ]; then
    PATH=$DSH_COREPACK_HOME/node_modules/.bin:$PATH
    export PATH
  else
    if ! command -v npm >/dev/null 2>&1; then
      dsh_macos_runtime_error \
        'Corepack is unavailable and npm was not found for the private fallback install.'
      return 1
    fi
    printf '%s\n' \
      "Corepack was not found. Installing version $DSH_COREPACK_FALLBACK_VERSION in the private temporary runtime..."
    if ! (umask 077 && npm install \
      --prefix "$DSH_COREPACK_HOME" \
      --no-save \
      --no-audit \
      --no-fund \
      "corepack@$DSH_COREPACK_FALLBACK_VERSION"); then
      dsh_macos_runtime_error 'Failed to install the private Corepack fallback.'
      return 1
    fi
    PATH=$DSH_COREPACK_HOME/node_modules/.bin:$PATH
    export PATH
  fi

  if ! corepack enable pnpm --install-directory "$DSH_COREPACK_SHIMS"; then
    dsh_macos_runtime_error 'Failed to prepare the pnpm Corepack shim.'
    return 1
  fi
  PATH=$DSH_COREPACK_SHIMS:$PATH
  export PATH
}

dsh_prepare_macos_toolchain() {
  DSH_MACOS_TOOLCHAIN_ROOT=$1
  dsh_prepare_macos_node || return 1
  dsh_read_expected_pnpm_version "$DSH_MACOS_TOOLCHAIN_ROOT" || return 1
  dsh_prepare_macos_corepack || return 1

  if ! DSH_ACTUAL_PNPM_VERSION=$(pnpm --version 2>/dev/null); then
    dsh_macos_runtime_error 'The pnpm Corepack shim did not start.'
    return 1
  fi
  if [ "$DSH_ACTUAL_PNPM_VERSION" != "$DSH_EXPECTED_PNPM_VERSION" ]; then
    dsh_macos_runtime_error \
      "packageManager requires pnpm $DSH_EXPECTED_PNPM_VERSION, but Corepack started $DSH_ACTUAL_PNPM_VERSION."
    return 1
  fi
}

dsh_heap_mib_from_physical_bytes() {
  DSH_PHYSICAL_MEMORY_BYTES=$1
  case "$DSH_PHYSICAL_MEMORY_BYTES" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "${#DSH_PHYSICAL_MEMORY_BYTES}" -gt 18 ] \
    || [ "$DSH_PHYSICAL_MEMORY_BYTES" -le 0 ]; then
    return 1
  fi

  DSH_PHYSICAL_MEMORY_MIB=$((DSH_PHYSICAL_MEMORY_BYTES / 1048576))
  DSH_AUTO_HEAP_MIB=$((DSH_PHYSICAL_MEMORY_MIB / 2))
  if [ "$DSH_AUTO_HEAP_MIB" -lt 4096 ]; then
    DSH_AUTO_HEAP_MIB=4096
  elif [ "$DSH_AUTO_HEAP_MIB" -gt 16384 ]; then
    DSH_AUTO_HEAP_MIB=16384
  fi
  printf '%s\n' "$DSH_AUTO_HEAP_MIB"
}

dsh_select_heap_mib() {
  if [ "${DSH_MAX_OLD_SPACE_MIB+x}" = x ]; then
    case "$DSH_MAX_OLD_SPACE_MIB" in
      ''|*[!0-9]*)
        dsh_macos_runtime_error \
          'DSH_MAX_OLD_SPACE_MIB must be an integer from 512 through 131072.'
        return 1
        ;;
    esac
    if [ "${#DSH_MAX_OLD_SPACE_MIB}" -gt 6 ] \
      || [ "$DSH_MAX_OLD_SPACE_MIB" -lt 512 ] \
      || [ "$DSH_MAX_OLD_SPACE_MIB" -gt 131072 ]; then
      dsh_macos_runtime_error \
        'DSH_MAX_OLD_SPACE_MIB must be an integer from 512 through 131072.'
      return 1
    fi
    printf '%s\n' "$DSH_MAX_OLD_SPACE_MIB"
    return 0
  fi

  DSH_PHYSICAL_MEMORY_BYTES=
  if command -v sysctl >/dev/null 2>&1; then
    DSH_PHYSICAL_MEMORY_BYTES=$(sysctl -n hw.memsize 2>/dev/null) || DSH_PHYSICAL_MEMORY_BYTES=
  fi
  if DSH_AUTO_HEAP_MIB=$(dsh_heap_mib_from_physical_bytes "$DSH_PHYSICAL_MEMORY_BYTES"); then
    printf '%s\n' "$DSH_AUTO_HEAP_MIB"
  else
    printf '%s\n' 8192
  fi
}

dsh_resolve_macos_home() {
  if ! DSH_RESOLVED_MACOS_HOME=$(node -e '
const { homedir } = require("node:os")
const { join, resolve } = require("node:path")
const configured = process.env.DSH_HOME
const selected = configured !== undefined && configured.trim().length > 0
  ? configured
  : join(homedir(), ".dsh")
const expanded = selected === "~"
  ? homedir()
  : selected.startsWith("~/") || selected.startsWith("~\\")
    ? join(homedir(), selected.slice(2))
    : selected
process.stdout.write(resolve(expanded))
'); then
    dsh_macos_runtime_error 'Failed to resolve DSH_HOME.'
    return 1
  fi
  printf '%s\n' "$DSH_RESOLVED_MACOS_HOME"
}

dsh_prepare_macos_web_runtime() {
  DSH_HOME=$(dsh_resolve_macos_home) || return 1
  DSH_DIAGNOSTICS=$DSH_HOME/diagnostics
  if [ -L "$DSH_DIAGNOSTICS" ]; then
    dsh_macos_runtime_error \
      "Refusing the symlinked diagnostics directory $DSH_DIAGNOSTICS."
    return 1
  fi
  if ! (umask 077 && mkdir -p "$DSH_DIAGNOSTICS"); then
    dsh_macos_runtime_error "Failed to create diagnostics at $DSH_DIAGNOSTICS."
    return 1
  fi
  if [ -L "$DSH_DIAGNOSTICS" ] || [ ! -d "$DSH_DIAGNOSTICS" ]; then
    dsh_macos_runtime_error \
      "Refusing the non-directory diagnostics path $DSH_DIAGNOSTICS."
    return 1
  fi
  if ! chmod 700 "$DSH_DIAGNOSTICS"; then
    dsh_macos_runtime_error "Failed to protect diagnostics at $DSH_DIAGNOSTICS."
    return 1
  fi

  DSH_SELECTED_HEAP_MIB=$(dsh_select_heap_mib) || return 1
  if ! DSH_REPORT_DIRECTORY_JSON=$(node -e \
    'process.stdout.write(JSON.stringify(process.argv[1]))' \
    "$DSH_DIAGNOSTICS"); then
    dsh_macos_runtime_error 'Failed to encode the Node.js report directory.'
    return 1
  fi
  DSH_RUNTIME_NODE_OPTIONS="--max-old-space-size=$DSH_SELECTED_HEAP_MIB --report-on-fatalerror --report-uncaught-exception --report-exclude-env --report-exclude-network --report-directory=$DSH_REPORT_DIRECTORY_JSON"
  if [ -n "${NODE_OPTIONS:-}" ]; then
    NODE_OPTIONS=$NODE_OPTIONS\ $DSH_RUNTIME_NODE_OPTIONS
  else
    NODE_OPTIONS=$DSH_RUNTIME_NODE_OPTIONS
  fi
  export DSH_HOME DSH_DIAGNOSTICS NODE_OPTIONS
}
