# Fork-maintained plugins

English | [中文](README.zh.md)

This directory contains plugin sources that must track this fork's DSH APIs and ship with the fork. Keeping them outside the official `packages/` tree prevents routine upstream DSH merges from treating third-party plugins as official workspace packages and confines future conflicts to `fork-plugins/`.

## macOS profile setup

After `build.command` succeeds, `setup.command` verifies and installs the current Agent Teams and Context artifacts into the receiving Mac's `web` profile and applies the Context low-overhead bounds. It imports no other machine's runtime data and backs up only the four local profile configuration files it may change; inspect the exact actions without writing anything first:

```sh
./setup.command --dry-run
./setup.command
./run.command
```

The setup intentionally omits marketplace plugins, subscriptions, watchdogs, custom presets, and process-worker profiles. Each machine owns those optional runtime choices separately.

## Agent Teams

- Source: `fork-plugins/dsh-agent-teams`
- Current private version: `0.1.15-dsh012rc1.2`
- Upstream base: `NanmiCoder/dsh-agent-teams main@232a338fc9`
- API migration: upstream PR #124 `098e4e97eb`
- Distribution artifact: `fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz`
- Artifact SHA256: `22312117EE48C46FE00CD5926A9D2B3FFC9788DA4A1098B11DF17E9F4FA520D9`

The `.2` build protects all three retired-member entry points: the RC.1 public `sendMessage()`, Host Queue, and the fork's nearest-step path. Its bounded unread-only LRU also removes the active panel's once-per-second full reread of unchanged mailbox JSONL files. The on-disk format remains unchanged.

After cloning this fork, setting their own `DSH_HOME`, and stopping any running DSH instance, a colleague can run this command from the repository root:

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.15-dsh012rc1.2.tgz).Path
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add $artifact
```

This updates only that colleague's profile. It does not copy or overwrite any Session, attachment, or `.agent-teams` data.

Build and verification:

```powershell
cd fork-plugins\dsh-agent-teams
corepack pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 pack --pack-destination ..\releases
```

Before updating from official Agent Teams, stop DSH and retain a profile configuration backup, then run:

```powershell
git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git main --squash
```

Reapply or retire the fork behavior listed in `FORK_MAINTENANCE.md`, advance the private version, build a new tgz, and validate startup with an isolated `DSH_HOME`. Never install npm `@latest` directly into a real profile.

Agent Teams durable data belongs to each workspace's `.agent-teams/` directory; this directory contains only code and distribution artifacts. Plugin updates must not scan, modify, migrate, or delete existing `.agent-teams` data, DSH Sessions, or attachments.

## Context

- Source: `fork-plugins/dsh-context`
- Current private version: `0.41.3-dsh012rc1.1`
- Upstream base: `bowenliang123/dsh-context v0.41.3@dce08e0db3`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.41.3-dsh012rc1.1.tgz`
- Artifact SHA256: `C260E939F79A52AADC1626180DAA1E25E9119C29FE7E138C0CCFB3EC0E2DE3D4`

This build preserves the `contextTimeline` projection key, wire schema, persisted state schema, and session event vocabulary. Field-level copy-on-write, dirty retention trimming, first-view restored-state bounds, and a reference-stable view cache reduce Host allocation and publication costs. A closed `/context` modal retains only its open-state subscription. See `fork-plugins/dsh-context/FORK_MAINTENANCE.md` for maintenance and rollback rules.

The low-overhead deployment values are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, and `maxArchiveNodes: 100`. Confirm that DSH has stopped before changing a profile. Never read, migrate, or delete Session, attachment, credential, or projection-cache data during a plugin update.
