# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with real browsers over real HTTP. Chromium runs the full lane; the [model and reasoning picker scenario](declared-reasoning.e2e.ts) also runs in WebKit to cover native mouse focus behavior. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

After installing workspace dependencies, install the browsers and their system dependencies from the repository root:

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

On Linux, `--with-deps` installs dependencies through the system package manager. The persistent CI VM must provide these dependencies through image maintenance; CI installs only the browser binaries, as required by the [failover runbook](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md).

Ordinary scenarios begin with no registered Workspace or Session and a durable marker recording a removed default Workspace, so explicit folder-selection scenarios retain control of their cwd. `launchWebScaffold({ firstUse: true })` leaves initialization eligible for startup scenarios.

## Manual load diagnostics

`complex-history.perf.ts` runs under `vitest.web.perf.config.ts` and reports large workspace/history costs, eight continued turns, and a 100-turn browser soak. Synthetic history reserves the current format's system head before user messages. The workspace case checks all stored Sessions and the five-row preview plus hidden count; Trajectory measurements use logical row counts because the table virtualizes mounted rows. Live tool turns execute the platform's shipped shell (`pwsh` on Windows, `bash` elsewhere) and assert the returned marker. Its GC checkpoints measure browser heap, DOM nodes, and listeners; the test retains observed Session events, so the test Host's RSS is not a product-retention measurement.

`../stress-tests/subagent-reconnect.stress.ts` runs under `vitest.web-stress.config.ts`: eight real continuable children produce paced synthetic output while a real WebSocket is closed and reconnected. It checks retained draft/title, complete durable child output, unique lifecycle events, and child release, and reports trusted keyboard-input and recovery times without a new timing budget. Both diagnostics use private temporary data, a source-resolved Host, and built Client assets; they exclude remote model latency.

Set `DSH_PERF_CAPTURE=1` for a separate diagnostic run of the default-window or fully expanded continuation cases. The first turn writes browser CPU profiles, a Chrome timeline, a Host CPU profile, and available source maps under `tmp/runtime-profiles/`. Capture uses an in-process Node inspector session without opening a listening port. It resolves the Send control before recording and checks only the recent message nodes during recording; profile-enabled timings include instrumentation and must stay separate from ordinary benchmark samples.

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. See the [CI fixture synchronization decision](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.md).

Explicit scrolling uses `scrollIntoView` from `support.ts`: it resolves the locator again when its old element detaches and checks connection in the same browser task as native scrolling. Scenarios retain their visibility and geometry assertions after scrolling.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript project, and every project it references, into the **Host build graph**. That has bitten this lane once already: four Client consumer packages reference `api/remotes`' Client face, which cannot compile until Host tsdown has generated `@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

The built-client harness is the exception. `assembled-boot.ts` imports `AppWebEntry`, the boot-manifest type, and `RemoteMock`; `assembled-remote.ts` imports the Client test runtime's default responses and `RemoteMock`. These packages are explicit project references for booting the real shell against a test-owned carrier. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
