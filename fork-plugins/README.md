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
- Current private version: `0.1.19-dsh016alpha2.1`
- Upstream base: `NanmiCoder/dsh-agent-teams v0.1.19`
- Private host target: `dsh-v0.1.6-alpha.2`
- Distribution artifact: `fork-plugins/releases/nanmicoder-dsh-agent-teams-0.1.19-dsh016alpha2.1.tgz`
- Artifact SHA256: `1C93655EE5162987ECBA1BBCD6C084E84DE87A486EF8ED4AF2E33D957EEBE9B9`

This build adopts v0.1.19 member-start recovery for renamed tools, repair-scope correction, captain task amendments, atomic roster creation, next-step coordination, stale-attempt rejection, retired-member cleanup, and task correction. The private layer adapts awaited `agent/created` startup and Alpha.2 `uiWorkspace` navigation, preserves cold Captain mailbox recovery and the bounded unread-mailbox cache, and keeps the on-disk format unchanged.

Each Team message enters the durable Team mailbox before Host delivery. The plugin marks it delivered only after the Host accepts it into the DSH durable inbox; a recipient already inside a non-interruptible tool consumes that queued input after the tool settles rather than being preempted. Failed Host delivery leaves the Team record retryable, while an inactive Captain cold-resumes and replays unacknowledged rows in order.

Members include the current `attempt_id` in every task update. Omitting it produces a retryable error that names the current id without revoking the attempt; supplying a different id is a genuinely stale update and is rejected after takeover or reassignment.

After cloning this fork, setting their own `DSH_HOME`, and stopping any running DSH instance, a colleague can run this command from the repository root:

```powershell
$artifact = (Resolve-Path .\fork-plugins\releases\nanmicoder-dsh-agent-teams-0.1.19-dsh016alpha2.1.tgz).Path
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
- Current private version: `0.53.3-dsh016alpha2.1`
- Upstream base: `bowenliang123/dsh-context v0.53.3`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.53.3-dsh016alpha2.1.tgz`
- Artifact SHA256: `8C84B018DE10CF181A77AD151D069A00133D7AF8537EE766F2A46C8154DD5843`

This build adopts v0.53.3 Context Insights, activity projection, last-message cards, and on-demand corpus backfill. Field-level copy-on-write, dirty retention trimming, first-view restored-state bounds, reference-stable inline/slim caches, closed-modal subscription release, and V3 system-node header pricing remain private performance and compatibility fixes. See `fork-plugins/dsh-context/FORK_MAINTENANCE.md` for maintenance and rollback rules.

The low-overhead deployment values are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`. Confirm that DSH has stopped before changing a profile. Never read, migrate, or delete Session, attachment, credential, or projection-cache data during a plugin update.

## Subscriptions

- Source: `fork-plugins/dsh-plugin-subscriptions`
- Current private version: `0.9.2-dsh016alpha2.1`
- Upstream base: `V1ki/dsh-plugin-subscriptions v0.9.2`
- Private host target: `dsh-v0.1.6-alpha.2`
- Distribution artifact: `fork-plugins/releases/dsh-plugin-subscriptions-0.9.2-dsh016alpha2.1.tgz`
- Artifact SHA256: `5B6AC96A2E22946BAC53339F4D2A307AD29DAC5195851BF55606BA946CD37177`

The private build keeps the upstream multi-account providers, usage UI, request translation, image and video tools, and credential format. Its Alpha.2 adaptation uses the awaited `agent/created` payload and exact DSH dependency cohort; no Session or credential migration is introduced. See `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md` for verification and rollback rules.
