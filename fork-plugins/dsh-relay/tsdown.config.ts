/**
 * Standalone tsdown config: the node half is bundled from `src/index.ts` and
 * the browser half from `src/client/index.ts` with the closure-factory
 * wrapper the web shell's module table expects. The shared client options live
 * in `tsdown.client.options.mjs`, which the repository staging build imports
 * directly so both builds apply the same recipe.
 */
import { defineConfig } from 'tsdown'
import { clientBuildOptions } from './tsdown.client.options.mjs'

export default defineConfig([
  {
    name: 'dsh-relay',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: true,
    deps: {
      neverBundle: [/^@deepseek-ai\//],
    },
  },
  {
    ...clientBuildOptions,
    clean: false,
  },
])
