# dsh-agent-teams fork maintenance

This subtree carries the DeepSeek Harness fork build of `dsh-agent-teams`. It retains the upstream MIT `LICENSE` and the full upstream runtime source, tests, build scripts, and assets; only the fork adaptations listed below differ.

## Provenance

- Upstream repository: `https://github.com/NanmiCoder/dsh-agent-teams.git`
- Upstream tag: `v0.1.31`
- Fork package version: `0.1.31-dsh023a2.1`
- Subtree path: `fork-plugins/dsh-agent-teams`
- Release channel: npm `dsh023a2` (prerelease; never `latest`)
- Distribution artifact: none — the real Web profile links the staging copy at `.build/fork-plugins/agent-teams` that `scripts/fork-plugins-build.ts` builds from this source in an isolated work copy; the committed `lib/` is a Git artifact, not a build input.
- Changes since the previous fork tag (`v0.1.24` → `v0.1.31`): upstream moved member delivery onto the 0.2.2-rc.2+ tree manager and flat activation spec, added the parked-attempt guidance notice, inline member prompts in plans, blank-subject rejection, output-limit settlement, off-loop workspace audits, scoped/revalidated activity polls, ranged session-history reads, and replaced its enumerated host peers with a minimum-host requirement. See `release-notes/v0.1.25.md` … `v0.1.31.md` and this fork's `release-notes/v0.1.31-dsh023a2.1.md`.

## Host baseline

The development cohort, every declared DSH peer range, and the 303 `pnpm-workspace.yaml` overrides are pinned to Harness `0.2.3-alpha.2`; Cordis is `4.2.0-alpha.1` and Schemastery `3.20.0-alpha.1`, the vendored versions of that checkout. The fork keeps `compatibility.json` with `0.2.2-rc.1` as the recommended host and `0.2.3-alpha.2` as a preview target, and keeps the enumerated peer/`engines.dsh` declaration for exactly those targets. Upstream `v0.1.31` instead declares `"*"` peers and a `>=<oldest host>` engine derived from its own matrix; that model is not adopted here because the fork's matrix has no 0.2.3-alpha.2 entry and the fork requires an exact, audited host set. `0.2.2-rc.5`, `0.2.2-rc.2` and `0.2.1-rc.3` from the upstream matrix are not added as fork targets: they are not installed by this fork's CI. `engines.node` is unchanged.

## What changed for 0.2.3-alpha.2

- **Tree manager and flat activation.** Upstream `v0.1.31` already handles the 0.2.2-rc.2+ host generation: `harness-compat.startMember` sends the flat top-level task fields when `treeBoundary(runtime)` is present (0.2.3-alpha.2 included) and the nested `request` otherwise; `drainMemberChildren` joins only the selected creation branches and disposes their resident activations instead of using the host's tree-wide drain. The fork's own flat-spec and cancel/interrupt patches are retired to this implementation; the cancel+interrupt path remains only as the fallback for a host with neither a targeted drain nor the tree manager.
- **AgentTeams member entry.** Member creation still prefers the host's `Symbol.for('dsh.subagent.startAgentTeamsMember')`, the only creation path that does not apply the user's global subagent model override; the plugin's own member route stays a user-declared exception. Presence of that entry is the generation test; a host without it uses `startActivation`.
- **Route authentication.** 0.2.3-alpha.2 removed `requestRejection` and authorizes every registered route itself, so the panel routes declare `auth: 'required'` and let the host answer. Hosts through 0.2.2 keep the plugin gate and its `401`/`403`/`503` JSON. `admit()` cannot replace the gate: Cordis `4.2.0-alpha.1` resolves a service method's `this.<sub-service>` read (in `admit`, `this.authentication`) through the *calling* fiber's `inject` table, so a context that does not inject `connection.authentication` throws `cannot get property "connection.authentication" without inject`, and the WebServer's last-resort guard answers that escaped throw with an empty-body `400`.
- **Provider enumeration.** `SubagentRuntime.list()` is gone. The missing-provider diagnostic names the registered providers only on hosts that still publish the enumeration.
- **PTC program format.** `dsh-ptc-runtime-node` resolves its default `persistent-in-memory` execution to the scoped REPL format, which rejects a top-level `return` and reports only `inspect()`/console output as the model-visible result. The plugin does not parse program text; its capability test and the protocol fixture emit programs for the runtime's own `programFormat`, and a plain statement sequence runs unchanged on every declared host.
- **Scoped activity reads.** The fork's `captainSessionId` / paired `teamCaptainSessionId`+`teamId` targets, `detail=1` and `400` for malformed scope remain; the route additionally accepts the upstream client's `session=` and `summary=1` switches and revalidates unchanged polls with an ETag (`writeJsonWithEtag`). `collectTeamsActivity` / `collectArchivedTeamsActivity` take one options object, and `includeDetails` remains a fork alias for `summary`.

