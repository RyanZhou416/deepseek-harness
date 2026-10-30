# Fork maintenance: claude-code-wire-compat

This directory is the DeepSeek Harness-maintained fork of
[`@tormentalabs/claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat).
The subscriptions plugin and `scripts/fork-plugins-build.ts` consume it from
this source checkout; no tarball is a build input.

## Provenance

- Upstream repository: `marco-jardim/claude-code-wire-compat`
- Upstream release: `0.7.1`; its reviewed publication manifest is
  `release-manifests/0.7.1.json`.
- DSH delta: the fork adds the `clear_at` cache-control preservation and
  publishes it as `0.7.2-dsh16`. That version names the DSH build, not an
  upstream release. The retained
  `fork-plugins/releases/tormentalabs-claude-code-wire-compat-0.7.2-dsh15.tgz`
  is historical evidence of the previous DSH build, which first added the fix;
  the current `0.7.2-dsh16` build has no tarball.
- Package name and license (`GPL-3.0-or-later`) are preserved from upstream.
  Do not rename or re-version the package: the consumer's
  `CLAUDE_WIRE_RECORD_LIBRARY` and the `llm/request-record` snapshots identify
  this exact pin.
- `LICENSE` and `NOTICE` stay with the source tree. The compiled builder is
  inlined into the subscriptions bundle, so this GPL-3.0-or-later code ships
  inside that MIT-licensed plugin; staging copies both notices into
  `third-party-licenses/claude-code-wire-compat/` in the staged package.

The fork keeps the upstream history out of this checkout: only the source,
tests, configuration, build scripts, governance docs, and provenance files
were imported. Upstream `.git`, `node_modules`, `dist`, `coverage`, and the
per-release tarballs were intentionally not copied.

## Fork delta

The upstream `applyMessageCacheControl` rebuilt every message from `role` and
`content`, which dropped the mid-conversation system message's `clear_at`
field before the request was sent. The fork spreads the message first and
overrides only `content`, preserving every other field and the wire key order
`role`, `content`, `clear_at`:

```ts
const result = value.map((message): Message => ({
  ...message,
  content: /* cache-control-applied content */,
}))
```

**Preservation rule.** Keep the message spread (`{ ...message, content }`,
not `{ role, content }`) in `applyMessageCacheControl` and keep the key order
`role`, `content`, `clear_at`. A user message cannot carry the field, so the
user-breakpoint rebuild after it still owns only `role` and `content`. Do not
replace the source package with the historical
`fork-plugins/releases/tormentalabs-claude-code-wire-compat-0.7.2-dsh15.tgz`
tarball; the tarball is retained only as history.

Two further deltas keep model identity and mid-conversation-system answers
consistent with the wire:

- `normalizeModelId` strips the request-time `[1m]`/`[2m]` marker before the
  dotted rewrite and the catalogue rungs, so a marked id and its plain
  spelling resolve to one identity. The package root exports it so a consumer
  that keys its own tables by model id asks the same question.
- `supportsMidConversationSystem` normalizes its argument before the catalogue
  lookup and is the one predicate both the beta composer and the builder use,
  so the header and the body cannot disagree about a marked or uncatalogued
  id.

## Build and verification

This package builds with its own TypeScript 6 toolchain; in the DSH checkout
the repository compiler produces the same output:

```powershell
node ..\..\node_modules\typescript\bin\tsc -p tsconfig.json
```

`dist/` is generated output and is not tracked. `prepare` runs the same
`tsc` build after a real install. The subscriptions plugin's `pnpm test`
runs `scripts/ensure-wire-compat.mjs` first, which builds `dist/` on demand
from the plugin's own TypeScript dependency.

Focused regression for the fork delta (from this directory, using the DSH
checkout's vitest):

```powershell
node ..\..\node_modules\vitest\vitest.mjs run test/validation/cache-control-strip.test.ts test/validation/beta-registry-2.1.280.test.ts test/validation/betas-2.1.280-push-sites.test.ts
```

The full upstream suite is green in this fork: 3659 tests pass with
`npm_execpath` unset, including both `test/pack/pack-policy.test.ts` cases.
`test/runtime/runtime-neutral.test.ts` pins the closed runtime export set; the
fork exports `normalizeModelId` from the package root and records it together
with the already-exported `supportsContextManagement`, so the runtime-neutral
test passes rather than failing on an unpinned export.

One environment trap makes a local full run look worse than the committed
tree: `test/docs/provenance.test.ts` compares exact header lines, so a CRLF
working copy makes the 18 ported protocol documents fail. This fork's
`.gitattributes` pins `eol=lf` for the tree; check the checkout's line
endings before attributing those failures to the import. Unset `npm_execpath`
when running the suite: a DSH shell exports it as pnpm 11, which rejects
`pack --ignore-scripts`; with it unset, the pack-policy cases pass.

## Updating from upstream

1. Fetch the new upstream commit and copy its `src/`, `test/`, `scripts/`,
   `docs/`, `release-manifests/`, `package.json`, and TypeScript/Vitest
   configuration over this directory (exclude `.git`, `node_modules`,
   `dist`, coverage, and `*.tgz`).
2. Re-apply the `applyMessageCacheControl` spread (the diff is in this file)
   and the `prepare` script.
3. Keep this file and the README fork note.
4. Build `dist`, run the focused regression above, then run the
   subscriptions plugin's `pnpm test`.
5. Update `FORK_MAINTENANCE.md` at the repository root and
   `fork-plugins/releases/README.md` if the pin or the build path changes.
