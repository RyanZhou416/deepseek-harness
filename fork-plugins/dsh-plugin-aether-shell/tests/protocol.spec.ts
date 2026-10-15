/**
 * Decoding of the two native protocols into the canonical outcome vocabulary.
 *
 * The facts under test are the ones a real interpreter run produced: an Agent
 * API envelope whose `success` is false while the process exited 0, a failure
 * whose `error` is a JSON string rather than text, and a command-line run whose
 * exit code, stdout value, and stderr diagnostics are three independent facts.
 * A non-zero exit always outranks an envelope's claim of success.
 */

import { describe, expect, it } from 'vitest'
import { jsonKindOf, isJsonObject, numberFidelityProblem, recovery, stripRequestEcho } from '../src/outcome.ts'
import type { AetherDiagnostics, AetherProcessFacts, AetherSandboxFacts } from '../src/outcome.ts'
import { AetherProtocolError, decodeEnvelope, decodeEvalOutcome, decodeFailure, toOutcome } from '../src/protocol.ts'

const process = (exitCode: number | null = 0): AetherProcessFacts =>
  ({ exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1_000, cleanupFailed: false })

const sandbox: AetherSandboxFacts = { mode: 'danger-full-access', denied: false }

const noDiagnostics: AetherDiagnostics = { text: '', truncated: false }

describe('Agent API envelope decoding', () => {
  it('decodes a successful envelope and drops the request echo from metadata', () => {
    const envelope = decodeEnvelope(JSON.stringify({
      success: true,
      result: { name: 'pwd' },
      result_type: 'Record',
      metadata: { code_executed: 'pwd()', token_accounting: { tokens_total: 3 } },
    }))
    expect(envelope).toEqual({
      success: true,
      result: { name: 'pwd' },
      resultType: 'Record',
      metadata: { token_accounting: { tokens_total: 3 } },
    })
  })

  it('keeps the failure text and strips the failed-call echo', () => {
    const envelope = decodeEnvelope(JSON.stringify({
      success: false,
      error: 'boom',
      metadata: { code_attempted: 'boom()', token_accounting: { tokens_total: 1 } },
    }))
    expect(envelope.success).toBe(false)
    expect(envelope.error).toBe('boom')
    expect(envelope.metadata).toEqual({ token_accounting: { tokens_total: 1 } })
  })

  it('drops metadata entirely when only the request echo was present', () => {
    expect(decodeEnvelope(JSON.stringify({ success: true, metadata: { code_executed: 'x()' } })).metadata).toBeUndefined()
  })

  it.each([
    ['empty stdout', '', /wrote no response to stdout/],
    ['unparseable stdout', '{not json', /not one JSON response document/],
    ['a bare array', '[1, 2]', /was an array, not an envelope object/],
    ['a bare number', '7', /was a number, not an envelope object/],
    ['a missing success flag', '{"result": 1}', /no boolean "success" field/],
    ['a non-boolean success flag', '{"success": "yes"}', /no boolean "success" field/],
    ['a non-string result_type', '{"success": true, "result_type": 4}', /"result_type" is a number, not a string/],
    ['a non-string error', '{"success": false, "error": {"message": "x"}}', /"error" is .*, not a string/],
  ])('rejects %s', (_label, stdout, pattern) => {
    expect(() => decodeEnvelope(stdout)).toThrowError(AetherProtocolError)
    expect(() => decodeEnvelope(stdout)).toThrowError(pattern as RegExp)
  })

  it('names the spill file in a protocol failure, so the complete stream stays reachable', () => {
    expect(() => decodeEnvelope('garbage', 'C:\\spill\\stdout.log')).toThrowError(/complete stream: C:\\spill\\stdout\.log/)
  })

  it('quotes a bounded excerpt of the offending stream', () => {
    const noise = `x${'y'.repeat(500)}`
    try {
      decodeEnvelope(noise)
      expect.unreachable('a non-document stream must fail')
    } catch (error) {
      expect((error as Error).message).toContain('…')
      expect((error as Error).message.length).toBeLessThan(600)
    }
  })

  it('refuses a native number this runtime could not carry exactly', () => {
    expect(() => decodeEnvelope(JSON.stringify({ success: true, result: 9_007_199_254_740_993 })))
      .toThrowError(/E_PROTOCOL_NUMBER/)
    // A large integer nested more deeply is still refused.
    expect(() => decodeEnvelope(JSON.stringify({ success: true, result: { rows: [{ n: 18_446_744_073_709_551_615 }] } })))
      .toThrowError(/outside the exact integer range/)
    expect(() => decodeEnvelope(JSON.stringify({ success: true, result: { nested: [1, 2.5] } }))).not.toThrow()
  })
})

