# Agent Note: Exact external AgentTeams release ports

Status: implemented

English | [中文](2026-09-10-external-agentteams-release-port.zh.md)

## Problem

The external AgentTeams plugin retains one Promise chain per team lock key unless the final owner deletes its settled queue entry. Long-running profiles that create many teams therefore accumulate process memory even after those teams finish. The plugin also consumes pre-stable DSH Agent setup, Session access, Host delivery, Web client, and profile composition APIs, so installing its upstream npm candidate directly can lose fork behavior or combine incompatible DSH packages.

The fork additionally relies on cold Captain mailbox recovery and bounded unread-mailbox projections. Upstream v0.1.18 owns nearest-step member delivery, retired-member cleanup, fallback persistence, parked-attempt recovery, and task-attempt correction, so a source replacement must distinguish those upstream guarantees from the smaller private layer.

## Decision

The fork vendors the exact external tag `v0.1.18` under [`fork-plugins/dsh-agent-teams`](../../../../fork-plugins/dsh-agent-teams) and distributes the private `0.1.18-dsh016alpha1.1` artifact only for DSH `0.1.6-alpha.1`. Its manifest, peer declarations, development dependencies, pnpm overrides, lockfile, compatibility policy, setup scripts, and checked-in SHA-256 all identify that exact pair.

The runtime keeps v0.1.18 scheduling, next-step delivery, retirement, task correction, and final-tail deletion in `withTeamLock()`. The DSH 0.1.6 port initializes members through the awaited `agent/created` event, reads current Session events through `ownEvents()`, uses the unified Host Queue/Steer adapter, cold-resumes an inactive Captain for durable mailbox delivery, and retains the bounded unread-mailbox cache listed in [`FORK_MAINTENANCE.md`](../../../../FORK_MAINTENANCE.md#local-agentteams-package).

Profile installation uses the checked-in artifact rather than npm `latest` or `next`. It changes executable plugin code only; workspace `.agent-teams` records, Sessions, attachments, and credentials remain untouched. A profile restart is required before the new code is active.

The imported plugin source tree retains upstream documentation, release evidence, and skills verbatim under its own maintenance policy. DSH documentation, terminology, and repository-reference gates exclude that external tree; the paired [`fork-plugins/README.md`](../../../../fork-plugins/README.md), this Agent Note, and [`FORK_MAINTENANCE.md`](../../../../FORK_MAINTENANCE.md) own DSH integration claims.

## Alternatives considered

**Install upstream `v0.1.18` directly.** Rejected because its published compatibility matrix stops at DSH `0.1.5-rc.1`, and its package does not carry this fork's awaited creation adapter, cold Captain delivery, or unread-cache guarantee.

**Keep the v0.1.16 fork and patch only DSH compatibility.** Rejected because v0.1.18 owns task correction, dependency-ready startup, stale-message filtering, and stronger retirement cleanup. Keeping the older scheduler would retain defects and enlarge later source comparison.

**Replace the external plugin with DSH experimental Agent Teams.** Rejected because the two implementations have different tools, persisted state, Web presentation, and operational behavior. The official experimental packages do not migrate or preserve the external plugin's teams.

## Consequences

Settled team lock keys no longer accumulate in the process, while queued successors remain serialized. The private artifact preserves existing Team JSON and mailbox data while using the current DSH lifecycle. The working tree retains only the current artifact; older package bytes remain recoverable from Git history.

Each future AgentTeams or DSH release requires another exact source import, coherent dependency pin, focused API port, full plugin verification, package identity and digest check, and real profile boot. Passing upstream tests or an npm installation alone is insufficient compatibility evidence.

DSH gates still validate every DSH-owned integration document. Each imported plugin's complete lint and verification suite validates its executable source; DSH gates do not reinterpret historical upstream evidence or nested tool configuration.
