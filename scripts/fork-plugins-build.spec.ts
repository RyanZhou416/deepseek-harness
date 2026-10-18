import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertStagedManifest, localDependencyPath, lockedUndiciVersion, parseArguments,
  privateDependencySpecs, resolveHome, stagedManifest, type PluginManifest,
} from './fork-plugins-build.ts'

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
