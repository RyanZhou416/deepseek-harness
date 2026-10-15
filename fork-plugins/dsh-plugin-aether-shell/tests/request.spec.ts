/**
 * Request construction and input validation, exercised directly.
 *
 * These are the checks that decide whether model-supplied data can reach the
 * interpreter at all: a builtin name, a `select` path, a `predicate` fragment,
 * and every JSON value are all validated before a request is encoded, because
 * the native Agent API converts arguments into AetherShell source. Nothing in
 * this suite spawns a process; the process-level proofs live in the tool suites.
 */

import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  AGENT_API_ARGV,
  MAX_ARGV_CHARS,
  assertEvalCode,
  assertFlatBuiltin,
  assertPredicate,
  assertRequestBytes,
  assertSafeData,
  assertSelectPath,
  callRequest,
  capabilitiesRequest,
  encodeRequest,
  evalArgv,
  ontologyDescribeRequest,
  ontologyManifestRequest,
  pipelineRequest,
} from '../src/request.ts'
import { callTimeout, Config as ConfigSchema, resolveConfig } from '../src/config.ts'

const resolved = resolveConfig({})

describe('aether-shell builtin names', () => {
  it('accepts one flat identifier and refuses anything the interpreter would re-parse', () => {
    expect(() => { assertFlatBuiltin('crypto_hash', 'builtin') }).not.toThrow()
    expect(() => { assertFlatBuiltin('_private1', 'builtin') }).not.toThrow()
    for (const name of ['crypto.hash', '', ' ', '1abc', 'with space', 'a-b', 'a()', 'ls; rm', 'x${1}']) {
      expect(() => { assertFlatBuiltin(name, 'builtin') }).toThrowError(/E_INPUT_BUILTIN/)
    }
  })

  it('names the argument path that failed, so a multi-step pipeline is diagnosable', () => {
    expect(() => { assertFlatBuiltin('a.b', 'steps[2].builtin') }).toThrowError(/steps\[2\]\.builtin/)
  })
})

describe('aether-shell select paths', () => {
  it('accepts a plain or dotted field path', () => {
    for (const path of ['name', 'meta.size', 'a1.b2.c3']) {
      expect(() => { assertSelectPath(path, 'select') }).not.toThrow()
    }
  })

  it('refuses source syntax the interpreter would expand into code', () => {
    for (const path of ['', 'a b', 'a[0]', 'a->b', 'a | b', 'a.b()', '1a', '$x', 'a;b']) {
      expect(() => { assertSelectPath(path, 'steps[0].select') }).toThrowError(/E_INPUT_SELECT/)
    }
  })
})

describe('aether-shell predicate fragments', () => {
  it('accepts a non-empty expression inside the deployment budget', () => {
    expect(() => { assertPredicate('x > 1', 'predicate', resolved) }).not.toThrow()
  })

  it('refuses empty, NUL-bearing, and over-budget fragments', () => {
    expect(() => { assertPredicate('   ', 'predicate', resolved) }).toThrowError(/E_INPUT_PREDICATE/)
    expect(() => { assertPredicate('x\0y', 'predicate', resolved) }).toThrowError(/E_INPUT_PREDICATE/)
    const budget = resolveConfig({ maxExpressionChars: 8 })
    expect(() => { assertPredicate('x'.repeat(9), 'predicate', budget) }).toThrowError(/8-character budget/)
    expect(() => { assertPredicate('x'.repeat(8), 'predicate', budget) }).not.toThrow()
  })
})

describe('aether-shell data safety', () => {
  it('accepts plain JSON data with identifier record keys', () => {
    expect(() => { assertSafeData({ a: 1, b: ['x', { c: null }], d: true }, 'args[0]') }).not.toThrow()
    expect(() => { assertSafeData('plain text without interpolation', 'args[0]') }).not.toThrow()
  })

  it('refuses the interpolation sequence the native converter would re-parse as code', () => {
    expect(() => { assertSafeData('a${1 + 2}b', 'args[0]') }).toThrowError(/E_INPUT_LITERAL/)
    expect(() => { assertSafeData(['safe', '${shell.exec("rm")}'], 'args[0]') }).toThrowError(/args\[0\]\[1\]/)
    expect(() => { assertSafeData({ nested: { deep: 'x${y}' } }, 'args[0]') }).toThrowError(/args\[0\]\.nested\.deep/)
  })

  it('refuses record keys the interpreter would write unquoted', () => {
    for (const key of ['a-b', 'a:1,extra', '', 'a b', '1a', '$x', 'a.b']) {
      expect(() => { assertSafeData({ [key]: 1 }, 'args[0]') }).toThrowError(/E_INPUT_KEY/)
    }
  })

  it('walks arrays and records so no nested value escapes the check', () => {
    expect(() => { assertSafeData({ list: [{ ok: 1 }, { 'bad-key': 2 }] }, 'input') }).toThrowError(/input\.list\[1\]/)
  })
})

