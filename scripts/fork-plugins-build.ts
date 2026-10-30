/**
 * Build or stage the four fork plugins and the workspace llm-cc-pool package,
 * then install them into the selected web profile by local path.
 *
 * `build.cmd` runs this after the ordinary root build. Every fork plugin is
 * built from source: subscriptions and aether-shell emit their bundles directly
 * into the staging directory, while agent-teams and context are copied into an
 * isolated work directory under `.build/fork-plugins/work/` and run their own
 * `build` script there. The workspace llm-cc-pool package is copied from the
 * root build output into the same staging root, with its `workspace:` peer
 * ranges converted to the versions a profile install can resolve. Staged
 * packages live under the ignored `.build/fork-plugins/` directory, are
 * installed with `dsh plugin --profile web add <absolute staged directory>` (a
 * pnpm `link:` dependency).
 *
 * The guarded profile mutation is transactional: the script inspects the
 * repository base bundle, the portable templates, the profile patch, the home
 * patch, and the known `--patch` overlays for a legacy `llm-pi-ai`
 * `providers.cc-pool` route before writing anything. A safe declaration in the
 * profile patch is backed up and removed structurally (block, quoted, and
 * flow-map forms); any declaration elsewhere fails with the exact file to edit.
 * The backup covers the profile files and the portable seed files and is used
 * to roll the profile back when a later step fails. Staging is written through a
 * temporary directory and swapped into place, so a failed build leaves the
 * previous staging generation intact.
 *
 * The tracked plugin `lib/` directories are never a build input: a clean clone
 * needs no prebuilt output. Isolated builds install their pinned plugin-local
 * dependencies from the checked-in lockfile (offline when the pnpm store
 * already has them, otherwise with network access) and fail with an actionable
 * message when preparation cannot finish.
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
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import * as yaml from 'js-yaml'
import { seedPortableProfile, type SeedResult } from './fork-profile-seed.ts'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD_ROOT = join(REPOSITORY_ROOT, '.build', 'fork-plugins')
const STATE_FILE = join(BUILD_ROOT, 'state.json')
const CONFIG_ROOT = join(BUILD_ROOT, 'configs')
const DEPENDENCY_ROOT = join(BUILD_ROOT, 'build-deps')
const WORK_ROOT = join(BUILD_ROOT, 'work')
const PROFILE_NAME = 'web'
const HOST_PORT = 3080
const SCHEMA_VERSION = 1
/** Bump when the staging recipe changes in a way the source hash does not capture. */
const SCRIPT_VERSION = 7
const WORK_MARKER_FILE = '.fork-plugin-build.json'
const DEPENDENCY_MARKER_FILE = '.fork-plugin-deps.json'

/** Plugin ids this script stages or copies from the workspace, in installation order. */
export type PluginId = 'subscriptions' | 'aether-shell' | 'agent-teams' | 'context' | 'llm-cc-pool'

/** How a plugin's staged package obtains its runtime files. */
export type PluginBuilder = 'subscriptions' | 'aether-shell' | 'isolated' | 'workspace'

/** One fork plugin, its build recipe, and the files staging copies. */
export interface PluginDefinition {
  readonly id: PluginId
  readonly name: string
  readonly directory: string
  readonly mode: 'build'
  readonly builder: PluginBuilder
  /** Built files the staged package and the installed profile must expose. */
  readonly outputs: readonly string[]
  /** Entries copied from the build directory into the staged package. */
  readonly stage: readonly string[]
  /** Entries copied from the source package into the isolated work directory. */
  readonly workCopy: readonly string[]
  /** Whether the isolated build needs a plugin-local `pnpm install` first. */
  readonly installDependencies: boolean
}

/** Plugin entries this script installs, in installation order. */
const PLUGIN_DEFINITIONS = [
  {
    id: 'subscriptions',
    name: 'dsh-plugin-subscriptions',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-plugin-subscriptions'),
    mode: 'build',
    builder: 'subscriptions',
    outputs: ['lib/index.js', 'lib/client.js'],
    stage: ['cordis.patch.yml'],
    workCopy: [],
    installDependencies: false,
  },
  {
    id: 'aether-shell',
    name: '@ryanzhou416/dsh-plugin-aether-shell',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-plugin-aether-shell'),
    mode: 'build',
    builder: 'aether-shell',
    outputs: ['lib/lifecycle.mjs'],
    stage: ['cordis.patch.yml'],
    workCopy: [],
    installDependencies: false,
  },
  {
    id: 'agent-teams',
    name: '@nanmicoder/dsh-agent-teams',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-agent-teams'),
    mode: 'build',
    builder: 'isolated',
    outputs: ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/client/index.d.ts'],
    stage: ['lib', 'assets', 'release-notes', 'README.md', 'README_ZH.md', 'compatibility.json', 'cordis.patch.yml'],
    workCopy: [
      'src', 'scripts', 'assets', 'release-notes', '.npmrc',
      'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json',
      'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts',
      'README.md', 'README_ZH.md', 'compatibility.json', 'cordis.patch.yml',
    ],
    installDependencies: true,
  },
  {
    id: 'context',
    name: 'dsh-context',
    directory: join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-context'),
    mode: 'build',
    builder: 'isolated',
    outputs: ['lib/index.js', 'lib/client.js', 'lib/index.d.ts'],
    stage: ['lib', 'locale', 'icon.svg', 'README.md', 'LICENSE', 'cordis.patch.yml'],
    workCopy: [
      'src', 'locale', 'icon.svg', 'LICENSE', 'README.md', 'README_zh.md',
      'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json',
      'tsconfig.json', 'tsdown.config.ts', 'cordis.patch.yml',
    ],
    installDependencies: true,
  },
] as const satisfies readonly PluginDefinition[]

/** The plugin definitions, for tests that assert the staging recipe. */
export const PLUGINS: readonly PluginDefinition[] = PLUGIN_DEFINITIONS

/**
 * Workspace packages the root build compiles and this script links into the
 * profile beside the fork plugins. Their `lib/` output is the root build's, so
 * staging copies it instead of building a second time; only the manifest is
 * rewritten for a profile install.
 */
const WORKSPACE_PLUGIN_DEFINITIONS = [
  {
    id: 'llm-cc-pool',
    name: '@deepseek-ai/dsh-llm-cc-pool',
    directory: join(REPOSITORY_ROOT, 'packages', 'llm', 'llm-cc-pool'),
    mode: 'build',
    builder: 'workspace',
    outputs: ['lib/index.js'],
    stage: ['lib', 'cordis.patch.yml'],
    workCopy: [],
    installDependencies: false,
  },
] as const satisfies readonly PluginDefinition[]

/** The workspace packages this script links into the profile, in installation order. */
export const WORKSPACE_PLUGINS: readonly PluginDefinition[] = WORKSPACE_PLUGIN_DEFINITIONS

const SUBSCRIPTIONS_PLUGIN = PLUGIN_DEFINITIONS[0]
const AETHER_SHELL_PLUGIN = PLUGIN_DEFINITIONS[1]

/** One transport module the staged subscriptions package emits beside `lib/index.js`. */
export interface SubscriptionsTransportModule {
  /** Source file relative to the subscriptions package. */
  readonly source: string
  /** Emitted file relative to the staged package root. */
  readonly output: string
}

/**
 * Transport modules the subscriptions bundle loads as separate runtime files.
 *
 * The child entry and its frame codec must sit beside `lib/index.js`. Staging
 * emits them from these sources with the repository TypeScript compiler, so an
 * edited transport module can never be masked by a stale plugin-local build.
 */
export const SUBSCRIPTIONS_TRANSPORT_MODULES: readonly SubscriptionsTransportModule[] = [
  { source: 'src/transport/bun-child.ts', output: 'lib/bun-child.js' },
  { source: 'src/transport/frames.ts', output: 'lib/frames.js' },
]

/** Options accepted on the command line. */
export interface BuildOptions {
  /** Continue while the Host port is listening, after a loud warning. */
  readonly allowRunningHost: boolean
  /** Rebuild even when the recorded source key matches. */
  readonly forceRebuild: boolean
  /** Override the Harness home; defaults to `DSH_HOME`, then `~/.dsh`. */
  readonly dshHome?: string
  /** Extra `--patch` overlays whose composition the guard must inspect. */
  readonly patchOverlays: readonly string[]
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

/** One plugin's recorded staging generation. */
export interface StagedPluginState {
  key: string
  version: string
  installedAt: string
}

/** The staging state recorded after a successful build. */
export interface BuildState {
  schema: number
  scriptVersion: number
  plugins: Record<string, StagedPluginState>
}

interface StagedPlugin {
  readonly definition: PluginDefinition
  readonly directory: string
  readonly version: string
  readonly changed: boolean
}

interface WorkMarker {
  readonly schema: number
  readonly key: string
  readonly builtAt: string
}

interface DependencyMarker {
  readonly schema: number
  readonly key: string
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
    '  --patch <file>        Also inspect this --patch overlay for a legacy cc-pool route (repeatable)',
    '  --help                Show this help',
    '',
  ].join('\n')
}

