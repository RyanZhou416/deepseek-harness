/**
 * Build or stage the four fork plugins and install them into the selected
 * web profile by local path.
 *
 * `build.cmd` runs this after the ordinary root build. The script stages
 * bundles under the ignored `.build/fork-plugins/` directory, installs them
 * with `dsh plugin --profile web add <absolute staged directory>` (a pnpm
 * `link:` dependency), and rewrites profile configuration only after backing
 * up `package.json` and `cordis.patch.yml`.
 *
 * Safety: profile mutation while a Host is serving that profile is unsafe, so
 * a listener on the Host port refuses the run unless `--allow-running-host`
 * is passed explicitly. The script touches only profile package metadata and
 * pnpm state; it never reads or writes Sessions, attachments, credentials,
 * `.agent-teams` data, or projection caches.
 *
 * @module scripts/fork-plugins-build
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD_ROOT = join(REPOSITORY_ROOT, '.build', 'fork-plugins')
const STATE_FILE = join(BUILD_ROOT, 'state.json')
const CONFIG_ROOT = join(BUILD_ROOT, 'configs')
const DEPENDENCY_ROOT = join(BUILD_ROOT, 'build-deps')
const PROFILE_NAME = 'web'
const HOST_PORT = 3080
const SCHEMA_VERSION = 1
/** Bump when the staging recipe changes in a way the source hash does not capture. */
const SCRIPT_VERSION = 2

/** Plugin entries this script installs, in installation order. */
const PLUGINS = [
  {
    id: 'subscriptions',
    name: 'dsh-plugin-subscriptions',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-plugin-subscriptions'),
    mode: 'build',
    outputs: ['lib/index.js', 'lib/client.js'],
    copy: [] as string[],
  },
  {
    id: 'aether-shell',
    name: '@ryanzhou416/dsh-plugin-aether-shell',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-plugin-aether-shell'),
    mode: 'build',
    outputs: ['lib/lifecycle.mjs'],
    copy: [] as string[],
  },
  {
    id: 'agent-teams',
    name: '@nanmicoder/dsh-agent-teams',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-agent-teams'),
    mode: 'copy',
    outputs: ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts'],
    copy: ['lib', 'assets', 'release-notes', 'README.md', 'README_ZH.md', 'compatibility.json', 'cordis.patch.yml'],
  },
  {
    id: 'context',
    name: 'dsh-context',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-context'),
    mode: 'copy',
    outputs: ['lib/index.js', 'lib/client.js', 'lib/index.d.ts'],
    copy: ['lib', 'locale', 'icon.svg', 'README.md', 'LICENSE', 'cordis.patch.yml'],
  },
] as const

type PluginId = (typeof PLUGINS)[number]['id']

/** Options accepted on the command line. */
export interface BuildOptions {
  /** Continue while the Host port is listening, after a loud warning. */
  readonly allowRunningHost: boolean
  /** Rebuild even when the recorded source key matches. */
  readonly forceRebuild: boolean
  /** Override the Harness home; defaults to `DSH_HOME`, then `~/.dsh`. */
  readonly dshHome?: string
}

/** Shape of a plugin `package.json` the script reads and rewrites. */
export interface PluginManifest extends Record<string, unknown> {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, unknown>
}

interface BuildState {
  schema: number
  scriptVersion: number
  plugins: Record<string, { key: string; version: string; installedAt: string }>
}

interface StagedPlugin {
  readonly definition: (typeof PLUGINS)[number]
  readonly directory: string
  readonly version: string
  readonly changed: boolean
}

function log(message: string): void {
  process.stdout.write(`[fork-plugins] ${message}\n`)
}

function warn(message: string): void {
  process.stderr.write(`[fork-plugins] warning: ${message}\n`)
}

function fail(message: string): never {
  throw new Error(message)
}

function usage(): string {
  return [
    'Usage: tsx scripts/fork-plugins-build.ts [options]',
    '',
    'Builds or stages the fork plugins and links them into the selected web profile.',
    'Normally invoked by build.cmd after the ordinary root build.',
    '',
    'Options:',
    '  --allow-running-host  Continue while the Host port is listening (unsafe; warns loudly)',
    '  --force-rebuild       Rebuild staged bundles even when the source key is unchanged',
    '  --dsh-home <path>     Harness home to use instead of DSH_HOME or ~/.dsh',
    '  --help                Show this help',
    '',
  ].join('\n')
}

