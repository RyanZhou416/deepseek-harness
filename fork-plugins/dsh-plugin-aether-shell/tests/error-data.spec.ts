/** Native failure objects remain directly readable in canonical and model-visible results. */
import { describe, expect, it } from 'vitest'
import type { AetherProcessFacts } from '../src/outcome.ts'
import { decodeEnvelope, toOutcome } from '../src/protocol.ts'
import { renderOutcome } from '../src/render.ts'
import { isJsonObject, stripRequestEcho } from '../src/outcome.ts'

const process: AetherProcessFacts = {
  exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1_000, cleanupFailed: false,
}
const diagnostics = { text: '', truncated: false }
const sandbox = { mode: 'danger-full-access', denied: false }
const error = {
  code: 'E_UNBOUND_VARIABLE', message: 'undefined variable: missing',
  expected: '`missing` to be bound', got: 'no binding',
  phase: 'evaluation', side_effects: 'unknown', safe_to_retry: false, retryable: true,
}

describe('direct native error data', () => {
  it('preserves __proto__ metadata as an own field without changing the prototype', () => {
    const metadata = JSON.parse('{"__proto__":{"fact":true},"code_executed":"omit"}')
    const kept = stripRequestEcho(metadata)
    if (!isJsonObject(kept)) throw new Error('Expected retained metadata')
    expect(Object.hasOwn(kept, '__proto__')).toBe(true)
    expect(kept['__proto__']).toEqual({ fact: true })
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype)
    expect(JSON.stringify(kept)).toBe('{"__proto__":{"fact":true}}')
  })

  it('preserves stated phase and effects from a legacy structured error string', () => {
    const outcome = toOutcome(decodeEnvelope(JSON.stringify({ success: false, error: JSON.stringify({ error }) })), process, diagnostics, sandbox)
    expect(JSON.parse(renderOutcome(outcome))).toEqual({ error })
  })
  it('uses the error object without parsing legacy error text', () => {
    const outcome = toOutcome(decodeEnvelope(JSON.stringify({
      success: false, error: 'legacy text', metadata: { error },
    })), process, diagnostics, sandbox)
    expect(outcome).toMatchObject({ kind: 'error', error: { code: error.code, details: error } })
    expect(JSON.parse(renderOutcome(outcome))).toEqual({ error })
  })

  it('does not reinterpret a successful value or its metadata as a failure', () => {
    const outcome = toOutcome(decodeEnvelope(JSON.stringify({
      success: true, result: { error, success: false }, metadata: { error },
    })), process, diagnostics, sandbox)
    expect(outcome.kind).toBe('value')
    expect(JSON.parse(renderOutcome(outcome))).toEqual({ error, success: false })
  })

  it('retains legacy decoding when a failure has no valid direct object', () => {
    const outcome = toOutcome(decodeEnvelope(JSON.stringify({
      success: false, error: JSON.stringify({ error }), metadata: { error: { message: 7 } },
    })), process, diagnostics, sandbox)
    expect(outcome).toMatchObject({ kind: 'error', error: { code: error.code, message: error.message } })
    expect(renderOutcome(outcome)).toContain('E_UNBOUND_VARIABLE')
  })
})
