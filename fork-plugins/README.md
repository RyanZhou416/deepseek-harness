# Fork-maintained plugins

English | [中文](README.zh.md)

This directory contains plugin sources that must track this fork's DSH APIs and ship with the fork. Keeping them outside the official `packages/` tree prevents routine upstream DSH merges from treating third-party plugins as official workspace packages and confines future conflicts to `fork-plugins/`.

## macOS profile setup

After `build.command` succeeds, `setup.command` verifies and installs the current Agent Teams, Context, and Subscriptions artifacts into the receiving Mac's `web` profile, removes `dshmarket`, and applies the Context low-overhead bounds. It imports no other machine's runtime data and backs up only the four local profile configuration files it may change; inspect the exact actions without writing anything first:

```sh
./setup.command --dry-run
./setup.command
./run.command
```

The setup intentionally omits marketplace plugins, watchdogs, custom presets, and process-worker profiles. Each machine owns those optional runtime choices separately.

## Agent Teams

- Source: `fork-plugins/dsh-agent-teams`
- Current private version: `0.1.20-dsh017rc1.1`
- Upstream base: `NanmiCoder/dsh-agent-teams v0.1.20`
- Private host target: `dsh-v0.1.7-rc.1`
- Distribution artifact: `fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.20-dsh017rc1.1.tgz`
- Artifact SHA256: `17CDEA664A3EC8764CB8763FEC32A8CAE54F5F6429C89958DBE141A26253FF4B`

Upstream v0.1.20 updates documentation; its runtime retains v0.1.19 member-start recovery, repair-scope correction, atomic roster creation, next-step coordination, stale-attempt rejection, and task correction. The private RC.1 layer keeps awaited `agent/created` startup, uses projection refresh for cold member navigation and a typed `agent-teams-host` message source, and preserves Captain mailbox recovery plus the bounded unread-mailbox cache without changing the on-disk format.

Each Team message enters the durable Team mailbox before Host delivery. The plugin marks it delivered only after the Host accepts it into the DSH durable inbox; a recipient already inside a non-interruptible tool consumes that queued input after the tool settles rather than being preempted. Failed Host delivery leaves the Team record retryable, while an inactive Captain cold-resumes and replays unacknowledged rows in order.

Members include the current `attempt_id` in every task update. Omitting it produces a retryable error that names the current id without revoking the attempt; supplying a different id is a genuinely stale update and is rejected after takeover or reassignment.

After cloning this fork, setting their own `DSH_HOME`, and stopping any running DSH instance, a colleague can run this command from the repository root:

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.20-dsh017rc1.1.tgz).Path
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
- Current private version: `0.55.0-dsh017rc1.1`
- Upstream base: `bowenliang123/dsh-context v0.55.0`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.55.0-dsh017rc1.1.tgz`
- Artifact SHA256: `F75D2CB582BF21813D883644600B866EC84800ED6E8D0E835187C1D7F48CA714`

This build adopts v0.55.0 V4 folding, Context Insights, balance display, incremental turn counting, selective tool-argument retention, and on-demand corpus backfill. Field-level copy-on-write, dirty retention trimming, first-view restored-state bounds, reference-stable inline/slim caches, closed-modal subscription release, and V3/V4 system-node header pricing remain private performance and compatibility fixes. See `fork-plugins/dsh-context/FORK_MAINTENANCE.md` for maintenance and rollback rules.

The low-overhead deployment values are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`. Confirm that DSH has stopped before changing a profile. Never read, migrate, or delete Session, attachment, credential, or projection-cache data during a plugin update.

## Subscriptions

- Source: `fork-plugins/dsh-plugin-subscriptions`
- Current private version: `0.9.4-dsh017rc1.1`
- Upstream base: `V1ki/dsh-plugin-subscriptions v0.9.4`
- Private host target: `dsh-v0.1.7-rc.1`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.4-dsh017rc1.1.tgz`
- Artifact SHA256: `A226E7D73A80249752BA926DF20274FBB2A2F0C9E974EB4BD2091C2088DCEAFC`

The private build keeps upstream multi-account providers, usage UI, Codex search, image/video tools, and credential format. Its RC.1 adaptation translates V4 tool-role messages without losing call identity or image results and pins the exact DSH dependency cohort; no Session or credential migration is introduced. See `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md` for verification and rollback rules.