## Host requirements for 0.2.3-alpha.2

Upstream 0.2.3-alpha.2 deleted `packages/subagent/subagent/src/internal.ts`, which carried the host-only prompt protocol (`Symbol.for('dsh.subagent.deliverPrompt')` queue/steer delivery) that this plugin's durable member mailbox acknowledges against, and it has no member creation entry at all. The fork restores that module and adds `startAgentTeamsMember`; the plugin addresses both through `Symbol.for` lookups, so it needs no import of the submodule. On a vanilla upstream 0.2.3-alpha.2 host the plugin fails loud at mount (`agent-teams: unsupported Harness subagent contract (missing continuable setup and modern host queue)`) instead of degrading member delivery to model-authored steering.

## Fork behaviors preserved

- Cold-captain mailbox recovery resolves the recorded `captainSessionId` through the Session Controller's `resolveAgent` (or `ctx.agents.resume` on older hosts) and rejects an Agent id mismatch; it never fabricates a resident captain.
- `readUnreadMailbox()` keeps its pending-only 256-entry / 8 MiB bounded LRU with file-replacement detection, and its lease is recomputed per call.
- Task-first scheduling (a ready task before unread mail), `spawnError` visibility, retired-member rejection, stale-attempt rejection, attempt-generator restoration for a dispatch that never reached a member, and fresh-spawn replacement of a released activation.
- `atomicWriteText` fsyncs the temp file before rename and on the Windows direct-overwrite fallback; unreadable teams are skipped during workspace scans and reported once as `DSH_AGENT_TEAMS_UNREADABLE_TEAM`.
- 14 captain tools and 4 member tools, member-level persona/tool restrictions on old hosts, and the private `dsh023a2` release channel.

## Retired fork behaviors

- Fork-owned member model selection (the mutable `installModelSelection` ref, saved-route recording and in-place fallback retry) is now upstream's Agent-owned selection: the fallback route is recorded on `Agent.model` and the member continues in a new turn. Evidence: upstream `src/members.ts` `nativeModel?.select(...)` plus `commitFallbackRoute`; commits `f399ff7`, `e203e5c`, `4027eca` and release note v0.1.29.
- The fork's `drainMemberChildren(ctx, parent, ids)` signature is kept for the cancel+interrupt fallback, but tree hosts use upstream's branch-owned disposal (evidence: upstream `src/harness-compat.ts` `treeWork`/`manager.dispose`, release note v0.1.31).
- The separate `collectTeamsActivity(ctx, roots, captainSessionId, summary)` selection is folded into one options object; `session=`/`summary=` are accepted alongside the fork's parameters. Evidence: upstream `src/snapshot.ts` `includePlanText`/`summary` and the `session=`-scoped client poll (`a901e19`, `#330`).

## Verification

Run from this directory (Windows: `..\..\scripts\fork-windows-pnpm.cmd install`):

```powershell
pnpm typecheck
pnpm build
pnpm verify
```

`pnpm verify` covers the fallback/member-failure TDD scripts, issue regressions (including the upstream v0.1.25–v0.1.31 issue tests), quality gates, lifecycle and stress verification, compatibility and doctor, skill sync, the harness contract (modern/delivery variants), capabilities, tool policies, member spawn/dispatch recovery, activity queries, and the release/README metadata gates. `scripts/harness-source-verify.mjs` and `harness-runtime-verify.mjs` are the deep product × host matrices and require a built host checkout plus an isolated profile; they are not part of `pnpm verify`.

`harness-validation.test.mjs` and `upgrade-status.test.mjs` encode upstream's minimum-host matrix and registry walk, so they are not part of this fork's gate; `pnpm check:upstream` still runs the report manually. Run it from an isolated copy, as CI does. Inside this repository the plugin directory sits below the workspace root, so `doctor.mjs` resolves the Windows-skipped optional `@deepseek-ai/dsh-cua-macos` into the workspace above it and then reports duplicate identities for the whole dependency graph; the install itself is complete (an isolated copy of the same tree passes).
