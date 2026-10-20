/**
 * The four model-facing tools through the REAL tool registry, the REAL local
 * subprocess provider, the REAL sandbox-policy service, and the deterministic
 * interpreter fixture.
 *
 * Two failure vocabularies meet here and must stay distinct. A reply the
 * interpreter itself reported as failed is a canonical `{kind:'error'}` value —
 * the model reads its error text, and the process facts stay separate, so a
 * failure reported by a process that exited 0 cannot be mistaken for a clean
 * run. An input the plugin refused, a corrupt stream, or an unavailable
 * interpreter is a thrown failure, and the registry reports it as `isError`.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, text, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

/** Mount one harness for this case. */
async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(options)
  return harness
}

/** The canonical outcome of a call that did not throw. */
function outcomeOf(result: Awaited<ReturnType<Harness['call']>>): Record<string, unknown> {
  expect(result.isError).toBe(false)
  return valueOf(result)
}

describe('aether-shell registration', () => {
  it('registers exactly the four foreground tools and no shell service', async () => {
    const mounted = await setup()
    const names = mounted.ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['aether_call', 'aether_discover', 'aether_eval', 'aether_pipeline'])
    // The plugin speaks the interpreter directly; it never registers a shell
    // executor, so the standing pwsh surface is unchanged.
    expect(mounted.ctx.get('shell')).toBeUndefined()
  })

  it('advertises the model-facing argument contract', async () => {
    const mounted = await setup()
    const schemaOf = (name: string) => {
      const schema = mounted.ctx.tools.schemas().find(candidate => candidate.name === name)
      if (schema === undefined) throw new Error(`${name} is not registered`)
      return schema.parameters as { required?: string[]; properties: Record<string, { type?: string }> }
    }
    expect(schemaOf('aether_discover').properties['query']?.type).toBe('string')
    expect(schemaOf('aether_discover').properties['offset']?.type).toBe('number')
    expect(schemaOf('aether_discover').properties['limit']?.type).toBe('number')
    expect(schemaOf('aether_call').properties['args']?.type).toBe('array')
    expect(schemaOf('aether_pipeline').properties['steps']?.type).toBe('array')
    expect(schemaOf('aether_pipeline').properties['input']).toBeDefined()
    expect(schemaOf('aether_eval').properties['code']?.type).toBe('string')
    expect(schemaOf('aether_call').required).toContain('builtin')
    expect(schemaOf('aether_pipeline').required).toContain('steps')
    expect(schemaOf('aether_eval').required).toContain('code')
  })

  it('states the argument channel this deployment actually applies', async () => {
    const legacy = await setup()
    const typed = await createHarness({ config: { structuredDataMode: 'typed-v1' } })
    try {
      const descriptionOf = (mounted: Harness, name: string) =>
        mounted.ctx.tools.schemas().find(schema => schema.name === name)?.description ?? ''
      expect(descriptionOf(legacy, 'aether_call')).toContain('legacy mode rejects strings containing `${`')
      expect(descriptionOf(legacy, 'aether_call')).not.toContain('typed argument channel')
      expect(descriptionOf(typed, 'aether_call')).toContain('typed argument channel')
      expect(descriptionOf(typed, 'aether_call')).not.toContain('is rejected because the interpreter')
      expect(descriptionOf(legacy, 'aether_pipeline')).toContain('legacy mode rejects `${` strings and non-identifier keys')
      expect(descriptionOf(typed, 'aether_pipeline')).toContain('Verified typed JSON args')
      // The seed's null rule differs by channel, and the parameter is what the
      // model reads before it decides to send one.
      const seedOf = (mounted: Harness) =>
        (mounted.ctx.tools.schemas().find(schema => schema.name === 'aether_pipeline')
          ?.parameters as { properties: Record<string, { description?: string }> }).properties['input']?.description ?? ''
      expect(seedOf(legacy)).toContain('Explicit null is rejected')
      expect(seedOf(typed)).toContain('Explicit null delivers None')
    } finally {
      await typed.dispose()
    }
  })
})

