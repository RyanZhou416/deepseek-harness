import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertStagedArtifacts, assertStagedManifest, buildSubscriptionsTransport, buildWireCompat, bunPlatformRuntime,
  copyStagedEntries, DEFAULT_HOST_ADDRESS, DEFAULT_HOST_PORT, dependencyPreparationError, ensurePluginDependencies,
  installAndSeedProfile, LAUNCHER_HOME_DIRECTORY,
  lockfileAutoInstallPeers, localDependencyPath, lockedDependencyVersion, lockedUndiciVersion, parseArguments, PLUGINS,
  pluginInstallArguments, privateDependencySpecs, registryPeerRange, resolveHome, sourceHash, sourcePaths,
  stageBunRuntime, stagedManifest, stagedWorkspaceManifest, stageWorkspacePlugin, stagingIsCurrent,
  subscriptionsRuntimeArtifacts, SUBSCRIPTIONS_TRANSPORT_MODULES, WIRE_COMPAT_DIRECTORY, WIRE_COMPAT_PACKAGE,
  wireCompatSourceHash, wireCompatSourcePaths, WORKSPACE_PLUGINS, writeStagedManifest,
  type BuildState, type PluginCommandRunner, type PluginDefinition, type PluginManifest,
} from './fork-plugins-build.ts'
import type { SeedResult } from './fork-profile-seed.ts'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const subscriptionsDirectory = join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-plugin-subscriptions')

/** Write one patch file, creating its directories. */
async function writePatch(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, source)
}

/** Look up one staged plugin definition by id. */
function plugin(id: PluginDefinition['id']): PluginDefinition {
  const found = PLUGINS.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`missing plugin definition ${id}`)
  return found
}

const subscriptionsSource = {
  name: 'dsh-plugin-subscriptions',
  version: '0.9.4-dsh021rc2.1',
  private: true,
  type: 'module',
  main: 'lib/index.js',
  types: 'lib/index.d.ts',
  exports: {
    '.': { types: './lib/index.d.ts', default: './lib/index.js' },
    './client': { types: './lib/client/index.d.ts', default: './lib/client.js' },
    './package.json': './package.json',
  },
  scripts: { build: 'tsc && tsdown' },
  dependencies: {
    '@tormentalabs/claude-code-wire-compat': 'file:../claude-code-wire-compat',
    undici: '^7.0.0',
  },
  devDependencies: { typescript: '^5.8.0' },
  optionalDependencies: { '@cursor/sdk': '1.0.32' },
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.5',
    '@deepseek-ai/dsh-llm': '0.2.1-rc.2',
    '@deepseek-ai/dsh-llm-request-record': '0.2.1-rc.2',
  },
  peerDependenciesMeta: { '@deepseek-ai/dsh-llm-request-record': { optional: true } },
} satisfies PluginManifest

const aetherSource = {
  name: '@ryanzhou416/dsh-plugin-aether-shell',
  version: '0.1.0-dsh021rc2.1',
  private: true,
  type: 'module',
  exports: { '.': './lib/lifecycle.mjs', './package.json': './package.json' },
  scripts: { build: 'pwsh -File scripts/run-local.ps1 build' },
  peerDependencies: {
    '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
  },
} satisfies PluginManifest

const agentTeamsSource = {
  name: '@nanmicoder/dsh-agent-teams',
  version: '0.1.24-dsh021rc2.1',
  type: 'module',
  exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
  scripts: { build: 'tsc' },
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
  },
} satisfies PluginManifest

const contextSource = {
  name: 'dsh-context',
  version: '0.73.0-dsh021rc2.1',
  type: 'module',
  exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
  scripts: { build: 'tsdown' },
  dependencies: { zod: '4.4.3' },
  devDependencies: { tsdown: '^0.15.0' },
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.5',
    '@deepseek-ai/dsh-session': '>=0.2.1-rc.2',
  },
} satisfies PluginManifest

