import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { assertHostNotRunning } from './fork-plugins-build.ts'
import {
  findLegacyPoolProviders,
  findLegacySettingsProviders,
  LAUNCHER_HOME_DIRECTORY,
  MIGRATION_MARKER_FILE,
  migrateLegacyProfile,
  migrateLegacyPoolProvider,
  migrateLegacySettingsProviders,
  parseArguments,
  resolveMigrationHome,
} from './migrate-legacy-cc-pool-profile.ts'

/** Write a file, creating its parent directories. */
async function writePatch(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, source)
}

/** Start a loopback listener on an ephemeral port, returning the server and its port. */
async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((settle) => { server.listen(0, '127.0.0.1', settle) })
  return { server, port: (server.address() as AddressInfo).port }
}

/** Stop a listener and wait for its handle to close. */
async function stop(server: Server): Promise<void> {
  await new Promise<void>((settle) => { server.close(() => settle()) })
}

/** A block-form legacy profile patch with a kept comment and `!!js`. */
const LEGACY_PATCH = `# kept profile comment
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    disabled: !!js process.platform === 'win32'
    providers:
      cc-pool:
        api: anthropic-messages
        baseURL: https://example.invalid
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
    keep: true
`

/** A minimal current-format profile manifest. */
const PROFILE_MANIFEST = `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}, undefined, 2)}\n`

/** A current-format profile patch with no legacy route. */
const CURRENT_PATCH = `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
`

/** A legacy `settings.yaml` beside settings the migration must keep. */
const LEGACY_SETTINGS = `# kept settings comment
llm-pi-ai:
  providers:
    cc-pool:
      api: anthropic-messages
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
`

/** Number of backups currently recorded by the migration script. */
async function backupCount(): Promise<number> {
  try {
    return (await readdir(join(process.cwd(), '.build', 'fork-plugins', 'backups'))).length
  } catch {
    return 0
  }
}

describe('legacy cc-pool provider migration', () => {
  it('removes block, quoted, flow, insert, and package-name forms', () => {
    const sources = [
      LEGACY_PATCH,
      '- id: llm-pi-ai\n  config:\n    providers:\n      \'cc-pool\': { api: anthropic }\n      anthropic: {}\n',
      '- id: llm-pi-ai\n  config:\n    providers: { "cc-pool": { api: anthropic }, anthropic: { apiKeyEnv: X } }\n',
      '- insert:\n    - id: llm-pi-ai\n      config:\n        providers:\n          cc-pool:\n            api: anthropic\n          anthropic: {}\n',
      '- name: \'@deepseek-ai/dsh-llm-pi-ai\'\n  config:\n    providers:\n      cc-pool:\n        api: anthropic\n',
    ]
    for (const source of sources) {
      const migrated = migrateLegacyPoolProvider(source)
      expect(migrated.removed).toBe(1)
      expect(findLegacyPoolProviders(migrated.source)).toEqual([])
    }
  })

  it('keeps comments, !!js expressions, and unrelated rows intact', () => {
    const source = `${LEGACY_PATCH}- id: unrelated\n  config:\n    providers:\n      cc-pool:\n        keep: true\n`
    const migrated = migrateLegacyPoolProvider(source)
    expect(migrated.source).toContain('# kept profile comment')
    expect(migrated.source).toContain("disabled: !!js process.platform === 'win32'")
    expect(migrated.source).toContain('keep: true')
    expect(migrated.source).toContain('- id: unrelated\n  config:\n    providers:\n      cc-pool:\n        keep: true')
    expect(migrated.source).not.toContain('baseURL: https://example.invalid')
  })

  it('keeps an empty providers mapping when the legacy route was its only entry', () => {
    const migrated = migrateLegacyPoolProvider('- id: llm-pi-ai\n  config:\n    providers:\n      cc-pool:\n        api: anthropic\n    other: 1\n')
    expect(migrated.source).toContain('providers: {}')
    expect(migrated.source).toContain('other: 1')
    expect(findLegacyPoolProviders(migrated.source)).toEqual([])
  })

  it('fails instead of half-editing an unusual layout or malformed YAML', () => {
    expect(() => migrateLegacyPoolProvider('- id: llm-pi-ai\n  config:\n    providers:\n      ? cc-pool\n      : { api: anthropic }\n      anthropic: {}\n'))
      .toThrow(/cannot rewrite safely/)
    expect(() => migrateLegacyPoolProvider('- id: llm-pi-ai\n  config:\n    providers:\n      cc-pool: [unclosed\n'))
      .toThrow(/not readable YAML/)
  })
})

