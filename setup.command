#!/bin/sh

set -eu

usage() {
  printf '%s\n' 'Usage: ./setup.command [--dry-run]'
  printf '%s\n' 'Installs the fork-pinned Agent Teams and Context bundles into the web profile.'
}

DSH_SETUP_DRY_RUN=false
case "${1-}" in
  '') ;;
  --dry-run)
    DSH_SETUP_DRY_RUN=true
    shift
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
if [ "$#" -ne 0 ]; then
  usage >&2
  exit 64
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ "$(uname -s 2>/dev/null || printf unknown)" != Darwin ]; then
  printf '%s\n' 'ERROR: setup.command supports macOS only.' >&2
  exit 1
fi

DSH_RUNTIME_HELPER=$SCRIPT_DIR/scripts/fork-macos-runtime.sh
DSH_SETUP_HELPER=$SCRIPT_DIR/fork-runtime/setup-profile.mjs
DSH_CONTEXT_PATCH=$SCRIPT_DIR/fork-runtime/web/cordis.patch.yml
DSH_AGENT_TEAMS_ARTIFACT=$SCRIPT_DIR/fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz
DSH_CONTEXT_ARTIFACT=$SCRIPT_DIR/fork-plugins/releases/dsh-context-0.41.3-dsh012rc1.1.tgz
DSH_AGENT_TEAMS_SHA256=22312117EE48C46FE00CD5926A9D2B3FFC9788DA4A1098B11DF17E9F4FA520D9
DSH_CONTEXT_SHA256=C260E939F79A52AADC1626180DAA1E25E9119C29FE7E138C0CCFB3EC0E2DE3D4

for DSH_REQUIRED_FILE in \
  "$DSH_RUNTIME_HELPER" \
  "$DSH_SETUP_HELPER" \
  "$DSH_CONTEXT_PATCH" \
  "$DSH_AGENT_TEAMS_ARTIFACT" \
  "$DSH_CONTEXT_ARTIFACT"
do
  if [ ! -r "$DSH_REQUIRED_FILE" ]; then
    printf '%s\n' "ERROR: Missing required fork file $DSH_REQUIRED_FILE." >&2
    exit 1
  fi
done

. "$DSH_RUNTIME_HELPER"
if [ "$DSH_SETUP_DRY_RUN" = true ]; then
  # The full toolchain preparation creates private Corepack directories.
  # Dry-run restricts itself to the read-only half of the same preparation.
  dsh_prepare_macos_node
  dsh_read_expected_pnpm_version "$SCRIPT_DIR"
else
  dsh_prepare_macos_toolchain "$SCRIPT_DIR"
fi

if ! command -v tar >/dev/null 2>&1; then
  printf '%s\n' 'ERROR: tar is required to verify the bundled plugin manifests.' >&2
  exit 1
fi

DSH_HOME=$(node "$DSH_SETUP_HELPER" resolve-home)
export DSH_HOME
DSH_PROFILE_DIR=$DSH_HOME/profiles/web
DSH_PROFILE_PATCH=$DSH_PROFILE_DIR/cordis.patch.yml

printf '%s\n' "Target DSH_HOME: $DSH_HOME"
printf '%s\n' "Target profile: $DSH_PROFILE_DIR"

node "$DSH_SETUP_HELPER" verify-sha256 \
  "$DSH_AGENT_TEAMS_ARTIFACT" "$DSH_AGENT_TEAMS_SHA256"
node "$DSH_SETUP_HELPER" verify-sha256 \
  "$DSH_CONTEXT_ARTIFACT" "$DSH_CONTEXT_SHA256"
tar -xOzf "$DSH_AGENT_TEAMS_ARTIFACT" package/package.json \
  | node "$DSH_SETUP_HELPER" verify-manifest \
    '@nanmicoder/dsh-agent-teams' '0.1.15-dsh012rc1.2'
tar -xOzf "$DSH_CONTEXT_ARTIFACT" package/package.json \
  | node "$DSH_SETUP_HELPER" verify-manifest \
    'dsh-context' '0.41.3-dsh012rc1.1'

# Reject an ambiguous user patch before package installation changes anything.
node "$DSH_SETUP_HELPER" merge-patch \
  "$DSH_PROFILE_PATCH" "$DSH_CONTEXT_PATCH" --dry-run >/dev/null

DSH_PROFILE_CURRENT=false
if node "$DSH_SETUP_HELPER" verify-profile \
  "$DSH_PROFILE_DIR" "$DSH_AGENT_TEAMS_ARTIFACT" "$DSH_CONTEXT_ARTIFACT" \
  "$DSH_PACKAGE_MANAGER" \
  >/dev/null 2>&1
then
  DSH_PROFILE_CURRENT=true
fi

DSH_PATCH_CURRENT=false
if node "$DSH_SETUP_HELPER" verify-patch \
  "$DSH_PROFILE_PATCH" "$DSH_CONTEXT_PATCH" >/dev/null 2>&1
then
  DSH_PATCH_CURRENT=true
fi