describe('fork plugin staging manifests', () => {
  it('strips private runtime and development dependencies from the subscriptions package', () => {
    const staged = stagedManifest(subscriptionsSource, 'subscriptions')
    expect(staged.dependencies).toBeUndefined()
    expect(staged.devDependencies).toBeUndefined()
    expect(staged.scripts).toBeUndefined()
    expect(staged.types).toBeUndefined()
    expect(staged.optionalDependencies).toEqual({ '@cursor/sdk': '1.0.32' })
    expect(staged.exports).toEqual({
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    })
    expect(staged.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '^4.0.5',
      '@deepseek-ai/dsh-llm': '0.2.1-rc.2',
    })
    expect(privateDependencySpecs(staged)).toEqual([])
    expect(() => { assertStagedManifest(staged, 'subscriptions') }).not.toThrow()
  })

  it('keeps the aether-shell harness peers external at the repository cohort', () => {
    const staged = stagedManifest(aetherSource, 'aether-shell')
    expect(staged.exports).toEqual({ '.': './lib/lifecycle.mjs', './package.json': './package.json' })
    expect(staged.dependencies).toBeUndefined()
    expect(staged.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '4.0.5',
      '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
    })
    expect(() => { assertStagedManifest(staged, 'aether-shell') }).not.toThrow()
  })

  it('keeps the context zod dependency and the agent-teams file list', () => {
    const agentTeams = stagedManifest(agentTeamsSource, 'agent-teams')
    expect(agentTeams.dependencies).toBeUndefined()
    expect(agentTeams.files).toContain('lib')
    expect(() => { assertStagedManifest(agentTeams, 'agent-teams') }).not.toThrow()

    const context = stagedManifest(contextSource, 'context')
    expect(context.dependencies).toEqual({ zod: '4.4.3' })
    expect(context.files).toContain('locale/*.json')
    expect(() => { assertStagedManifest(context, 'context') }).not.toThrow()

    const unexpected = stagedManifest(contextSource, 'context')
    unexpected.dependencies = { zod: '4.4.3', private: 'file:../private.tgz' }
    expect(() => { assertStagedManifest(unexpected, 'context') }).toThrow(/unexpected runtime dependency/)
  })

  it('rejects a staged manifest that keeps a private artifact or local path', () => {
    expect(privateDependencySpecs({ dependencies: { package: 'file:../releases/package.tgz' } })).toHaveLength(1)
    expect(privateDependencySpecs({ dependencies: { package: 'link:../package' } })).toHaveLength(1)
    expect(privateDependencySpecs({ optionalDependencies: { '@tormentalabs/claude-code-wire-compat': '^0.7.2' } })).toHaveLength(1)
    expect(privateDependencySpecs({ dependencies: { public: '^1.0.0' } })).toEqual([])
    const withRequestRecord = stagedManifest(subscriptionsSource, 'subscriptions')
    withRequestRecord.peerDependencies = { ...withRequestRecord.peerDependencies, '@deepseek-ai/dsh-llm-request-record': '0.2.1-rc.2' }
    expect(() => { assertStagedManifest(withRequestRecord, 'subscriptions') }).toThrow(/type-only/)
    const wrongCohort = stagedManifest(aetherSource, 'aether-shell')
    wrongCohort.peerDependencies = { '@deepseek-ai/dsh-tools': '0.1.7' }
    expect(() => { assertStagedManifest(wrongCohort, 'aether-shell') }).toThrow(/0\.2\.1-rc\.2/)
  })
})