/** Parse only the options this script owns. */
export function parseArguments(argv: readonly string[]): BuildOptions | undefined {
  let allowRunningHost = false
  let forceRebuild = false
  let dshHome: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--allow-running-host') allowRunningHost = true
    else if (argument === '--force-rebuild') forceRebuild = true
    else if (argument === '--help' || argument === '-h') return undefined
    else if (argument === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('--dsh-home requires a path')
      dshHome = value
      index += 1
    } else if (argument.startsWith('--dsh-home=')) dshHome = argument.slice('--dsh-home='.length)
    else fail(`unknown argument ${JSON.stringify(argument)}; pass --help to see supported options`)
  }
  return {
    allowRunningHost,
    forceRebuild,
    ...dshHome === undefined ? {} : { dshHome },
  }
}

/** Resolve the Harness home exactly as the launcher does, with an explicit override first. */
export function resolveHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = explicit ?? env.DSH_HOME
  return resolve(configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh'))
}

/** Windows file systems compare paths case-insensitively; every other platform does not. */
function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    try {
      return realpathSync.native(value)
    } catch {
      return resolve(value)
    }
  }
  const a = canonical(left)
  const b = canonical(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Resolve a profile dependency spec that names a local directory.
 * @param spec - the value recorded in the profile manifest.
 * @param profileDirectory - directory a relative spec resolves against.
 * @returns the absolute path, or undefined for a registry spec.
 */
export function localDependencyPath(spec: string, profileDirectory: string): string | undefined {
  const match = /^(?:file|link):(.*)$/s.exec(spec)
  if (match === null) return undefined
  const value = (match[1] as string).replace(/^~(?=$|[\\/])/, () => homedir())
  return resolve(profileDirectory, value)
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`)
  await rename(temporary, path)
}

/** Whether a TCP listener accepts connections on the loopback address. */
function portIsListening(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (listening: boolean): void => {
      socket.destroy()
      settle(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => { finish(true) })
    socket.once('timeout', () => { finish(false) })
    socket.once('error', () => { finish(false) })
  })
}

/** Run one child process with inherited output, failing on a nonzero exit. */
function run(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  })
  if (result.error !== undefined) fail(`failed to start ${command}: ${String(result.error)}`)
  if (result.status !== 0) {
    fail(`${basename(command)} ${args.join(' ')} exited with code ${String(result.status)}`)
  }
}

/** The repository-local pnpm entry, falling back to `pnpm` on PATH. */
function pnpmCommand(): { command: string; prefix: string[] } {
  for (const entry of [join(REPOSITORY_ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'), join(REPOSITORY_ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]) {
    if (existsSync(entry)) return { command: process.execPath, prefix: [entry] }
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
}

function addPath(environment: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const current = environment.PATH ?? environment.Path ?? ''
  return { ...environment, PATH: `${directory}${delimiter}${current}` }
}

/** The built CLI that owns profile initialization, package management, and compatibility checks. */
function cliEntry(): string {
  const entry = join(REPOSITORY_ROOT, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(entry)) {
    fail('the ordinary root build has not produced apps/cli/lib/bin.js; run build.cmd (this script runs after the root build)')
  }
  return entry
}

/** Versions of the toolchain and harness cohort that shape the staged output. */
async function toolchainVersions(): Promise<string> {
  const tsdown = await readJson<{ version?: string }>(join(REPOSITORY_ROOT, 'node_modules', 'tsdown', 'package.json'))
  const cli = await readJson<{ version?: string }>(join(REPOSITORY_ROOT, 'apps', 'cli', 'package.json'))
  return `${tsdown.version ?? 'unknown'}\n${cli.version ?? 'unknown'}`
}

function rootTsdown(): string {
  const entry = join(REPOSITORY_ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  if (!existsSync(entry)) fail('tsdown is missing from node_modules; run the ordinary root install and build first')
  return entry
}

/** Run the built dsh CLI against one Harness home with the repository pnpm on PATH. */
function runDsh(args: readonly string[], home: string): void {
  const environment = addPath({ ...process.env, DSH_HOME: home }, join(REPOSITORY_ROOT, 'node_modules', '.bin'))
  run(process.execPath, [cliEntry(), ...args], { cwd: REPOSITORY_ROOT, env: environment })
}

/** Files whose content decides whether a plugin must be rebuilt. */
function sourcePaths(plugin: (typeof PLUGINS)[number]): string[] {
  if (plugin.mode === 'copy') {
    return plugin.id === 'agent-teams'
      ? ['lib', 'assets', 'release-notes', 'README.md', 'README_ZH.md', 'compatibility.json', 'package.json', 'cordis.patch.yml']
      : ['lib', 'locale', 'icon.svg', 'README.md', 'LICENSE', 'package.json', 'cordis.patch.yml']
  }
  return plugin.id === 'subscriptions'
    ? ['src', 'package.json', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts', 'tsdown.client.options.mjs']
    : ['src', 'package.json', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts']
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Hash the files that change the staged output, excluding docs, tests, dependencies, and prior builds. */
async function sourceHash(plugin: (typeof PLUGINS)[number]): Promise<string> {
  const lines: string[] = []
  const includeLib = plugin.mode === 'copy'
  const visit = async (path: string, relative: string): Promise<void> => {
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || (!includeLib && entry.name === 'lib') || entry.name === 'lib-test' || entry.name === 'docs') continue
        await visit(join(path, entry.name), `${relative}/${entry.name}`)
      }
      return
    }
    if (!info.isFile()) return
    lines.push(`${relative}\0${await hashFile(path)}`)
  }
  for (const entry of sourcePaths(plugin)) {
    const path = join(plugin.directory, entry)
    if (existsSync(path)) await visit(path, entry)
  }
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** The exact `undici` version the plugin lockfile selected, with the declaration range as a fallback. */
export function lockedUndiciVersion(lockfile: string, fallback: string): string {
  const match = /^\s+undici:\s*\n\s+specifier: [^\n]+\n\s+version: ([^\s]+)/m.exec(lockfile)
  return match?.[1] ?? fallback
}

/** Read the source manifest of one plugin. */
async function sourceManifest(plugin: (typeof PLUGINS)[number]): Promise<PluginManifest> {
  return readJson<PluginManifest>(join(plugin.directory, 'package.json'))
}

/**
 * Build the staged package manifest: runtime files only, harness peers kept,
 * and every private build-time or inlined dependency removed.
 * @param source - source `package.json`.
 * @param pluginId - which plugin the manifest belongs to.
 * @returns a new manifest value.
 */
export function stagedManifest(source: PluginManifest, pluginId: PluginId): PluginManifest {
  const manifest = structuredClone(source)
  const packageName = manifest.name
  const packageVersion = manifest.version
  if (packageName === undefined || packageVersion === undefined) fail('source package.json must declare name and version')
  for (const field of ['scripts', 'devDependencies'] as const) {
    Reflect.deleteProperty(manifest, field)
  }
  if (pluginId === 'subscriptions') {
    delete manifest.dependencies
    delete manifest.peerDependenciesMeta
    delete manifest.types
    const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name !== '@deepseek-ai/dsh-llm-request-record'))
    if (Object.keys(peers).length > 0) manifest.peerDependencies = peers
    else delete manifest.peerDependencies
    manifest.exports = {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    }
    manifest.files = ['lib/**/*.js', 'cordis.patch.yml', 'third-party-licenses/**']
  } else if (pluginId === 'aether-shell') {
    delete manifest.dependencies
    delete manifest.peerDependenciesMeta
    manifest.exports = { '.': './lib/lifecycle.mjs', './package.json': './package.json' }
    manifest.files = ['lib', 'cordis.patch.yml']
  } else if (pluginId === 'context') {
    // zod is a real runtime dependency of the prebuilt context half; the
    // profile link resolves it from the repository install.
    manifest.files = ['lib/index.js', 'lib/client.js', 'lib/index.d.ts', 'icon.svg', 'locale/*.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
  } else {
    delete manifest.dependencies
    manifest.files = ['lib', 'assets/agent-teams', 'assets/readme', 'assets/ui.png', 'cordis.patch.yml', 'README.md', 'README_ZH.md', 'compatibility.json']
  }
  delete manifest.publishConfig
  return manifest
}

/**
 * Dependency values that would make the staged package fetch a private
 * package, a tarball, or another local path at install time.
 * @param manifest - staged manifest.
 * @returns the offending `name: value` entries.
 */
export function privateDependencySpecs(manifest: PluginManifest): string[] {
  const offenders: string[] = []
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      if (/^(?:file|link):|\.tgz(?:$|#)|^github:|^git\+|:\/\//i.test(value) || name === '@tormentalabs/claude-code-wire-compat' || name === 'undici') {
        offenders.push(`${section}.${name}: ${value}`)
      }
    }
  }
  return offenders
}

/**
 * Reject a staged manifest that would depend on a private artifact or a
 * non-cohort harness peer.
 * @param manifest - staged manifest.
 * @param pluginId - which plugin the manifest belongs to.
 */
export function assertStagedManifest(manifest: PluginManifest, pluginId: PluginId): void {
  const allowedDependencies = pluginId === 'context' ? new Set(['zod']) : new Set<string>()
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!allowedDependencies.has(name)) fail(`staged ${pluginId} manifest has an unexpected runtime dependency: ${name}@${range}`)
  }
  const offenders = privateDependencySpecs(manifest)
  if (offenders.length > 0) fail(`staged ${pluginId} manifest still has runtime/local dependencies: ${offenders.join(', ')}`)
  if (manifest.devDependencies !== undefined) {
    fail(`staged ${pluginId} manifest must not declare development dependencies`)
  }
  if (pluginId === 'subscriptions' && manifest.peerDependencies?.['@deepseek-ai/dsh-llm-request-record'] !== undefined) {
    fail('staged subscriptions manifest still declares the type-only @deepseek-ai/dsh-llm-request-record peer')
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    // Prebuilt upstream plugins express compatibility as a range that includes
    // the selected cohort; their source manifest is preserved verbatim.
    if (pluginId === 'agent-teams' || pluginId === 'context') continue
    if (range !== '0.2.1-rc.2') fail(`staged ${pluginId} peer ${name} is ${range}; the staged cohort must stay 0.2.1-rc.2`)
  }
}

interface WorkspacePackage {
  readonly name: string
  readonly directory: string
  readonly manifest: PluginManifest & { exports?: unknown; main?: string }
}

/** Read every workspace package so client-bundle aliases can point at built entry files. */
async function workspacePackages(): Promise<WorkspacePackage[]> {
  const found: WorkspacePackage[] = []
  const add = async (directory: string): Promise<void> => {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = await readJson<PluginManifest & { exports?: unknown; main?: string }>(manifestPath)
    if (manifest.name !== undefined) found.push({ name: manifest.name, directory, manifest })
  }
  const groups = join(REPOSITORY_ROOT, 'packages')
  for (const group of await readdir(groups, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDirectory = join(groups, group.name)
    for (const child of await readdir(groupDirectory, { withFileTypes: true })) {
      if (child.isDirectory()) await add(join(groupDirectory, child.name))
    }
  }
  for (const kind of ['vendor', 'apps', 'native']) {
    const root = join(REPOSITORY_ROOT, kind)
    if (!existsSync(root)) continue
    for (const child of await readdir(root, { withFileTypes: true })) {
      if (child.isDirectory()) await add(join(root, child.name))
    }
  }
  return found
}

/** The JavaScript entry a package export target names, preferring runtime conditions. */
function exportEntry(target: unknown): string | undefined {
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const item of target) {
      const entry = exportEntry(item)
      if (entry !== undefined) return entry
    }
    return undefined
  }
  if (typeof target !== 'object' || target === null) return undefined
  const record = target as Record<string, unknown>
  for (const condition of ['default', 'import', 'node', 'require']) {
    const entry = exportEntry(record[condition])
    if (entry !== undefined) return entry
  }
  return undefined
}

/** Map every workspace export specifier to its built file for the client bundle. */
async function workspaceAliases(): Promise<Record<string, string>> {
  const aliases: Record<string, string> = {}
  for (const pkg of await workspacePackages()) {
    const exportsField = pkg.manifest.exports
    if (typeof exportsField === 'string') {
      aliases[pkg.name] = resolve(pkg.directory, exportsField)
      continue
    }
    if (typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)) {
      for (const [subpath, target] of Object.entries(exportsField as Record<string, unknown>)) {
        if (subpath === './package.json') continue
        const entry = exportEntry(target)
        if (entry === undefined) continue
        aliases[subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`] = resolve(pkg.directory, entry)
      }
      continue
    }
    const main = pkg.manifest.main
    aliases[pkg.name] = resolve(pkg.directory, main ?? 'lib/index.js')
  }
  return aliases
}