/** Parse only the options this script owns. */
export function parseArguments(argv: readonly string[]): BuildOptions | undefined {
  let allowRunningHost = false
  let forceRebuild = false
  let dshHome: string | undefined
  const patchOverlays: string[] = []
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
    else if (argument === '--patch') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('--patch requires a path')
      patchOverlays.push(value)
      index += 1
    } else if (argument.startsWith('--patch=')) patchOverlays.push(argument.slice('--patch='.length))
    else fail(`unknown argument ${JSON.stringify(argument)}; pass --help to see supported options`)
  }
  return {
    allowRunningHost,
    forceRebuild,
    patchOverlays,
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

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text)
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
  const typescript = await readJson<{ version?: string }>(join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'package.json'))
  const pnpm = await readJson<{ version?: string }>(join(REPOSITORY_ROOT, 'node_modules', 'pnpm', 'package.json'))
  const cli = await readJson<{ version?: string }>(join(REPOSITORY_ROOT, 'apps', 'cli', 'package.json'))
  return `${tsdown.version ?? 'unknown'}\n${typescript.version ?? 'unknown'}\n${pnpm.version ?? 'unknown'}\n${cli.version ?? 'unknown'}`
}

function rootTsdown(): string {
  const entry = join(REPOSITORY_ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  if (!existsSync(entry)) fail('tsdown is missing from node_modules; run the ordinary root install and build first')
  return entry
}

/** The repository TypeScript compiler that emits the transport files. */
function rootTypeScript(): string {
  const entry = join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(entry)) fail('typescript is missing from node_modules; run the ordinary root install first')
  return entry
}

/** Run the built dsh CLI against one Harness home with the repository pnpm on PATH. */
function runDsh(args: readonly string[], home: string): void {
  const environment = addPath({ ...process.env, DSH_HOME: home }, join(REPOSITORY_ROOT, 'node_modules', '.bin'))
  run(process.execPath, [cliEntry(), ...args], { cwd: REPOSITORY_ROOT, env: environment })
}

/** Directory names never treated as build inputs for a source hash. */
const IGNORED_SOURCE_DIRECTORIES = new Set(['node_modules', 'lib', 'lib-test', 'docs', '.git', '.tmp', 'coverage'])

