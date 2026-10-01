/** Lifecycle metadata and real-GC checks run in credential-free Node children. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/fork-memory-lifetime.mjs', import.meta.url))

it.each(['metadata', 'active-history', 'capacity', 'failure-containment', 'real-gc'])(
  'observes lifecycle targets without retaining them: %s',
  (scenario) => {
    const result = spawnSync(process.execPath, ['--expose-gc', fixture, scenario], {
      encoding: 'utf8',
      env: {},
      // The fixture bounds GC polling at 10 seconds; process startup and exit
      // have a separate outer budget so timeout evidence remains unambiguous.
      timeout: 15_000,
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ scenario, passed: true })
  },
  20_000,
)