interface BuildDependencies {
  readonly wireEntry: string
  readonly undiciEntry: string
  readonly wire: WorkspacePackage
  readonly undici: WorkspacePackage
}

/** Install the two runtime packages that the subscriptions build inlines. */
async function ensureBuildDependencies(): Promise<BuildDependencies> {
  const wireTarball = join(REPOSITORY_ROOT, 'fork-plugins', 'releases', 'tormentalabs-claude-code-wire-compat-0.7.2-dsh14.tgz')
  if (!existsSync(wireTarball)) fail(`missing inlined dependency artifact ${wireTarball}`)
  const lockfile = await readFile(join(PLUGINS[0].directory, 'pnpm-lock.yaml'), 'utf8')
  const undiciVersion = lockedUndiciVersion(lockfile, '^7.0.0')
  const dependencyManifest = {
    name: 'dsh-fork-plugin-build-deps',
    private: true,
    type: 'module',
    dependencies: {
      '@tormentalabs/claude-code-wire-compat': `file:${wireTarball.replaceAll('\\', '/')}`,
      undici: undiciVersion,
    },
  }
  await mkdir(DEPENDENCY_ROOT, { recursive: true })
  const manifestPath = join(DEPENDENCY_ROOT, 'package.json')
  const existing = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : ''
  const desired = `${JSON.stringify(dependencyManifest, undefined, 2)}\n`
  const manifestChanged = existing !== desired
  if (manifestChanged) await writeFile(manifestPath, desired)

  const wireDirectory = join(DEPENDENCY_ROOT, 'node_modules', '@tormentalabs', 'claude-code-wire-compat')
  const undiciDirectory = join(DEPENDENCY_ROOT, 'node_modules', 'undici')
  const installed = !manifestChanged
    && existsSync(join(wireDirectory, 'package.json'))
    && existsSync(join(undiciDirectory, 'package.json'))
  if (!installed) {
    log('installing the build-time runtime packages that staging inlines')
    const pnpm = pnpmCommand()
    run(pnpm.command, [
      ...pnpm.prefix,
      'install',
      '--ignore-workspace',
      '--ignore-scripts',
      '--no-optional',
      '--config.auto-install-peers=false',
      '--config.confirm-modules-purge=false',
    ], { cwd: DEPENDENCY_ROOT })
  }
  const wire = await readJson<WorkspacePackage['manifest']>(join(wireDirectory, 'package.json'))
  const undici = await readJson<WorkspacePackage['manifest']>(join(undiciDirectory, 'package.json'))
  if (wire.name !== '@tormentalabs/claude-code-wire-compat') fail('build dependency resolution did not install the pinned wire-compat package')
  if (undici.name !== 'undici') fail('build dependency resolution did not install undici')
  return {
    wireEntry: join(wireDirectory, 'dist', 'index.js'),
    undiciEntry: join(undiciDirectory, 'index.js'),
    wire: { name: wire.name, directory: wireDirectory, manifest: wire },
    undici: { name: undici.name, directory: undiciDirectory, manifest: undici },
  }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/** Write the generated subscriptions tsdown config that stages both faces. */
async function subscriptionsConfig(stagingDirectory: string, wireEntry: string, undiciEntry: string): Promise<string> {
  const aliases = await workspaceAliases()
  const path = join(CONFIG_ROOT, 'subscriptions.mjs')
  const clientOptions = pathToFileURL(join(PLUGINS[0].directory, 'tsdown.client.options.mjs')).href
  const config = [
    "import { defineConfig } from 'tsdown'",
    `import { clientBuildOptions } from ${quote(clientOptions)}`,
    '',
    `const cwd = ${quote(PLUGINS[0].directory)}`,
    `const alias = ${JSON.stringify(aliases, undefined, 2)}`,
    `alias['@tormentalabs/claude-code-wire-compat'] = ${quote(wireEntry)}`,
    `alias['undici'] = ${quote(undiciEntry)}`,
    '',
    'export default defineConfig([',
    '  {',
    `    name: ${quote('dsh-plugin-subscriptions-staged')},`,
    '    cwd,',
    "    entry: { index: 'src/index.ts' },",
    `    outDir: ${quote(join(stagingDirectory, 'lib'))},`,
    "    format: ['esm'],",
    "    platform: 'node',",
    "    target: 'es2024',",
    '    fixedExtension: false,',
    '    dts: false,',
    '    clean: false,',
    '    deps: {',
    "      neverBundle: ['@cursor/sdk', new RegExp('^@deepseek-ai/')],",
    "      alwaysBundle: [new RegExp('^@tormentalabs/'), new RegExp('^undici$')],",
    '      onlyBundle: false,',
    '    },',
    '    alias,',
    '  },',
    '  {',
    '    ...clientBuildOptions,',
    '    cwd,',
    `    outDir: ${quote(join(stagingDirectory, 'lib'))},`,
    '    alias,',
    '  },',
    '])',
    '',
  ].join('\n')
  await writeFile(path, config)
  return path
}

/** Write the generated aether-shell tsdown config. */
async function aetherConfig(stagingDirectory: string): Promise<string> {
  const path = join(CONFIG_ROOT, 'aether-shell.mjs')
  const config = [
    "import { defineConfig } from 'tsdown'",
    '',
    'export default defineConfig({',
    `  name: ${quote('dsh-plugin-aether-shell-staged')},`,
    `  cwd: ${quote(PLUGINS[1].directory)},`,
    "  entry: { lifecycle: 'src/index.ts' },",
    `  outDir: ${quote(join(stagingDirectory, 'lib'))},`,
    "  format: 'esm',",
    "  platform: 'node',",
    "  target: 'node22',",
    '  dts: false,',
    '  sourcemap: true,',
    '  clean: true,',
    "  deps: { neverBundle: [new RegExp('^@deepseek-ai/')] },",
    '})',
    '',
  ].join('\n')
  await writeFile(path, config)
  return path
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (existsSync(source)) await copyFile(source, destination)
}

/** Bun platform packages the pinned transport can run on. */
const BUN_PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'win32-x64': '@oven/bun-windows-x64',
  'win32-arm64': '@oven/bun-windows-aarch64',
  'darwin-arm64': '@oven/bun-darwin-aarch64',
  'darwin-x64': '@oven/bun-darwin-x64',
  'linux-x64': '@oven/bun-linux-x64',
  'linux-arm64': '@oven/bun-linux-aarch64',
}