describe('aether-shell request builders', () => {
  it('omits absent arguments instead of sending null', () => {
    expect(callRequest('pwd', undefined)).toEqual({ action: 'call', builtin: 'pwd' })
    expect(callRequest('echo', ['hi'])).toEqual({ action: 'call', builtin: 'echo', args: ['hi'] })
  })

  it('refuses an unsafe argument before building the request', () => {
    expect(() => callRequest('echo', ['${x}'])).toThrowError(/E_INPUT_LITERAL/)
    expect(() => callRequest('bad.name', [])).toThrowError(/E_INPUT_BUILTIN/)
  })

  it('requires at least one pipeline step', () => {
    expect(() => pipelineRequest([], undefined, resolved)).toThrowError(/E_INPUT_STEPS/)
  })

  it('validates every pipeline step and omits absent optional fields', () => {
    expect(pipelineRequest([{ builtin: 'ls', args: ['.'] }, { builtin: 'len' }], undefined, resolved)).toEqual({
      action: 'pipeline',
      steps: [{ builtin: 'ls', args: ['.'] }, { builtin: 'len' }],
    })
    expect(() => pipelineRequest([{ builtin: 'ok' }, { builtin: 'bad.name' }], undefined, resolved))
      .toThrowError(/steps\[1\]\.builtin/)
    expect(() => pipelineRequest([{ builtin: 'echo', args: ['${x}'] }], undefined, resolved))
      .toThrowError(/steps\[0\]\.args\[0\]/)
    expect(() => pipelineRequest([{ builtin: 'map', select: 'a[0]' }], undefined, resolved))
      .toThrowError(/steps\[0\]\.select/)
    expect(() => pipelineRequest([{ builtin: 'where', predicate: '' }], undefined, resolved))
      .toThrowError(/steps\[0\]\.predicate/)
    expect(() => pipelineRequest([{ builtin: 'ls' }], 'x${y}', resolved)).toThrowError(/input/)
  })

  it('keeps a valid select and predicate on the step', () => {
    expect(pipelineRequest([{ builtin: 'ls', select: 'name', predicate: 'x > 1' }], '.', resolved)).toEqual({
      action: 'pipeline',
      steps: [{ builtin: 'ls', select: 'name', predicate: 'x > 1' }],
      input: '.',
    })
  })

  it('refuses an explicit null seed the interpreter would read as no input', () => {
    expect(() => pipelineRequest([{ builtin: 'pwd' }], null, resolved)).toThrowError(/E_INPUT_PIPELINE_NULL/)
    // Null nested inside step arguments or a record seed is data, not the seed.
    expect(pipelineRequest([{ builtin: 'echo', args: [null] }], undefined, resolved)).toEqual({
      action: 'pipeline',
      steps: [{ builtin: 'echo', args: [null] }],
    })
    expect(pipelineRequest([{ builtin: 'echo' }], { a: null }, resolved)).toEqual({
      action: 'pipeline',
      steps: [{ builtin: 'echo' }],
      input: { a: null },
    })
  })

  it('reads the ontology through the two discovery requests', () => {
    expect(ontologyManifestRequest()).toEqual({ action: 'call', builtin: 'ontology_manifest', args: [] })
    expect(ontologyDescribeRequest('pwd')).toEqual({ action: 'call', builtin: 'ontology_describe', args: ['pwd'] })
    expect(() => ontologyDescribeRequest('x${1}')).toThrowError(/E_INPUT_LITERAL/)
  })

  it('encodes exactly one JSON document', () => {
    const encoded = encodeRequest(callRequest('echo', ['hi']))
    expect(encoded).toBe('{"action":"call","builtin":"echo","args":["hi"]}')
    expect(JSON.parse(encoded)).toEqual({ action: 'call', builtin: 'echo', args: ['hi'] })
  })
})

