# Fork-maintained plugins

English | [中文](README.zh.md)

This directory contains plugin sources that must track this fork's DSH APIs and ship with the fork. Keeping them outside the official `packages/` tree prevents routine upstream DSH merges from treating third-party plugins as official workspace packages and confines future conflicts to `fork-plugins/`.

## Repo-integrated build and install

On Windows, `build.cmd` builds the source plugins and links the four fork plugins (AgentTeams, Context, Subscriptions, AetherShell) plus the workspace `@deepseek-ai/dsh-llm-cc-pool` provider bundle into the selected `web` profile after the ordinary root build. A current profile needs no second command, private registry, or hand-supplied tarball. The build **mutates the profile**, so stop the Host first. `build.cmd` runs `scripts/fork-plugins-build.ts` without options, so its guard probes only the default `127.0.0.1:3080`; to guard a Host on another endpoint, run the script directly with `--host`/`--port`. The guard fails before touching any profile file while a Host answers there, and an endpoint it cannot verify fails the run instead of assuming no Host is running.

The build targets the current profile format only: it has no legacy-profile detection, conversion, backup, or migration. An old profile that still declares `llm-pi-ai` `providers.cc-pool` must first be converted by the one-time [`scripts/migrate-legacy-cc-pool-profile.ts`](../scripts/migrate-legacy-cc-pool-profile.ts) script, then `build.cmd` must be run. That script backs up the profile, seed files, and `$DSH_HOME/settings.yaml`, removes the legacy declaration structurally, and cleans the matching `settings.yaml` declaration before the missing-profile and missing-package.json skips — a home with the legacy route and no web profile is still cleaned, without a profile marker. It then ensures the dedicated bundle/link, seeds as needed, writes `.dsh-profile-migrations.json`, and exits. Its Host guard accepts the same `--host`/`--port` options as `scripts/fork-plugins-build.ts`. It is the only legacy owner and can be deleted after every maintained profile is migrated.

`scripts/fork-plugins-build.ts` uses `--dsh-home`, then `DSH_HOME`, then the platform launcher default — `<checkout parent>\deepseek-harness-data` on Windows and `~/.dsh` on macOS/Linux, expanding a leading `~` — and targets `profiles/web`. It stages each package under the ignored `.build/fork-plugins/<id>/` directory and installs each stage with `dsh plugin --profile web add <absolute staged directory>`, which records a pnpm `link:`. It records a source key, so an unchanged second run neither rebuilds nor reinstalls, and it seeds a fresh profile only after the install succeeds. No Session, attachment, credential, projection-cache, or `.agent-teams` data is read or written.

- Subscriptions compiles `lib/index.js` and `lib/client.js` from source. The staged manifest inlines `@tormentalabs/claude-code-wire-compat` (from the `fork-plugins/claude-code-wire-compat` source, whose `dist/` the build compiles with the repository TypeScript compiler) and `undici`, removes the type-only `@deepseek-ai/dsh-llm-request-record` peer, and declares no runtime dependency. Public optional provider entries (`@cursor/sdk`, `@oven/bun-*`) stay declared; a link install does not install a linked package's optional dependencies, so those providers need the package available separately. The staged package ships no declarations; the source checkout remains the type source.
- AetherShell compiles `lib/lifecycle.mjs` from source and keeps every `@deepseek-ai/*` peer external at `0.2.1-rc.2`.
- AgentTeams and Context build in isolated work copies under `.build/fork-plugins/work/`; staging reads their built output there, never a committed `lib/`. Context keeps its `zod` runtime dependency, resolved from the repository install.
- The workspace `@deepseek-ai/dsh-llm-cc-pool` package is copied from the root build output into `.build/fork-plugins/llm-cc-pool/` and linked as a provider bundle beside the fork plugins.

Run the step directly when diagnosing a build (the Host-stopped rule still applies):

```powershell
$env:DSH_HOME = 'C:\path\to\isolated-home'
pnpm exec tsx scripts/fork-plugins-build.ts
```

## macOS profile setup

`build.command` prepares the macOS toolchain, runs `pnpm install`, and runs the root build; it does **not** build or link the fork plugins. After it succeeds, stop any running DSH and run the staging script directly from the repository root:

```sh
pnpm exec tsx scripts/fork-plugins-build.ts
./run.command
```

The script defaults to `~/.dsh` on macOS, stages under `.build/fork-plugins/`, and links the packages into `profiles/web`; the Host-stopped rule above still applies. `setup.command` and `setup-profile.mjs` were retired on 2026-10-18, so there is no separate installer or `--dry-run`. Each machine still owns its marketplace plugins, watchdogs, custom presets, and process-worker profiles separately.

## Agent Teams