/**
 * Stage the files the bundled Claude transport spawns beside `lib/index.js`.
 *
 * The transport bundle keeps the child entry and its frame codec as separate
 * runtime files, so a staged package without them starts no bridge and every
 * Messages request becomes an ambiguous transport failure.
 * @param plugin - the subscriptions source package.
 * @param stagingDirectory - staged package root.
 */
async function stageSubscriptionsTransport(
  plugin: (typeof PLUGINS)[number],
  stagingDirectory: string,
): Promise<void> {
  for (const entry of ['bun-child.js', 'frames.js']) {
    const source = join(plugin.directory, 'lib', 'transport', entry)
    if (!existsSync(source)) fail(`subscriptions is missing its transport artifact ${entry}; build the plugin before staging it`)
    await copyFile(source, join(stagingDirectory, 'lib', entry))
  }
  const platform = `${process.platform}-${process.arch}`
  const packageName = BUN_PLATFORM_PACKAGES[platform]
  if (packageName === undefined) fail(`the pinned Bun transport has no runtime package for ${platform}`)
  const source = join(plugin.directory, 'node_modules', ...packageName.split('/'))
  if (!existsSync(source)) fail(`subscriptions is missing its pinned Bun runtime ${packageName}; run its dependency install before staging it`)
  await cp(source, join(stagingDirectory, 'node_modules', ...packageName.split('/')), { recursive: true })
}