describe('aether_discover', () => {
  it('returns the category manifest bounded by the deployment entry budget', async () => {
    const mounted = await setup({ config: { maxManifestEntries: 2 } })
    const result = await mounted.call('aether_discover', {})
    const value = outcomeOf(result)
    expect(value['discovery']).toEqual({
      shape: 'manifest',
      offset: 0,
      shown: 2,
      total: 5,
      nextOffset: 2,
      truncated: true,
    })
    const payload = value['value'] as { categories: unknown[]; total_builtins: number; ontology: string }
    expect(payload.categories).toHaveLength(2)
    expect(payload.total_builtins).toBe(24)
    expect(payload.ontology).toBe('manifest')
    expect(text(result)).toContain('[showing 2 of 5; continue with offset 2]')
  })

  it('pages a list through offset and limit and stops offering a continuation', async () => {
    const mounted = await setup()
    const first = outcomeOf(await mounted.call('aether_discover', { limit: 2 }))
    expect(first['discovery']).toMatchObject({ shape: 'manifest', offset: 0, shown: 2, total: 5, nextOffset: 2, truncated: true })
    const second = outcomeOf(await mounted.call('aether_discover', { offset: 2, limit: 2 }))
    expect(second['discovery']).toMatchObject({ shape: 'manifest', offset: 2, shown: 2, total: 5, nextOffset: 4, truncated: true })
    const last = outcomeOf(await mounted.call('aether_discover', { offset: 4, limit: 2 }))
    expect(last['discovery']).toMatchObject({ shape: 'manifest', offset: 4, shown: 1, total: 5, truncated: false })
    expect(last['discovery']).not.toHaveProperty('nextOffset')
  })

  it('caps a requested page at the deployment entry budget', async () => {
    const mounted = await setup({ config: { maxManifestEntries: 2 } })
    const value = outcomeOf(await mounted.call('aether_discover', { limit: 50 }))
    expect(value['discovery']).toMatchObject({ shown: 2, total: 5, nextOffset: 2, truncated: true })
  })

  it('refuses a page bound that is not a whole number in range', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    for (const args of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: -2 }]) {
      const result = await mounted.call('aether_discover', args)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('E_INPUT_PAGE')
    }
  })

  it('describes a builtin and bounds only its illustrative examples', async () => {
    const mounted = await setup({ config: { maxManifestEntries: 2 } })
    const result = await mounted.call('aether_discover', { query: 'pwd' })
    const value = outcomeOf(result)
    expect(value['discovery']).toEqual({ shape: 'builtin', query: 'pwd', truncated: true })
    const payload = value['value'] as { builtin: string; examples: unknown[]; parameters: unknown[] }
    expect(payload.builtin).toBe('pwd')
    expect(payload.examples).toHaveLength(2)
    expect(payload.parameters).toEqual([])
    expect(text(result)).toContain('[examples truncated to the page size]')
  })

  it('describes a category', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_discover', { query: 'Core' }))
    expect(value['discovery']).toMatchObject({ shape: 'category', query: 'Core', offset: 0, shown: 3, total: 3, truncated: false })
  })

  it('reports the interpreter unknown-name reply as a successful not-found value', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_discover', { query: 'zzz_nope' })
    const value = outcomeOf(result)
    expect(value['discovery']).toEqual({ shape: 'unknown', query: 'zzz_nope', truncated: false })
    // The process exited 0 and the envelope said success; only the payload says not found.
    expect((value['process'] as { exitCode: number }).exitCode).toBe(0)
    expect(text(result)).toContain("aether ontology: 'zzz_nope' is not a known category or builtin")
    expect(text(result)).toContain('hint: call ontology_manifest()')
  })

  it('refuses a blank query before any process starts', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_discover', { query: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_QUERY')
  })
})

