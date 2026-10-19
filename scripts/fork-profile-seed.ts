/**
 * Seed a fresh Web profile from the fork's portable profile kit.
 *
 * The kit is a tracked template: `portable-profile.patch.yml`, the local
 * watchdog and ChatGPT preset plugins, and the ChatGPT preset files. It is
 * copied only when the profile is first created. An existing profile patch is
 * never overwritten; support files are added only when absent.
 *
 * @module scripts/fork-profile-seed
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_KIT_ROOT = join(REPOSITORY_ROOT, 'fork-runtime', 'web')

/** Files copied beside the profile patch. */
const PROFILE_FILES = [
  ['memory-watchdog.cjs', 'memory-watchdog.cjs'],
  ['chatgpt-subagent-preset.cjs', 'chatgpt-subagent-preset.cjs'],
  ['goal-disabled.cjs', 'goal-disabled.cjs'],
  ['portable-memory-limits.patch.yml', 'memory-limits.patch.yml'],
] as const

/** Files copied into `$DSH_HOME/.agent-presets/chatgpt-dsh`. */
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml', 'no-escalation.cjs'] as const

/** Options for {@link seedPortableProfile}. */
export interface SeedOptions {
  /** Harness home that owns `profiles/web` and `.agent-presets`. */
  readonly dshHome: string
  /** Kit source directory; defaults to `fork-runtime/web`. */
  readonly kitRoot?: string
  /** Overwrite an existing profile patch, even when it has entries. */
  readonly force?: boolean
}

/** Outcome of one seed invocation. */
export interface SeedResult {
  /** Profile directory that was inspected. */
  readonly profileDirectory: string
  /** Whether the profile patch was replaced by the template. */
  readonly patchSeeded: boolean
  /** Support files copied during this invocation. */
  readonly copied: readonly string[]
  /** Support files left untouched because they already existed. */
  readonly kept: readonly string[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Treat comments, blank lines, and an empty top-level array as an unedited
 * profile. Anything else belongs to the user.
 * @param source - raw profile patch text.
 * @returns whether the patch carries no user entries.
 */
export function isEmptyProfilePatch(source: string): boolean {
  const meaningful = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .join('')
  return meaningful === '' || meaningful === '[]'
}

async function copyIfMissing(source: string, destination: string, copied: string[], kept: string[]): Promise<void> {
  if (await exists(destination)) {
    kept.push(destination)
    return
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  copied.push(destination)
}

/**
 * Seed a fresh profile from the fork's portable kit.
 * @param options - harness home, optional kit root, and overwrite policy.
 * @returns what was seeded and what was preserved.
 */
export async function seedPortableProfile(options: SeedOptions): Promise<SeedResult> {
  const kitRoot = options.kitRoot ?? DEFAULT_KIT_ROOT
  const profileDirectory = join(options.dshHome, 'profiles', 'web')
  const copied: string[] = []
  const kept: string[] = []
  await mkdir(profileDirectory, { recursive: true })

  const patchPath = join(profileDirectory, 'cordis.patch.yml')
  const templatePath = join(kitRoot, 'portable-profile.patch.yml')
  if (!(await exists(patchPath))) {
    await copyFile(templatePath, patchPath)
    copied.push(patchPath)
  } else {
    const current = await readFile(patchPath, 'utf8')
    if (options.force === true || isEmptyProfilePatch(current)) {
      await copyFile(templatePath, patchPath)
      copied.push(patchPath)
    } else {
      kept.push(patchPath)
    }
  }

  for (const [source, destination] of PROFILE_FILES) {
    await copyIfMissing(join(kitRoot, source), join(profileDirectory, destination), copied, kept)
  }

  const presetDirectory = join(options.dshHome, '.agent-presets', 'chatgpt-dsh')
  for (const file of PRESET_FILES) {
    await copyIfMissing(join(kitRoot, 'agent-presets', 'chatgpt-dsh', file), join(presetDirectory, file), copied, kept)
  }

  return {
    profileDirectory,
    patchSeeded: copied.includes(patchPath),
    copied,
    kept,
  }
}
