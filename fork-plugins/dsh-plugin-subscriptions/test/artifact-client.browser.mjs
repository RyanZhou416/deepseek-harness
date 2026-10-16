// Packed client-face materialization for dsh-plugin-subscriptions.
//
// Materializes the packed lib/client.js factory under the maintained production
// ClientModuleSystem with the real platform seed (react, react/jsx-runtime,
// react-dom, the built ui-primitives library) in a headless Chromium page: no
// server, no network route, no persistent profile, no download. It registers and
// materializes the factory only — apply is never called, so this claims no UI
// rendering and no platform/UI compatibility beyond the module table.
//
// The page script is bundled by the installed Vite Node API (configFile: false,
// build.write: false): Vite's own CSS pipeline compiles the ui-primitives CSS
// modules, and without a config file there is no tsconfig path aliasing, so every
// first-party import must resolve through a package export to built lib/.
//
// Run from any cwd: node test/artifact-client.browser.mjs
// Env:
//   DSH_SUBSCRIPTIONS_ARTIFACT_ROOT     mandatory absolute unpacked package root
//   DSH_CLIENT_MODULES_ENTRY            optional absolute built .../lib/types/client/index.js
//   DSH_CLIENT_UI_PRIMITIVES_ENTRY      optional absolute built .../ui-primitives/lib/index.js
//   DSH_VITE_MODULE                     mandatory absolute vite dist/node/index.js
//   PLAYWRIGHT_PATH                     mandatory absolute playwright package root (index.mjs is appended)
//   DSH_PLAYWRIGHT_CHROMIUM_EXECUTABLE  optional absolute chromium executable
//
// Launch inputs are explicit paths only: no directory scan, no module resolution
// fallback, no install, and no browser download.
import assert from 'node:assert/strict'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..')
const CHECKOUT_ROOT = resolve(PLUGIN_ROOT, '..', '..')
const CANDIDATE_ID = 'dsh-plugin-subscriptions'
const CANDIDATE_VERSION = '0.9.4-dsh017rc1.30'
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const PLATFORM_SPECIFIERS = ['react', 'react/jsx-runtime', 'react-dom', PRIMITIVES]
const CLIENT_SERVICE_INJECT = ['slots', 'connection', 'locale']
const VIRTUAL_ID = 'virtual:dsh-artifact-client-table'
const VIRTUAL_RESOLVED = `\0${VIRTUAL_ID}`

/** Require an absolute path from the environment; a relative or empty value is a run defect, never a fallback. */
function absoluteFromEnv(name) {
  const value = process.env[name]
  assert.ok(typeof value === 'string' && value.trim().length > 0, `${name} must be set to an absolute path`)
  assert.ok(isAbsolute(value), `${name} must be an absolute path, got ${JSON.stringify(value)}`)
  return value
}

/** Require a real file at `path`, naming the remedy instead of substituting a source tree. */
function requireFile(path, subject, remedy) {
  assert.ok(existsSync(path), `${subject} is missing at ${path}${remedy === undefined ? '' : ` — ${remedy}`}`)
  assert.ok(statSync(path).isFile(), `${subject} at ${path} must be a file, not a directory`)
  return realpathSync(path)
}

/** The built face a path must name: emitted under lib/, never a TypeScript source. */
function requireBuiltFace(path, subject) {
  assert.ok(!/\.tsx?$/.test(path), `${subject} must be built output, got the source path ${path}`)
  assert.ok(/[\\/]lib[\\/]/.test(path), `${subject} must be built output under lib/, got ${path}`)
  return path
}

const artifactRoot = realpathSync(absoluteFromEnv('DSH_SUBSCRIPTIONS_ARTIFACT_ROOT'))
const manifest = JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8'))
assert.equal(manifest.name, CANDIDATE_ID, 'DSH_SUBSCRIPTIONS_ARTIFACT_ROOT must hold the packed candidate')
assert.equal(manifest.version, CANDIDATE_VERSION, 'DSH_SUBSCRIPTIONS_ARTIFACT_ROOT must hold the exact packed revision')
const clientEntry = requireFile(join(artifactRoot, 'lib', 'client.js'), 'the packed client bundle')
const clientBundle = await readFile(clientEntry, 'utf8')