describe('aether_call', () => {
  it('returns a native value with its independent process and sandbox facts', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    const value = outcomeOf(result)
    expect(value['kind']).toBe('value')
    expect(typeof value['value']).toBe('string')
    expect(value['process']).toMatchObject({ exitCode: 0, signal: null, timedOut: false, aborted: false, cleanupFailed: false })
    expect(value['sandbox']).toEqual({ mode: 'danger-full-access', denied: false })
    expect(value['stderr']).toEqual({ text: '', truncated: false })
    expect(text(result)).not.toContain('[exit code:')
  })

  it('reports a native failure as an error outcome while the process exited 0', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_call', { builtin: 'unknown_builtin' })
    const value = outcomeOf(result)
    expect(value['kind']).toBe('error')
    expect((value['process'] as { exitCode: number }).exitCode).toBe(0)
    expect(value['error']).toMatchObject({
      code: 'E_UNKNOWN_BUILTIN',
      builtin: 'unknown_builtin',
      retryable: true,
    })
    expect(text(result)).toContain('aether error (E_UNKNOWN_BUILTIN): unknown builtin: unknown_builtin')
    expect(text(result)).toContain('hint: no builtin has a similar name')
  })

  it('reports a plain native failure message', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_call', { builtin: 'fail' }))
    expect(value['kind']).toBe('error')
    expect((value['error'] as { message: string }).message).toBe('the builtin refused the request')
  })

  it('keeps a native value that merely looks like a failure envelope', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_call', { builtin: 'value_success_false' }))
    expect(value['kind']).toBe('value')
    expect(value['value']).toMatchObject({ success: false })
  })

  it('passes the request to the interpreter exactly as encoded', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_call', { builtin: 'fixture_echo_request', args: ['a', 2, { k: true }] }))
    const echo = value['value'] as { argv: string[]; request: unknown }
    expect(echo.argv).toEqual(['agent', 'execute'])
    expect(echo.request).toEqual({ action: 'call', builtin: 'fixture_echo_request', args: ['a', 2, { k: true }] })
  })

  it('round-trips non-ASCII argument and result text', async () => {
    const mounted = await setup()
    const payload = 'héllo — 世界 🌍'
    const result = await mounted.call('aether_call', { builtin: 'echo', args: [payload] })
    expect(outcomeOf(result)['value']).toBe(payload)
    expect(text(result)).toBe(payload)
  })

  it('runs the interpreter in the calling session workspace and honors a relative cwd', async () => {
    const mounted = await setup()
    const nested = join(mounted.workspace, 'sub')
    await mkdir(nested)
    await writeFile(join(nested, 'nested.txt'), 'x')
    expect(outcomeOf(await mounted.call('aether_call', { builtin: 'pwd' }))['value']).toBe(mounted.workspace)
    expect(outcomeOf(await mounted.call('aether_call', { builtin: 'pwd', cwd: 'sub' }))['value']).toBe(nested)
  })

  it('falls back to the process directory when the execution has no session', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_call', { builtin: 'pwd' }, { agent: null }))
    expect(typeof value['value']).toBe('string')
    expect(isAbsolute(value['value'] as string)).toBe(true)
  })
})

describe('aether_pipeline', () => {
  it('runs an ordered pipeline and returns the interpreter value', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_pipeline', { steps: [{ builtin: 'pwd' }] }))
    expect(value['kind']).toBe('value')
    expect((value['value'] as { steps: string[] }).steps).toEqual(['pwd'])
  })

  it('forwards steps, select, predicate, and input in one request', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_pipeline', {
      steps: [{ builtin: 'ls', select: 'name' }, { builtin: 'where', predicate: 'x > 1' }],
      input: '.',
    })
    expect(result.isError).toBe(false)
  })

  it('refuses an empty pipeline', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_pipeline', { steps: [] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_STEPS')
  })

  it('refuses an explicit null pipeline seed before any process starts', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_pipeline', { steps: [{ builtin: 'pwd' }], input: null })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_PIPELINE_NULL')
  })

  it('reports a failing pipeline step as an error outcome', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_pipeline', { steps: [{ builtin: 'unknown_builtin' }] }))
    expect(value['kind']).toBe('error')
    expect((value['error'] as { code?: string }).code).toBe('E_UNKNOWN_BUILTIN')
  })
})

