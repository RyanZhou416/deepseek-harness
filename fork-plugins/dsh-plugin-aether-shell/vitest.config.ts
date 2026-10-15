/** Source-plane tests for the optional fork-owned AetherShell plugin. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))] }),
    standardDecoratorPlugin(),
  ],
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    execArgv: vitestExecArgv,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