/** Stage the plugin package files and its inlined-license notices. */
async function stagePackage(
  plugin: (typeof PLUGINS)[number],
  stagingDirectory: string,
  dependencies: Awaited<ReturnType<typeof ensureBuildDependencies>>,
): Promise<void> {
  const manifest = await sourceManifest(plugin)
  const staged = stagedManifest(manifest, plugin.id)
  assertStagedManifest(staged, plugin.id)
  await writeJson(join(stagingDirectory, 'package.json'), staged)
  await copyFile(join(plugin.directory, 'cordis.patch.yml'), join(stagingDirectory, 'cordis.patch.yml'))
  await copyIfPresent(join(plugin.directory, 'LICENSE'), join(stagingDirectory, 'LICENSE'))
  if (plugin.id === 'subscriptions') {
    const notices = join(stagingDirectory, 'third-party-licenses')
    await mkdir(join(notices, 'claude-code-wire-compat'), { recursive: true })
    await mkdir(join(notices, 'undici'), { recursive: true })
    await copyIfPresent(join(dependencies.wire.directory, 'LICENSE'), join(notices, 'claude-code-wire-compat', 'LICENSE'))
    await copyIfPresent(join(dependencies.wire.directory, 'NOTICE'), join(notices, 'claude-code-wire-compat', 'NOTICE'))
    await copyIfPresent(join(dependencies.undici.directory, 'LICENSE'), join(notices, 'undici', 'LICENSE'))
    await stageSubscriptionsTransport(plugin, stagingDirectory)
  }
}

