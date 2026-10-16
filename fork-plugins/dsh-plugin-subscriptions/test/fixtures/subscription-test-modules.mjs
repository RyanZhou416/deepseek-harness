/**
 * The one product-module selection both Claude fixture probes read from.
 *
 * Both probes hand the same non-serializable internals to the same real plugin, so both read the
 * same product modules: the plugin entry, the Claude protocol profile, the account store, the
 * Claude device-id derivation, the host-egress readers and the account-reference comparator. This
 * module selects that closed set once per process and hands each probe the actual namespace or
 * export, so a probe names no plane of its own and both probes observe one plane.
 *
 * `DSH_SUBSCRIPTIONS_ARTIFACT_ROOT` absent selects the unbuilt source plane (the sibling `src`
 * modules through this child's tsx hook); present selects the installed artifact plane and must name
 * the absolute root of an installed `dsh-plugin-subscriptions` manifest of the pinned candidate
 * generation, so a blank, relative, unreadable or foreign root fails here instead of falling back to
 * source. That plane imports each module by absolute `file://` URL from `<root>/lib`, after the root
 * and the target are resolved and the target is confirmed to lie inside `lib`, and it refuses a
 * child that can still strip types or load a script hook: it is plain Node over built `.js`.
 *
 * Importing these modules reads no credential and starts no request — the plugin's network work
 * lives in `apply` — and this fixture reads no product option and invents no Host SDK argument.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Environment name selecting the installed artifact root; absent selects the source plane. */
const ARTIFACT_ROOT_ENV = 'DSH_SUBSCRIPTIONS_ARTIFACT_ROOT'

/** The manifest name and release suffix an artifact root must state. */
const PACKAGE_NAME = 'dsh-plugin-subscriptions'
const CANDIDATE_VERSION_SUFFIX = '.31'

/** The closed set both probes read: each module's sibling source, and its built file under `lib`. */
const PRODUCT_MODULES = {
  entry: { src: '../../src/index.ts', artifact: 'index.js' },
  accountRef: { src: '../../src/claude-core/account-ref.ts', artifact: 'claude-core/account-ref.js' },
  claudeProtocol: { src: '../../src/providers/claude-protocol.ts', artifact: 'providers/claude-protocol.js' },
  claude: { src: '../../src/providers/claude.ts', artifact: 'providers/claude.js' },
  store: { src: '../../src/auth/store.ts', artifact: 'auth/store.js' },
  hostEgress: { src: '../../src/transport/host-egress.ts', artifact: 'transport/host-egress.js' },
}

/** The named export a selected product module must carry, or this selection is unusable. */
function pick(namespace, name) {
  const value = namespace[name]
  if (value === undefined) throw new Error(`subscription-test-modules: the selected product module exports no ${name}`)
  return value
}

/** Resolve a path, refusing anything that is not a readable directory. */
function requireRealDirectory(path, label) {
  let resolved
  try {
    resolved = realpathSync(path)
  } catch (error) {
    throw new Error(`${label} is not a readable directory: ${path} (${String(error)})`)
  }
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
  return resolved
}

/** Resolve the installed root this process was pointed at, or refuse the value it was given. */
function resolveArtifactRoot(raw) {
  if (!isAbsolute(raw)) throw new Error(`${ARTIFACT_ROOT_ENV} must be an absolute root (got ${JSON.stringify(raw)})`)
  const root = requireRealDirectory(raw, ARTIFACT_ROOT_ENV)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`${ARTIFACT_ROOT_ENV} states no readable package.json (${String(error)})`)
  }
  if (manifest?.name !== PACKAGE_NAME || typeof manifest.version !== 'string'
    || !manifest.version.endsWith(CANDIDATE_VERSION_SUFFIX)) {
    throw new Error(`${ARTIFACT_ROOT_ENV} is not the pinned ${PACKAGE_NAME} candidate generation`
      + ` (name ${String(manifest?.name)}, version ${String(manifest?.version)})`)
  }
  return root
}

