import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isEmptyProfilePatch, seedPortableProfile } from './fork-profile-seed.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fork-profile-seed-'))
  roots.push(root)
  return root
}

async function kit(root: string): Promise<string> {
  const directory = join(root, 'kit')
  await mkdir(join(directory, 'agent-presets', 'chatgpt-dsh'), { recursive: true })
  await writeFile(join(directory, 'portable-profile.patch.yml'), '- id: template\n  disabled: true\n')
  await writeFile(join(directory, 'memory-watchdog.cjs'), 'watchdog\n')
  await writeFile(join(directory, 'chatgpt-subagent-preset.cjs'), 'preset\n')
  await writeFile(join(directory, 'portable-memory-limits.patch.yml'), '- id: memory\n')
  for (const file of ['agent.cordis.yml', 'preset.yml', 'no-escalation.cjs']) {
    await writeFile(join(directory, 'agent-presets', 'chatgpt-dsh', file), `${file}\n`)
  }
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('portable profile seed', () => {
  it('recognizes an unedited profile patch', () => {
    expect(isEmptyProfilePatch('')).toBe(true)
    expect(isEmptyProfilePatch('# header\n[]\n')).toBe(true)
    expect(isEmptyProfilePatch('- id: custom\n')).toBe(false)
  })

  it('seeds a new profile and its support files', async () => {
    const root = await temporaryRoot()
    const kitRoot = await kit(root)
    const dshHome = join(root, 'home')

    const result = await seedPortableProfile({ dshHome, kitRoot })

    expect(result.patchSeeded).toBe(true)
    expect(await readFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toContain('id: template')
    expect(await readFile(join(dshHome, 'profiles', 'web', 'memory-limits.patch.yml'), 'utf8')).toContain('id: memory')
    expect(await readFile(join(dshHome, '.agent-presets', 'chatgpt-dsh', 'preset.yml'), 'utf8')).toBe('preset.yml\n')
    expect(result.copied.length).toBeGreaterThan(0)
  })

  it('preserves an existing user profile and existing support files', async () => {
    const root = await temporaryRoot()
    const kitRoot = await kit(root)
    const dshHome = join(root, 'home')
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: mine\n')
    await writeFile(join(profile, 'memory-watchdog.cjs'), 'mine\n')

    const result = await seedPortableProfile({ dshHome, kitRoot })

    expect(result.patchSeeded).toBe(false)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('id: mine')
    expect(await readFile(join(profile, 'memory-watchdog.cjs'), 'utf8')).toBe('mine\n')
    expect(result.kept.length).toBeGreaterThan(0)
  })

  it('can force the template over a user profile', async () => {
    const root = await temporaryRoot()
    const kitRoot = await kit(root)
    const dshHome = join(root, 'home')
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: mine\n')

    const result = await seedPortableProfile({ dshHome, kitRoot, force: true })

    expect(result.patchSeeded).toBe(true)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('id: template')
  })
})