/** Copy a prebuilt plugin's runtime files into its staging directory. */
async function stageCopiedFiles(
  plugin: (typeof PLUGINS)[number],
  stagingDirectory: string,
): Promise<void> {
  for (const entry of plugin.copy) {
    const source = join(plugin.directory, entry)
    if (!existsSync(source)) {
      if (plugin.mode === 'copy') fail(`${plugin.name} is missing its runtime entry ${entry}`)
      continue
    }
    await cp(source, join(stagingDirectory, entry), {
      recursive: true,
      filter: path => !path.endsWith('.map'),
    })
  }
}

/** Build one plugin into its staging directory and verify the expected artifacts. */
async function buildPlugin(
  plugin: (typeof PLUGINS)[number],
  stagingDirectory: string,
  dependencies: Awaited<ReturnType<typeof ensureBuildDependencies>>,
): Promise<void> {
  await rm(stagingDirectory, { recursive: true, force: true })
  await mkdir(stagingDirectory, { recursive: true })
  if (plugin.mode === 'build') {
    const config = plugin.id === 'subscriptions'
      ? await subscriptionsConfig(stagingDirectory, dependencies.wireEntry, dependencies.undiciEntry)
      : await aetherConfig(stagingDirectory)
    log(`building ${plugin.name} from source`)
    run(process.execPath, [rootTsdown(), '--config', config], { cwd: REPOSITORY_ROOT })
  } else {
    log(`staging prebuilt ${plugin.name}`)
  }
  await stagePackage(plugin, stagingDirectory, dependencies)
  if (plugin.mode === 'copy') await stageCopiedFiles(plugin, stagingDirectory)
  for (const output of plugin.outputs) {
    const path = join(stagingDirectory, output)
    if (!existsSync(path) || statSync(path).size === 0) fail(`${plugin.name} staging did not produce ${output}`)
  }
}