describe('aether_eval', () => {
  it('returns the command-line canonical JSON value and its inferred type', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_eval', { code: 'json.stringify({a: 1})' }))
    expect(value['kind']).toBe('value')
    expect(value['value']).toBe('{"a":1}')
    expect(value['resultType']).toBe('string')
  })

  it('reports a program that printed nothing as a null value with resultType none', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_eval', { code: 'fixture:silent:' }))
    expect(value).toMatchObject({ kind: 'value', value: null, resultType: 'none' })
  })

  it('returns the interpreter error text and code for a failing program', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_eval', { code: 'fixture:fail:' })
    const value = outcomeOf(result)
    expect(value['kind']).toBe('error')
    expect(value['error']).toMatchObject({ code: 'E_FIXTURE_DIRECTIVE' })
    expect(value['process']).toMatchObject({ exitCode: 1 })
    expect(text(result)).toContain('aether error (E_FIXTURE_DIRECTIVE)')
  })

  it('rejects a program whose successful exit did not print one JSON value', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_eval', { code: 'fixture:malformed:' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_PROTOCOL_OUTPUT')
  })

  it('rejects a program whose value cannot round-trip as a runtime number', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_eval', { code: 'fixture:value:9007199254740993' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_PROTOCOL_NUMBER')
  })

  it('treats a nested `{success:false}` program value as a value', async () => {
    const mounted = await setup()
    const value = outcomeOf(await mounted.call('aether_eval', { code: 'fixture:value:{"success":false}' }))
    expect(value['value']).toEqual({ success: false })
  })

  it('refuses an empty program before any process starts', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_eval', { code: '  ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_CODE')
  })
})

describe('aether-shell input refusal happens before the runtime', () => {
  // Every case mounts an interpreter name that cannot resolve, so a spawn
  // attempt would surface E_EXECUTABLE instead of the input error.
  it('refuses the interpolation sequence in call data', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_call', { builtin: 'echo', args: ['a${1 + 2}b'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_LITERAL')
    expect(text(result)).not.toContain('E_EXECUTABLE')
  })

  it('refuses a record key the interpreter would write unquoted', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_call', { builtin: 'echo', args: [{ 'bad-key': 1 }] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_KEY')
  })

  it('refuses unsafe pipeline step data and an over-limit request', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter', config: { maxRequestBytes: 128 } })
    const unsafe = await mounted.call('aether_pipeline', { steps: [{ builtin: 'echo', args: ['${x}'] }] })
    expect(unsafe.isError).toBe(true)
    expect(text(unsafe)).toContain('E_INPUT_LITERAL')
    const oversized = await mounted.call('aether_call', { builtin: 'echo', args: ['x'.repeat(256)] })
    expect(oversized.isError).toBe(true)
    expect(text(oversized)).toContain('E_INPUT_SIZE')
  })

  it('refuses a dotted builtin name the interpreter would read as field access', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_call', { builtin: 'crypto.hash' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_BUILTIN')
  })

  it('reports a missing interpreter as a spawn failure, not as a tool result', async () => {
    const mounted = await setup({ executable: 'definitely-not-an-aether-interpreter' })
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/E_EXECUTABLE|E_SPAWN/)
  })
})

