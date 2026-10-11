/** Give every Node test process a private Harness home before plugin imports run. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'

// Workspace primitives and plugin components share one renderer identity in Node,
// just as the Web module table supplies a single React instance to both bundles.
const workspaceRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react' || specifier.startsWith('react/')
      || specifier === 'react-dom' || specifier.startsWith('react-dom/')) {
      return { url: pathToFileURL(workspaceRequire.resolve(specifier)).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const previous = process.env.DSH_HOME
const previousTsconfig = process.env.TSX_TSCONFIG_PATH
process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.base.client.json', import.meta.url))
const temporaryRoot = realpathSync(tmpdir())
const testHome = realpathSync(mkdtempSync(join(temporaryRoot, 'dsh-subscriptions-test-')))
const leaf = relative(temporaryRoot, testHome)
if (!/^dsh-subscriptions-test-[^\\/]+$/.test(leaf)) throw new Error('test home escaped the temporary root')
process.env.DSH_HOME = testHome

process.on('exit', () => {
  if (previousTsconfig === undefined) delete process.env.TSX_TSCONFIG_PATH
  else process.env.TSX_TSCONFIG_PATH = previousTsconfig
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  rmSync(testHome, { recursive: true, force: true })
})
