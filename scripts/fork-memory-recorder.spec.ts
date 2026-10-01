/** Recorder controls and actual Inspector sampling run only in isolated children. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/fork-memory-recorder.mjs', import.meta.url))

it.each(['policy', 'inspector', 'inspector-gc', 'guards', 'retention-trigger', 'dispose', 'dispose-error', 'startup-dispose'])(
  'records bounded private evidence and releases its observers: %s',
  (scenario) => {
    const result = spawnSync(process.execPath, ['--expose-gc', fixture, scenario], {
      encoding: 'utf8',
      env: {},
      timeout: 15_000,
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ scenario, passed: true })
  },
  20_000,
)
