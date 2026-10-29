import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKSPACE_PLUGINS } from './fork-plugins-build.ts'
import { isEmptyProfilePatch, seedPortableProfile } from './fork-profile-seed.ts'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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
  await writeFile(join(directory, 'goal-disabled.cjs'), 'disabled\n')
  await writeFile(join(directory, 'portable-memory-limits.patch.yml'), '- id: memory\n')
  for (const file of ['agent.cordis.yml', 'preset.yml', 'no-escalation.cjs']) {
    await writeFile(join(directory, 'agent-presets', 'chatgpt-dsh', file), `${file}\n`)
  }
  return directory
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One parsed patch row. */
type Row = Record<string, unknown>

/**
 * Parse a tracked YAML patch. The portable template carries `!!js` tags, so
 * those value lines are removed before parsing; no managed row uses one.
 * @param path - repository-relative patch path.
 * @returns the top-level rows.
 */
async function readPatch(path: string): Promise<Row[]> {
  const source = (await readFile(join(REPOSITORY_ROOT, path), 'utf8'))
    .split(/\r?\n/)
    .filter(line => !line.includes('!!js'))
    .join('\n')
  const parsed: unknown = yaml.load(source)
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a top-level list`)
  return parsed.filter((row): row is Row => row !== null && typeof row === 'object' && !Array.isArray(row))
}

/**
 * Flatten `- insert:` wrappers into the rows they install.
 * @param rows - top-level patch rows.
 * @returns every managed row.
 */
function insertedRows(rows: readonly Row[]): Row[] {
  return rows.flatMap((row) => {
    const inserted = row['insert']
    return Array.isArray(inserted) ? inserted.filter((entry): entry is Row => entry !== null && typeof entry === 'object') : [row]
  })
}

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
    expect(await readFile(join(dshHome, 'profiles', 'web', 'goal-disabled.cjs'), 'utf8')).toBe('disabled\n')
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

describe('cc-pool route ownership', () => {
  it('leaves the route to the dedicated plugin and links that plugin into the profile', async () => {
    const templateRows = await readPatch('fork-runtime/web/portable-profile.patch.yml')
    const template = insertedRows(templateRows)
    const llm = template.find(row => row['id'] === 'llm-pi-ai')
    expect(llm).toBeDefined()
    const providers = (llm?.['config'] as Record<string, unknown>)['providers'] as Record<string, unknown>
    // The old generic route is gone; the dedicated bundle owns cc-pool.
    expect(providers).not.toHaveProperty('cc-pool')
    expect(providers).toHaveProperty('anthropic')
    // The template must not install the plugin row itself: the bundle patch does.
    expect(template.some(row => row['id'] === 'llm-cc-pool')).toBe(false)

    const pluginRows = insertedRows(await readPatch('packages/llm/llm-cc-pool/cordis.patch.yml'))
    const ccPool = pluginRows.filter(row => row['id'] === 'llm-cc-pool')
    expect(ccPool).toHaveLength(1)
    expect(ccPool[0]).toMatchObject({ name: '@deepseek-ai/dsh-llm-cc-pool' })
    // Exactly one cc-pool route across the template and the installed bundle.
    expect(pluginRows.filter(row => row['name'] === '@deepseek-ai/dsh-llm-cc-pool')).toHaveLength(1)

    // The fork build links exactly that workspace package into a fresh profile.
    const workspace = WORKSPACE_PLUGINS.find(entry => entry.name === '@deepseek-ai/dsh-llm-cc-pool')
    expect(workspace?.directory).toBe(join(REPOSITORY_ROOT, 'packages', 'llm', 'llm-cc-pool'))
    expect(workspace?.outputs).toEqual(['lib/index.js'])
    const manifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'packages/llm/llm-cc-pool/package.json'), 'utf8')) as {
      dsh?: unknown
      files?: unknown
    }
    expect(manifest.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    expect(manifest.files).toContain('cordis.patch.yml')
  })
})