const modulesEntry = requireBuiltFace(
  requireFile(
    process.env.DSH_CLIENT_MODULES_ENTRY ?? join(CHECKOUT_ROOT, 'packages', 'client', 'modules', 'lib', 'types', 'client', 'index.js'),
    'the built ClientModuleSystem face',
    'build that package with tsc or pass DSH_CLIENT_MODULES_ENTRY; src is never substituted',
  ),
  'the ClientModuleSystem face',
)
const primitivesEntry = requireBuiltFace(
  requireFile(
    process.env.DSH_CLIENT_UI_PRIMITIVES_ENTRY ?? join(CHECKOUT_ROOT, 'packages', 'client', 'ui-primitives', 'lib', 'index.js'),
    'the built ui-primitives browser library',
    'build that package in the maintained checkout or pass DSH_CLIENT_UI_PRIMITIVES_ENTRY; src is never substituted',
  ),
  'the ui-primitives library',
)
// React identity comes from the ui-primitives entry's own resolution root, so the
// page never mixes two react instances.
const fromPrimitives = createRequire(pathToFileURL(primitivesEntry))
const platformEntries = {
  'react': fromPrimitives.resolve('react'),
  'react/jsx-runtime': fromPrimitives.resolve('react/jsx-runtime'),
  'react-dom': fromPrimitives.resolve('react-dom'),
}

const viteModule = requireFile(absoluteFromEnv('DSH_VITE_MODULE'), 'the vite module', 'point DSH_VITE_MODULE at the vite dist/node/index.js Node API entry')
const playwrightModule = requireFile(join(absoluteFromEnv('PLAYWRIGHT_PATH'), 'index.mjs'), 'the playwright module', 'point PLAYWRIGHT_PATH at the playwright package root')
const { build } = await import(pathToFileURL(viteModule).href)
const { chromium } = await import(pathToFileURL(playwrightModule).href)
const executablePath = process.env.DSH_PLAYWRIGHT_CHROMIUM_EXECUTABLE === undefined
  ? undefined
  : requireFile(absoluteFromEnv('DSH_PLAYWRIGHT_CHROMIUM_EXECUTABLE'), 'the chromium executable')