/** The `file://` URL of one built product module, refused unless it is the file inside `lib` it claims. */
function artifactModuleUrl(libRoot, path) {
  let target
  try {
    target = realpathSync(join(libRoot, path))
  } catch (error) {
    throw new Error(`the artifact root states no readable ${path} (${String(error)})`)
  }
  const inside = relative(libRoot, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`the artifact module ${path} resolves outside ${libRoot}`)
  }
  return pathToFileURL(target)
}

/**
 * Refuse a child that could still load TypeScript or a script-loading hook.
 *
 * The artifact plane is built `.js` under plain Node, so a stripping runtime or a hook inherited
 * through `--import`/`--loader` (tsx among them) would exercise a different plane than the one this
 * selection claims. The flags are read as tokens, so the sibling `--no-experimental-strip-types`
 * fact is not confused with a loader.
 */
function requirePlainNodeRuntime() {
  if (process.features.typescript !== false) {
    throw new Error(`the artifact plane strips no types (process.features.typescript is ${JSON.stringify(process.features.typescript)})`)
  }
  const tsxConfig = process.env.TSX_TSCONFIG_PATH
  if (tsxConfig !== undefined && tsxConfig !== '') {
    throw new Error(`the artifact plane runs no tsx paths map (TSX_TSCONFIG_PATH is ${tsxConfig})`)
  }
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)]
  const hook = flags.find(flag => /^--(import|loader|experimental-loader)\b/.test(flag) || flag.includes('tsx'))
  if (hook !== undefined) throw new Error(`the artifact plane runs no script-loading hook (found ${JSON.stringify(hook)})`)
}

const artifactRoot = process.env[ARTIFACT_ROOT_ENV]
const root = artifactRoot === undefined ? undefined : resolveArtifactRoot(artifactRoot)
const libRoot = root === undefined ? undefined : requireRealDirectory(join(root, 'lib'), `${ARTIFACT_ROOT_ENV} lib`)
if (root !== undefined) requirePlainNodeRuntime()

/** The URL each selected module is imported from; the plane decides which half of the table. */
const moduleUrls = Object.fromEntries(Object.entries(PRODUCT_MODULES).map(([key, module_]) => [
  key,
  root === undefined
    ? new URL(module_.src, import.meta.url).href
    : artifactModuleUrl(libRoot, module_.artifact).href,
]))

/** The loaded product modules, by the keys {@link PRODUCT_MODULES} names. */
const loaded = {}
for (const [key, url] of Object.entries(moduleUrls)) loaded[key] = await import(url)

/** The plugin entry namespace; the composing host mounts it and calls its own `apply`. */
export const subscriptions = loaded.entry
/** The durable account-store write the synthetic account is seeded through. */
export const saveAccountSession = pick(loaded.store, 'saveAccountSession')
/** The device id the adapter's identity gate derives. */
export const deriveClaudeDeviceId = pick(loaded.claude, 'deriveClaudeDeviceId')
/** The pinned Messages protocol profile the transports admit. */
export const CLAUDE_PROTOCOL_PROFILE = pick(loaded.claudeProtocol, 'CLAUDE_PROTOCOL_PROFILE')
/** The account-reference comparator the durable identity is matched with. */
export const sameClaudeAccountRef = pick(loaded.accountRef, 'sameClaudeAccountRef')
/** The host's mandatory Claude route reader. */
export const hostClaudeRoute = pick(loaded.hostEgress, 'hostClaudeRoute')
/** The host's per-scheme proxy reader. */
export const hostProxyForScheme = pick(loaded.hostEgress, 'hostProxyForScheme')
// The entry is mounted whole: the Loader reads these four members and calls `apply` itself.
for (const member of ['name', 'inject', 'Config', 'apply']) pick(subscriptions, member)

/**
 * The product-module plane this process loaded. Test output for the composing spec only: a probe
 * writes it into its own marker line, and it adds no Session event and no user-visible log.
 */
export const productModuleObservation = Object.freeze({
  mode: root === undefined ? 'src' : 'artifact',
  entryUrl: moduleUrls.entry,
  ...(root === undefined ? {} : { root }),
})