- Source: `fork-plugins/dsh-agent-teams`
- Current private version: `0.1.24-dsh021rc2.1`
- Upstream base: `NanmiCoder/dsh-agent-teams v0.1.24`
- Profile target: DSH `0.2.1-rc.2`
- Profile install: `link:` to `.build/fork-plugins/agent-teams`

Upstream v0.1.24 adapts member creation, cancellation, and recovery to Harness `0.2.1-rc.2`, and preserves member roles and custom tool restrictions across plugin reloads. The private layer keeps awaited `agent/created` startup, projection refresh for cold member navigation, a typed `agent-teams-host` message source, Captain mailbox recovery, and the bounded unread-mailbox cache without changing the on-disk format.

Each Team message enters the durable Team mailbox before Host delivery. The plugin marks it delivered only after the Host accepts it into the DSH durable inbox; a recipient already inside a non-interruptible tool consumes that queued input after the tool settles rather than being preempted. Failed Host delivery leaves the Team record retryable, while an inactive Captain cold-resumes and replays unacknowledged rows in order.

Members include the current `attempt_id` in every task update. Omitting it produces a retryable error that names the current id without revoking the attempt; supplying a different id is a genuinely stale update and is rejected after takeover or reassignment.

After cloning this fork, setting their own `DSH_HOME`, and stopping any running DSH instance, a colleague can run this from the repository root:

```powershell
.\build.cmd
```

This installs and builds the repository, then stages and links the fork plugins into that colleague's `web` profile. It does not copy or overwrite any Session, attachment, or `.agent-teams` data.

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

Reapply or retire the fork behavior listed in `FORK_MAINTENANCE.md`, advance the private version, and re-run `build.cmd` (or `scripts/fork-plugins-build.ts`) to stage the new source. Never install npm `@latest` directly into a real profile.

Agent Teams durable data belongs to each workspace's `.agent-teams/` directory; this directory contains only code and distribution artifacts. Plugin updates must not scan, modify, migrate, or delete existing `.agent-teams` data, DSH Sessions, or attachments.

## Context

- Source: `fork-plugins/dsh-context`
- Current private version: `0.73.0-dsh021rc2.1`
- Upstream base: `bowenliang123/dsh-context v0.73.0`
- Profile install: `link:` to `.build/fork-plugins/context`

The private pricing catalog covers GPT-6 Astra/Sol, Claude Opus 5.5/Fable 5.1, and Grok 4.7 through Cursor. Agent totals include standard-speed API-equivalent prices and per-request long-context tiers; projection version 21 refolds existing logs without changing Session data. See [prices and assumptions](dsh-context/docs/model-pricing.md).

This build adopts v0.73.0's `foldState`/`foldMetering`/`foldWire` split, Context Insights, balance display, incremental turn counting, selective tool-argument retention, and on-demand corpus backfill. Maintenance-preserved fork behavior and rollback rules are listed in `fork-plugins/dsh-context/FORK_MAINTENANCE.md`.

The low-overhead deployment values are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, `maxArchiveNodes: 100`, and `maxFileOps: 100`. Confirm that DSH has stopped before changing a profile. Never read, migrate, or delete Session, attachment, credential, or projection-cache data during a plugin update.

## Subscriptions

- Source: `fork-plugins/dsh-plugin-subscriptions`
- Current private version: `0.9.4-dsh021rc2.1`
- Upstream base: `V1ki/dsh-plugin-subscriptions v0.9.4`
- Profile target: DSH `0.2.1-rc.2`
- Profile install: `link:` to `.build/fork-plugins/subscriptions`

The private build keeps upstream multi-account providers, usage UI, Codex search, image/video tools, and credential format. Its 0.2.1 adaptation translates V4 tool-role messages without losing call identity or image results and pins the exact DSH dependency cohort; no Session or credential migration is introduced. Cursor login, usage, and local-SDK limits, ChatGPT reset-credit display, and the ChatGPT pool's 100 percent full mark are private behaviors. Reapply them from `fork-plugins/dsh-plugin-subscriptions/FORK_MAINTENANCE.md` after every upstream import.

## AetherShell

- Source: `fork-plugins/dsh-plugin-aether-shell`
- Current private version: `0.1.0-dsh021rc2.4`
- Package: `@ryanzhou416/dsh-plugin-aether-shell v0.1.0`
- Profile target: DSH `0.2.1-rc.2`
- Profile install: `link:` to `.build/fork-plugins/aether-shell`

The bundle keeps every `@deepseek-ai/*` peer external at `0.2.1-rc.2` and is a pure Host plugin with no client assets. It requires the external AetherShell interpreter — legacy mode targets `12.0.2`, typed mode requires `12.0.2+ryan.2` — and the plugin does not redistribute it. See `fork-plugins/dsh-plugin-aether-shell/FORK_MAINTENANCE.md` for preservation and verification.
