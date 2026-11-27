# dsh-agent-teams fork maintenance

This subtree carries the DeepSeek Harness fork build of `dsh-agent-teams`. It retains the upstream MIT `LICENSE` and the full upstream runtime source, tests, build scripts, and assets; only the fork adaptations listed below differ.

## Provenance

- Upstream repository: `https://github.com/NanmiCoder/dsh-agent-teams.git`
- Upstream tag: `v0.1.24`
- Fork package version: `0.1.24-dsh023a2.1`
- Subtree path: `fork-plugins/dsh-agent-teams`
- Release channel: npm `dsh023a2` (prerelease; never `latest`)
- Distribution artifact: none — the real Web profile links the staging copy at `.build/fork-plugins/agent-teams` that `scripts/fork-plugins-build.ts` builds from this source in an isolated work copy; the committed `lib/` is a Git artifact, not a build input.

## Host baseline

The development cohort, every declared DSH peer range, and the 303 `pnpm-workspace.yaml` overrides are pinned to Harness `0.2.3-alpha.2`; Cordis is `4.2.0-alpha.1` and Schemastery `3.20.0-alpha.1`, the vendored versions of that checkout. `compatibility.json` keeps `0.2.2-rc.1` as the recommended host and adds `0.2.3-alpha.2` as a preview target; `0.2.2-rc.1`, `0.2.1-rc.2`, `0.2.0-rc.2`, `0.1.7-rc.2`, `0.1.5-rc.3`, `0.1.5-rc.2`, `0.1.5-rc.1`, `0.1.2-rc.1`, `0.1.2-alpha.5`, and `0.1.2-alpha.2` stay declared legacy targets whose runtime branches remain installed. `engines.node` is unchanged.

## What changed for 0.2.3-alpha.2

- **Flat activation spec.** `SubagentActivationSpec` carries `provider`/`parent`/`prompt`/`agentOptions`/`maxDepth`/`outputSchema`/`delivery` at the top level; `start`/`startContinuable` are gone. `harness-compat.startMember` now sends one spec that serves both generations: the flattened task fields for 0.2.3-alpha.2 and the nested `request` for 0.2.2 and earlier, which read only the fields they use. Persona and tool-filter options still stop at the 0.2.1-and-earlier creation seam.
- **AgentTeams member entry.** Member creation prefers the host's `Symbol.for('dsh.subagent.startAgentTeamsMember')` entry, because that is the only creation path that does not apply the user's global subagent model override; the plugin's own member route is a user-declared exception. The entry's presence is the generation test. A host without it (0.2.2 and earlier) keeps the previous `startActivation` path, and an upstream 0.2.3-alpha.2 build without it applies the global override to members — see *Host requirements*.
- **Targeted drain.** `drainChildren(parent, ids)` is replaced by a tree-wide `drainDescendants(parents)` whose admission cutoff lasts until the parent leaves the registry, so using it for a member stop would also halt unrelated delegation under the captain and block every later spawn of that session. `harness-compat.drainMemberChildren` keeps the targeted drain where the host publishes one and otherwise cancels and interrupts exactly the selected children; the per-step admission check and the retired-id delivery guard already reject every later turn of a stopped member.
- **Agent registry ownership.** `AgentRegistry.isOwnedBy`/`roots()` are gone and subagent lineage is header-based. The plugin never used either; it walks `session.header.parentSession` and the durable team record.
- **Route authentication.** `HostConnectionService.requestRejection` is gone and `admit(request)` returns the rejecting status. `admit()` cannot replace the gate for a raw-route plugin: Cordis `4.2.0-alpha.1` resolves a service method's `this.<sub-service>` reads (in `admit`, `this.authentication`) through the *calling* fiber's `inject` table, so a context that does not inject `connection.authentication` throws `cannot get property "connection.authentication" without inject` instead of returning an admission, and the WebServer's last-resort guard answers that escaped throw with an empty-body `400`. 0.2.3-alpha.2 authorizes raw routes itself (route `auth`, default `required`), so the plugin registers `auth: 'required'` and lets the host answer; hosts through 0.2.2 keep the `requestRejection` gate that returns the panel's own `401`/`403`/`503` JSON. `scripts/web-routes-verify.mjs` mounts Connection on a real plugin fiber and exercises the host `webserver/authorize` waterfall, because a root-context `apply()` exposes `connection.authentication` as a root provision and hides the defect.
- **Provider enumeration.** `SubagentRuntime.list()` is gone. The missing-provider diagnostic names the registered providers only on hosts that still publish the enumeration.
- **PTC program format.** `dsh-ptc-runtime-node` now resolves its default `persistent-in-memory` execution to the scoped REPL format, which rejects a top-level `return` and reports only `inspect()`/console output as the model-visible result. The plugin does not parse program text; its capability test and the protocol fixture emit programs for the runtime's own `programFormat`, and a plain statement sequence runs unchanged on every declared host.

## Host requirements for 0.2.3-alpha.2

Upstream 0.2.3-alpha.2 deleted `packages/subagent/subagent/src/internal.ts`, which carried the host-only prompt protocol
(`Symbol.for('dsh.subagent.deliverPrompt')` queue/steer delivery) that this plugin's durable member mailbox acknowledges against, and it has no member creation entry at all. The fork restores that module and adds `startAgentTeamsMember`; the plugin addresses both through `Symbol.for` lookups, so it needs no import of the submodule. On a vanilla upstream 0.2.3-alpha.2 host the plugin fails loud at mount
(`agent-teams: unsupported Harness subagent contract (missing continuable setup and modern host queue)`) instead of degrading member delivery to model-authored steering.

## Fork behaviors preserved

- Cold-captain mailbox recovery resolves the recorded `captainSessionId` through the Session Controller (or `ctx.agents.resume` on older hosts) and rejects an Agent id mismatch; it never fabricates a resident captain.
- `readUnreadMailbox()` keeps its pending-only 256-entry / 8 MiB bounded LRU with file-replacement detection, and its lease is recomputed per call.
- Task-first scheduling, `spawnError` visibility, retired-member rejection, stale-attempt rejection, and fresh-spawn replacement of a released activation.
- Scoped activity reads: named captain/team targets, details on demand, archived collections, and a 400 for invalid scope parameters.
- `atomicWriteText` fsyncs before rename and on the Windows direct-overwrite fallback; unreadable teams are skipped during workspace scans and reported once as `DSH_AGENT_TEAMS_UNREADABLE_TEAM`.
- 14 captain tools and 4 member tools, member-level persona/tool restrictions on old hosts, and the private `dsh023a2` release channel.

## Verification

Run from this directory (Windows: `..\..\scripts\fork-windows-pnpm.cmd install`):

```powershell
pnpm typecheck
pnpm build
pnpm verify
```

`pnpm verify` covers the fallback/member-failure TDD scripts, issue regressions, quality gates, lifecycle and stress verification, compatibility and doctor, skill sync, the harness contract (modern/delivery variants), capabilities, tool policies, member spawn/dispatch recovery, and the release/README metadata gates. `harness-source-verify.mjs` and `harness-runtime-verify.mjs` are the deep product × host matrices and require a built host checkout plus an isolated profile; they are not part of `pnpm verify`.

Run it from an isolated copy, as CI does. Inside this repository the plugin directory sits below the workspace root, so `doctor.mjs` resolves the Windows-skipped optional `@deepseek-ai/dsh-cua-macos` into the workspace above it and then reports duplicate identities for the whole dependency graph; the install itself is complete (an isolated copy of the same tree passes with 339 identities).