describe('legacy settings migration', () => {
  it('finds and removes the legacy provider from settings.yaml', () => {
    expect(findLegacySettingsProviders(LEGACY_SETTINGS)).toEqual([{ section: 'llm-pi-ai' }])
    const migrated = migrateLegacySettingsProviders(LEGACY_SETTINGS)

    expect(migrated.removed).toBe(1)
    const document = yaml.load(migrated.source) as Record<string, Record<string, unknown>>
    expect(document['llm-pi-ai']?.['providers']).toEqual({ anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } })
    expect(document['agent-default-model']).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(findLegacySettingsProviders(migrated.source)).toEqual([])
  })

  it('reads the package-name section key and flow style too', () => {
    expect(findLegacySettingsProviders('agent-default-model: {}\n')).toEqual([])
    expect(findLegacySettingsProviders('- not a settings document\n')).toEqual([])

    const packageKey = "name: '@deepseek-ai/dsh-llm-pi-ai'\n" // not a section key
    expect(findLegacySettingsProviders(packageKey)).toEqual([])

    const packageSection = "'@deepseek-ai/dsh-llm-pi-ai':\n  providers:\n    cc-pool: {}\n"
    expect(findLegacySettingsProviders(packageSection)).toEqual([{ section: '@deepseek-ai/dsh-llm-pi-ai' }])
    expect(findLegacySettingsProviders(migrateLegacySettingsProviders(packageSection).source)).toEqual([])

    const flow = 'llm-pi-ai:\n  providers: {cc-pool: {api: anthropic}, anthropic: {}}\n'
    expect(findLegacySettingsProviders(flow)).toEqual([{ section: 'llm-pi-ai' }])
    const migrated = migrateLegacySettingsProviders(flow)
    expect(migrated.removed).toBe(1)
    expect(findLegacySettingsProviders(migrated.source)).toEqual([])
    expect(migrated.source).not.toContain('cc-pool')
  })

  it('leaves a settings document without the route untouched', () => {
    const source = 'agent-default-model:\n  provider: deepseek-official\n'
    expect(migrateLegacySettingsProviders(source)).toEqual({ source, removed: 0 })
  })

  it('refuses a settings document whose loader expressions a rewrite would flatten', () => {
    const source = 'llm-pi-ai:\n  providers:\n    cc-pool:\n      api: anthropic\n  token: !!js process.env.POOL_TOKEN\n'
    expect(() => migrateLegacySettingsProviders(source)).toThrow(/cannot rewrite safely/)
  })
})

describe('migration host and home policy', () => {
  it('refuses while a Host listens and continues only with the override', async () => {
    const { server, port } = await listen()
    try {
      await expect(assertHostNotRunning({
        allowRunningHost: false,
        action: 'migrating the profile',
        warn: () => {},
        port,
      })).rejects.toThrow(/a Host is listening on 127\.0\.0\.1:\d+; stop it before migrating the profile/)

      const warn = vi.fn()
      await expect(assertHostNotRunning({
        allowRunningHost: true,
        action: 'migrating the profile',
        warn,
        port,
      })).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      await stop(server)
    }
  })

  it('continues when nothing listens on the port', async () => {
    const { server, port } = await listen()
    await stop(server)
    await expect(assertHostNotRunning({
      allowRunningHost: false,
      action: 'migrating the profile',
      warn: () => {},
      port,
    })).resolves.toBeUndefined()
  })

  it('parses the running-Host override and the home override', () => {
    expect(parseArguments(['--allow-running-host'])).toEqual({ allowRunningHost: true })
    expect(parseArguments(['--dsh-home', 'C:/home', '--allow-running-host']))
      .toEqual({ dshHome: 'C:/home', allowRunningHost: true })
    expect(parseArguments(['--help'])).toBeUndefined()
    expect(() => parseArguments(['--unknown'])).toThrow(/unknown argument/)
  })

  it('defaults the home exactly as the Windows launchers do', () => {
    const repositoryRoot = join(tmpdir(), 'dsh-launcher-home', 'deepseek-harness')
    const launcherDefault = resolve(join(dirname(repositoryRoot), LAUNCHER_HOME_DIRECTORY))

    expect(resolveMigrationHome(undefined, {}, repositoryRoot)).toBe(launcherDefault)
    expect(resolveMigrationHome(undefined, { DSH_HOME: '' }, repositoryRoot)).toBe(launcherDefault)
    expect(resolveMigrationHome(undefined, { DSH_HOME: join(repositoryRoot, 'env-home') }, repositoryRoot))
      .toBe(resolve(join(repositoryRoot, 'env-home')))
    expect(resolveMigrationHome(join(repositoryRoot, 'flag-home'), { DSH_HOME: 'ignored' }, repositoryRoot))
      .toBe(resolve(join(repositoryRoot, 'flag-home')))
  })
})