/** Files whose content decides whether a plugin must be rebuilt. */
export function sourcePaths(plugin: PluginDefinition): string[] {
  if (plugin.builder === 'isolated') return [...plugin.workCopy]
  // These builders read their sources directly and stage copied entries from
  // the source package; `lib` stays out of the recipe either way.
  return plugin.id === 'subscriptions'
    ? ['src', 'package.json', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts', 'tsdown.client.options.mjs']
    : ['src', 'package.json', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.ts']
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Hash the files that change the staged output, excluding docs, tests, dependencies, and prior builds. */
export async function sourceHash(plugin: PluginDefinition): Promise<string> {
  const lines: string[] = []
  const visit = async (path: string, relative: string): Promise<void> => {
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (IGNORED_SOURCE_DIRECTORIES.has(entry.name)) continue
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

/**
 * The exact version a plugin lockfile selected for one dependency.
 * @param lockfile - plugin `pnpm-lock.yaml` contents.
 * @param packageName - dependency name to find.
 * @param fallback - value used when the lockfile records no version.
 * @returns the exact version or the fallback.
 */
export function lockedDependencyVersion(lockfile: string, packageName: string, fallback: string): string {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s+'?${escaped}'?:\\s*\\n\\s+specifier: [^\\n]+\\n\\s+version: ([^\\s]+)`, 'm').exec(lockfile)
  return match?.[1] ?? fallback
}

/** The exact `undici` version the plugin lockfile selected, with the declaration range as a fallback. */
export function lockedUndiciVersion(lockfile: string, fallback: string): string {
  return lockedDependencyVersion(lockfile, 'undici', fallback)
}

/** Read the source manifest of one plugin. */
async function sourceManifest(plugin: PluginDefinition): Promise<PluginManifest> {
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
    // zod is a real runtime dependency of the context host half; the profile
    // link resolves it from the repository install.
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

/**
 * Convert a workspace protocol range into the registry range a profile install
 * can resolve.
 * @param range - peer range from a workspace manifest.
 * @param version - installed version of the referenced package.
 * @returns the registry-facing range.
 */
export function registryPeerRange(range: string, version: string): string {
  if (range === 'workspace:*') return version
  if (range === 'workspace:^') return `^${version}`
  if (range === 'workspace:~') return `~${version}`
  if (range.startsWith('workspace:')) return range.slice('workspace:'.length)
  return range
}

/**
 * The version the repository install exposes for one package.
 * @param name - package name.
 * @returns the installed version.
 */
async function installedPackageVersion(name: string): Promise<string> {
  for (const path of [
    join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'), 'package.json'),
    join(REPOSITORY_ROOT, 'node_modules', ...name.split('/'), 'package.json'),
  ]) {
    if (!existsSync(path)) continue
    const manifest = await readJson<PluginManifest>(path)
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version
  }
  fail(`the repository install does not expose ${name}; run the ordinary root install before the fork plugin build`)
}

/**
 * Build the staged manifest of a workspace package.
 *
 * A profile install is not a workspace, so `workspace:` peer ranges must become
 * registry ranges and the package's own build-time dependencies stay out of the
 * staged manifest; its runtime imports resolve from the repository install the
 * staged package is linked beside.
 * @param source - workspace package `package.json`.
 * @param resolveVersion - version lookup for each peer; defaults to the repository install.
 * @returns the manifest written into the staging directory.
 */
export async function stagedWorkspaceManifest(
  source: PluginManifest,
  resolveVersion: (name: string) => Promise<string> = installedPackageVersion,
): Promise<PluginManifest> {
  const manifest = structuredClone(source)
  for (const field of ['scripts', 'devDependencies', 'dependencies', 'peerDependenciesMeta', 'publishConfig'] as const) {
    Reflect.deleteProperty(manifest, field)
  }
  const peers: Record<string, string> = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    peers[name] = registryPeerRange(range, await resolveVersion(name))
  }
  if (Object.keys(peers).length === 0) Reflect.deleteProperty(manifest, 'peerDependencies')
  else manifest.peerDependencies = peers
  return manifest
}

/**
 * Stage one workspace package from the root build output.
 *
 * The root build is the only build input, so a missing `lib/` entry fails here
 * with the command the operator still needs to run instead of installing a
 * package that cannot load.
 * @param plugin - workspace plugin definition.
 * @param stagingDirectory - staging root to replace.
 */
export async function stageWorkspacePlugin(plugin: PluginDefinition, stagingDirectory: string): Promise<void> {
  await replaceStagingDirectory(stagingDirectory, async (temporary) => {
    assertStagedArtifacts(plugin, plugin.directory, 'root build')
    const source = await readJson<PluginManifest>(join(plugin.directory, 'package.json'))
    await writeJson(join(temporary, 'package.json'), await stagedWorkspaceManifest(source))
    for (const entry of plugin.stage) {
      const path = join(plugin.directory, entry)
      if (!existsSync(path)) fail(`${plugin.name} is missing its staged entry ${entry} in ${plugin.directory}`)
      await cp(path, join(temporary, entry), { recursive: true, filter: candidate => !candidate.endsWith('.map') })
    }
    assertStagedArtifacts(plugin, temporary)
  })
}

/** A unique sibling path for an atomic staging replacement. */
function stagingSibling(stagingDirectory: string, kind: 'partial' | 'retired'): string {
  return `${stagingDirectory}.${kind}-${process.pid}-${Date.now().toString(36)}`
}

/**
 * Populate a temporary sibling and swap it into the staging path.
 *
 * The previous generation is retired only after the replacement is complete, so
 * a failed build removes only the partial directory and leaves the last usable
 * staging output in place for the profile link and the next incremental run.
 * @param stagingDirectory - final staging directory.
 * @param populate - writes the complete staged package into the given directory.
 */
async function replaceStagingDirectory(
  stagingDirectory: string,
  populate: (temporaryDirectory: string) => Promise<void>,
): Promise<void> {
  const temporary = stagingSibling(stagingDirectory, 'partial')
  const retired = stagingSibling(stagingDirectory, 'retired')
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  try {
    await populate(temporary)
    const previous = existsSync(stagingDirectory)
    if (previous) await rename(stagingDirectory, retired)
    try {
      await rename(temporary, stagingDirectory)
    } catch (error) {
      if (!previous) throw error
      try {
        await rename(retired, stagingDirectory)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `could not replace ${stagingDirectory} and could not restore it from ${retired}`,
        )
      }
      throw error
    }
    if (previous) {
      try {
        await rm(retired, { recursive: true, force: true })
      } catch (error) {
        // The replacement is in place; a leftover retired copy only occupies space.
        warn(`could not remove retired staging directory ${retired}: ${String(error)}`)
      }
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
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
  readonly bunRuntime: BunRuntimeArtifact
}

/** Install the build-time runtime packages that staging inlines or copies into the staged package. */
async function ensureBuildDependencies(): Promise<BuildDependencies> {
  const bunRuntimeTarget = bunPlatformRuntime(process.platform, process.arch)
  const wireTarball = join(REPOSITORY_ROOT, 'fork-plugins', 'releases', 'tormentalabs-claude-code-wire-compat-0.7.2-dsh14.tgz')
  if (!existsSync(wireTarball)) fail(`missing inlined dependency artifact ${wireTarball}`)
  const lockfile = await readFile(join(SUBSCRIPTIONS_PLUGIN.directory, 'pnpm-lock.yaml'), 'utf8')
  const undiciVersion = lockedDependencyVersion(lockfile, 'undici', '^7.0.0')
  const bunVersion = lockedDependencyVersion(lockfile, bunRuntimeTarget.packageName, '^1.4.0')
  const dependencyManifest = {
    name: 'dsh-fork-plugin-build-deps',
    private: true,
    type: 'module',
    dependencies: {
      '@tormentalabs/claude-code-wire-compat': `file:${wireTarball.replaceAll('\\', '/')}`,
      undici: undiciVersion,
      [bunRuntimeTarget.packageName]: bunVersion,
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
  const bunDirectory = join(DEPENDENCY_ROOT, 'node_modules', ...bunRuntimeTarget.packageName.split('/'))
  const installed = !manifestChanged
    && existsSync(join(wireDirectory, 'package.json'))
    && existsSync(join(undiciDirectory, 'package.json'))
    && existsSync(join(bunDirectory, 'package.json'))
    && existsSync(join(bunDirectory, bunRuntimeTarget.executable))
  if (!installed) {
    log('installing the build-time runtime packages that staging inlines and copies')
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
  const bun = await readJson<PluginManifest>(join(bunDirectory, 'package.json'))
  if (wire.name !== '@tormentalabs/claude-code-wire-compat') fail('build dependency resolution did not install the pinned wire-compat package')
  if (undici.name !== 'undici') fail('build dependency resolution did not install undici')
  if (bun.name !== bunRuntimeTarget.packageName) fail(`build dependency resolution did not install ${bunRuntimeTarget.packageName}`)
  return {
    wireEntry: join(wireDirectory, 'dist', 'index.js'),
    undiciEntry: join(undiciDirectory, 'index.js'),
    wire: { name: wire.name, directory: wireDirectory, manifest: wire },
    undici: { name: undici.name, directory: undiciDirectory, manifest: undici },
    bunRuntime: {
      packageName: bunRuntimeTarget.packageName,
      version: bun.version ?? bunVersion,
      // pnpm resolves the platform package through its virtual store. Copying
      // the resolved directory keeps the staged package independent of
      // `.build/fork-plugins/build-deps/`.
      directory: realpathSync(bunDirectory),
      executable: bunRuntimeTarget.executable,
    },
  }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/** Write the generated subscriptions tsdown config that stages both faces. */
async function subscriptionsConfig(stagingDirectory: string, wireEntry: string, undiciEntry: string): Promise<string> {
  const aliases = await workspaceAliases()
  const path = join(CONFIG_ROOT, 'subscriptions.mjs')
  const clientOptions = pathToFileURL(join(SUBSCRIPTIONS_PLUGIN.directory, 'tsdown.client.options.mjs')).href
  const config = [
    "import { defineConfig } from 'tsdown'",
    `import { clientBuildOptions } from ${quote(clientOptions)}`,
    '',
    `const cwd = ${quote(SUBSCRIPTIONS_PLUGIN.directory)}`,
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

/**
 * Emit the transport child and its frame codec from source into the staged package.
 *
 * The emit mirrors the plugin's own `tsc` node-half output without needing the
 * plugin's development dependencies, so the staged transport always matches the
 * sources that produced the source key.
 * @param pluginDirectory - subscriptions source package.
 * @param stagingDirectory - staged package root.
 */
export function buildSubscriptionsTransport(pluginDirectory: string, stagingDirectory: string): void {
  const sourceDirectory = join(pluginDirectory, 'src', 'transport')
  const sources = SUBSCRIPTIONS_TRANSPORT_MODULES.map(module => join(pluginDirectory, module.source))
  for (const source of sources) {
    if (!existsSync(source)) fail(`subscriptions is missing its transport source ${source}`)
  }
  log('building the subscriptions transport from source')
  run(process.execPath, [
    rootTypeScript(),
    // The repository TypeScript 6 rejects explicit files while a tsconfig is in
    // scope, and this transpiles only: the plugin's development types are absent.
    '--ignoreConfig',
    '--noCheck',
    '--skipLibCheck',
    '--target', 'es2024',
    '--module', 'nodenext',
    '--moduleResolution', 'nodenext',
    '--outDir', join(stagingDirectory, 'lib'),
    '--rootDir', sourceDirectory,
    ...sources,
  ], { cwd: pluginDirectory })
}

/** Write the generated aether-shell tsdown config. */
async function aetherConfig(stagingDirectory: string): Promise<string> {
  const path = join(CONFIG_ROOT, 'aether-shell.mjs')
  const config = [
    "import { defineConfig } from 'tsdown'",
    '',
    'export default defineConfig({',
    `  name: ${quote('dsh-plugin-aether-shell-staged')},`,
    `  cwd: ${quote(AETHER_SHELL_PLUGIN.directory)},`,
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

/** A pinned Bun platform package staged beside the subscriptions bundle. */
export interface BunRuntimeArtifact {
  /** Package name, for example `@oven/bun-windows-x64`. */
  readonly packageName: string
  /** Installed package version. */
  readonly version: string
  /** Installed package directory in the staging build dependencies. */
  readonly directory: string
  /** Executable path inside the package directory. */
  readonly executable: string
}

/**
 * Resolve the pinned Bun package and executable for one platform.
 * @param platform - Node platform name, for example `win32`.
 * @param arch - Node architecture name, for example `x64`.
 * @returns the package name and its executable path inside the package.
 */
export function bunPlatformRuntime(platform: string, arch: string): { packageName: string; executable: string } {
  const packageName = BUN_PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (packageName === undefined) fail(`the pinned Bun transport has no runtime package for ${platform}-${arch}`)
  return { packageName, executable: platform === 'win32' ? 'bin/bun.exe' : 'bin/bun' }
}

/**
 * Files the staged subscriptions package needs beyond its two bundle outputs.
 *
 * The transport child, its frame codec, and the platform runtime are separate
 * artifacts; a staged package missing any of them starts no bridge and reports
 * an ambiguous transport failure instead of a missing build product.
 * @param platform - Node platform name; defaults to the running platform.
 * @param arch - Node architecture name; defaults to the running architecture.
 * @returns staged files relative to the package root.
 */
export function subscriptionsRuntimeArtifacts(platform: string = process.platform, arch: string = process.arch): string[] {
  const runtime = bunPlatformRuntime(platform, arch)
  return [
    ...SUBSCRIPTIONS_TRANSPORT_MODULES.map(module => module.output),
    join('node_modules', ...runtime.packageName.split('/'), runtime.executable),
  ]
}

/** Files staging and the installed profile must expose for one plugin. */
export function pluginArtifacts(plugin: PluginDefinition): string[] {
  return plugin.id === 'subscriptions'
    ? [...plugin.outputs, ...subscriptionsRuntimeArtifacts()]
    : [...plugin.outputs]
}

/**
 * Copy the pinned Bun platform package into a staged package's `node_modules`.
 *
 * pnpm links the installed package through its virtual store, so the copy
 * dereferences links: the staged package must keep working when the build
 * dependencies directory is removed while the profile still links to it.
 * @param runtime - installed platform runtime selected by the build dependencies.
 * @param stagingDirectory - staged package root.
 */
export async function stageBunRuntime(runtime: BunRuntimeArtifact, stagingDirectory: string): Promise<void> {
  if (!existsSync(join(runtime.directory, runtime.executable))) {
    fail(`the installed ${runtime.packageName} has no ${runtime.executable}`)
  }
  const source = realpathSync(runtime.directory)
  const destination = join(stagingDirectory, 'node_modules', ...runtime.packageName.split('/'))
  await cp(source, destination, { recursive: true, dereference: true })
  if (lstatSync(destination).isSymbolicLink()) fail(`staging copied ${runtime.packageName} as a symbolic link`)
  if (!existsSync(join(destination, runtime.executable))) fail(`staging did not copy ${runtime.packageName}`)
}

/**
 * Verify the staged transport files and copy the platform runtime beside them.
 *
 * The transport bundle keeps the child entry and its frame codec as separate
 * runtime files, so a staged package without them starts no bridge and every
 * Messages request becomes an ambiguous transport failure.
 * @param stagingDirectory - staged package root.
 * @param runtime - pinned Bun platform package to copy.
 */
async function stageSubscriptionsTransport(stagingDirectory: string, runtime: BunRuntimeArtifact): Promise<void> {
  for (const module of SUBSCRIPTIONS_TRANSPORT_MODULES) {
    const staged = join(stagingDirectory, module.output)
    if (!existsSync(staged) || statSync(staged).size === 0) fail(`subscriptions staging did not produce ${module.output}`)
  }
  await stageBunRuntime(runtime, stagingDirectory)
}

/** Write the validated staged package manifest. */
export async function writeStagedManifest(plugin: PluginDefinition, stagingDirectory: string): Promise<void> {
  const manifest = await sourceManifest(plugin)
  const staged = stagedManifest(manifest, plugin.id)
  assertStagedManifest(staged, plugin.id)
  await writeJson(join(stagingDirectory, 'package.json'), staged)
}

/**
 * Verify every artifact the staged package and its profile link must expose.
 * @param plugin - plugin definition that declares the artifacts.
 * @param directory - staged or installed package root.
 * @param label - where the directory came from, for the failure message.
 */
export function assertStagedArtifacts(plugin: PluginDefinition, directory: string, label = 'staging'): void {
  for (const output of pluginArtifacts(plugin)) {
    const path = join(directory, output)
    if (!existsSync(path) || statSync(path).size === 0) fail(`${plugin.name} ${label} did not produce ${output}`)
  }
}

/**
 * Copy the plugin's declared staged entries from a build directory.
 *
 * Isolated builders pass their work copy, so a tracked `lib/` in the source
 * checkout can never leak into the staged package; sourcemap files stay out.
 * @param plugin - plugin definition that declares the entries.
 * @param buildDirectory - directory holding the built package files.
 * @param stagingDirectory - staged package root.
 */
export async function copyStagedEntries(
  plugin: PluginDefinition,
  buildDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  for (const entry of plugin.stage) {
    const source = join(buildDirectory, entry)
    if (!existsSync(source)) fail(`${plugin.name} is missing its staged entry ${entry} in ${buildDirectory}`)
    await cp(source, join(stagingDirectory, entry), {
      recursive: true,
      filter: path => !path.endsWith('.map'),
    })
  }
}

/** Stage the plugin manifest and the subscriptions-only runtime extras. */
async function stagePackage(
  plugin: PluginDefinition,
  stagingDirectory: string,
  dependencies: Awaited<ReturnType<typeof ensureBuildDependencies>>,
): Promise<void> {
  await writeStagedManifest(plugin, stagingDirectory)
  if (plugin.id === 'subscriptions') {
    const notices = join(stagingDirectory, 'third-party-licenses')
    await mkdir(join(notices, 'claude-code-wire-compat'), { recursive: true })
    await mkdir(join(notices, 'undici'), { recursive: true })
    await copyIfPresent(join(dependencies.wire.directory, 'LICENSE'), join(notices, 'claude-code-wire-compat', 'LICENSE'))
    await copyIfPresent(join(dependencies.wire.directory, 'NOTICE'), join(notices, 'claude-code-wire-compat', 'NOTICE'))
    await copyIfPresent(join(dependencies.undici.directory, 'LICENSE'), join(notices, 'undici', 'LICENSE'))
    await stageSubscriptionsTransport(stagingDirectory, dependencies.bunRuntime)
  }
}

/** One captured child-process result used by dependency preparation. */
export interface PluginCommandResult {
  readonly status: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: string
}

/** Runs one plugin-local command; tests inject a failing runner. */
export type PluginCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => PluginCommandResult

/** Whether the plugin lockfile asks pnpm to auto-install peers. */
export function lockfileAutoInstallPeers(lockfile: string): boolean {
  const match = /^\s+autoInstallPeers:\s*(true|false)\s*$/m.exec(lockfile)
  return match?.[1] !== 'false'
}

/**
 * The exact dependency install invocation for one plugin work copy.
 * @param lockfile - plugin `pnpm-lock.yaml` contents.
 * @param offline - whether to require the local pnpm store.
 * @returns pnpm arguments, excluding the repository pnpm entry prefix.
 */
export function pluginInstallArguments(lockfile: string, offline: boolean): string[] {
  return [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--config.confirm-modules-purge=false',
    // The lockfile is checked in, so offline preparation can trust it instead
    // of fetching supply-chain metadata for every entry.
    '--config.trust-lockfile=true',
    `--config.auto-install-peers=${lockfileAutoInstallPeers(lockfile)}`,
    '--config.verify-deps-before-run=false',
    '--child-concurrency=2',
    ...offline ? ['--offline'] : ['--prefer-offline'],
  ]
}

/** One attempted dependency preparation command. */
export interface DependencyAttempt {
  readonly command: string
  readonly status: number | null
  readonly detail?: string
}

/** A plugin-local dependency preparation failure with actionable context. */
export function dependencyPreparationError(
  plugin: PluginDefinition,
  workDirectory: string,
  attempts: readonly DependencyAttempt[],
): Error {
  const details = attempts.map((attempt) => {
    const tail = (attempt.detail ?? '').trim().split(/\r?\n/).filter(line => line !== '').slice(-4).join('\n    ')
    return `  ${attempt.command} -> ${attempt.status === null ? 'did not start' : `exit code ${String(attempt.status)}`}${tail === '' ? '' : `\n    ${tail}`}`
  })
  return new Error([
    `failed to prepare plugin-local dependencies for ${plugin.name} (${plugin.id})`,
    `  source: ${plugin.directory}`,
    `  build copy: ${workDirectory}`,
    ...details,
    'Fix: run `pnpm install --frozen-lockfile` in the build copy and review the reported error,',
    `or delete ${workDirectory} to force a clean preparation on the next build.`,
  ].join('\n'))
}

/** Run one child process, echoing its output and returning the exit facts. */
function runCaptured(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): PluginCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  })
  const stdout = result.stdout
  const stderr = result.stderr
  if (stdout !== '') process.stdout.write(stdout)
  if (stderr !== '') process.stderr.write(stderr)
  return {
    status: result.status,
    stdout,
    stderr,
    ...result.error === undefined ? {} : { error: String(result.error) },
  }
}

/** Environment shared by plugin-local installs and builds. */
function pluginBuildEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    pnpm_config_verify_deps_before_run: 'false',
    pnpm_config_trust_lockfile: 'true',
  }
}

/**
 * Install the isolated plugin's pinned dependencies.
 *
 * The local pnpm store is tried first so offline machines and CI caches need no
 * network; a missing store entry retries with pnpm's normal network access.
 * @param plugin - plugin being prepared.
 * @param workDirectory - isolated copy that contains the lockfile.
 * @param runner - command runner; tests inject a failing one.
 */
export async function ensurePluginDependencies(
  plugin: PluginDefinition,
  workDirectory: string,
  runner: PluginCommandRunner = runCaptured,
): Promise<void> {
  const lockPath = join(workDirectory, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) {
    throw dependencyPreparationError(plugin, workDirectory, [{
      command: 'pnpm install --frozen-lockfile',
      status: null,
      detail: `${lockPath} is missing; the isolated build copy must include the plugin lockfile`,
    }])
  }
  const lockfile = await readFile(lockPath, 'utf8')
  const workspacePath = join(workDirectory, 'pnpm-workspace.yaml')
  const manifestPath = join(workDirectory, 'package.json')
  const dependencyKey = createHash('sha256').update([
    String(SCRIPT_VERSION),
    lockfile,
    existsSync(workspacePath) ? await readFile(workspacePath, 'utf8') : '',
    existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : '',
  ].join('\0')).digest('hex')
  const markerPath = join(workDirectory, DEPENDENCY_MARKER_FILE)
  if (existsSync(markerPath) && existsSync(join(workDirectory, 'node_modules'))) {
    try {
      const marker = await readJson<DependencyMarker>(markerPath)
      if (marker.schema === 1 && marker.key === dependencyKey) {
        log(`${plugin.name} plugin-local dependencies are current`)
        return
      }
    } catch {
      // A malformed marker is not authoritative; reinstall below.
    }
  }
  const pnpm = pnpmCommand()
  const attempts: DependencyAttempt[] = []
  for (const offline of [true, false]) {
    if (!offline) warn(`offline dependency install for ${plugin.name} failed; retrying with network access`)
    const args = pluginInstallArguments(lockfile, offline)
    const commandLine = `${basename(pnpm.command)} ${[...pnpm.prefix, ...args].join(' ')}`
    const result = runner(pnpm.command, [...pnpm.prefix, ...args], { cwd: workDirectory, env: pluginBuildEnvironment() })
    if (result.status === 0 && existsSync(join(workDirectory, 'node_modules'))) {
      await writeJson(markerPath, { schema: 1, key: dependencyKey })
      log(`installed plugin-local dependencies for ${plugin.name}`)
      return
    }
    const detail = result.error ?? result.stderr ?? (result.status === 0 ? 'pnpm install created no node_modules directory' : undefined)
    attempts.push({
      command: commandLine,
      status: result.status,
      ...detail === undefined ? {} : { detail },
    })
  }
  throw dependencyPreparationError(plugin, workDirectory, attempts)
}

/** Whether an isolated work copy still matches the source key and has its outputs. */
async function workIsCurrent(plugin: PluginDefinition, workDirectory: string, key: string): Promise<boolean> {
  const markerPath = join(workDirectory, WORK_MARKER_FILE)
  if (!existsSync(markerPath)) return false
  try {
    const marker = await readJson<WorkMarker>(markerPath)
    if (marker.schema !== 1 || marker.key !== key) return false
  } catch {
    return false
  }
  if (plugin.installDependencies && !existsSync(join(workDirectory, 'node_modules'))) return false
  return plugin.outputs.every(output => existsSync(join(workDirectory, output)))
}

/**
 * Prepare and build one isolated plugin copy with the plugin's own build script.
 * @param plugin - plugin definition whose sources are copied.
 * @param key - source/toolchain key that decides whether the copy is current.
 * @param force - rebuild even when the work marker matches.
 * @returns the work directory holding the built package.
 */
export async function ensureIsolatedBuild(plugin: PluginDefinition, key: string, force = false): Promise<string> {
  const workDirectory = join(WORK_ROOT, plugin.id)
  if (!force && await workIsCurrent(plugin, workDirectory, key)) {
    log(`${plugin.name} isolated build is current`)
    return workDirectory
  }
  await rm(workDirectory, { recursive: true, force: true })
  await mkdir(workDirectory, { recursive: true })
  for (const entry of plugin.workCopy) {
    const source = join(plugin.directory, entry)
    if (!existsSync(source)) fail(`${plugin.name} cannot build from source: its ${entry} is missing`)
    await cp(source, join(workDirectory, entry), { recursive: true })
  }
  if (plugin.installDependencies) await ensurePluginDependencies(plugin, workDirectory)
  log(`building ${plugin.name} with its own build script in ${workDirectory}`)
  const pnpm = pnpmCommand()
  try {
    run(pnpm.command, [...pnpm.prefix, 'run', 'build'], { cwd: workDirectory, env: pluginBuildEnvironment() })
  } catch (error) {
    fail(`${plugin.name} build failed in ${workDirectory}: ${error instanceof Error ? error.message : String(error)}. `
      + `Review the build output above, then delete ${workDirectory} to force a clean rebuild.`)
  }
  for (const output of plugin.outputs) {
    const path = join(workDirectory, output)
    if (!existsSync(path) || statSync(path).size === 0) fail(`${plugin.name} build in ${workDirectory} did not produce ${output}`)
  }
  await writeJson(join(workDirectory, WORK_MARKER_FILE), {
    schema: 1,
    key,
    builtAt: new Date().toISOString(),
  } satisfies WorkMarker)
  return workDirectory
}

/** Build one plugin into its staging directory and verify the expected artifacts. */
async function buildPlugin(
  plugin: PluginDefinition,
  stagingDirectory: string,
  dependencies: Awaited<ReturnType<typeof ensureBuildDependencies>>,
  key: string,
  force: boolean,
): Promise<void> {
  await replaceStagingDirectory(stagingDirectory, async (temporary) => {
    if (plugin.builder === 'isolated') {
      const workDirectory = await ensureIsolatedBuild(plugin, key, force)
      await copyStagedEntries(plugin, workDirectory, temporary)
    } else {
      const config = plugin.builder === 'subscriptions'
        ? await subscriptionsConfig(temporary, dependencies.wireEntry, dependencies.undiciEntry)
        : await aetherConfig(temporary)
      log(`building ${plugin.name} from source`)
      run(process.execPath, [rootTsdown(), '--config', config], { cwd: REPOSITORY_ROOT })
      if (plugin.builder === 'subscriptions') buildSubscriptionsTransport(plugin.directory, temporary)
      await copyStagedEntries(plugin, plugin.directory, temporary)
    }
    await stagePackage(plugin, temporary, dependencies)
    assertStagedArtifacts(plugin, temporary)
  })
}

/** Whether a previous staging still matches the current source and expected files. */
export async function stagingIsCurrent(
  plugin: PluginDefinition,
  stagingDirectory: string,
  state: BuildState,
  key: string,
  force: boolean,
): Promise<boolean> {
  if (force) return false
  const recorded = state.plugins[plugin.id]
  if (recorded === undefined || recorded.key !== key || recorded.version !== (await sourceManifest(plugin)).version) return false
  for (const file of ['package.json', 'cordis.patch.yml', ...pluginArtifacts(plugin)]) {
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

/** One patch layer the legacy-provider guard reads before any write. */
export interface PatchSource {
  /** Human label used by the failure report. */
  readonly label: string
  /** Absolute patch file path. */
  readonly path: string
  /** Whether a legacy declaration here may be rewritten automatically. */
  readonly migrate?: boolean
  /** Whether a missing file is a configuration error instead of an absent layer. */
  readonly required?: boolean
}

/** One legacy `providers.cc-pool` declaration inside an `llm-pi-ai` row. */
export interface LegacyPoolFinding {
  /** Path to the `cc-pool` key from the document root. */
  readonly path: readonly (string | number)[]
}

/** One profile patch rewrite planned by the guard. */
export interface ProfilePatchMigration {
  /** Patch file the migration rewrites after the backup exists. */
  readonly path: string
  /** Number of legacy declarations the rewrite removes. */
  readonly removed: number
}

/** Guard result: patches that still need a rewrite before the profile is used. */
export interface LegacyPoolGuardResult {
  readonly migrations: readonly ProfilePatchMigration[]
}

/**
 * YAML type for the loader's `!!js` scalar expressions. Guard and migration only
 * read structure, so the expression text is kept verbatim as an opaque value.
 */
const JAVASCRIPT_EXPRESSION_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data: string) => ({ jsExpression: data }),
})

/** Schema that parses every tracked patch, including its `!!js` expressions. */
const PATCH_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JAVASCRIPT_EXPRESSION_TAG])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse a patch file structurally.
 * @param source - YAML text.
 * @param label - file label for the diagnostic.
 * @returns the parsed document.
 */
function parsePatchDocument(source: string, label = 'patch'): unknown {
  try {
    return yaml.load(source, { schema: PATCH_YAML_SCHEMA })
  } catch (error) {
    throw new Error(`${label} is not readable YAML: ${errorMessage(error)}`)
  }
}

function ownsLegacyPoolRow(record: Record<string, unknown>): boolean {
  return record['id'] === 'llm-pi-ai' || record['name'] === '@deepseek-ai/dsh-llm-pi-ai'
}

function formatFindingPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (current, segment) => typeof segment === 'number' ? `${current}[${String(segment)}]` : `${current}.${segment}`,
    '$',
  )
}

/**
 * Find every legacy `llm-pi-ai` `providers.cc-pool` declaration.
 *
 * This is structural: quoted keys, flow mappings, `insert` wrappers, and rows
 * identified by package name all resolve through the parsed YAML. Comments and
 * the dedicated `llm-cc-pool` row are never findings.
 * @param source - patch text.
 * @param label - file label for a parse diagnostic.
 * @returns the declarations in document order.
 */
export function findLegacyPoolProviders(source: string, label = 'patch'): LegacyPoolFinding[] {
  const document = parsePatchDocument(source, label)
  const findings: LegacyPoolFinding[] = []
  const visited = new WeakSet<object>()
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (typeof value !== 'object' || value === null) return
    if (visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach((entry, index) => { visit(entry, [...path, index]) })
      return
    }
    const record = value as Record<string, unknown>
    if (ownsLegacyPoolRow(record)) {
      const config = record['config']
      if (isRecord(config)) {
        const providers = config['providers']
        if (isRecord(providers) && Object.hasOwn(providers, 'cc-pool')) {
          findings.push({ path: [...path, 'config', 'providers', 'cc-pool'] })
        }
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...path, key])
  }
  visit(document, [])
  return findings
}

function childAt(value: unknown, key: string | number): unknown {
  if (Array.isArray(value) && typeof key === 'number') return value[key]
  if (isRecord(value)) return value[String(key)]
  throw new Error(`cannot follow ${String(key)} in the parsed patch`)
}

/**
 * The parsed document with one legacy provider removed.
 *
 * A `providers` mapping that becomes empty is kept as `{}`: the declaration is
 * gone, but the profile still states that this adapter configures no routes.
 * @param document - parsed patch.
 * @param path - finding path to the `cc-pool` key.
 * @returns a new document value.
 */
function withoutLegacyPoolProvider(document: unknown, path: readonly (string | number)[]): unknown {
  const clone = structuredClone(document)
  const parentPath = path.slice(0, -1)
  let parent: unknown = clone
  for (const key of parentPath) parent = childAt(parent, key)
  if (!isRecord(parent)) throw new Error(`the legacy provider at ${formatFindingPath(path)} has no mapping parent`)
  Reflect.deleteProperty(parent, String(path[path.length - 1]))
  return clone
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t'
}

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n'
}

function skipSpaces(source: string, index: number): number {
  let position = index
  while (isSpace(source[position])) position += 1
  return position
}

function skipWhitespace(source: string, index: number): number {
  let position = index
  while (isWhitespace(source[position])) position += 1
  return position
}

function previousNonWhitespace(source: string, index: number): number {
  let position = index
  while (position >= 0 && isWhitespace(source[position])) position -= 1
  return position
}

/** End index (exclusive) of a quoted scalar, or undefined when it is unterminated. */
function quotedScalarEnd(source: string, start: number): number | undefined {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (quote === "'" && character === "'") {
      if (source[index + 1] === "'") {
        index += 2
        continue
      }
      return index + 1
    }
    if (quote === '"' && character === '\\') {
      index += 2
      continue
    }
    if (quote === '"' && character === '"') return index + 1
    index += 1
  }
  return undefined
}

/** Whether the position starts a mapping key in block or flow context. */
function isKeyPosition(source: string, start: number): boolean {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const prefix = source.slice(lineStart, start)
  if (/^[ \t]*$/.test(prefix)) return true
  if (/^[ \t]*-[ \t]+$/.test(prefix)) return true
  const previous = previousNonWhitespace(source, start - 1)
  return previous >= 0 && (source[previous] === '{' || source[previous] === ',')
}

function isKeyColon(source: string, index: number): boolean {
  return source[skipSpaces(source, index)] === ':'
}

function hasNameBoundary(source: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : source[index - 1] ?? ''
  const after = source[index + length] ?? ''
  return !/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)
}

interface KeyOccurrence {
  readonly start: number
  readonly end: number
  readonly name: string
}

/** Every plain or quoted mapping-key occurrence of one name, outside comments and values. */
function keyOccurrences(source: string, name: string): KeyOccurrence[] {
  const occurrences: KeyOccurrence[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character === '#') {
      const before = index === 0 ? '\n' : source[index - 1]
      if (before !== undefined && /\s/.test(before)) {
        const newline = source.indexOf('\n', index)
        index = newline < 0 ? source.length : newline + 1
        continue
      }
    }
    const tokenStart = index === 0 || /[\s{[,:-]/.test(source[index - 1] ?? '')
    if ((character === "'" || character === '"') && tokenStart) {
      const end = quotedScalarEnd(source, index)
      if (end === undefined) {
        index += 1
        continue
      }
      const inner = character === '"' ? source.slice(index + 1, end - 1) : source.slice(index + 1, end - 1).replaceAll("''", "'")
      if (inner === name && isKeyPosition(source, index) && isKeyColon(source, end)) {
        occurrences.push({ start: index, end, name })
      }
      index = end
      continue
    }
    if (source.startsWith(name, index)
      && hasNameBoundary(source, index, name.length)
      && isKeyPosition(source, index)
      && isKeyColon(source, index + name.length)) {
      occurrences.push({ start: index, end: index + name.length, name })
      index += name.length
      continue
    }
    index += 1
  }
  return occurrences
}

interface SourceRange {
  readonly start: number
  readonly end: number
}

/** End index of one flow collection starting at `start`, quotes and comments aware. */
function matchingFlowEnd(source: string, start: number): number | undefined {
  const expected: string[] = []
  let index = start
  while (index < source.length) {
    const character = source[index]
    if (character === "'" || character === '"') {
      const end = quotedScalarEnd(source, index)
      if (end === undefined) return undefined
      index = end
      continue
    }
    if (character === '#' && /\s/.test(source[index - 1] ?? '\n')) {
      const newline = source.indexOf('\n', index)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (character === '{') expected.push('}')
    else if (character === '[') expected.push(']')
    else if (character === '}' || character === ']') {
      if (expected.pop() !== character) return undefined
      if (expected.length === 0) return index + 1
    }
    index += 1
  }
  return undefined
}

/** End index of a flow value beginning at `start`. */
function flowValueEnd(source: string, start: number): number | undefined {
  const character = source[start]
  if (character === undefined) return undefined
  if (character === '{' || character === '[') return matchingFlowEnd(source, start)
  if (character === "'" || character === '"') return quotedScalarEnd(source, start)
  let index = start
  while (index < source.length) {
    const current = source[index]
    if (current === ',' || current === '}' || current === ']') return index
    if (current === '#' && /\s/.test(source[index - 1] ?? '\n')) return index
    index += 1
  }
  return index
}

/** End index of a nested block mapping or sequence value starting at `start`. */
function nestedBlockEnd(source: string, start: number, keyIndent: number): number {
  let position = start
  while (position < source.length) {
    const lineEnd = source.indexOf('\n', position)
    const next = lineEnd < 0 ? source.length : lineEnd + 1
    const line = source.slice(position, lineEnd < 0 ? source.length : lineEnd)
    const trimmed = line.trim()
    if (trimmed === '') {
      position = next
      continue
    }
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0
    if (trimmed.startsWith('#') && indent <= keyIndent) return position
    if (indent <= keyIndent) return position
    position = next
  }
  return source.length
}

/** Removal range for a block mapping entry. */
function blockKeyRange(source: string, occurrence: KeyOccurrence): SourceRange | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const lineStart = source.lastIndexOf('\n', occurrence.start - 1) + 1
  const prefix = source.slice(lineStart, occurrence.start)
  if (!/^[ \t]*$/.test(prefix) && !/^[ \t]*-[ \t]+$/.test(prefix)) return undefined
  const keyIndent = /^[ \t]*/.exec(prefix)?.[0].length ?? 0
  const inlineStart = skipSpaces(source, colon + 1)
  const rawLineEnd = source.indexOf('\n', colon)
  const lineEnd = rawLineEnd < 0 ? source.length : rawLineEnd
  const inline = source.slice(inlineStart, lineEnd)
  const hasInlineValue = inline.trim() !== '' && !inline.trimStart().startsWith('#')
  if (!hasInlineValue) return { start: lineStart, end: nestedBlockEnd(source, lineEnd + 1, keyIndent) }
  const first = source[inlineStart]
  if (first === '{' || first === '[') {
    const close = matchingFlowEnd(source, inlineStart)
    if (close === undefined) return undefined
    const tail = source.slice(skipSpaces(source, close), lineEnd)
    const finish = tail.trim() === '' || tail.trimStart().startsWith('#') ? (rawLineEnd < 0 ? source.length : rawLineEnd + 1) : close
    return { start: lineStart, end: finish }
  }
  const trimmed = inline.trimStart()
  if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
    return { start: lineStart, end: nestedBlockEnd(source, lineEnd + 1, keyIndent) }
  }
  return { start: lineStart, end: rawLineEnd < 0 ? source.length : rawLineEnd + 1 }
}

/** Removal range for one entry inside a flow mapping. */
function flowEntryRange(source: string, occurrence: KeyOccurrence): SourceRange | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const valueStart = skipWhitespace(source, colon + 1)
  const valueEnd = flowValueEnd(source, valueStart)
  if (valueEnd === undefined) return undefined
  const afterValue = skipWhitespace(source, valueEnd)
  if (source[afterValue] === ',') return { start: occurrence.start, end: afterValue + 1 }
  const beforeEntry = previousNonWhitespace(source, occurrence.start - 1)
  if (source[beforeEntry] === ',') return { start: beforeEntry, end: valueEnd }
  return { start: occurrence.start, end: valueEnd }
}

interface TextEdit extends SourceRange {
  readonly replacement: string
}

/** Replace a block mapping value with an empty flow mapping. */
function blockValueEmptyMapEdit(source: string, occurrence: KeyOccurrence): TextEdit | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const lineStart = source.lastIndexOf('\n', occurrence.start - 1) + 1
  const prefix = source.slice(lineStart, occurrence.start)
  if (!/^[ \t]*$/.test(prefix) && !/^[ \t]*-[ \t]+$/.test(prefix)) return undefined
  const keyIndent = /^[ \t]*/.exec(prefix)?.[0].length ?? 0
  const inlineStart = skipSpaces(source, colon + 1)
  const rawLineEnd = source.indexOf('\n', colon)
  const lineEnd = rawLineEnd < 0 ? source.length : rawLineEnd
  const inline = source.slice(inlineStart, lineEnd)
  if (inline.trim() === '') {
    const blockEnd = nestedBlockEnd(source, lineEnd + 1, keyIndent)
    const newline = blockEnd > colon + 1 && source[blockEnd - 1] === '\n' ? '\n' : ''
    return { start: colon + 1, end: blockEnd, replacement: ` {}${newline}` }
  }
  if (inline.trimStart().startsWith('#')) {
    // A comment between the key and its nested value is kept, so the empty map
    // is inserted before it instead of replacing the comment.
    const blockEnd = nestedBlockEnd(source, lineEnd + 1, keyIndent)
    const newline = blockEnd > inlineStart && source[blockEnd - 1] === '\n' ? '\n' : ''
    return { start: inlineStart, end: blockEnd, replacement: `{} ${source.slice(inlineStart, lineEnd)}${newline}` }
  }
  if (source[inlineStart] !== '{' && source[inlineStart] !== '[') return undefined
  const close = matchingFlowEnd(source, inlineStart)
  return close === undefined ? undefined : { start: inlineStart, end: close, replacement: '{}' }
}

/** Replace a flow mapping entry's value with an empty flow mapping. */
function flowValueEmptyMapEdit(source: string, occurrence: KeyOccurrence): TextEdit | undefined {
  const colon = skipSpaces(source, occurrence.end)
  if (source[colon] !== ':') return undefined
  const valueStart = skipWhitespace(source, colon + 1)
  const valueEnd = flowValueEnd(source, valueStart)
  return valueEnd === undefined ? undefined : { start: valueStart, end: valueEnd, replacement: '{}' }
}

/** Try every textual edit that reproduces the structurally computed target. */
function findTextualRemoval(source: string, target: unknown): string | undefined {
  const edits: TextEdit[] = []
  for (const name of ['cc-pool', 'providers'] as const) {
    for (const occurrence of keyOccurrences(source, name)) {
      const block = blockKeyRange(source, occurrence)
      if (block !== undefined) edits.push({ ...block, replacement: '' })
      const flow = flowEntryRange(source, occurrence)
      if (flow !== undefined) edits.push({ ...flow, replacement: '' })
      if (name !== 'providers') continue
      const blockValue = blockValueEmptyMapEdit(source, occurrence)
      if (blockValue !== undefined) edits.push(blockValue)
      const flowValue = flowValueEmptyMapEdit(source, occurrence)
      if (flowValue !== undefined) edits.push(flowValue)
    }
  }
  const attempted = new Set<string>()
  for (const edit of edits) {
    const key = `${edit.start}:${edit.end}:${edit.replacement}`
    if (attempted.has(key) || edit.end < edit.start) continue
    attempted.add(key)
    const candidate = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end)
    let parsed: unknown
    try {
      parsed = parsePatchDocument(candidate)
    } catch {
      continue
    }
    if (isDeepStrictEqual(parsed, target)) return candidate
  }
  return undefined
}

/** Outcome of removing every legacy provider declaration from one patch. */
export interface LegacyPoolMigration {
  readonly source: string
  readonly removed: number
}

/**
 * Remove the legacy `llm-pi-ai` `providers.cc-pool` declaration structurally.
 *
 * The rewrite is accepted only when re-parsing the edited text equals the parsed
 * document with that provider removed, so comments and unrelated rows are kept
 * and an unusual layout fails instead of producing a half-edited profile.
 * @param source - profile patch text.
 * @param label - file label for diagnostics.
 * @returns the migrated text and the number of declarations removed.
 */
export function migrateLegacyPoolProvider(source: string, label = 'profile patch'): LegacyPoolMigration {
  let current = source
  let removed = 0
  for (;;) {
    const findings = findLegacyPoolProviders(current, label)
    if (findings.length === 0) return { source: current, removed }
    const finding = findings[0]
    if (finding === undefined) return { source: current, removed }
    const document = parsePatchDocument(current, label)
    const target = withoutLegacyPoolProvider(document, finding.path)
    const candidate = findTextualRemoval(current, target)
    if (candidate === undefined) {
      throw new Error(`${label} declares ${formatFindingPath(finding.path)} in a layout this build cannot rewrite safely`)
    }
    current = candidate
    removed += 1
    if (removed > 32) throw new Error(`${label} has too many legacy cc-pool declarations to migrate`)
  }
}

function legacyDeclarationError(source: PatchSource, findings: readonly LegacyPoolFinding[]): Error {
  const locations = findings.map(finding => formatFindingPath(finding.path)).join(', ')
  return new Error([
    `${source.label} at ${source.path} still declares the legacy llm-pi-ai "providers.cc-pool" route (${locations}).`,
    `Remove the "cc-pool" key under the llm-pi-ai row's config.providers in ${source.path} (block, quoted, or flow-map form), then run build.cmd again.`,
    'The dedicated @deepseek-ai/dsh-llm-cc-pool bundle must be the only owner of the cc-pool route; keeping both makes two adapters claim it and plugin loading fails.',
    'No profile or staging file was changed.',
  ].join('\n'))
}

/**
 * Every patch layer the web profile composes before and around seeding.
 * @param input - repository root, Harness home, profile directory, and extra overlays.
 * @returns the guard sources in composition order.
 */
export function compositionPatchSources(input: {
  readonly home: string
  readonly profileDirectory: string
  readonly repositoryRoot?: string
  readonly overlays?: readonly string[]
}): PatchSource[] {
  const repositoryRoot = input.repositoryRoot ?? REPOSITORY_ROOT
  const sources: PatchSource[] = [
    { label: 'repository base bundle patch', path: join(repositoryRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml') },
    { label: 'repository web bundle patch', path: join(repositoryRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml') },
    { label: 'portable profile template', path: join(repositoryRoot, 'fork-runtime', 'web', 'portable-profile.patch.yml') },
    { label: 'portable memory-limits template', path: join(repositoryRoot, 'fork-runtime', 'web', 'portable-memory-limits.patch.yml') },
    { label: 'repository diagnostics overlay', path: join(repositoryRoot, 'fork-runtime', 'diagnostics', 'cordis.patch.yml') },
    { label: 'profile patch', path: join(input.profileDirectory, 'cordis.patch.yml'), migrate: true },
    { label: 'profile memory-limits overlay', path: join(input.profileDirectory, 'memory-limits.patch.yml') },
    { label: 'home patch', path: join(input.home, 'cordis.patch.yml') },
  ]
  for (const overlay of input.overlays ?? []) {
    sources.push({ label: `--patch overlay ${overlay}`, path: resolve(overlay), required: true })
  }
  return sources
}

/**
 * Inspect every composition source before the build writes staging or profile files.
 *
 * A legacy declaration outside the target profile patch is never rewritten: the
 * guard fails with the exact file and key to remove. The target profile patch is
 * only accepted when the structural rewrite reproduces the expected document.
 * @param sources - patch layers to inspect.
 * @returns the profile rewrites the caller must apply after taking the backup.
 */
export async function guardLegacyPoolProviders(sources: readonly PatchSource[]): Promise<LegacyPoolGuardResult> {
  const migrations: ProfilePatchMigration[] = []
  for (const source of sources) {
    if (!existsSync(source.path)) {
      if (source.required === true) throw new Error(`required patch ${source.label} is missing at ${source.path}`)
      continue
    }
    const text = await readFile(source.path, 'utf8')
    let findings: LegacyPoolFinding[]
    try {
      findings = findLegacyPoolProviders(text, source.label)
    } catch (error) {
      throw new Error(`${source.label} at ${source.path} could not be inspected: ${errorMessage(error)}. No profile or staging file was changed.`)
    }
    if (findings.length === 0) continue
    if (source.migrate !== true) throw legacyDeclarationError(source, findings)
    try {
      const migrated = migrateLegacyPoolProvider(text, `${source.label} at ${source.path}`)
      migrations.push({ path: source.path, removed: migrated.removed })
    } catch (error) {
      throw new Error([
        `cannot safely migrate ${source.path}: ${errorMessage(error)}`,
        `Edit ${source.path} and delete the "cc-pool" key under the llm-pi-ai row's config.providers (block, quoted, or flow-map form), then run build.cmd again.`,
        'No profile or staging file was changed.',
      ].join('\n'))
    }
  }
  return { migrations }
}

/** Profile files the build may rewrite or create. */
const PROFILE_BACKUP_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'compatibility.json',
  'memory-watchdog.cjs',
  'chatgpt-subagent-preset.cjs',
  'goal-disabled.cjs',
  'memory-limits.patch.yml',
] as const

/** Home files the portable seed may create. */
const HOME_BACKUP_FILES = [
  '.agent-presets/chatgpt-dsh/agent.cordis.yml',
  '.agent-presets/chatgpt-dsh/preset.yml',
  '.agent-presets/chatgpt-dsh/no-escalation.cjs',
] as const

/** One file recorded by a profile backup. */
export interface ProfileBackupEntry {
  /** Root that owns the file: the profile or the Harness home. */
  readonly root: 'profile' | 'home'
  /** Portable relative path below that root. */
  readonly relative: string
  /** Whether the file existed when the backup was taken. */
  readonly existed: boolean
}

/** Snapshot of every profile and seed file the build may change. */
export interface ProfileBackup {
  /** Backup directory holding `backup.json` and the copied files. */
  readonly directory: string
  /** Profile directory the backup belongs to. */
  readonly profileDirectory: string
  /** Harness home that owns the seed files. */
  readonly home: string
  /** Whether the profile directory existed before the build. */
  readonly profileDirectoryExisted: boolean
  /** Whether the profile manifest existed before the build. */
  readonly profileExisted: boolean
  /** Recorded files and whether each existed. */
  readonly entries: readonly ProfileBackupEntry[]
}

/** Files restored or removed by a rollback. */
export interface ProfileRollbackResult {
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  readonly profileRemoved: boolean
  readonly failures: readonly string[]
}

function backupFileDestination(directory: string, entry: ProfileBackupEntry): string {
  return join(directory, entry.root, ...entry.relative.split('/'))
}

/**
 * Snapshot the profile and portable seed files before the build mutates them.
 * @param options - profile directory and Harness home.
 * @returns the recorded backup.
 */
export async function backupProfile(options: {
  readonly profileDirectory: string
  readonly home: string
}): Promise<ProfileBackup> {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const directory = join(BUILD_ROOT, 'backups', `${PROFILE_NAME}-${stamp}-${process.pid}`)
  await mkdir(directory, { recursive: true })
  const entries: ProfileBackupEntry[] = []
  for (const [root, base, files] of [
    ['profile', options.profileDirectory, PROFILE_BACKUP_FILES],
    ['home', options.home, HOME_BACKUP_FILES],
  ] as const) {
    for (const relative of files) {
      const source = join(base, ...relative.split('/'))
      const existed = existsSync(source)
      const entry: ProfileBackupEntry = { root, relative, existed }
      entries.push(entry)
      if (!existed) continue
      const destination = backupFileDestination(directory, entry)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
  }
  const backup: ProfileBackup = {
    directory,
    profileDirectory: options.profileDirectory,
    home: options.home,
    profileDirectoryExisted: existsSync(options.profileDirectory),
    profileExisted: existsSync(join(options.profileDirectory, 'package.json')),
    entries,
  }
  await writeFile(join(directory, 'backup.json'), `${JSON.stringify(backup, undefined, 2)}\n`)
  await writeFile(join(directory, 'profile-path.txt'), `${options.profileDirectory}\n`)
  if (!backup.profileExisted) {
    await writeFile(
      join(directory, 'profile-created-by-build.txt'),
      'The profile did not exist before this run; no prior configuration existed to back up.\n',
    )
  }
  return backup
}

function safeRelativePath(root: string, relative: string): string | undefined {
  const normalized = relative.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  return join(root, ...parts)
}

/**
 * Restore the profile and seed files recorded by {@link backupProfile}.
 *
 * A profile directory that did not exist before the build is removed entirely;
 * otherwise every recorded file is restored byte-for-byte and every file the
 * build created is removed. Package-manager state under `node_modules` is not
 * copied; the restored manifest and lockfile are the next build's input.
 * @param backup - snapshot returned by {@link backupProfile}.
 * @returns what was restored or removed, plus any rollback failures.
 */
export async function rollbackProfileBackup(backup: ProfileBackup): Promise<ProfileRollbackResult> {
  const restored: string[] = []
  const removed: string[] = []
  const failures: string[] = []
  for (const entry of backup.entries) {
    if (!backup.profileDirectoryExisted && entry.root === 'profile') continue
    const root = entry.root === 'profile' ? backup.profileDirectory : backup.home
    const target = safeRelativePath(root, entry.relative)
    if (target === undefined) {
      failures.push(`refused unsafe backup path ${entry.relative}`)
      continue
    }
    if (entry.existed) {
      const source = backupFileDestination(backup.directory, entry)
      if (!existsSync(source)) {
        failures.push(`backup copy of ${entry.relative} is missing from ${backup.directory}`)
        continue
      }
      try {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(source, target)
        restored.push(target)
      } catch (error) {
        failures.push(`could not restore ${target}: ${errorMessage(error)}`)
      }
      continue
    }
    if (!existsSync(target)) continue
    try {
      await rm(target, { force: true })
      removed.push(target)
    } catch (error) {
      failures.push(`could not remove ${target}: ${errorMessage(error)}`)
    }
  }
  let profileRemoved = false
  if (!backup.profileDirectoryExisted && existsSync(backup.profileDirectory)) {
    try {
      await rm(backup.profileDirectory, { recursive: true, force: true })
      profileRemoved = true
    } catch (error) {
      failures.push(`could not remove ${backup.profileDirectory}: ${errorMessage(error)}`)
    }
  }
  return { restored, removed, profileRemoved, failures }
}

/** Profile manifest fields the bundle reconciliation owns. */
interface ProfileManifest extends PluginManifest {
  dsh?: { profile?: { bundles?: string[] } }
}

/**
 * Add missing bundle-layer entries to an installed profile manifest.
 * @param profileDirectory - profile whose manifest records the bundle order.
 * @param names - bundle package names that must contribute a layer.
 */
export async function ensureProfileBundles(profileDirectory: string, names: readonly string[]): Promise<void> {
  const manifestPath = join(profileDirectory, 'package.json')
  if (!existsSync(manifestPath)) fail(`cannot add profile bundle entries: ${manifestPath} is missing`)
  const manifest = await readJson<ProfileManifest>(manifestPath)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const missing = names.filter(name => !bundles.includes(name))
  if (missing.length === 0) return
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, ...missing] } }
  await writeJson(manifestPath, manifest)
  log(`added profile bundle entr${missing.length === 1 ? 'y' : 'ies'} ${missing.join(', ')}`)
}

/** One install-then-seed pass for the selected profile. */
export interface ProfileInstallAndSeedOptions {
  /** Harness home that owns the profile. */
  readonly home: string
  /** Profile directory being installed into. */
  readonly profileDirectory: string
  /** Bundle-layer names the installed packages must contribute. */
  readonly bundleNames: readonly string[]
  /** Runs the package installation; omitted when the profile already resolves. */
  readonly install?: () => void | Promise<void>
  /** Seed override for tests; defaults to the portable profile kit. */
  readonly seed?: () => Promise<SeedResult>
}

/**
 * Ensure the installed profile's bundle entries, then seed it.
 *
 * Seeding happens only after the install callback returns, so a failed install
 * cannot leave a freshly seeded profile behind. The caller owns backup and
 * rollback around this step.
 * @param options - install callback, bundle names, and optional seed override.
 * @returns the seed result.
 */
export async function installAndSeedProfile(options: ProfileInstallAndSeedOptions): Promise<SeedResult> {
  await options.install?.()
  await ensureProfileBundles(options.profileDirectory, options.bundleNames)
  return options.seed === undefined
    ? seedPortableProfile({ dshHome: options.home })
    : options.seed()
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
  for (const output of pluginArtifacts(plugin.definition)) {
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
 * Apply the guard's planned profile rewrites, re-reading the file first so an
 * external edit cannot make the build write text the guard never validated.
 * @param migrations - profile patches to migrate.
 */
async function applyProfileMigrations(migrations: readonly ProfilePatchMigration[]): Promise<void> {
  for (const migration of migrations) {
    if (!existsSync(migration.path)) continue
    const current = await readFile(migration.path, 'utf8')
    const migrated = migrateLegacyPoolProvider(current, migration.path)
    if (migrated.removed === 0) continue
    await writeTextAtomic(migration.path, migrated.source)
    log(`removed ${String(migrated.removed)} legacy llm-pi-ai "providers.cc-pool" declaration(s) from ${migration.path}`)
  }
}

/** Verify the installed profile resolves every staged package and owns only one cc-pool route. */
async function verifyInstalledProfile(
  staged: readonly StagedPlugin[],
  profileDirectory: string,
  sources: readonly PatchSource[],
): Promise<void> {
  const problems: string[] = []
  for (const plugin of staged) {
    const problem = await profileProblem(plugin, profileDirectory)
    if (problem !== undefined) problems.push(problem)
  }
  if (problems.length > 0) {
    throw new Error(`the profile does not resolve the staged plugins after installation:\n  ${problems.join('\n  ')}`)
  }
  const post = await guardLegacyPoolProviders(sources)
  if (post.migrations.length > 0) {
    throw new Error(`the profile still declares the legacy llm-pi-ai "providers.cc-pool" route after migration:\n  ${post.migrations.map(item => item.path).join('\n  ')}`)
  }
}

/**
 * Build or stage the four fork plugins and the workspace llm-cc-pool package,
 * then make the selected web profile resolve them.
 *
 * The composition guard runs before staging or profile work. The profile backup
 * then precedes every mutation, and a later failure restores it.
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
  const sources = compositionPatchSources({ home, profileDirectory, overlays: options.patchOverlays })
  const guard = await guardLegacyPoolProviders(sources)
  for (const migration of guard.migrations) {
    log(`profile patch ${migration.path} still declares the legacy llm-pi-ai "providers.cc-pool" route; it will be removed after the backup`)
  }
  const backup = await backupProfile({ profileDirectory, home })
  try {
    await applyProfileMigrations(guard.migrations)
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
        keyParts.push(dependencies.bunRuntime.packageName, dependencies.bunRuntime.version)
      }
      const key = createHash('sha256').update(keyParts.join('\n')).digest('hex')
      const current = await stagingIsCurrent(plugin, stagingDirectory, state, key, options.forceRebuild)
      if (current) {
        log(`${plugin.name} staging is current (${version})`)
      } else {
        await buildPlugin(plugin, stagingDirectory, dependencies, key, options.forceRebuild)
        changed = true
        state.plugins[plugin.id] = { key, version, installedAt: new Date().toISOString() }
        await writeJson(STATE_FILE, state)
      }
      staged.push({ definition: plugin, directory: stagingDirectory, version, changed: !current })
    }
    for (const plugin of WORKSPACE_PLUGINS) {
      const stagingDirectory = join(BUILD_ROOT, plugin.id)
      const version = (await sourceManifest(plugin)).version
      if (version === undefined) fail(`${plugin.name} source manifest has no version`)
      await stageWorkspacePlugin(plugin, stagingDirectory)
      log(`${plugin.name} staged from the root build (${version})`)
      staged.push({ definition: plugin, directory: stagingDirectory, version, changed: false })
    }

    const problems: string[] = []
    for (const plugin of staged) {
      const problem = await profileProblem(plugin, profileDirectory)
      if (problem !== undefined) problems.push(problem)
    }
    const install = !existsSync(join(profileDirectory, 'package.json'))
      || problems.length > 0
      || changed
    if (install) {
      log(`installing ${staged.map(plugin => plugin.definition.name).join(' and ')} into profile ${PROFILE_NAME}`)
    } else {
      log('profile already resolves all staged plugins; reconciling bundle entries only')
    }
    const optionsForInstall: ProfileInstallAndSeedOptions = {
      home,
      profileDirectory,
      bundleNames: staged.map(plugin => plugin.definition.name),
      ...install
        ? { install: () => { runDsh(['plugin', '--profile', PROFILE_NAME, 'add', ...staged.map(plugin => plugin.directory)], home) } }
        : {},
    }
    const seeded = await installAndSeedProfile(optionsForInstall)
    if (seeded.patchSeeded) {
      log(`seeded portable profile configuration from ${join(REPOSITORY_ROOT, 'fork-runtime', 'web', 'portable-profile.patch.yml')}`)
    }
    for (const path of seeded.copied) log(`seeded profile file ${path}`)
    await verifyInstalledProfile(staged, profileDirectory, sources)
    report(staged, profileDirectory, backup.directory)
  } catch (error) {
    let rollbackText: string
    try {
      const rollback = await rollbackProfileBackup(backup)
      const actions: string[] = []
      if (rollback.restored.length > 0) actions.push(`restored ${String(rollback.restored.length)} file(s)`)
      if (rollback.removed.length > 0) actions.push(`removed ${String(rollback.removed.length)} file(s) created by this run`)
      if (rollback.profileRemoved) actions.push('removed the profile created by this run')
      rollbackText = rollback.failures.length === 0
        ? `Profile rollback: ${actions.length > 0 ? actions.join(', ') : 'no profile files needed changing'}.`
        : `Profile rollback is incomplete: ${rollback.failures.join('; ')}.`
    } catch (rollbackError) {
      rollbackText = `Profile rollback failed: ${errorMessage(rollbackError)}.`
    }
    throw new Error([
      errorMessage(error),
      `Profile backup: ${backup.directory}`,
      rollbackText,
      'Do not start the Host until the reported problem is fixed.',
    ].join('\n'), { cause: error })
  }
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
