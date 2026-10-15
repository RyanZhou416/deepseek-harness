/**
 * The real AetherShell interpreter, when this host has one installed.
 *
 * The deterministic fixture proves the plugin's own protocol, budget, and
 * lifecycle behavior; only a real interpreter proves the plugin speaks the
 * native protocol as shipped — the envelope fields, the ontology payload
 * shapes, the unknown-builtin failure form, the command-line JSON output, and
 * module support through `--deterministic -c`. The suite self-skips on a host
 * without the interpreter.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, installedInterpreter, text, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

const interpreter = installedInterpreter()

let harness: Harness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

/** Mount the plugin against the installed interpreter. */
async function setup(): Promise<Harness> {
  harness = await createHarness({
    ...interpreter === undefined ? {} : { executable: interpreter },
    executableArgs: [],
    config: { mode: 'human', graceMs: 1_000 },
  })
  return harness
}

describe.skipIf(interpreter === undefined)('aether-shell against the installed interpreter', () => {
  it('reads the real ontology manifest', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_discover', {})
    const value = valueOf(result)
    expect(value['discovery']).toMatchObject({ shape: 'manifest', truncated: false })
    const payload = value['value'] as { total_builtins: number; categories: unknown[]; ontology: string }
    expect(payload.ontology).toBe('manifest')
    expect(payload.total_builtins).toBeGreaterThan(100)
    expect(payload.categories.length).toBeGreaterThan(10)
  })

  it('describes a real builtin and reports an unknown name as not found', async () => {
    const mounted = await setup()
    const known = valueOf(await mounted.call('aether_discover', { query: 'pwd' }))
    expect(known['discovery']).toMatchObject({ shape: 'builtin', query: 'pwd' })
    expect((known['value'] as { signature: string }).signature).toContain('pwd(')

    const unknown = await mounted.call('aether_discover', { query: 'dsh_no_such_builtin_xyz' })
    const notFound = valueOf(unknown)
    expect(notFound['discovery']).toMatchObject({ shape: 'unknown', query: 'dsh_no_such_builtin_xyz' })
    expect(text(unknown)).toContain('aether ontology:')
  })

  it('calls a real builtin and returns its typed value', async () => {
    const mounted = await setup()
    const value = valueOf(await mounted.call('aether_call', { builtin: 'pwd' }))
    expect(value['kind']).toBe('value')
    expect(typeof value['value']).toBe('string')
    expect(value['resultType']).toBe('String')
    expect((value['process'] as { exitCode: number }).exitCode).toBe(0)
  })

  it('reports the real unknown-builtin failure', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_call', { builtin: 'dsh_no_such_builtin_xyz' })
    const value = valueOf(result)
    expect(value['kind']).toBe('error')
    expect((value['error'] as { code?: string }).code).toBe('E_UNKNOWN_BUILTIN')
  })

  it('runs a real two-builtin pipeline', async () => {
    const mounted = await setup()
    const value = valueOf(await mounted.call('aether_pipeline', {
      steps: [{ builtin: 'ls', args: ['.'] }, { builtin: 'len' }],
    }))
    expect(value['kind']).toBe('value')
    expect(typeof value['value']).toBe('number')
  })

  it('evaluates a real program that uses a module, which the native Eval action cannot', async () => {
    const mounted = await setup()
    const value = valueOf(await mounted.call('aether_eval', { code: 'json.stringify({a: 1})' }))
    expect(value['kind']).toBe('value')
    expect(value['value']).toBe('{"a":1}')
    expect(value['resultType']).toBe('string')
  })

  it('returns the real command-line failure text for a failing program', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_eval', { code: 'dsh_no_such_builtin_xyz()' })
    const value = valueOf(result)
    expect(value['kind']).toBe('error')
    expect((value['error'] as { code?: string }).code).toBe('E_UNKNOWN_BUILTIN')
    expect((value['error'] as { hint?: string }).hint).toBeDefined()
    expect((value['process'] as { exitCode: number }).exitCode).not.toBe(0)
  })
})
