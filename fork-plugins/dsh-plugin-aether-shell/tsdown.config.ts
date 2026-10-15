/** Build the optional Host plugin without bundling the Harness's shared runtime identities. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  cwd: import.meta.dirname,
  entry: { lifecycle: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: /^@deepseek-ai\// },
})