describe('native failure text decoding', () => {
  it('splits the structured failure form into its fields', () => {
    const failure = decodeFailure(JSON.stringify({
      error: {
        builtin: 'nope',
        code: 'E_UNKNOWN_BUILTIN',
        did_you_mean: ['pwd', 'cat'],
        hint: 'list the categories',
        message: 'unknown builtin: nope',
        retryable: true,
      },
    }))
    expect(failure).toEqual({
      message: 'unknown builtin: nope',
      code: 'E_UNKNOWN_BUILTIN',
      builtin: 'nope',
      didYouMean: ['pwd', 'cat'],
      hint: 'list the categories',
      retryable: true,
    })
  })

  it('keeps plain text as the whole message', () => {
    expect(decodeFailure('the builtin refused the request')).toEqual({ message: 'the builtin refused the request' })
    expect(decodeFailure('{"error": "a string"}')).toEqual({ message: '{"error": "a string"}' })
    expect(decodeFailure('{"error": {"code": "E_X"}}')).toEqual({ message: '{"error": {"code": "E_X"}}' })
  })

  it('drops an empty or non-string suggestion list', () => {
    expect(decodeFailure(JSON.stringify({ error: { message: 'x', did_you_mean: [] } }))).toEqual({ message: 'x' })
    expect(decodeFailure(JSON.stringify({ error: { message: 'x', did_you_mean: [1, 2] } }))).toEqual({ message: 'x' })
  })

  it('bounds an enormous failure message rather than forwarding it whole', () => {
    const failure = decodeFailure('x'.repeat(20_000))
    expect(failure.message.length).toBe(8_193)
    expect(failure.message.endsWith('…')).toBe(true)
  })
})

describe('envelope to canonical outcome', () => {
  it('keeps a native failure separate from the successful process that reported it', () => {
    const outcome = toOutcome(
      { success: false, error: JSON.stringify({ error: { code: 'E_UNKNOWN_BUILTIN', message: 'unknown builtin: nope' } }) },
      process(0),
      noDiagnostics,
      sandbox,
    )
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') throw new Error('expected an error outcome')
    expect(outcome.error).toEqual({ message: 'unknown builtin: nope', code: 'E_UNKNOWN_BUILTIN' })
    expect(outcome.process.exitCode).toBe(0)
    expect(outcome.process.timedOut).toBe(false)
    expect(outcome.sandbox).toEqual(sandbox)
  })

  it('reports a success without a result as a null value rather than an error', () => {
    const outcome = toOutcome({ success: true }, process(0), noDiagnostics, sandbox)
    expect(outcome).toMatchObject({ kind: 'value', value: null })
  })

  it('reports a failure without text through a readable fallback message', () => {
    const outcome = toOutcome({ success: false }, process(0), noDiagnostics, sandbox)
    expect(outcome).toMatchObject({
      kind: 'error',
      error: { message: 'the interpreter reported an unsuccessful request without an error message' },
    })
  })

  it('refuses a success envelope written by a process that then exited nonzero', () => {
    const outcome = toOutcome({ success: true, result: 'untrusted' }, process(3), noDiagnostics, sandbox)
    expect(outcome).toMatchObject({
      kind: 'error',
      error: { code: 'E_PROCESS_EXIT', retryable: false },
      process: { exitCode: 3 },
    })
  })
})