describe('aether-shell child environment', () => {
  const POLLUTED = ['AETHER_ALLOW_SH', 'AE_DETERMINISTIC', 'AETHER_MODE', 'AETHER_WORKSPACE', 'AE_POLICY'] as const

  it('clears every inherited AETHER_*/AE_* control setting and sets the deployment values', async () => {
    const saved = new Map<string, string | undefined>()
    for (const name of POLLUTED) {
      saved.set(name, process.env[name])
      process.env[name] = 'inherited-permissive-value'
    }
    try {
      const mounted = await setup({ config: { mode: 'human', allowShell: false } })
      const env = outcomeOf(await mounted.call('aether_call', { builtin: 'fixture_env' }))['value'] as {
        mode: string
        allowSh: string
        aetherKeys: string[]
        aeKeys: string[]
        dshKeys: string[]
      }
      expect(env.mode).toBe('human')
      expect(env.allowSh).toBe('false')
      // Only this deployment's values survive; the inherited jail, policy, and
      // shell switches are tombstoned rather than forwarded.
      expect(env.aetherKeys).toEqual(['AETHER_ALLOW_SH', 'AETHER_MODE'])
      expect(env.aeKeys).toEqual(['AE_DETERMINISTIC'])
      expect(env.dshKeys).toEqual([])
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('applies the managed DSH_* facts when the shell-env registry is mounted', async () => {
    const mounted = await setup({ shellEnv: true })
    const env = outcomeOf(await mounted.call('aether_call', { builtin: 'fixture_env' }))['value'] as { dshKeys: string[] }
    expect(env.dshKeys).toContain('DSH_HOME')
    expect(env.dshKeys).toContain('DSH_SHELL')
  })
})

describe('aether-shell output retention', () => {
  it('returns the value and spills an oversized diagnostic stream to a readable file', async () => {
    const mounted = await setup({ config: { maxOutputBytes: 4_096, maxSpillBytes: 1_048_576 } })
    const result = await mounted.call('aether_call', { builtin: 'stderr_big', args: [200_000] })
    const value = outcomeOf(result)
    const stderr = value['stderr'] as { text: string; truncated: boolean; spillPath?: string }
    expect(stderr.truncated).toBe(true)
    expect(stderr.spillPath).toBeDefined()
    expect(Buffer.byteLength(stderr.text, 'utf8')).toBeLessThanOrEqual(4_096)
    const spilled = await readFile(stderr.spillPath as string, 'utf8')
    expect(spilled.length).toBeGreaterThanOrEqual(200_000)
    expect(text(result)).toContain('[stderr truncated; complete stream:')
  })

  it('decodes the complete spill when only the in-memory response was truncated', async () => {
    const mounted = await setup({ config: { maxOutputBytes: 4_096, maxSpillBytes: 1_048_576, maxResultBytes: 200_000 } })
    const result = await mounted.call('aether_call', { builtin: 'big', args: [100_000] })
    expect(result.isError).toBe(false)
    expect(outcomeOf(result)).toMatchObject({ kind: 'value', value: 'x'.repeat(100_000) })
  })

  it('refuses a response when neither the memory window nor the spill retained it whole', async () => {
    const mounted = await setup({ config: { maxOutputBytes: 4_096, maxSpillBytes: 8_192 } })
    const result = await mounted.call('aether_call', { builtin: 'big', args: [100_000] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_PROTOCOL_TRUNCATED')
    expect(text(result)).toContain('effects of this invocation are unknown')
  })

  it('turns an oversized complete result into the narrowing failure', async () => {
    const mounted = await setup({ config: { maxResultBytes: 1_024 } })
    const result = await mounted.call('aether_call', { builtin: 'big', args: [4_000] })
    const value = outcomeOf(result)
    expect(value['kind']).toBe('error')
    expect(value['error']).toMatchObject({ code: 'E_RESULT_LIMIT', retryable: false })
    expect((value['error'] as { hint: string }).hint).toContain('narrow the request')
    expect(text(result)).toContain('over the maxResultBytes budget of 1024')
  })

  it('never returns model content larger than the configured complete-result budget', async () => {
    const mounted = await setup({ config: { maxResultBytes: 1_024 } })
    for (const size of [900, 4_000]) {
      const result = await mounted.call('aether_call', { builtin: 'big', args: [size] })
      expect(Buffer.byteLength(text(result), 'utf8')).toBeLessThanOrEqual(1_024)
    }
  })
})

describe('aether-shell process outcome separation', () => {
  it('does not report a successful value when the interpreter exited nonzero', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_call', { builtin: 'nonzero' })
    const value = outcomeOf(result)
    expect(value['kind']).toBe('error')
    expect(value['error']).toMatchObject({ code: 'E_PROCESS_EXIT', retryable: false })
    expect((value['process'] as { exitCode: number }).exitCode).toBe(3)
    expect(text(result)).toContain('[exit code: 3]')
  })
})

describe('aether-shell temporary workspaces', () => {
  it('honors an explicit absolute workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-aether-root-'))
    const mounted = await setup({ workspaceRoot: root })
    expect(outcomeOf(await mounted.call('aether_call', { builtin: 'pwd' }))['value']).toBe(root)
  })
})
