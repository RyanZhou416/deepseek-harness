/**
 * Plugin-local vitest projects. Specs import `src/` directly, never `lib/`, so
 * the suite needs no build step. The alias table mirrors the tsconfig `paths`
 * map for the host packages the plugin imports at runtime; everything else
 * resolves from the repository install.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const repository = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-credentials$/, replacement: fileURLToPath(new URL('../../packages/credentials/credentials/src/index.ts', import.meta.url)) },
      { find: /^@deepseek-ai\/dsh-brand$/, replacement: fileURLToPath(new URL('../../packages/util/brand/src/index.ts', import.meta.url)) },
      { find: /^@deepseek-ai\/dsh-home-paths$/, replacement: fileURLToPath(new URL('../../packages/util/home-paths/src/index.ts', import.meta.url)) },
      { find: /^@deepseek-ai\/schemastery$/, replacement: fileURLToPath(new URL('../../vendor/schemastery/src/index.ts', import.meta.url)) },
      { find: /^@deepseek-ai\/dsh-client-connection$/, replacement: fileURLToPath(new URL('../../packages/client/connection/src/index.ts', import.meta.url)) },
      { find: /^@deepseek-ai\/dsh-host-webserver$/, replacement: fileURLToPath(new URL('../../packages/host/webserver/src/index.ts', import.meta.url)) },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: fileURLToPath(new URL('../../packages/client/ui-primitives/src/index.ts', import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react/index.js', import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react/jsx-runtime.js', import.meta.url)) },
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react/jsx-dev-runtime.js', import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react-dom/index.js', import.meta.url)) },
      { find: /^react-dom\/client$/, replacement: fileURLToPath(new URL('../../node_modules/.pnpm/node_modules/react-dom/client.js', import.meta.url)) },
    ],
  },
  test: {
    reporters: ['dot'],
    projects: [
      {
        extends: true,
        test: {
          name: 'host',
          include: ['tests/host/**/*.spec.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'compose',
          include: ['tests/compose/**/*.spec.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        logLevel: 'error',
        test: {
          name: 'client',
          include: ['tests/client/**/*.spec.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['tests/client/setup.ts'],
          server: {
            deps: {
              inline: ['@deepseek-ai/dsh-client-ui-primitives'],
            },
          },
        },
      },
    ],
  },
  define: {
    __RELAY_REPOSITORY__: JSON.stringify(repository),
  },
})