describe('command-line evaluation decoding', () => {
  it('reads a canonical JSON value from a successful exit', () => {
    const outcome = decodeEvalOutcome(process(0), { text: '{"a":1}\n', truncated: false }, noDiagnostics, sandbox)
    expect(outcome).toMatchObject({ kind: 'value', value: { a: 1 }, resultType: 'record' })
  })

  it('reports a program that printed nothing as null with resultType none', () => {
    const outcome = decodeEvalOutcome(process(0), { text: '  \n', truncated: false }, noDiagnostics, sandbox)
    expect(outcome).toMatchObject({ kind: 'value', value: null, resultType: 'none' })
  })

  it('keeps a nested `{success:false}` value as a value, never as a tool failure', () => {
    const outcome = decodeEvalOutcome(process(0), { text: '{"success":false}\n', truncated: false }, noDiagnostics, sandbox)
    expect(outcome.kind).toBe('value')
    if (outcome.kind !== 'value') throw new Error('expected a value outcome')
    expect(outcome.value).toEqual({ success: false })
  })

  it('parses the interpreter error form into a code and hint on a non-zero exit', () => {
    const outcome = decodeEvalOutcome(
      process(1),
      { text: '', truncated: false },
      { text: 'error[E_UNKNOWN_BUILTIN]: unknown builtin: nope\n  hint: call ontology_manifest()\n', truncated: false },
      sandbox,
    )
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') throw new Error('expected an error outcome')
    expect(outcome.error.code).toBe('E_UNKNOWN_BUILTIN')
    expect(outcome.error.message).toBe('unknown builtin: nope')
    expect(outcome.error.hint).toBe('call ontology_manifest()')
    expect(outcome.process.exitCode).toBe(1)
  })

  it('falls back to the exit facts when a failing run wrote no diagnostic', () => {
    const outcome = decodeEvalOutcome(process(3), { text: '', truncated: false }, noDiagnostics, sandbox)
    expect(outcome).toMatchObject({ kind: 'error', error: { message: 'the interpreter exited with code 3 without reporting a failure' } })
  })

  it('rejects a successful exit that did not print exactly one JSON value', () => {
    expect(() => decodeEvalOutcome(process(0), { text: 'not json\n', truncated: false }, noDiagnostics, sandbox))
      .toThrowError(/exited successfully but stdout was not one JSON value/)
  })

  it('rejects a rounded integer on the command-line path too', () => {
    expect(() => decodeEvalOutcome(process(0), { text: '9007199254740993\n', truncated: false }, noDiagnostics, sandbox))
      .toThrowError(/E_PROTOCOL_NUMBER/)
  })
})

describe('shared outcome readings', () => {
  it('names JSON kinds the way the interpreter does', () => {
    expect(jsonKindOf(null)).toBe('null')
    expect(jsonKindOf(true)).toBe('boolean')
    expect(jsonKindOf(1)).toBe('number')
    expect(jsonKindOf('s')).toBe('string')
    expect(jsonKindOf([])).toBe('array')
    expect(jsonKindOf({})).toBe('record')
  })

  it('recognizes only non-null non-array objects as records', () => {
    expect(isJsonObject({})).toBe(true)
    expect(isJsonObject([])).toBe(false)
    expect(isJsonObject(null)).toBe(false)
    expect(isJsonObject('x')).toBe(false)
  })

  it('describes the numbers this runtime cannot round-trip', () => {
    expect(numberFidelityProblem(1)).toBeUndefined()
    expect(numberFidelityProblem(-0)).toContain('negative zero')
    expect(numberFidelityProblem(Number.MAX_SAFE_INTEGER + 1)).toContain('outside the exact integer range')
    expect(numberFidelityProblem(Number.POSITIVE_INFINITY)).toContain('non-finite')
  })

  it('renders a recovery pointer only when a spill file exists', () => {
    expect(recovery(undefined)).toBe('')
    expect(recovery('/tmp/spill.log')).toBe('; complete stream: /tmp/spill.log')
  })

  it('keeps metadata that is not a record unchanged', () => {
    expect(stripRequestEcho(undefined)).toBeUndefined()
    expect(stripRequestEcho('kept')).toBe('kept')
  })
})
