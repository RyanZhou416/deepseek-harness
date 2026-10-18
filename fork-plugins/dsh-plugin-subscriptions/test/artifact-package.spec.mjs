/**
 * Artifact acceptance for the offline-packed dsh-plugin-subscriptions release.
 * Every case reads the unpacked package named by DSH_SUBSCRIPTIONS_ARTIFACT_ROOT;
 * a missing, relative, or manifest-less root fails outright rather than falling
 * back to the checkout or skipping. No process spawn, listener, network use, or
 * process.env mutation.
 */
import assert from 'node:assert/strict'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT_ENV = 'DSH_SUBSCRIPTIONS_ARTIFACT_ROOT'
const PACKAGE_NAME = 'dsh-plugin-subscriptions'
const PACKAGE_VERSION = '0.9.4-dsh017rc1.33'

const declaredRoot = process.env[ROOT_ENV]
assert.ok(typeof declaredRoot === 'string' && declaredRoot.trim().length > 0, `${ROOT_ENV} must name the unpacked package root`)
assert.ok(isAbsolute(declaredRoot), `${ROOT_ENV} must be an absolute path`)
assert.ok(existsSync(join(declaredRoot, 'package.json')), `${ROOT_ENV} must point at a package root containing package.json`)

const ARTIFACT_ROOT = realpathSync(declaredRoot)
const MANIFEST_PATH = join(ARTIFACT_ROOT, 'package.json')

/** Whether a real path stays inside the artifact root. */
function insideRoot(target) {
  const rel = relative(ARTIFACT_ROOT, realpathSync(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The one loader registration the browser bundle protocol allows. */
function assertSingleFactoryRegistration(registrations) {
  assert.equal(registrations.length, 1, 'exactly one module registration')
  const [entry] = registrations
  assert.ok(entry && typeof entry === 'object', 'a registration must be an object')
  assert.equal(entry.id, PACKAGE_NAME)
  assert.equal(typeof entry.factory, 'function')
  return entry
}

test('packed manifest declares the artifact identity and lib-only faces', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  assert.ok(manifest && typeof manifest === 'object', 'the manifest must be a JSON object')
  assert.equal(manifest.name, PACKAGE_NAME)
  assert.equal(manifest.version, PACKAGE_VERSION)
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.types, 'lib/index.d.ts')

  const exportsMap = manifest.exports
  assert.ok(exportsMap && typeof exportsMap === 'object', 'exports must be an object')
  const rootFace = exportsMap['.']
  const clientFace = exportsMap['./client']
  assert.ok(rootFace && typeof rootFace === 'object', 'exports["."] must be an object')
  assert.ok(clientFace && typeof clientFace === 'object', 'exports["./client"] must be an object')
  assert.equal(rootFace.default, './lib/index.js')
  assert.equal(rootFace.types, './lib/index.d.ts')
  assert.equal(clientFace.default, './lib/client.js')
  assert.equal(clientFace.types, './lib/client/index.d.ts')
  // main/types and the root export name the same entry: the three faces agree.
  assert.equal(`./${manifest.main}`, rootFace.default)
  assert.equal(`./${manifest.types}`, rootFace.types)

  const faces = [
    ['main', manifest.main, '.js'],
    ['types', manifest.types, '.d.ts'],
    ['exports["."].default', rootFace.default, '.js'],
    ['exports["."].types', rootFace.types, '.d.ts'],
    ['exports["./client"].default', clientFace.default, '.js'],
    ['exports["./client"].types', clientFace.types, '.d.ts'],
  ]
  for (const [label, target, suffix] of faces) {
    const normalized = String(target).replace(/^\.\//, '')
    const segments = normalized.split('/')
    assert.equal(segments[0], 'lib', `${label} must stay inside lib/`)
    assert.ok(!segments.includes('src'), `${label} must not name a source tree`)
    assert.ok(normalized.endsWith(suffix), `${label} must be a built ${suffix} file, not source`)
    const absolute = resolve(ARTIFACT_ROOT, normalized)
    assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `${label} target ${normalized} must be a packed file`)
    assert.ok(insideRoot(absolute), `${label} target ${normalized} must resolve inside the artifact root`)
  }

  // Named packed-root absences; the payload gate owns the recursive sweep.
  for (const rejected of ['src', 'test', 'lib-test', 'lib/client.js.map']) {
    assert.equal(existsSync(join(ARTIFACT_ROOT, rejected)), false, `${rejected} must not be packed`)
  }
})

test('artifact lib/index.js imports under plain Node and resolves its schema defaults', async (t) => {
  // Plain Node only: a source loader or a tsx tsconfig would let a development
  // tree satisfy this import.
  const loaderFlags = ['--import', '--loader', '--experimental-loader']
  const isSourceLoaderToken = (token) => token.includes('tsx') || loaderFlags.some((flag) => token === flag || token.startsWith(`${flag}=`))
  const nodeOptions = (process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)
  assert.ok(!process.execArgv.some(isSourceLoaderToken) && !nodeOptions.some(isSourceLoaderToken), 'the artifact case must not run under a source loader')
  assert.equal((process.env.TSX_TSCONFIG_PATH ?? '').trim(), '', 'TSX_TSCONFIG_PATH must be unset')
  // Node's `--test` child normalizes `--no-experimental-strip-types` to the exact token `--no-strip-types`.
  const stripFlags = ['--no-experimental-strip-types', '--no-strip-types']
  assert.ok(process.allowedNodeEnvironmentFlags.has('--experimental-strip-types'), 'Node must support --experimental-strip-types')
  assert.equal(process.features.typescript, false, 'native type stripping must be off for this process')
  assert.ok(stripFlags.some((flag) => process.execArgv.includes(flag) || nodeOptions.includes(flag)), `${stripFlags.join(' or ')} must be in force for this process, not merely supported`)

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const entry = realpathSync(resolve(ARTIFACT_ROOT, manifest.main))
  const entryRel = relative(ARTIFACT_ROOT, entry).split(sep).join('/')
  assert.equal(entryRel, manifest.main.replace(/^\.\//, ''), 'the imported module must be the manifest entry')
  assert.ok(entry.endsWith('.js'), 'the artifact entry must be built JavaScript')
  assert.ok(insideRoot(entry), 'the artifact entry must stay inside the artifact root')

  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let fetchCalls = 0
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch
    else Object.defineProperty(globalThis, 'fetch', originalFetch)
  })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: () => {
      fetchCalls += 1
      throw new Error('the artifact import must not call fetch')
    },
  })

  const loaded = await import(pathToFileURL(entry).href)

  assert.equal(fetchCalls, 0, 'importing the packed entry must not call fetch')
  assert.equal(loaded.name, PACKAGE_NAME)
  assert.deepEqual([...loaded.inject], ['llm'])
  assert.equal(typeof loaded.apply, 'function')
  assert.equal(typeof loaded.Config, 'function')
  assert.equal(loaded.DEFAULT_CONTINUATION_STATE_DEADLINE_MS, 5000)
  assert.equal(loaded.DEFAULT_CONTINUATION_STATE_LOCK_TIMEOUT_MS, 2000)
  const resolved = loaded.Config({ providers: ['claude'] })
  assert.deepEqual([...resolved.providers], ['claude'])
  assert.equal(resolved.continuationStateDeadlineMs, 5000)
  assert.equal(resolved.continuationStateLockTimeoutMs, 2000)
  // A zero budget is a misconfiguration the schema refuses at load.
  assert.throws(() => loaded.Config({ providers: ['claude'], continuationStateDeadlineMs: 0 }))
  assert.throws(() => loaded.Config({ providers: ['claude'], continuationStateLockTimeoutMs: 0 }))
})