describe('one-time profile migration', () => {
  it('backs up, migrates, seeds after linking, and writes a marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-migration-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const patch = join(profile, 'cordis.patch.yml')
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(patch, LEGACY_PATCH)
      await writePatch(join(profile, 'pnpm-lock.yaml'), 'lockfile: original\n')
      const order: string[] = []
      const marker = join(profile, MIGRATION_MARKER_FILE)

      const outcome = await migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: {
          ensurePlugin: () => { order.push('ensure') },
          seed: () => {
            order.push('seed')
            expect(existsSync(marker)).toBe(false)
          },
        },
      })

      expect(outcome.status).toBe('migrated')
      expect(outcome.removed).toBe(1)
      expect(order).toEqual(['ensure', 'seed'])
      expect(outcome.backup).toBeDefined()
      expect(await readFile(join(outcome.backup!, 'profile', 'cordis.patch.yml'), 'utf8')).toBe(LEGACY_PATCH)
      expect(findLegacyPoolProviders(await readFile(patch, 'utf8'))).toEqual([])
      expect(existsSync(marker)).toBe(true)
      const recorded = JSON.parse(await readFile(marker, 'utf8')) as { migrations: Record<string, unknown> }
      expect(recorded.migrations['legacy-llm-pi-ai-cc-pool-provider']).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is idempotent and does not back up or write a current profile again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-idempotent-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const patch = join(profile, 'cordis.patch.yml')
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(patch, LEGACY_PATCH)
      await migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: { ensurePlugin: () => {}, seed: () => {} },
      })
      const migrated = await readFile(patch, 'utf8')
      const before = await backupCount()
      const second = await migrateLegacyProfile({
        dshHome: home,
        hooks: { ensurePlugin: () => { throw new Error('must not run') } },
      })
      expect(second.status).toBe('skipped')
      expect(await readFile(patch, 'utf8')).toBe(migrated)
      expect(await backupCount()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips a fresh profile without creating it or a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-fresh-'))
    try {
      const home = join(root, 'home')
      const before = await backupCount()
      let called = false
      const outcome = await migrateLegacyProfile({
        dshHome: home,
        hooks: { ensurePlugin: () => { called = true }, seed: () => { called = true } },
      })
      expect(outcome.status).toBe('skipped')
      expect(called).toBe(false)
      expect(existsSync(join(home, 'profiles', 'web'))).toBe(false)
      expect(await backupCount()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rolls the profile back when a later migration step fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-rollback-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const patch = join(profile, 'cordis.patch.yml')
      const created = join(profile, 'memory-limits.patch.yml')
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(patch, LEGACY_PATCH)

      await expect(migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: {
          ensurePlugin: () => {},
          seed: async () => {
            await writePatch(created, '- id: memory\n')
            throw new Error('seed failed')
          },
        },
      })).rejects.toThrow(/seed failed[\s\S]*Profile rollback/)

      expect(await readFile(patch, 'utf8')).toBe(LEGACY_PATCH)
      expect(existsSync(created)).toBe(false)
      expect(existsSync(join(profile, MIGRATION_MARKER_FILE))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrates and backs up the legacy settings document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-settings-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const patch = join(profile, 'cordis.patch.yml')
      const settingsPath = join(home, 'settings.yaml')
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(patch, LEGACY_PATCH)
      await writePatch(settingsPath, LEGACY_SETTINGS)

      const outcome = await migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: { ensurePlugin: () => {}, seed: () => {} },
      })

      expect(outcome.status).toBe('migrated')
      expect(outcome.removedSettings).toBe(1)
      expect(await readFile(join(outcome.backup!, 'home', 'settings.yaml'), 'utf8')).toBe(LEGACY_SETTINGS)
      expect(findLegacySettingsProviders(await readFile(settingsPath, 'utf8'))).toEqual([])
      const rewritten = yaml.load(await readFile(settingsPath, 'utf8')) as Record<string, Record<string, unknown>>
      expect(rewritten['llm-pi-ai']?.['providers']).toEqual({ anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } })
      expect(rewritten['agent-default-model']).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores the settings document when a later migration step fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-settings-rollback-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const settingsPath = join(home, 'settings.yaml')
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(join(profile, 'cordis.patch.yml'), LEGACY_PATCH)
      await writePatch(settingsPath, LEGACY_SETTINGS)

      await expect(migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: { ensurePlugin: () => {}, seed: () => { throw new Error('seed failed') } },
      })).rejects.toThrow(/seed failed/)

      expect(await readFile(settingsPath, 'utf8')).toBe(LEGACY_SETTINGS)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('scans the home patch and overlays even when the profile patch is clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-composition-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const patch = join(profile, 'cordis.patch.yml')
      const homePatch = join(home, 'cordis.patch.yml')
      const homeLegacy = '- id: llm-pi-ai\n  config:\n    providers:\n      cc-pool:\n        api: anthropic\n'
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(patch, CURRENT_PATCH)
      await writePatch(homePatch, homeLegacy)
      const before = await backupCount()

      await expect(migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: { ensurePlugin: () => { throw new Error('must not run') } },
      })).rejects.toThrow(/home patch .*still declares the legacy llm-pi-ai "providers\.cc-pool" route/)

      expect(await readFile(patch, 'utf8')).toBe(CURRENT_PATCH)
      expect(await backupCount()).toBe(before)

      await rm(homePatch, { force: true })
      const overlay = join(root, 'legacy-overlay.yml')
      await writePatch(overlay, homeLegacy)
      await expect(migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        overlays: [overlay],
        hooks: { ensurePlugin: () => { throw new Error('must not run') } },
      })).rejects.toThrow(/--patch overlay .*still declares the legacy llm-pi-ai "providers\.cc-pool" route/)
      expect(await backupCount()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('completes and marks a hand-migrated or interrupted profile instead of skipping forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-adopt-'))
    try {
      const home = join(root, 'home')
      const profile = join(home, 'profiles', 'web')
      const patch = join(profile, 'cordis.patch.yml')
      const marker = join(profile, MIGRATION_MARKER_FILE)
      await writePatch(join(profile, 'package.json'), PROFILE_MANIFEST)
      await writePatch(patch, CURRENT_PATCH)
      const order: string[] = []

      const outcome = await migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: {
          ensurePlugin: () => { order.push('ensure') },
          seed: () => { order.push('seed') },
        },
      })

      expect(outcome.status).toBe('completed')
      expect(outcome.removed).toBe(0)
      expect(order).toEqual(['ensure', 'seed'])
      expect(existsSync(marker)).toBe(true)
      expect(await readFile(patch, 'utf8')).toBe(CURRENT_PATCH)
      const recorded = JSON.parse(await readFile(marker, 'utf8')) as { migrations: Record<string, unknown> }
      expect(recorded.migrations['legacy-llm-pi-ai-cc-pool-provider']).toBeDefined()

      const before = await backupCount()
      const second = await migrateLegacyProfile({
        dshHome: home,
        allowRunningHost: true,
        hooks: { ensurePlugin: () => { throw new Error('must not run') } },
      })
      expect(second.status).toBe('skipped')
      expect(await backupCount()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
