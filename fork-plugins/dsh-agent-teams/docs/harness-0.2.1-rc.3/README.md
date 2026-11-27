# Harness 0.2.1-rc.3 compatibility

The published `0.1.26` artifact enumerates exact peer versions up to rc.2, so the rc.3 host rejects installation before activation ([#277](https://github.com/NanmiCoder/dsh-agent-teams/issues/277)). This change adds rc.3 as an exact `preview` target. The recommended host and the development cohort stay on rc.2; promoting rc.3 is a release decision.

## Source audit

- rc.2: `687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`).
- rc.3: `1f81c047fc48fa190a683e469daa699857e9afe8` (`dsh-v0.2.1-rc.3`).
- Six commits including the release and its merge: navigation entry customization, navigation analytics, navigation pin fixes, and the DeepSeek API-key `/models` listing.
- Server packages AgentTeams imports (agent, session, session-projection, subagent, tools, system-prompt, llm, llm-retry, commands, util-values, workspace, api-session-controller, plugin manager and app boot) change only their versions, apart from one doc comment in `api-session-controller`.
- The client contracts AgentTeams consumes remain compatible. `dsh-client-ui-conversation` adds View-tab More-menu/pin behavior and a `whenDraftExists` input option. Its submission state and injected header types gain required fields, but AgentTeams does not construct those objects; its card definition/types are unchanged. `dsh-client-ui-primitives` adds a `current` Menu row prop, optional `minWidthFromAnchor` (default false), a `left` tooltip side and an icon. AgentTeams uses `Menu`, `MenuEntry` and `Modal`.
- `dsh-client-ui-sidebar-right` adds guide More-menu/pin behavior; the tab registry, `sidebar.right.pane.tab` and `useTabInfo` contracts used by AgentTeams are unchanged. The optional `dsh-client-ui-workspace` service changes blank-session reuse and preset selection for `startSession`/`connectWorkspace`; AgentTeams only calls `openSession`, whose implementation is unchanged.

An independent recheck on 2026-10-26 fetched both exact official tags and compared the relevant packages from each npm version, validating the downloaded tarballs against registry integrity values. This covers the CLI, plugin manager/app boot, AgentTeams server/client imports and the relevant session persistence packages. Session format and SQLite schema guards are unchanged. Source-tag and published-artifact evidence are separate: the npm metadata does not supply `gitHead`, so the audit compares their actual contents rather than assuming a tag identifies the npm bytes.

## Verification

The unmodified `0.1.26` npm tarball was rejected by the rc.3 CLI plugin manager in a fresh isolated profile (`installation rejected: ... incompatible with dsh 0.2.1-rc.3`), reproducing #277. The runtime runner's real plugin-manager install check now runs for rc.3 as well as rc.2, and CI requires it for both.

Local macOS arm64 validation passed with pnpm 10.33.0 and Node 26 (CI uses Node 24): `pnpm install --frozen-lockfile`, typecheck, build, full `pnpm verify`, and `harness-runtime-verify.mjs` on rc.3 (296-package cohort) and rc.2 (295) from the same tarball. Both hosts passed all ten scenarios and the plugin-manager install without an exemption. Candidate SHA-256: `b33b258de4aee06bcdfc28770d446630a8ed83c3f4c2577bd5bc525078673770` (`0.1.26` sources, built locally). A copy with the development cohort and overrides moved to rc.3 also installed, typechecked and built cleanly.

Real provider credentials, native desktop interaction and migration of existing user data are outside the isolated fixture coverage. Do not equate these checks with a manual desktop acceptance test.

Independent revalidation on 2026-10-26 passed frozen installation, typecheck, build and full `pnpm verify`. One locally built candidate (`a8b0a3bb01c21e9d9612d15334db4d16d573c3a976e01802b9c883ac7a4b9b6f`) passed all ten functional records and the real plugin-manager installation on both fresh rc.2 (295-package) and rc.3 (296-package) cohorts. A separate reviewer reproduced the published package's rejection and the candidate's successful installation in fresh web profiles, and verified empty version-exemption maps. The [original candidate CI run](https://github.com/NanmiCoder/dsh-agent-teams/actions/runs/40149169358) also passed all eleven declared host versions. Any later integration still requires its own final-head CI.

## Recovery

Existing published artifacts and tags are immutable. Until a release includes rc.3, stay on rc.2 with `0.1.26`; do not bypass host compatibility checks.
