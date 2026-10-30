// SPDX-License-Identifier: MIT
/**
 * Build the workspace wire-compat source package's `dist/` before this plugin
 * type-checks, tests or builds.
 *
 * The plugin resolves `@tormentalabs/claude-code-wire-compat` to
 * `fork-plugins/claude-code-wire-compat`, whose exports point at `dist/`.
 * That directory is generated and not tracked, so a clean checkout has to
 * build it once. It is also never a truth signal on its own: a `dist/` left
 * over from an earlier checkout predates whatever the compat `src/` now says,
 * and a test run against it silently exercises the previous builder. The
 * guard therefore rebuilds on every run instead of skipping when the files
 * exist, and a cheap mtime comparison would not fix it because a same-second
 * edit, a fresh clone and a restored artifact all defeat it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const compatRoot = resolve(pluginRoot, '..', 'claude-code-wire-compat')

const tsc = join(pluginRoot, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  process.stderr.write(
    `cannot build ${compatRoot}: ${tsc} is missing. Run pnpm install in ${pluginRoot} first.\n`,
  )
  process.exit(1)
}

process.stdout.write(`[subscriptions] building ${compatRoot} before type-checking\n`)
const result = spawnSync(process.execPath, [tsc, '-p', join(compatRoot, 'tsconfig.json')], {
  cwd: compatRoot,
  stdio: 'inherit',
})
if (result.error !== undefined) {
  process.stderr.write(`failed to start the compat TypeScript build: ${String(result.error)}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
