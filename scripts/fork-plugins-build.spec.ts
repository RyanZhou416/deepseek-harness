import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertStagedManifest, buildSubscriptionsTransport, bunPlatformRuntime, localDependencyPath,
  lockedDependencyVersion, lockedUndiciVersion, parseArguments, privateDependencySpecs, resolveHome,
  stageBunRuntime, stagedManifest, subscriptionsRuntimeArtifacts, SUBSCRIPTIONS_TRANSPORT_MODULES,
  type PluginManifest,
} from './fork-plugins-build.ts'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const subscriptionsDirectory = join(REPOSITORY_ROOT, 'fork-plugins', 'dsh-plugin-subscriptions')

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
    '@tormentalabs/claude-code-wire-compat': 'file:../releases/wire.tgz',
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

  it('stages the two prebuilt plugins with their runtime files and context zod dependency', () => {
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

describe('fork plugin profile install helpers', () => {
  it('resolves the Harness home from the override, the environment, then the user home', () => {
    expect(resolveHome('C:\\custom\\home', {})).toBe(resolve('C:\\custom\\home'))
    expect(resolveHome(undefined, { DSH_HOME: 'C:\\env\\home' })).toBe(resolve('C:\\env\\home'))
    expect(resolveHome(undefined, {})).toBe(join(homedir(), '.dsh'))
    expect(resolveHome(undefined, { DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
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
    expect(parseArguments([])).toEqual({ allowRunningHost: false, forceRebuild: false })
    expect(parseArguments(['--allow-running-host', '--force-rebuild', '--dsh-home', 'C:\\home'])).toEqual({
      allowRunningHost: true,
      forceRebuild: true,
      dshHome: 'C:\\home',
    })
    expect(parseArguments(['--dsh-home=C:\\home'])).toEqual({ allowRunningHost: false, forceRebuild: false, dshHome: 'C:\\home' })
    expect(parseArguments(['--help'])).toBeUndefined()
    expect(() => parseArguments(['--unknown'])).toThrow(/unknown argument/)
    expect(() => parseArguments(['--dsh-home'])).toThrow(/requires a path/)
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
