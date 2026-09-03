# dsh-context fork maintenance

This subtree carries the DeepSeek Harness fork build of `dsh-context`. It retains the upstream Apache-2.0 `LICENSE` and keeps every fork-modified source and test file marked with a `DeepSeek Harness fork modification` notice.

## Provenance

- Upstream repository: `https://github.com/bowenliang123/dsh-context.git`
- Upstream tag: `v0.41.3`
- Upstream commit: `dce08e0db3ad1dae40da0eb586e7da7f587b32b6`
- Fork package version: `0.41.3-dsh012rc1.1`
- Subtree path: `fork-plugins/dsh-context`
- Distribution artifact: `fork-plugins/releases/dsh-context-0.41.3-dsh012rc1.1.tgz`

## Fork behavior

The fork preserves the package name, Cordis ids, projection keys, wire schemas, persisted `TimelineState` schema and `stateVersion`, and session event vocabulary.

The timeline fold uses field-level copy-on-write state. An event clones only the arrays or records it mutates, and a normalized state checks retention only for request, event, or archive collections changed by that event. Restored checkpoint state is clamped through the same whole-turn, hard-step, event-tail, and archive-floor rules before the first wire value is built; this view-time clamp does not modify the checkpoint.

Each projection definition retains a weak reference cache keyed by the visible state inputs. Host-only changes such as a pending tool-call name or the open step timing slot reuse the prior raw wire value, so the RC.1 projection registry's `Object.is` check suppresses schema validation and `session/projection` publication. Any visible input change receives a fresh identity.

The `/context` overlay keeps only its modal-store gate mounted while closed. Projection and conversation hooks, the browser tree, keyboard handling, and layout observation mount with the open body and dispose when it closes.

The low-overhead deployment bounds are `maxRequestSteps: 300`, `maxKeptTurns: 60`, `maxEvents: 100`, `maxNodes: 400`, and `maxArchiveNodes: 100`. Bounds remain ordinary Cordis plugin configuration and do not change stored or wire fields.

## Verification and packaging

Run commands from this directory. Keep each test invocation below the repository's 20-second task limit.

```powershell
corepack pnpm@11.9.0 install --frozen-lockfile --ignore-scripts
corepack pnpm@11.9.0 typecheck
corepack pnpm@11.9.0 exec vitest run tests/host/fold-events.spec.ts tests/host/fold-retention.spec.ts tests/host/fold-surface.spec.ts tests/host/fold-timing.spec.ts tests/host/fold-view.spec.ts tests/host/fold-performance.spec.ts tests/host/timeline.spec.ts tests/client/components/contextModal.spec.ts --coverage.enabled=false
corepack pnpm@11.9.0 build
corepack pnpm@11.9.0 pack --pack-destination ..\releases
```

Store the artifact's uppercase SHA-256 beside it as `dsh-context-0.41.3-dsh012rc1.1.tgz.sha256`. Inspect the tarball manifest and its embedded `package.json` version before installation.

## Updating upstream

Confirm the repository worktree contains no unrelated changes, then import a reviewed upstream tag through the existing subtree:

```powershell
git subtree pull --prefix=fork-plugins/dsh-context https://github.com/bowenliang123/dsh-context.git <tag> --squash
```

Reapply or retire each behavior in this document, preserve the file-level fork notices, advance the private version, run focused compatibility and behavior tests, build, pack, and record the new artifact hash. Never update a real profile with an unreviewed npm `@latest` package.

## Rollback

Rollback uses a retained, verified artifact and leaves projection caches and Session data intact. The unchanged projection key, `stateVersion`, wire schema, and event vocabulary require no data migration. If a future upstream merge changes any of those fields, that release needs its own compatibility and rollback decision before packaging.
