import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for SOURCE `dsh` execution: run `apps/cli/src/bin.ts`
 * with the exact production runtime vector (`node --import tsx/esm`, the
 * vector the root `dsh` script invokes directly). The suite checks the
 * required-profile diagnostic and a shipped headless tool round trip. The
 * Node compatibility matrix runs this whole file, so a Node release changing
 * module hooks, TypeScript handling, or source-profile resolution breaks this
 * gate instead of every developer's `pnpm dsh`; the built-bin suite covers
 * the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const headlessOverlay = fileURLToPath(new URL('./profiles/headless/tests/fixtures/headless-profile.patch.yml', import.meta.url))
const sourceProcessTimeoutMs = 60_000

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('boots the source entry and requires a profile', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
    expect(result.stdout).toBe('')
  }, 30_000)

  it('keeps the profile graph on the source plane through a real tool round trip', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-source-launch-tool-'))
    try {
      const result = await execa(process.execPath, [
        '--import', 'tsx/esm', dshSourceBin,
        '--profile', 'headless', '--patch', headlessOverlay,
        'prove the source tool path',
      ], {
        cwd: repoRoot,
        env: {
          DSH_HOME: join(temporaryRoot, 'home'),
          DSH_TELEMETRY_DISABLED: '1',
        },
        timeout: sourceProcessTimeoutMs,
        killSignal: 'SIGKILL',
        reject: false,
      })
      if (result.timedOut) {
        throw new Error(`dsh source tool round trip did not exit within ${sourceProcessTimeoutMs}ms. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toBe('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      expect(result.stderr).not.toContain('tool scheduler is unavailable')
      expect(result.stderr).not.toContain("reading 'prepare'")
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, sourceProcessTimeoutMs + 15_000)
})
