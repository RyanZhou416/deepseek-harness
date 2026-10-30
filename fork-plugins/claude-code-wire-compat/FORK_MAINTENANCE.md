# Fork maintenance: claude-code-wire-compat

This directory is the DeepSeek Harness-maintained fork of
[`@tormentalabs/claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat).
The subscriptions plugin and `scripts/fork-plugins-build.ts` consume it from
this source checkout, so it has no separate tarball release.

## Provenance

- Upstream repository: `marco-jardim/claude-code-wire-compat`
- Upstream base commit: `d5b036a` (`Release 0.7.2-dsh15: preserve clear_at
  through the cache-control pass`)
- Package name, version (`0.7.2-dsh15`), license (`GPL-3.0-or-later`), and
  provenance files are preserved from upstream. Do not rename or re-version
  the package: the consumer's `CLAUDE_WIRE_RECORD_LIBRARY` and the
  `llm/request-record` snapshots identify this exact pin.
- `LICENSE` and `NOTICE` stay with the source tree; staging copies them into
  the subscriptions package's `third-party-licenses/claude-code-wire-compat/`.

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

The full upstream suite is not green in this fork:
`test/runtime/runtime-neutral.test.ts` pins a public export list that predates
`supportsContextManagement`, so that one test fails with or without the
import. It is unrelated to the `clear_at` fix and is not edited here.

Two environment traps make a local full run look worse than the committed
tree:

- `test/docs/provenance.test.ts` compares exact header lines, so a CRLF
  working copy makes the 18 ported protocol documents fail. This fork's
  `.gitattributes` pins `eol=lf` for the tree; check the checkout's line
  endings before attributing those failures to the import.
- `test/pack/pack-policy.test.ts` shells out to `pack --ignore-scripts`.
  A DSH shell exports `npm_execpath` as pnpm 11, which rejects that flag.
  Run the suite with the npm CLI (`Remove-Item Env:npm_execpath`) when
  checking the packed-file policy.

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
