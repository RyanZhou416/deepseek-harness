/**
 * Package-private test composition for `@deepseek-ai/dsh-llm-request-record`: this
 * package's specs only, over the repository's shared resolution, decorator
 * transform, and environment hygiene. It exists so the package can be exercised
 * from a checkout that carries no repository-wide `vitest.config.ts`; it adds no
 * test library and no gate of its own.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  // The package directory, derived from this file rather than the invoking cwd.
  root: import.meta.dirname,
  plugins: [
    // Absolute so the mapping is the repository's, whatever root a caller passes.
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))] }),
    standardDecoratorPlugin(),
  ],
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: [
      fileURLToPath(new URL('../../../scripts/test-proxy-environment.ts', import.meta.url)),
      fileURLToPath(new URL('../../../scripts/test-invariants.ts', import.meta.url)),
    ],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    execArgv: vitestExecArgv,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