describe('fork plugin build recipe', () => {
  it('builds all four fork plugins from source', () => {
    expect(PLUGINS.map(entry => entry.id)).toEqual(['subscriptions', 'aether-shell', 'agent-teams', 'context'])
    for (const entry of PLUGINS) {
      expect(entry.mode).toBe('build')
      expect(entry.outputs.length).toBeGreaterThan(0)
      expect(entry.stage.length).toBeGreaterThan(0)
    }
    expect(PLUGINS.filter(entry => entry.builder === 'isolated').map(entry => entry.id)).toEqual(['agent-teams', 'context'])
  })

  it('never treats a prebuilt lib directory as a build input', () => {
    for (const entry of PLUGINS) {
      expect(sourcePaths(entry)).not.toContain('lib')
      expect(entry.workCopy).not.toContain('lib')
      expect(entry.workCopy).not.toContain('node_modules')
    }
  })

  it('changes the source hash for source edits but not for stale lib files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugin-hash-'))
    try {
      const directory = join(root, 'plugin')
      await mkdir(join(directory, 'src'), { recursive: true })
      await mkdir(join(directory, 'lib'), { recursive: true })
      await writeFile(join(directory, 'package.json'), `${JSON.stringify(aetherSource, undefined, 2)}\n`)
      await writeFile(join(directory, 'src', 'index.ts'), 'export const value = 1\n')
      await writeFile(join(directory, 'lib', 'lifecycle.mjs'), 'stale prebuilt output\n')
      const entry = { ...plugin('aether-shell'), directory }
      const first = await sourceHash(entry)
      await writeFile(join(directory, 'lib', 'lifecycle.mjs'), 'different stale prebuilt output\n')
      expect(await sourceHash(entry)).toBe(first)
      await writeFile(join(directory, 'src', 'index.ts'), 'export const value = 2\n')
      expect(await sourceHash(entry)).not.toBe(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the inlined wire builder from the fork source checkout', async () => {
    expect(WIRE_COMPAT_DIRECTORY).toBe(join(REPOSITORY_ROOT, 'fork-plugins', 'claude-code-wire-compat'))
    const manifest = JSON.parse(await readFile(join(WIRE_COMPAT_DIRECTORY, 'package.json'), 'utf8')) as PluginManifest
    expect(manifest.name).toBe(WIRE_COMPAT_PACKAGE)
    expect(manifest.version).toBe('0.7.2-dsh15')
    expect(wireCompatSourcePaths()).toContain('src')
    expect(wireCompatSourcePaths()).not.toContain('dist')
    expect(sourcePaths(plugin('subscriptions'))).not.toContain('dist')
  })

  it('hashes wire builder sources but not its generated dist output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wire-compat-hash-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: WIRE_COMPAT_PACKAGE }, undefined, 2)}\n`)
      await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
      await writeFile(join(root, 'dist', 'index.js'), 'generated one\n')
      const first = await wireCompatSourceHash(root)
      await writeFile(join(root, 'dist', 'index.js'), 'generated two\n')
      expect(await wireCompatSourceHash(root)).toBe(first)
      await writeFile(join(root, 'src', 'index.ts'), 'export const value = 2\n')
      expect(await wireCompatSourceHash(root)).not.toBe(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compiles wire builder dist from source before subscriptions bundling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wire-compat-build-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: WIRE_COMPAT_PACKAGE }, undefined, 2)}\n`)
      await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
          strict: true,
          types: [],
        },
        include: ['src/**/*.ts'],
      }, undefined, 2))
      buildWireCompat(root)
      expect(existsSync(join(root, 'dist', 'index.js'))).toBe(true)
      expect(existsSync(join(root, 'dist', 'index.d.ts'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails when the wire builder source checkout is missing', () => {
    expect(() => { buildWireCompat(join(tmpdir(), 'dsh-missing-wire-compat')) }).toThrow(/wire builder is missing/)
  })

  it('stages built files from the isolated work copy, never from the source lib', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugin-isolated-'))
    try {
      const source = join(root, 'source')
      const work = join(root, 'work')
      const staging = join(root, 'staging')
      await mkdir(join(source, 'lib'), { recursive: true })
      await mkdir(join(work, 'lib'), { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(join(source, 'lib', 'index.js'), 'stale checkout output')
      await writeFile(join(work, 'lib', 'index.js'), 'fresh isolated output')
      const entry: PluginDefinition = {
        ...plugin('agent-teams'),
        directory: source,
        stage: ['lib'],
        outputs: ['lib/index.js'],
      }
      await copyStagedEntries(entry, work, staging)
      expect(await readFile(join(staging, 'lib', 'index.js'), 'utf8')).toBe('fresh isolated output')
      assertStagedArtifacts(entry, staging)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips an unchanged staging and rebuilds when the source key changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugin-staging-'))
    try {
      const directory = join(root, 'aether-shell')
      const staging = join(root, 'staged')
      await mkdir(join(directory, 'lib'), { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(join(directory, 'package.json'), `${JSON.stringify(aetherSource, undefined, 2)}\n`)
      await writeFile(join(directory, 'lib', 'lifecycle.mjs'), 'stale\n')
      await writeFile(join(staging, 'package.json'), `${JSON.stringify(stagedManifest(aetherSource, 'aether-shell'), undefined, 2)}\n`)
      await writeFile(join(staging, 'cordis.patch.yml'), '- insert: []\n')
      await mkdir(join(staging, 'lib'), { recursive: true })
      await writeFile(join(staging, 'lib', 'lifecycle.mjs'), 'built\n')
      const entry = { ...plugin('aether-shell'), directory }
      const state: BuildState = {
        schema: 1,
        scriptVersion: 5,
        plugins: { 'aether-shell': { key: 'unchanged', version: aetherSource.version, installedAt: '2026-10-19T00:00:00.000Z' } },
      }
      expect(await stagingIsCurrent(entry, staging, state, 'unchanged', false)).toBe(true)
      expect(await stagingIsCurrent(entry, staging, state, 'changed', false)).toBe(false)
      expect(await stagingIsCurrent(entry, staging, state, 'unchanged', true)).toBe(false)
      await rm(join(staging, 'lib', 'lifecycle.mjs'))
      expect(await stagingIsCurrent(entry, staging, state, 'unchanged', false)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages the declared manifest, assets, and outputs for every plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugin-stage-all-'))
    try {
      for (const entry of PLUGINS) {
        const work = join(root, `${entry.id}-work`)
        const staging = join(root, `${entry.id}-staging`)
        await mkdir(work, { recursive: true })
        await mkdir(staging, { recursive: true })
        for (const stagedEntry of entry.stage) {
          if (stagedEntry === 'lib') {
            for (const output of entry.outputs) {
              const path = join(work, output)
              await mkdir(dirname(path), { recursive: true })
              await writeFile(path, 'built output\n')
            }
            continue
          }
          const source = join(entry.directory, stagedEntry)
          expect(existsSync(source), `${entry.id} is missing its staged ${stagedEntry}`).toBe(true)
          await cp(source, join(work, stagedEntry), { recursive: true })
        }
        await copyStagedEntries(entry, work, staging)
        await writeStagedManifest(entry, staging)
        if (entry.builder !== 'isolated') {
          // These builders emit their bundles straight into the staging root.
          for (const output of entry.outputs) {
            const path = join(staging, output)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, 'built output\n')
          }
        }
        expect(existsSync(join(staging, 'package.json')), `${entry.id} has no staged manifest`).toBe(true)
        for (const stagedEntry of entry.stage) {
          expect(existsSync(join(staging, stagedEntry)), `${entry.id} did not stage ${stagedEntry}`).toBe(true)
        }
        for (const output of entry.outputs) {
          expect(existsSync(join(staging, output)), `${entry.id} is missing ${output}`).toBe(true)
        }
        if (entry.id !== 'subscriptions') assertStagedArtifacts(entry, staging)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('fork plugin dependency preparation', () => {
  it('reads the lockfile peer policy and selects offline or network installs', () => {
    expect(lockfileAutoInstallPeers('settings:\n  autoInstallPeers: true\n')).toBe(true)
    expect(lockfileAutoInstallPeers('settings:\n  autoInstallPeers: false\n')).toBe(false)
    expect(lockfileAutoInstallPeers('lockfileVersion: 9\n')).toBe(true)
    const lockfile = 'settings:\n  autoInstallPeers: false\n'
    expect(pluginInstallArguments(lockfile, true)).toContain('--offline')
    expect(pluginInstallArguments(lockfile, false)).toContain('--prefer-offline')
    expect(pluginInstallArguments(lockfile, true)).toContain('--config.auto-install-peers=false')
    expect(pluginInstallArguments(lockfile, true)).toContain('--frozen-lockfile')
  })

  it('fails with the plugin, work copy, commands, and a fix when preparation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugin-deps-'))
    try {
      const work = join(root, 'work')
      await mkdir(work, { recursive: true })
      await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'dsh-context' }))
      await writeFile(join(work, 'pnpm-lock.yaml'), 'settings:\n  autoInstallPeers: true\n')
      const calls: string[] = []
      const runner: PluginCommandRunner = (_command, args) => {
        calls.push(args.join(' '))
        return { status: 1, stderr: 'ERR_PNPM_NO_OFFLINE_META store is missing zod\n' }
      }
      const error = await ensurePluginDependencies(plugin('context'), work, runner).then(
        () => undefined,
        (failure: unknown) => failure as Error,
      )
      expect(error).toBeInstanceOf(Error)
      const message = error?.message ?? ''
      expect(message).toContain('failed to prepare plugin-local dependencies for dsh-context')
      expect(message).toContain(`build copy: ${work}`)
      expect(message).toContain('ERR_PNPM_NO_OFFLINE_META')
      expect(message).toContain('Fix:')
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('--offline')
      expect(calls[1]).toContain('--prefer-offline')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('formats an actionable dependency failure for an incomplete work copy', async () => {
    const error = dependencyPreparationError(plugin('agent-teams'), join('C:', 'tmp', 'work', 'agent-teams'), [{
      command: 'pnpm install --offline',
      status: null,
      detail: 'pnpm-lock.yaml is missing',
    }])
    expect(error.message).toContain('@nanmicoder/dsh-agent-teams')
    expect(error.message).toContain('did not start')
    expect(error.message).toContain('pnpm-lock.yaml is missing')
    expect(error.message).toContain('Fix:')
  })
})

describe('fork plugin profile install helpers', () => {
  it('resolves the Harness home from the override, the environment, then the platform launcher default', () => {
    const launcherDefault = process.platform === 'win32'
      ? resolve(join(dirname(REPOSITORY_ROOT), LAUNCHER_HOME_DIRECTORY))
      : join(homedir(), '.dsh')
    expect(resolveHome('C:\\custom\\home', {})).toBe(resolve('C:\\custom\\home'))
    expect(resolveHome(undefined, { DSH_HOME: 'C:\\env\\home' })).toBe(resolve('C:\\env\\home'))
    expect(resolveHome(undefined, {})).toBe(launcherDefault)
    expect(resolveHome(undefined, { DSH_HOME: '   ' })).toBe(launcherDefault)
    expect(resolveHome(undefined, { DSH_HOME: '~/env-home' })).toBe(join(homedir(), 'env-home'))
    expect(resolveHome('~', {})).toBe(homedir())
  })

  it('resolves only local link and file dependency values', () => {
    const profile = resolve('C:\\profiles\\web')
    expect(localDependencyPath('link:C:/repo/.build/plugin', profile)).toBe(resolve('C:/repo/.build/plugin'))
    expect(localDependencyPath('file:../plugin', profile)).toBe(resolve(profile, '../plugin'))
    expect(localDependencyPath('^0.9.4', profile)).toBeUndefined()
  })

  it('pins the undici version recorded by the plugin lockfile', () => {
    const lock = 'importers:\n\n  .:\n    dependencies:\n      undici:\n        specifier: ^7.0.0\n        version: 7.29.0\n'
    expect(lockedUndiciVersion(lock, '^7.0.0')).toBe('7.29.0')
    expect(lockedUndiciVersion('', '^7.0.0')).toBe('^7.0.0')
  })

  it('parses only the options the build script owns', () => {
    expect(parseArguments([])).toEqual({
      allowRunningHost: false,
      forceRebuild: false,
      host: DEFAULT_HOST_ADDRESS,
      port: DEFAULT_HOST_PORT,
    })
    expect(parseArguments(['--allow-running-host', '--force-rebuild', '--dsh-home', 'C:\\home'])).toEqual({
      allowRunningHost: true,
      forceRebuild: true,
      host: DEFAULT_HOST_ADDRESS,
      port: DEFAULT_HOST_PORT,
      dshHome: 'C:\\home',
    })
    expect(parseArguments(['--dsh-home=C:\\home'])).toEqual({
      allowRunningHost: false,
      forceRebuild: false,
      host: DEFAULT_HOST_ADDRESS,
      port: DEFAULT_HOST_PORT,
      dshHome: 'C:\\home',
    })
    expect(parseArguments(['--host', '10.0.0.7', '--port', '8080'])).toEqual({
      allowRunningHost: false,
      forceRebuild: false,
      host: '10.0.0.7',
      port: 8080,
    })
    expect(parseArguments(['--host=::1', '--port=8080'])).toEqual({
      allowRunningHost: false,
      forceRebuild: false,
      host: '::1',
      port: 8080,
    })
    expect(parseArguments(['--help'])).toBeUndefined()
    expect(() => parseArguments(['--unknown'])).toThrow(/unknown argument/)
    expect(() => parseArguments(['--dsh-home'])).toThrow(/requires a path/)
    expect(() => parseArguments(['--host'])).toThrow(/--host requires an address/)
    expect(() => parseArguments(['--port'])).toThrow(/--port requires an integer from 1 through 65535/)
    expect(() => parseArguments(['--port', '65536'])).toThrow(/--port requires an integer from 1 through 65535/)
    expect(() => parseArguments(['--patch', 'legacy.yml'])).toThrow(/unknown argument/)
  })
})

describe('subscriptions transport staging', () => {
  it('maps every supported platform to its pinned Bun package and executable', () => {
    const targets = [
      ['win32', 'x64', '@oven/bun-windows-x64', 'bin/bun.exe'],
      ['win32', 'arm64', '@oven/bun-windows-aarch64', 'bin/bun.exe'],
      ['darwin', 'arm64', '@oven/bun-darwin-aarch64', 'bin/bun'],
      ['darwin', 'x64', '@oven/bun-darwin-x64', 'bin/bun'],
      ['linux', 'x64', '@oven/bun-linux-x64', 'bin/bun'],
      ['linux', 'arm64', '@oven/bun-linux-aarch64', 'bin/bun'],
    ] as const
    for (const [platform, arch, packageName, executable] of targets) {
      expect(bunPlatformRuntime(platform, arch)).toEqual({ packageName, executable })
    }
    expect(() => bunPlatformRuntime('linux', 'ia32')).toThrow(/no runtime package for linux-ia32/)
  })

  it('requires the transport child, frame codec, and platform runtime in the staged package', () => {
    expect(SUBSCRIPTIONS_TRANSPORT_MODULES.map(module => module.output)).toEqual(['lib/bun-child.js', 'lib/frames.js'])
    for (const module of SUBSCRIPTIONS_TRANSPORT_MODULES) {
      expect(existsSync(join(subscriptionsDirectory, module.source))).toBe(true)
    }
    expect(subscriptionsRuntimeArtifacts('win32', 'x64')).toEqual([
      'lib/bun-child.js',
      'lib/frames.js',
      join('node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe'),
    ])
  })

  it('pins the platform runtime version recorded by the plugin lockfile', async () => {
    const lock = "    optionalDependencies:\n      '@oven/bun-windows-x64':\n        specifier: ^1.4.0\n        version: 1.4.2\n"
    expect(lockedDependencyVersion(lock, '@oven/bun-windows-x64', '^1.4.0')).toBe('1.4.2')
    expect(lockedDependencyVersion('', '@oven/bun-windows-x64', '^1.4.0')).toBe('^1.4.0')
    const lockfile = await readFile(join(subscriptionsDirectory, 'pnpm-lock.yaml'), 'utf8')
    for (const [platform, arch] of [
      ['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'],
    ] as const) {
      const runtime = bunPlatformRuntime(platform, arch)
      expect(lockedDependencyVersion(lockfile, runtime.packageName, '')).toMatch(/^\d+\.\d+\.\d+/)
    }
  }, 15_000)

  it('builds the transport files from source and copies the platform runtime beside them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugins-build-'))
    try {
      const staging = join(root, 'staged')
      await mkdir(staging, { recursive: true })
      buildSubscriptionsTransport(subscriptionsDirectory, staging)
      const child = await readFile(join(staging, 'lib', 'bun-child.js'), 'utf8')
      const frames = await readFile(join(staging, 'lib', 'frames.js'), 'utf8')
      expect(child).toContain("from './frames.js'")
      expect(frames).toContain('FRAME_LENGTH_BYTES')

      const target = bunPlatformRuntime(process.platform, process.arch)
      const runtimeDirectory = join(root, 'runtime', ...target.packageName.split('/'))
      await mkdir(join(runtimeDirectory, 'bin'), { recursive: true })
      await writeFile(join(runtimeDirectory, target.executable), 'pinned bun')
      const runtime = {
        packageName: target.packageName,
        version: '1.4.2',
        directory: runtimeDirectory,
        executable: target.executable,
      }
      await stageBunRuntime(runtime, staging)
      const stagedDirectory = join(staging, 'node_modules', ...target.packageName.split('/'))
      expect(lstatSync(stagedDirectory).isSymbolicLink()).toBe(false)
      expect(await readFile(join(stagedDirectory, target.executable), 'utf8')).toBe('pinned bun')
      await rm(runtimeDirectory, { recursive: true, force: true })
      expect(await readFile(join(stagedDirectory, target.executable), 'utf8')).toBe('pinned bun')
      await expect(stageBunRuntime({ ...runtime, directory: join(root, 'missing') }, staging)).rejects.toThrow(/has no bin\//)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('materializes a platform runtime installed through a link', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-plugins-runtime-'))
    try {
      const target = bunPlatformRuntime(process.platform, process.arch)
      const realDirectory = join(root, 'runtime', ...target.packageName.split('/'))
      await mkdir(join(realDirectory, 'bin'), { recursive: true })
      await writeFile(join(realDirectory, target.executable), 'pinned bun')
      const linkedDirectory = join(root, 'linked', ...target.packageName.split('/'))
      await mkdir(dirname(linkedDirectory), { recursive: true })
      try {
        await symlink(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        context.skip(`this host cannot create a directory link: ${String(error)}`)
        return
      }
      const staging = join(root, 'staged')
      await mkdir(staging, { recursive: true })
      const runtime = {
        packageName: target.packageName,
        version: '1.4.2',
        directory: linkedDirectory,
        executable: target.executable,
      }
      await stageBunRuntime(runtime, staging)
      const destination = join(staging, 'node_modules', ...target.packageName.split('/'))
      expect(lstatSync(destination).isSymbolicLink()).toBe(false)
      await rm(realDirectory, { recursive: true, force: true })
      expect(await readFile(join(destination, target.executable), 'utf8')).toBe('pinned bun')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('workspace plugin staging', () => {
  it('links the llm-cc-pool workspace package into the profile', () => {
    expect(WORKSPACE_PLUGINS.map(entry => entry.name)).toEqual(['@deepseek-ai/dsh-llm-cc-pool'])
    const entry = WORKSPACE_PLUGINS[0]
    expect(entry).toBeDefined()
    expect(entry?.builder).toBe('workspace')
    expect(entry?.directory).toBe(join(REPOSITORY_ROOT, 'packages', 'llm', 'llm-cc-pool'))
    expect(entry?.outputs).toEqual(['lib/index.js'])
    expect(entry?.stage).toEqual(['lib', 'cordis.patch.yml'])
  })

  it('converts workspace peer ranges into registry ranges', () => {
    expect(registryPeerRange('workspace:*', '0.2.1-rc.2')).toBe('0.2.1-rc.2')
    expect(registryPeerRange('workspace:~', '4.0.5')).toBe('~4.0.5')
    expect(registryPeerRange('workspace:^', '1.2.3')).toBe('^1.2.3')
    expect(registryPeerRange('workspace:^1.2.3', '9.9.9')).toBe('^1.2.3')
    expect(registryPeerRange('^2.0.0', '9.9.9')).toBe('^2.0.0')
  })

  it('stages a workspace manifest without build-time or workspace dependencies', async () => {
    const manifest = await stagedWorkspaceManifest({
      name: '@deepseek-ai/dsh-llm-cc-pool',
      version: '0.2.1-rc.2',
      type: 'module',
      main: 'lib/index.js',
      scripts: { build: 'tsdown' },
      dependencies: { '@deepseek-ai/schemastery': 'workspace:~' },
      devDependencies: { vitest: '4.1.11' },
      peerDependencies: {
        '@deepseek-ai/cordis': 'workspace:~',
        '@deepseek-ai/dsh-llm': 'workspace:*',
      },
      peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true } },
      publishConfig: { access: 'public' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, async name => name === '@deepseek-ai/cordis' ? '4.0.5' : '0.2.1-rc.2')

    expect(manifest).toMatchObject({
      name: '@deepseek-ai/dsh-llm-cc-pool',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/cordis': '~4.0.5', '@deepseek-ai/dsh-llm': '0.2.1-rc.2' },
    })
    for (const field of ['scripts', 'dependencies', 'devDependencies', 'peerDependenciesMeta', 'publishConfig']) {
      expect(manifest[field]).toBeUndefined()
    }
  })

  it('leaves the previous staging generation intact when the new build fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-staging-transaction-'))
    try {
      const source = join(root, 'source')
      const staging = join(root, 'staging')
      await mkdir(source, { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(join(source, 'package.json'), `${JSON.stringify({
        name: '@deepseek-ai/dsh-llm-cc-pool',
        version: '0.2.1-rc.2',
      }, undefined, 2)}\n`)
      await writeFile(join(staging, 'previous.txt'), 'usable previous staging\n')
      const definition: PluginDefinition = { ...WORKSPACE_PLUGINS[0]!, directory: source }

      await expect(stageWorkspacePlugin(definition, staging)).rejects.toThrow(/did not produce lib\/index\.js/)
      expect(await readFile(join(staging, 'previous.txt'), 'utf8')).toBe('usable previous staging\n')
      expect((await readdir(root)).filter(name => name.includes('.partial-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies the root build output and the bundle patch into staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-workspace-stage-'))
    try {
      const source = join(root, 'source')
      await mkdir(join(source, 'lib'), { recursive: true })
      await writeFile(join(source, 'lib', 'index.js'), 'export const plugin = true\n')
      await writeFile(join(source, 'cordis.patch.yml'), '- insert: []\n')
      await writeFile(join(source, 'package.json'), `${JSON.stringify({
        name: '@deepseek-ai/dsh-llm-cc-pool',
        version: '0.2.1-rc.2',
        peerDependencies: { '@deepseek-ai/dsh-llm': 'workspace:*' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, undefined, 2)}\n`)
      const definition: PluginDefinition = { ...WORKSPACE_PLUGINS[0]!, directory: source }
      const staging = join(root, 'staging')

      await stageWorkspacePlugin(definition, staging)

      expect(await readFile(join(staging, 'lib', 'index.js'), 'utf8')).toBe('export const plugin = true\n')
      expect(await readFile(join(staging, 'cordis.patch.yml'), 'utf8')).toBe('- insert: []\n')
      const staged = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as PluginManifest
      expect(staged.peerDependencies).toEqual({ '@deepseek-ai/dsh-llm': '0.2.1-rc.2' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('profile install and seed ordering', () => {
  it('seeds only after a successful install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-install-seed-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      await writePatch(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }, undefined, 2)}\n`)
      const order: string[] = []
      const seeded: SeedResult = { profileDirectory: profile, patchSeeded: false, copied: [], kept: [] }
      await installAndSeedProfile({
        home,
        profileDirectory: profile,
        bundleNames: ['@deepseek-ai/dsh-llm-cc-pool'],
        install: async () => {
          order.push('install')
          const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            dsh: { profile: { bundles: string[] } }
          }
          manifest.dependencies = { '@deepseek-ai/dsh-llm-cc-pool': 'link:C:/staged/llm-cc-pool' }
          await writePatch(join(profile, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
        },
        seed: async () => {
          order.push('seed')
          return seeded
        },
      })
      expect(order).toEqual(['install', 'seed'])
      const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-llm-cc-pool'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not special-case a legacy-looking profile patch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-current-format-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      await writePatch(join(profile, 'package.json'), '{"name":"dsh-profile-web"}\n')
      await writePatch(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      cc-pool:\n        api: anthropic\n')
      const order: string[] = []
      await installAndSeedProfile({
        home,
        profileDirectory: profile,
        bundleNames: [],
        install: () => { order.push('install') },
        seed: async () => {
          order.push('seed')
          return { profileDirectory: profile, patchSeeded: false, copied: [], kept: [] }
        },
      })
      expect(order).toEqual(['install', 'seed'])
      expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('cc-pool')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not seed after a failed install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-install-fail-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      await writePatch(join(profile, 'package.json'), '{"name":"dsh-profile-web"}\n')
      let seeded = false
      await expect(installAndSeedProfile({
        home,
        profileDirectory: profile,
        bundleNames: [],
        install: () => { throw new Error('install failed') },
        seed: async () => {
          seeded = true
          return { profileDirectory: profile, patchSeeded: false, copied: [], kept: [] }
        },
      })).rejects.toThrow(/install failed/)
      expect(seeded).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