describe('aether-shell typed-v1 argument channel', () => {
  // The channel's promise is that data stays data. These cases pin exactly which
  // refusals it drops, and that it drops none of the others.
  it('accepts interpolation text and non-identifier keys as data', () => {
    expect(() => { assertSafeData('a${1 + 2}b', 'args[0]', 'typed-v1') }).not.toThrow()
    expect(() => { assertSafeData({ 'a-b': 1, 'a:1,extra': 2, '': 3, 'has space': 4 }, 'args[0]', 'typed-v1') }).not.toThrow()
    // A record decoded from JSON can carry `__proto__` as its own key; it stays
    // data because nothing here assigns it onto a prototype.
    expect(() => { assertSafeData(JSON.parse('{"__proto__": {"polluted": true}}'), 'args[0]', 'typed-v1') }).not.toThrow()
    expect(() => { assertSafeData({ nested: { deep: ['x${y}', { 'bad-key': 1 }] } }, 'args[0]', 'typed-v1') }).not.toThrow()
  })

  it('keeps the number-fidelity refusal on every channel', () => {
    for (const mode of ['legacy', 'typed-v1'] as const) {
      expect(() => { assertSafeData(9_007_199_254_740_993, 'args[0]', mode) }).toThrowError(/E_INPUT_NUMBER/)
      expect(() => { assertSafeData(-0, 'args[0]', mode) }).toThrowError(/negative zero/)
      expect(() => { assertSafeData({ deep: [1e300] }, 'args[0]', mode) }).toThrowError(/args\[0\]\.deep\[0\]/)
      expect(() => { assertSafeData(Number.MAX_SAFE_INTEGER, 'args[0]', mode) }).not.toThrow()
    }
  })

  it('reads a broader select path on the typed channel and the strict one still applies without it', () => {
    for (const path of ['name', 'meta.size', '1leading', 'a-b', 'has space', '$x', 'ünïcode.key']) {
      expect(() => { assertSelectPath(path, 'select', 'typed-v1') }).not.toThrow()
    }
    for (const path of ['', '.a', 'a.', 'a..b', 'a\0b']) {
      expect(() => { assertSelectPath(path, 'select', 'typed-v1') }).toThrowError(/E_INPUT_SELECT/)
    }
    // The converting channel is unchanged: it expands the path into source.
    for (const path of ['1leading', 'a-b', 'has space', '$x']) {
      expect(() => { assertSelectPath(path, 'select') }).toThrowError(/E_INPUT_SELECT/)
    }
  })

  it('carries unsafe-by-conversion data on the typed channel only', () => {
    expect(callRequest('echo', ['a${1 + 2}b'], 'typed-v1'))
      .toEqual({ action: 'call', builtin: 'echo', args: ['a${1 + 2}b'] })
    expect(pipelineRequest([{ builtin: 'echo', args: [{ 'bad-key': 1 }] }], undefined, resolved, 'typed-v1'))
      .toEqual({ action: 'pipeline', steps: [{ builtin: 'echo', args: [{ 'bad-key': 1 }] }] })
    // An explicit null seed is the None value on the typed channel, which is what
    // `explicit_null_pipeline_input_v1` guarantees.
    expect(pipelineRequest([{ builtin: 'echo' }], null, resolved, 'typed-v1'))
      .toEqual({ action: 'pipeline', steps: [{ builtin: 'echo' }], input: null })
    expect(ontologyDescribeRequest('x${1}', 'typed-v1'))
      .toEqual({ action: 'call', builtin: 'ontology_describe', args: ['x${1}'] })

    expect(() => callRequest('echo', ['a${1 + 2}b'])).toThrowError(/E_INPUT_LITERAL/)
    expect(() => pipelineRequest([{ builtin: 'echo' }], null, resolved)).toThrowError(/E_INPUT_PIPELINE_NULL/)
  })

  it('keeps the checks that are not about data conversion', () => {
    expect(() => callRequest('crypto.hash', [], 'typed-v1')).toThrowError(/E_INPUT_BUILTIN/)
    expect(() => pipelineRequest([{ builtin: 'bad.name' }], undefined, resolved, 'typed-v1'))
      .toThrowError(/steps\[0\]\.builtin/)
    expect(() => { assertPredicate('', 'predicate', resolved) }).toThrowError(/E_INPUT_PREDICATE/)
    const small = resolveConfig({ maxRequestBytes: 32 })
    expect(() => { assertRequestBytes('x'.repeat(33), small) }).toThrowError(/E_INPUT_SIZE/)
  })

  it('pins the capability request the preflight sends', () => {
    expect(capabilitiesRequest()).toEqual({ action: 'capabilities' })
    expect(encodeRequest(capabilitiesRequest())).toBe('{"action":"capabilities"}')
  })

  it('defaults to the converting channel and refuses an unrecognized mode name', () => {
    expect(resolveConfig({}).structuredDataMode).toBe('legacy')
    expect(resolveConfig({ structuredDataMode: 'typed-v1' }).structuredDataMode).toBe('typed-v1')
    // A `cordis.yml` value reaches this schema as parsed data, not as a typed
    // literal, so the invalid spelling is fed through that same parsed boundary.
    expect(() => ConfigSchema(JSON.parse('{"structuredDataMode":"typed"}'))).toThrowError(/structuredDataMode/)
  })
})