// Vite is not a Node import loader: the page's imports name absolute filesystem
// paths in forward-slash form, while the driver's own dynamic imports stay URLs.
const moduleSpecifier = path => path.replace(/\\/g, '/')
const entrySource = `
import * as modulesClient from ${JSON.stringify(moduleSpecifier(modulesEntry))}
import * as reactNamespace from ${JSON.stringify(moduleSpecifier(platformEntries['react']))}
import * as jsxRuntimeNamespace from ${JSON.stringify(moduleSpecifier(platformEntries['react/jsx-runtime']))}
import * as reactDomNamespace from ${JSON.stringify(moduleSpecifier(platformEntries['react-dom']))}
import * as primitivesNamespace from ${JSON.stringify(moduleSpecifier(primitivesEntry))}

const MODULES_ID = ${JSON.stringify(MODULES_ID)}
const CANDIDATE_ID = ${JSON.stringify(CANDIDATE_ID)}
const state = { factoryCalls: 0, required: Object.create(null), loadBundleCalls: 0, target: undefined, modules: undefined }
const seeds = {
  'react': reactNamespace.default ?? reactNamespace,
  'react/jsx-runtime': jsxRuntimeNamespace.default ?? jsxRuntimeNamespace,
  'react-dom': reactDomNamespace.default ?? reactDomNamespace,
  ${JSON.stringify(PRIMITIVES)}: primitivesNamespace,
}
const target = {
  mode: 'queue',
  pendingQueue: [],
  load(registration) {
    target.pendingQueue.push({
      id: registration.id,
      ...(registration.chunk === undefined ? {} : { chunk: registration.chunk }),
      factory(require) {
        state.factoryCalls += 1
        const capture = (specifier) => {
          const value = require(specifier)
          state.required[specifier] = value
          return value
        }
        capture.async = require.async
        return registration.factory(capture)
      },
    })
  },
  create(options) {
    return modulesClient.createClientModuleSystem(target, { id: MODULES_ID, exports: modulesClient }, options)
  },
}
state.target = target
window.__ModuleLoader__ = target
window.__dshArtifact = {
  seeds,
  state,
  pendingLength: () => target.pendingQueue.length,
  factoryCalls: () => state.factoryCalls,
  async createAndImport(id) {
    const pendingBeforeCreate = target.pendingQueue.length
    const callsBeforeCreate = state.factoryCalls
    const url = './client.js?rev=0'
    const modules = target.create({
      boot: {
        rev: '0',
        entries: [{ id, url, rev: '0', inject: [], external: [] }],
        batches: [{ phase: 'application', url, rev: '0', entries: [id] }],
      },
      staticModules: seeds,
      loadBundle: (bundleUrl) => {
        state.loadBundleCalls += 1
        return Promise.reject(new Error('no bundle transport: ' + bundleUrl))
      },
    })
    state.modules = modules
    const materializedBeforeImport = modules.loadCache.has(id)
    const exported = await modules.import(id)
    const record = modules.loadCache.get(id)
    return {
      pendingBeforeCreate,
      callsBeforeCreate,
      materializedBeforeImport,
      factoryCalls: state.factoryCalls,
      edges: record === undefined ? null : [...record.edges],
      exportsIsObject: typeof exported === 'object' && exported !== null,
      applyType: typeof exported.apply,
      inject: Array.isArray(exported.inject) ? [...exported.inject] : null,
      requiredKeys: Object.keys(state.required),
      seedIdentity: { react: state.required['react'] === seeds['react'], jsxRuntime: state.required['react/jsx-runtime'] === seeds['react/jsx-runtime'], reactDom: state.required['react-dom'] === seeds['react-dom'], primitives: state.required[${JSON.stringify(PRIMITIVES)}] === seeds[${JSON.stringify(PRIMITIVES)}] },
      seedReal: { createElement: typeof seeds['react'].createElement === 'function', jsx: typeof seeds['react/jsx-runtime'].jsx === 'function', createPortal: typeof seeds['react-dom'].createPortal === 'function', Button: typeof seeds[${JSON.stringify(PRIMITIVES)}].Button === 'function', StateDot: typeof seeds[${JSON.stringify(PRIMITIVES)}].StateDot === 'function' },
      loadBundleCalls: state.loadBundleCalls,
    }
  },
}
`

const pageErrors = []
const consoleErrors = []
let networkAttempts = 0
let buildOutput
let browser
let context