/** Whether a previous staging still matches the current source and expected files. */
async function stagingIsCurrent(
  plugin: (typeof PLUGINS)[number],
  stagingDirectory: string,
  state: BuildState,
  key: string,
  force: boolean,
): Promise<boolean> {
  if (force) return false
  const recorded = state.plugins[plugin.id]
  if (recorded === undefined || recorded.key !== key || recorded.version !== (await sourceManifest(plugin)).version) return false
  for (const file of ['package.json', 'cordis.patch.yml', ...plugin.outputs]) {
    if (!existsSync(join(stagingDirectory, file))) return false
  }
  const staged = await readJson<PluginManifest>(join(stagingDirectory, 'package.json'))
  try {
    assertStagedManifest(staged, plugin.id)
  } catch {
    return false
  }
  return true
}

/** Back up the profile files this script may change. */
async function backupProfile(profileDirectory: string, created: boolean): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const destination = join(BUILD_ROOT, 'backups', `${PROFILE_NAME}-${stamp}`)
  await mkdir(destination, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']) {
    await copyIfPresent(join(profileDirectory, file), join(destination, file))
  }
  await writeFile(join(destination, 'profile-path.txt'), `${profileDirectory}\n`)
  if (created) await writeFile(join(destination, 'profile-created-by-build.txt'), 'The profile did not exist before this run; no prior configuration existed to back up.\n')
  return destination
}

/** Why the profile still does not resolve one staged plugin, if that is the case. */
async function profileProblem(plugin: StagedPlugin, profileDirectory: string): Promise<string | undefined> {
  const manifestPath = join(profileDirectory, 'package.json')
  if (!existsSync(manifestPath)) return `${manifestPath} is missing`
  const manifest = await readJson<PluginManifest & { dsh?: { profile?: { bundles?: string[] } } }>(manifestPath)
  const recorded = manifest.dependencies?.[plugin.definition.name]
  if (recorded === undefined) return `the profile does not declare ${plugin.definition.name}`
  const recordedPath = localDependencyPath(recorded, profileDirectory)
  if (recordedPath === undefined) return `the profile records ${plugin.definition.name} as ${recorded}, not a local link`
  if (!samePath(recordedPath, plugin.directory)) return `the profile link for ${plugin.definition.name} points at ${recordedPath}, not ${plugin.directory}`
  const installed = join(profileDirectory, 'node_modules', plugin.definition.name)
  if (!existsSync(join(installed, 'package.json'))) return `the profile has no installed node_modules entry for ${plugin.definition.name}`
  for (const output of plugin.definition.outputs) {
    if (!existsSync(join(installed, output))) return `${installed} does not expose ${output}`
  }
  if (!(manifest.dsh?.profile?.bundles ?? []).includes(plugin.definition.name)) {
    return `the profile bundle list does not include ${plugin.definition.name}`
  }
  return undefined
}

/** Print the staged and installed result for the operator. */
function report(staged: readonly StagedPlugin[], profileDirectory: string, backup: string | undefined): void {
  for (const plugin of staged) {
    log(`${plugin.definition.name}@${plugin.version} -> ${plugin.directory}${plugin.changed ? ' (rebuilt)' : ' (unchanged)'}`)
  }
  log(`profile: ${profileDirectory}`)
  if (backup !== undefined) log(`profile configuration backup: ${backup}`)
  log('restart the Host with run.cmd to load the staged packages')
}

