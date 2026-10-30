import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findLegacyPoolProviders,
  MIGRATION_MARKER_FILE,
  migrateLegacyProfile,
  migrateLegacyPoolProvider,
} from './migrate-legacy-cc-pool-profile.ts'

/** Write a file, creating its parent directories. */
async function writePatch(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, source)
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
})