try {
  const observedModules = new Set()
  buildOutput = await build({
    configFile: false,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'dsh-artifact-client-table',
        enforce: 'pre',
        resolveId: id => (id === VIRTUAL_ID ? VIRTUAL_RESOLVED : null),
        load: id => (id === VIRTUAL_RESOLVED ? entrySource : null),
      },
      {
        name: 'dsh-artifact-module-observation',
        generateBundle(_options, bundle) {
          for (const file of Object.values(bundle)) {
            if (file.type !== 'chunk') continue
            for (const id of Object.keys(file.modules)) observedModules.add(id)
          }
        },
      },
    ],
    build: {
      write: false,
      lib: { entry: VIRTUAL_ID, formats: ['iife'], name: 'DshArtifactClientTable', fileName: () => 'artifact-client-table.js' },
      // Vite resolves libOptions.entry to an absolute path when rollupOptions.input
      // is absent (vite 6.4.3 dep-Dm0c1Wj2.js:46170); the explicit virtual input keeps
      // the plugin-resolved id instead.
      rollupOptions: { input: VIRTUAL_ID, output: { inlineDynamicImports: true } },
    },
  })
  const bundleOutput = Array.isArray(buildOutput) ? buildOutput[0] : buildOutput
  const chunk = bundleOutput.output.find(file => file.type === 'chunk')
  assert.ok(chunk !== undefined && typeof chunk.code === 'string', 'the virtual entry must produce one script chunk')
  // configFile:false means no tsconfig path aliasing: a first-party module that
  // reached the bundle outside lib/ proves a source fallback.
  const builtModules = [...observedModules].map(id => id.replace(/\\/g, '/'))
  for (const id of builtModules) {
    if (id.startsWith('\0') || !/\/(packages|vendor)\//.test(id)) continue
    assert.ok(!/\/src\//.test(id), `bundled module ${id} fell back to a source tree`)
    assert.ok(/\/lib\//.test(id), `bundled first-party module ${id} is not built output under lib/`)
  }
  assert.ok(builtModules.some(id => id.includes('ui-primitives/lib/index.js')), 'the built ui-primitives library must be the bundled seed')

  browser = await chromium.launch({ headless: true, ...(executablePath === undefined ? {} : { executablePath }) })
  const launchContext = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', offline: true })
  context = launchContext
  const page = await launchContext.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.route('**/*', route => {
    networkAttempts += 1
    return route.abort()
  })

  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
  await page.addScriptTag({ content: chunk.code })
  const queueBefore = await page.evaluate(() => window.__dshArtifact.pendingLength())
  const callsBefore = await page.evaluate(() => window.__dshArtifact.factoryCalls())
  assert.equal(queueBefore, 0, 'the module table must start with an empty pending queue')
  assert.equal(callsBefore, 0, 'the module table must not execute a factory before the packed script runs')

  await page.addScriptTag({ content: clientBundle })
  const facts = await page.evaluate(id => window.__dshArtifact.createAndImport(id), CANDIDATE_ID)

  assert.equal(facts.pendingBeforeCreate, 1, 'the packed bundle must register exactly one factory')
  assert.equal(facts.callsBeforeCreate, 0, 'registration must not execute the factory')
  assert.equal(facts.materializedBeforeImport, false, 'the factory must stay unmaterialized until import')
  assert.equal(facts.factoryCalls, 1, 'the factory must materialize exactly once')
  assert.deepEqual(facts.edges?.slice().sort(), [...PLATFORM_SPECIFIERS].sort(), 'the factory must request exactly the platform seed words')
  assert.equal(facts.exportsIsObject, true, 'materialization must return the bundle exports')
  assert.equal(facts.applyType, 'function', 'the materialized exports must carry apply')
  assert.deepEqual(facts.inject, CLIENT_SERVICE_INJECT, 'the client service inject must match the packed declaration')
  assert.deepEqual(facts.requiredKeys.slice().sort(), [...PLATFORM_SPECIFIERS].sort())
  assert.deepEqual(facts.seedIdentity, { react: true, jsxRuntime: true, reactDom: true, primitives: true }, 'every required seed word must be the real module the page bundled')
  assert.deepEqual(facts.seedReal, { createElement: true, jsx: true, createPortal: true, Button: true, StateDot: true }, 'the seeded modules must be the real React and ui-primitives library')
  assert.equal(facts.loadBundleCalls, 0, 'materialization must never request a bundle over the transport')
  assert.equal(networkAttempts, 0, 'the page must make no network request')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(consoleErrors, [])

  console.log(JSON.stringify({
    ok: true,
    artifactRoot,
    clientEntry,
    modulesEntry,
    primitivesEntry,
    platformEntries,
    viteModule,
    playwrightModule,
    virtualEntry: VIRTUAL_ID,
    bundledFirstPartyModules: builtModules.filter(id => /\/(packages|vendor)\//.test(id)),
    builtModuleCount: builtModules.length,
    executablePath: executablePath ?? null,
    facts,
    networkAttempts,
    pageErrors,
    consoleErrors,
  }, null, 2))
} finally {
  if (context !== undefined) await context.close()
  if (browser !== undefined) await browser.close()
}
