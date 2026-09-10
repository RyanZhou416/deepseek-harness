# Agent Note: Exact external AgentTeams release ports

Status: implemented

English | [中文](2026-09-10-external-agentteams-release-port.zh.md)

## Problem

The external AgentTeams plugin retains one Promise chain per team lock key unless the final owner deletes its settled queue entry. Long-running profiles that create many teams therefore accumulate process memory even after those teams finish. The plugin also consumes pre-stable DSH Agent setup, Session access, Host delivery, Web client, and profile composition APIs, so installing its upstream npm candidate directly can lose fork behavior or combine incompatible DSH packages.

The fork additionally relies on nearest-step member delivery, cold Captain mailbox recovery, retired-member delivery rejection, bounded unread-mailbox projections, fallback persistence, and parked-attempt recovery. An upstream source replacement cannot distinguish those deployment guarantees from obsolete compatibility code.

## Decision

The fork vendors the exact external tag `v0.1.16-rc.3` under [`fork-plugins/dsh-agent-teams`](../../../../fork-plugins/dsh-agent-teams) and distributes the private `0.1.16-dsh015rc1.1` artifact only for DSH `0.1.5-rc.1`. Its manifest, peer declarations, development dependencies, pnpm overrides, lockfile, compatibility policy, setup scripts, and checked-in SHA-256 all identify that exact pair.

The runtime keeps the upstream final-tail deletion in `withTeamLock()` and its serial handoff tests. The DSH 0.1.5 RC.1 port passes the unpublished Agent explicitly into member setup, reads current Session events through `ownEvents()`, uses the unified Host Queue/Steer adapter, and retains every fork delivery, recovery, retirement, and cache behavior listed in [`FORK_MAINTENANCE.md`](../../../../FORK_MAINTENANCE.md#local-agentteams-package).

Profile installation uses the checked-in artifact rather than npm `latest` or `next`. It changes executable plugin code only; workspace `.agent-teams` records, Sessions, attachments, and credentials remain untouched. A profile restart is required before the new code is active.

## Alternatives considered

**Install upstream `v0.1.16-rc.3` directly.** Rejected because its published compatibility matrix does not include DSH `0.1.5-alpha.2`, and its package does not carry this fork's Host delivery, cold Captain, retirement, and cache guarantees.

**Apply only the lock deletion patch to the existing plugin source.** Rejected because the exact upstream candidate also owns stable Captain/member capability presentation, Web approval wakeup, and existing-team reuse guidance. Keeping a partial local copy would make later source comparison and regression attribution harder.

**Replace the external plugin with DSH experimental Agent Teams.** Rejected because the two implementations have different tools, persisted state, Web presentation, and operational behavior. The official experimental packages do not migrate or preserve the external plugin's teams.

## Consequences

Settled team lock keys no longer accumulate in the process, while queued successors remain serialized. The private artifact preserves the fork's existing durable data and custom delivery behavior and can be rolled back by reinstalling the preceding checked-in artifact.

Each future AgentTeams or DSH release requires another exact source import, coherent dependency pin, focused API port, full plugin verification, package identity and digest check, and real profile boot. Passing upstream tests or an npm installation alone is insufficient compatibility evidence.