/**
 * Build or stage the four plugins and make the selected web profile resolve them.
 * @param options - parsed command-line options.
 */
export async function main(options: BuildOptions): Promise<void> {
  cliEntry()
  const home = resolveHome(options.dshHome)
  const profileDirectory = join(home, 'profiles', PROFILE_NAME)
  const listening = await portIsListening(HOST_PORT)
  if (listening && !options.allowRunningHost) {
    fail(`a Host is listening on 127.0.0.1:${HOST_PORT}; stop it before rebuilding the profile. `
      + 'Profile package links must not change under a running Host. Pass --allow-running-host only if you accept that risk.')
  }
  if (listening) warn(`a Host is listening on 127.0.0.1:${HOST_PORT}; continuing only because --allow-running-host was passed`)
  let previousState: BuildState = { schema: SCHEMA_VERSION, scriptVersion: SCRIPT_VERSION, plugins: {} }
  if (existsSync(STATE_FILE)) {
    try {
      previousState = await readJson<BuildState>(STATE_FILE)
    } catch {
      warn(`${STATE_FILE} is not valid JSON; rebuilding all staged packages`)
    }
  }
  const state: BuildState = previousState.schema === SCHEMA_VERSION && previousState.scriptVersion === SCRIPT_VERSION
    ? previousState
    : { schema: SCHEMA_VERSION, scriptVersion: SCRIPT_VERSION, plugins: {} }
  await mkdir(CONFIG_ROOT, { recursive: true })
  const dependencies = await ensureBuildDependencies()
  const staged: StagedPlugin[] = []
  let changed = false
  const toolchain = await toolchainVersions()
  for (const plugin of PLUGINS) {
    const stagingDirectory = join(BUILD_ROOT, plugin.id)
    const version = (await sourceManifest(plugin)).version
    if (version === undefined) fail(`${plugin.name} source manifest has no version`)
    const keyParts = [String(SCRIPT_VERSION), await sourceHash(plugin), version, toolchain]
    if (plugin.id === 'subscriptions') {
      keyParts.push(await hashFile(join(REPOSITORY_ROOT, 'fork-plugins', 'releases', 'tormentalabs-claude-code-wire-compat-0.7.2-dsh14.tgz')))
      keyParts.push(dependencies.wire.manifest.version ?? '', dependencies.undici.manifest.version ?? '')
    }
    const key = createHash('sha256').update(keyParts.join('\n')).digest('hex')
    const current = await stagingIsCurrent(plugin, stagingDirectory, state, key, options.forceRebuild)
    if (current) {
      log(`${plugin.name} staging is current (${version})`)
    } else {
      await buildPlugin(plugin, stagingDirectory, dependencies)
      changed = true
      state.plugins[plugin.id] = { key, version, installedAt: new Date().toISOString() }
      await writeJson(STATE_FILE, state)
    }
    staged.push({ definition: plugin, directory: stagingDirectory, version, changed: !current })
  }

  let profileCreated = false
  if (!existsSync(join(profileDirectory, 'package.json'))) {
    log(`initializing profile ${PROFILE_NAME} at ${profileDirectory}`)
    runDsh(['plugin', '--profile', PROFILE_NAME, 'install', '--ignore-scripts'], home)
    profileCreated = true
  }
  const problems: string[] = []
  for (const plugin of staged) {
    const problem = await profileProblem(plugin, profileDirectory)
    if (problem !== undefined) problems.push(problem)
  }
  if (problems.length === 0 && !changed) {
    log('profile already resolves all staged plugins; nothing to install')
    report(staged, profileDirectory, undefined)
    return
  }
  const backup = await backupProfile(profileDirectory, profileCreated)
  log(`installing ${staged.map(plugin => plugin.definition.name).join(' and ')} into profile ${PROFILE_NAME}`)
  runDsh(['plugin', '--profile', PROFILE_NAME, 'add', ...staged.map(plugin => plugin.directory)], home)
  const remaining: string[] = []
  for (const plugin of staged) {
    const problem = await profileProblem(plugin, profileDirectory)
    if (problem !== undefined) remaining.push(problem)
  }
  if (remaining.length > 0) {
    fail(`the profile does not resolve the staged plugins after installation:\n  ${remaining.join('\n  ')}\n`
      + `Backup: ${backup}. Do not start the Host until this is repaired.`)
  }
  report(staged, profileDirectory, backup)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArguments(process.argv.slice(2))
  if (options === undefined) {
    process.stdout.write(usage())
  } else {
    main(options).catch((error: unknown) => {
      process.stderr.write(`[fork-plugins] error: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
