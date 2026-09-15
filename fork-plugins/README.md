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
- Current private version: `0.1.18-dsh016alpha1.1`
- Upstream base: `NanmiCoder/dsh-agent-teams v0.1.18`
- Private host target: `dsh-v0.1.6-alpha.1`
- Distribution artifact: `fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.18-dsh016alpha1.1.tgz`
- Artifact SHA256: `575A45F50A9A7D12DE34567102C6C1D4EF9A1F70242A682C76EBC14FA4021DA4`

This build adopts v0.1.18 atomic roster creation, dependency-ready member startup, next-step coordination, stale-attempt rejection, retired-member cleanup, and task correction. The private layer adapts awaited `agent/created` startup for DSH 0.1.6, preserves cold Captain mailbox recovery and the bounded unread-mailbox cache, and keeps the on-disk format unchanged.

After cloning this fork, setting their own `DSH_HOME`, and stopping any running DSH instance, a colleague can run this command from the repository root:

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.18-dsh016alpha1.1.tgz).Path
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add $artifact
```

This updates only that colleague's profile. It does not copy or overwrite any Session, attachment, or `.agent-teams` data.

Build and verification:

```powershell
cd fork-plugins\dsh-agent-teams
corepack pnpm@10.30.2 install --frozen-lockfile --ignore-scripts
corepack pnpm@10.30.2 typecheck
corepack pnpm@10.30.2 build
corepack pnpm@10.30.2 verify
corepack pnpm@10.30.2 pack --pack-destination ..\releases
```

Before updating from official Agent Teams, stop DSH and retain a profile configuration backup, then run:

```powershell
git subtree pull --prefix=fork-plugins/dsh-agent-teams https://github.com/NanmiCoder/dsh-agent-teams.git <tag> --squash
```

Reapply or retire the fork behavior listed in `FORK_MAINTENANCE.md`, advance the private version, build a new tgz, and validate startup with an isolated `DSH_HOME`. Never install npm `@latest` directly into a real profile.

Agent Teams durable data belongs to each workspace's `.agent-teams/` directory; this directory contains only code and distribution artifacts. Plugin updates must not scan, modify, migrate, or delete existing `.agent-teams` data, DSH Sessions, or attachments.

## Context

- Source: `fork-plugins/dsh-context`
- Current private version: `0.52.2-dsh016alpha1.1`
- Upstream base: `bowenliang123/dsh-context v0.52.2`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.52.2-dsh016alpha1.1.tgz`
- Artifact SHA256: `064D91DEB012D6D183F164CD3053FAAE6EDB31FF893C416F036BF0EA47B5319D`

This build adopts the v0.52.2 Context board, pricing, injection labels, and agent-network improvements. Field-level copy-on-write, dirty retention trimming, first-view restored-state bounds, reference-stable inline/slim caches, closed-modal subscription release, and V3 system-node header pricing remain private performance and compatibility fixes. See `fork-plugins/dsh-context/FORK_MAINTENANCE.md` for maintenance and rollback rules.

The low-overhead deployment values are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`. Confirm that DSH has stopped before changing a profile. Never read, migrate, or delete Session, attachment, credential, or projection-cache data during a plugin update.