describe('aether-shell request and program budgets', () => {
  it('accepts a payload exactly at the byte budget and refuses one byte more', () => {
    const budget = resolveConfig({ maxRequestBytes: 32 })
    const exact = 'x'.repeat(32)
    expect(() => { assertRequestBytes(exact, budget) }).not.toThrow()
    expect(() => { assertRequestBytes(`${exact}y`, budget) }).toThrowError(/33 bytes, over the maxRequestBytes budget of 32/)
  })

  it('counts UTF-8 bytes rather than characters', () => {
    const budget = resolveConfig({ maxRequestBytes: 4 })
    expect(() => { assertRequestBytes('éé', budget) }).not.toThrow()
    expect(() => { assertRequestBytes('ééé', budget) }).toThrowError(/6 bytes/)
  })

  it('refuses an empty program and one that cannot travel as one argv element', () => {
    expect(() => { assertEvalCode('   ', resolved) }).toThrowError(/E_INPUT_CODE/)
    const small = resolveConfig({ maxRequestBytes: 16 })
    expect(() => { assertEvalCode('x'.repeat(17), small) }).toThrowError(/E_INPUT_SIZE/)
    const long = 'x'.repeat(MAX_ARGV_CHARS + 1)
    expect(() => { assertEvalCode(long, resolveConfig({ maxRequestBytes: MAX_ARGV_CHARS * 4 })) }).toThrowError(/argv element/)
  })

  it('pins the argv tails the interpreter is invoked with', () => {
    expect(AGENT_API_ARGV).toEqual(['agent', 'execute'])
    expect(evalArgv('1 + 1')).toEqual(['--deterministic', '-c', '1 + 1'])
  })
})

describe('aether-shell resolved configuration', () => {
  it('fills the documented defaults', () => {
    const config = resolveConfig({})
    expect(config.executable).toBe('ae')
    expect(config.executableArgs).toEqual([])
    expect(config.mode).toBe('human')
    expect(config.allowShell).toBe(false)
    expect(config.timeoutMs).toBe(120_000)
    expect(config.maxTimeoutMs).toBe(600_000)
    expect(config.maxOutputBytes).toBe(262_144)
    expect(config.maxSpillBytes).toBe(8_388_608)
    expect(config.maxResultBytes).toBe(65_536)
    expect(config.graceMs).toBe(3_000)
  })

  it('refuses a cap below the default deadline or an unusable budget', () => {
    expect(() => resolveConfig({ timeoutMs: 5_000, maxTimeoutMs: 4_999 })).toThrowError(/must be at least timeoutMs/)
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrowError(/positive finite number/)
    expect(() => resolveConfig({ maxOutputBytes: Number.NaN })).toThrowError(/positive finite number/)
    expect(() => resolveConfig({ graceMs: MAX_TIMER_DELAY_MS + 1 })).toThrowError(/graceMs must be no greater/)
  })

  it('refuses a complete-result budget too small to carry one usable value', () => {
    expect(() => resolveConfig({ maxResultBytes: 1_023 })).toThrowError(/maxResultBytes must be at least 1024/)
    expect(resolveConfig({ maxResultBytes: 1_024 }).maxResultBytes).toBe(1_024)
    expect(() => resolveConfig({ maxResultBytes: 0 })).toThrowError(/positive finite number/)
  })

  it('refuses an executable it could not resolve and blank fixture argv entries', () => {
    expect(() => resolveConfig({ executable: 'tools/ae' })).toThrowError(/absolute path or a bare name/)
    expect(() => resolveConfig({ executable: 'C:\\AetherShell\\ae.exe' })).not.toThrow()
    expect(() => resolveConfig({ executable: '  ' })).toThrowError(/executable must be a non-empty string/)
    expect(() => resolveConfig({ executableArgs: ['fixture.mjs', ''] })).toThrowError(/executableArgs\[1\]/)
  })

  it('resolves one call deadline from the hint, the default, and the cap', () => {
    const config = resolveConfig({ timeoutMs: 1_000, maxTimeoutMs: 2_000 })
    expect(callTimeout(undefined, config)).toBe(1_000)
    expect(callTimeout(1_500, config)).toBe(1_500)
    expect(callTimeout(9_000, config)).toBe(2_000)
    expect(() => callTimeout(0, config)).toThrowError(/positive finite number/)
  })

  it('accepts only the interpreter native runtime mode spellings', () => {
    expect(resolveConfig({}).mode).toBe('human')
    expect(resolveConfig({ mode: 'agent' }).mode).toBe('agent')
    // A deployment's `cordis.yml` reaches this schema as parsed data, not as a
    // typed literal, so the invalid spelling is fed through that same parsed
    // boundary: an unrecognized mode must be refused, not forwarded for the
    // interpreter to silently fall back from.
    const parsedConfig = JSON.parse('{"mode":"bogus"}')
    expect(() => ConfigSchema(parsedConfig)).toThrowError(/mode/)
  })
})