test('artifact lib/client.js registers one factory with the loader', async () => {
  const clientPath = join(ARTIFACT_ROOT, 'lib', 'client.js')
  const source = await readFile(clientPath, 'utf8')
  assert.ok(source.startsWith('window.__ModuleLoader__.load('), 'the browser bundle must register through window.__ModuleLoader__.load')

  const registrations = []
  const window = { __ModuleLoader__: { load: (entry) => registrations.push(entry) } }
  const context = vm.createContext({ window })
  const globalsBefore = Object.getOwnPropertyNames(context).sort()
  new vm.Script(source, { filename: clientPath }).runInContext(context)

  // Registration only: the sandbox installs no host or network surface, gains no
  // global, and the captured factory is never executed here. This proves the
  // registration protocol, not platform-module compatibility or UI rendering.
  assert.deepEqual(Object.getOwnPropertyNames(context).sort(), globalsBefore)
  assert.equal(context.process, undefined, 'the sandbox must not expose the host process')
  assert.deepEqual(Object.keys(window), ['__ModuleLoader__'])

  const entry = assertSingleFactoryRegistration(registrations)
  assert.equal(entry.id, PACKAGE_NAME)
  assert.equal(typeof entry.factory, 'function')

  // Negative control for the same check: no registration, duplicate
  // registrations, a foreign id, and a factory-less entry are all refused.
  assert.throws(() => assertSingleFactoryRegistration([]))
  assert.throws(() => assertSingleFactoryRegistration([entry, entry]))
  assert.throws(() => assertSingleFactoryRegistration([{ id: 'other-plugin', factory: entry.factory }]))
  assert.throws(() => assertSingleFactoryRegistration([{ id: PACKAGE_NAME }]))
})
