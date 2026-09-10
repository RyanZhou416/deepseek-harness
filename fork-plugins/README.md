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
- Current private version: `0.1.16-dsh015rc1.1`
- Upstream base: `NanmiCoder/dsh-agent-teams v0.1.16-rc.3@bf17f93d35`
- Private host target: `dsh-v0.1.5-rc.1`
- Distribution artifact: `fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.16-dsh015rc1.1.tgz`
- Artifact SHA256: `EAD7426C8BA4D3A72D4054E817CE2E19A4CB60A57F1CA49A9F2ABB7107E9F351`

This build adds the upstream rc.3 stable capability presentation, existing-team reuse guidance, Web approval wakeup, and settled team-lock cleanup. It preserves live-Steer/inactive-Queue delivery, cold Captain mailbox recovery, all retired-member entry-point guards, the bounded unread-only LRU, fallback persistence, and parked-attempt recovery. The on-disk format remains unchanged.

After cloning this fork, setting their own `DSH_HOME`, and stopping any running DSH instance, a colleague can run this command from the repository root:

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.16-dsh015rc1.1.tgz).Path
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
- Current private version: `0.41.3-dsh013alpha2.1`
- Upstream base: `bowenliang123/dsh-context v0.41.3@dce08e0db3`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.41.3-dsh013alpha2.1.tgz`
- Artifact SHA256: `8C681B385616770B397A5C44E5676A63C9F84F7C6E54061EE0BAE8F5194388B8`

This build preserves the `contextTimeline` projection key, wire schema, persisted state schema, and session event vocabulary. Field-level copy-on-write, dirty retention trimming, first-view restored-state bounds, and a reference-stable view cache reduce Host allocation and publication costs. A closed `/context` modal retains only its open-state subscription. See `fork-plugins/dsh-context/FORK_MAINTENANCE.md` for maintenance and rollback rules.

The low-overhead deployment values are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, and `maxArchiveNodes: 100`. Confirm that DSH has stopped before changing a profile. Never read, migrate, or delete Session, attachment, credential, or projection-cache data during a plugin update.