if [ "$DSH_SETUP_DRY_RUN" = true ]; then
  if [ "$DSH_PROFILE_CURRENT" = true ]; then
    printf '%s\n' 'Profile package pins, installed versions, bundles, and lockfile are already current.'
  else
    if [ ! -f "$DSH_PROFILE_DIR/package.json" ]; then
      printf '%s\n' 'Would initialize the base web profile with a config dump.'
    fi
    printf '%s\n' "Would pin the profile to $DSH_PACKAGE_MANAGER and install both verified tgz files."
  fi
  if [ "$DSH_PATCH_CURRENT" = true ]; then
    printf '%s\n' 'The managed dsh-context profile patch is already current.'
  else
    printf '%s\n' 'Would apply the low-overhead dsh-context profile patch.'
  fi
  if [ "$DSH_PROFILE_CURRENT" = false ] || [ "$DSH_PATCH_CURRENT" = false ]; then
    printf '%s\n' 'Would back up existing package.json, pnpm-lock.yaml, pnpm-workspace.yaml, and cordis.patch.yml only.'
  fi
  printf '%s\n' 'Would verify the final package pins, installed versions, bundle membership, lockfile, and composed config dump.'
  printf '%s\n' 'Dry run complete; no files or directories were written.'
  exit 0
fi

if [ ! -r "$SCRIPT_DIR/node_modules/tsx/package.json" ]; then
  printf '%s\n' 'ERROR: Repository dependencies are missing; run build.command before setup.command.' >&2
  exit 1
fi

if [ "$DSH_PROFILE_CURRENT" = false ] || [ "$DSH_PATCH_CURRENT" = false ]; then
  DSH_BACKUP_ROOT=$DSH_HOME/profile-backups
  if [ -L "$DSH_BACKUP_ROOT" ]; then
    printf '%s\n' "ERROR: Refusing symlinked backup directory $DSH_BACKUP_ROOT." >&2
    exit 1
  fi
  DSH_BACKUP_DIR=$DSH_BACKUP_ROOT/web-$(date -u '+%Y%m%dT%H%M%SZ')-$$
  DSH_HAVE_BACKUP=false
  for DSH_CONFIG_NAME in package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.patch.yml
  do
    DSH_CONFIG_PATH=$DSH_PROFILE_DIR/$DSH_CONFIG_NAME
    if [ -L "$DSH_CONFIG_PATH" ]; then
      printf '%s\n' "ERROR: Refusing symlinked profile config $DSH_CONFIG_PATH." >&2
      exit 1
    fi
    if [ -e "$DSH_CONFIG_PATH" ] && [ ! -f "$DSH_CONFIG_PATH" ]; then
      printf '%s\n' "ERROR: Profile config is not a regular file: $DSH_CONFIG_PATH." >&2
      exit 1
    fi
    if [ -f "$DSH_CONFIG_PATH" ]; then
      if [ "$DSH_HAVE_BACKUP" = false ]; then
        (umask 077 && mkdir -p "$DSH_BACKUP_DIR")
        DSH_HAVE_BACKUP=true
      fi
      cp -p "$DSH_CONFIG_PATH" "$DSH_BACKUP_DIR/$DSH_CONFIG_NAME"
    fi
  done
  if [ "$DSH_HAVE_BACKUP" = true ]; then
    printf '%s\n' "Backed up the four-file profile config surface to $DSH_BACKUP_DIR"
  else
    printf '%s\n' 'No existing web-profile config files required backup.'
  fi
fi

if [ "$DSH_PROFILE_CURRENT" = false ]; then
  if [ ! -f "$DSH_PROFILE_DIR/package.json" ]; then
    node --import tsx/esm "$SCRIPT_DIR/apps/cli/src/bin.ts" \
      --profile web --dump-default-config >/dev/null
    printf '%s\n' 'Initialized the base web profile.'
  fi
  node "$DSH_SETUP_HELPER" pin-package-manager \
    "$DSH_PROFILE_DIR/package.json" "$SCRIPT_DIR/package.json"
  DSH_PROFILE_PNPM_VERSION=$(CDPATH= cd -- "$DSH_PROFILE_DIR" && pnpm --version)
  if [ "$DSH_PROFILE_PNPM_VERSION" != "$DSH_EXPECTED_PNPM_VERSION" ]; then
    printf '%s\n' \
      "ERROR: The web profile selected pnpm $DSH_PROFILE_PNPM_VERSION; expected $DSH_EXPECTED_PNPM_VERSION." >&2
    exit 1
  fi
  printf '%s\n' "Verified web-profile pnpm $DSH_PROFILE_PNPM_VERSION."
  node --import tsx/esm "$SCRIPT_DIR/apps/cli/src/bin.ts" \
    plugin --profile web add "$DSH_AGENT_TEAMS_ARTIFACT" "$DSH_CONTEXT_ARTIFACT"
else
  printf '%s\n' 'Profile package installation is already current.'
fi

if [ "$DSH_PATCH_CURRENT" = false ]; then
  node "$DSH_SETUP_HELPER" merge-patch "$DSH_PROFILE_PATCH" "$DSH_CONTEXT_PATCH"
else
  printf '%s\n' 'Managed dsh-context profile patch is already current.'
fi

node "$DSH_SETUP_HELPER" verify-profile \
  "$DSH_PROFILE_DIR" "$DSH_AGENT_TEAMS_ARTIFACT" "$DSH_CONTEXT_ARTIFACT" \
  "$DSH_PACKAGE_MANAGER"
node "$DSH_SETUP_HELPER" verify-patch "$DSH_PROFILE_PATCH" "$DSH_CONTEXT_PATCH"
DSH_COMPOSED_CONFIG=$(node --import tsx/esm "$SCRIPT_DIR/apps/cli/src/bin.ts" \
  --profile web --dump-config)
printf '%s\n' "$DSH_COMPOSED_CONFIG" | node "$DSH_SETUP_HELPER" verify-dump -

printf '%s\n' 'macOS fork profile setup completed successfully.'
printf '%s\n' 'Not installed: dshmarket, subscriptions, watchdogs, custom presets, or process-worker profiles.'
printf '%s\n' 'No Session, attachment, DSH credential-store, projection-cache, or .agent-teams path was imported or modified.'
