/**
 * Model-facing rendering of one canonical outcome.
 *
 * The renderer is what the model actually reads, so these cases pin the reading
 * aids: the compact canonical value, the interpreter's error text with its code,
 * suggestions, and hint, the sandbox denial marker, the timeout or teardown
 * marker, the nonzero-exit and unclean-cleanup markers, and the bounded
 * diagnostic stream with its spill pointer.
 */

import { describe, expect, it } from 'vitest'
import type { AetherDiscoverOutcome } from '../src/discovery.ts'
import type { AetherDiagnostics, AetherOutcome, AetherProcessFacts, AetherSandboxFacts } from '../src/outcome.ts'
import { renderDiscovery, renderOutcome } from '../src/render.ts'

const facts = (overrides: Partial<AetherProcessFacts> = {}): AetherProcessFacts =>
  ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1_000, cleanupFailed: false, ...overrides })

const sandbox = (overrides: Partial<AetherSandboxFacts> = {}): AetherSandboxFacts =>
  ({ mode: 'danger-full-access', denied: false, ...overrides })

const diagnostics = (overrides: Partial<AetherDiagnostics> = {}): AetherDiagnostics =>
  ({ text: '', truncated: false, ...overrides })

const value = (result: unknown, overrides: Partial<AetherProcessFacts> = {}, stderr = diagnostics()): AetherOutcome =>
  ({ kind: 'value', value: result as never, process: facts(overrides), sandbox: sandbox(), stderr })

describe('value rendering', () => {
  it('renders a string as its own text and everything else as one line of JSON', () => {
    expect(renderOutcome(value('C:\\work'))).toBe('C:\\work')
    expect(renderOutcome(value({ a: 1 }))).toBe('{"a":1}')
    expect(renderOutcome(value([1, 2]))).toBe('[1,2]')
    expect(renderOutcome(value(null))).toBe('null')
  })

  it('renders an empty string value as an explicit no-output notice', () => {
    expect(renderOutcome(value(''))).toBe('(no output)')
  })

  it('adds the nonzero exit marker beside the value', () => {
    expect(renderOutcome(value('ok', { exitCode: 3 }))).toBe('ok\n[exit code: 3]')
  })

  it('reports a managed range that outlived the grace period', () => {
    expect(renderOutcome(value('ok', { cleanupFailed: true })))
      .toBe('ok\n[managed process range did not stop within the grace period]')
  })

  it('renders the diagnostic stream in a marked section', () => {
    expect(renderOutcome(value('ok', {}, diagnostics({ text: 'warning\n' })))).toBe('ok\n[stderr]\nwarning')
  })

  it('names the spill file when the diagnostic stream was truncated', () => {
    expect(renderOutcome(value('ok', {}, diagnostics({ text: 'tail\n', truncated: true, spillPath: 'C:\\spill\\stderr.log' }))))
      .toBe('ok\n[stderr]\ntail\n[stderr truncated; complete stream: C:\\spill\\stderr.log]')
  })

  it('marks a truncated stream without a spill file as unavailable', () => {
    expect(renderOutcome(value('ok', {}, diagnostics({ truncated: true }))))
      .toContain('[stderr truncated; complete stream: (unavailable)]')
  })
})

describe('failure rendering', () => {
  it('renders the code, message, hint, and retry advice the interpreter supplied', () => {
    const outcome: AetherOutcome = {
      kind: 'error',
      error: { message: 'unknown builtin: nope', code: 'E_UNKNOWN_BUILTIN', hint: 'list the categories', retryable: true },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    }
    expect(renderOutcome(outcome)).toBe('aether error (E_UNKNOWN_BUILTIN): unknown builtin: nope\nhint: list the categories\nretryable: true')
  })

  it('renders a failure without a code or hint compactly', () => {
    expect(renderOutcome({ kind: 'error', error: { message: 'boom' }, process: facts(), sandbox: sandbox(), stderr: diagnostics() }))
      .toBe('aether error: boom')
  })

  it('renders interpreter suggestions the hint does not already name', () => {
    const outcome: AetherOutcome = {
      kind: 'error',
      error: { message: 'unknown builtin: pwd2', code: 'E_UNKNOWN_BUILTIN', didYouMean: ['pwd', 'cat'] },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    }
    expect(renderOutcome(outcome)).toBe('aether error (E_UNKNOWN_BUILTIN): unknown builtin: pwd2\ndid you mean: pwd, cat')
  })

  it('does not repeat suggestions the hint already carries', () => {
    const outcome: AetherOutcome = {
      kind: 'error',
      error: { message: 'unknown builtin: pwd2', didYouMean: ['pwd'], hint: 'did you mean pwd?' },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    }
    expect(renderOutcome(outcome)).toBe('aether error: unknown builtin: pwd2\nhint: did you mean pwd?')
  })

  it('keeps the exit marker and stderr beside the failure text', () => {
    expect(renderOutcome({
      kind: 'error',
      error: { message: 'boom' },
      process: facts({ exitCode: 2 }),
      sandbox: sandbox(),
      stderr: diagnostics({ text: 'native noise\n' }),
    })).toBe('aether error: boom\n[exit code: 2]\n[stderr]\nnative noise')
  })
})

describe('denial and interruption rendering', () => {
  it('renders the sandbox denial marker in the shell tools dialect', () => {
    expect(renderOutcome({
      kind: 'denied',
      sandbox: sandbox({ mode: 'read-only', enforcement: 'full', denied: true }),
      process: facts({ exitCode: 5 }),
      stderr: diagnostics(),
    })).toBe('[sandbox: file access denied under read-only mode]\n[exit code: 5]')
  })

  it('names a deadline without claiming the interpreter reported anything', () => {
    expect(renderOutcome({
      kind: 'interrupted',
      timedOut: true,
      aborted: false,
      sandbox: sandbox(),
      process: facts({ timedOut: true, exitCode: null, timeoutMs: 250 }),
      stderr: diagnostics(),
    })).toBe('[timed out before the interpreter reported a result]')
  })

  it('names plugin unload when teardown stopped the interpreter', () => {
    expect(renderOutcome({
      kind: 'interrupted',
      timedOut: false,
      aborted: true,
      sandbox: sandbox(),
      process: facts({ aborted: true, exitCode: null }),
      stderr: diagnostics({ text: 'partial\n' }),
    })).toBe('[stopped: the plugin unloaded]\n[stderr]\npartial')
  })
})

describe('discovery rendering', () => {
  it('renders an unknown-name reply as ontology text with its hint', () => {
    const outcome: AetherDiscoverOutcome = {
      kind: 'value',
      value: { error: "'zzz' is not a known category or builtin", hint: 'call ontology_manifest() to see categories' },
      discovery: { shape: 'unknown', query: 'zzz', truncated: false },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    }
    expect(renderDiscovery(outcome)).toBe("aether ontology: 'zzz' is not a known category or builtin\nhint: call ontology_manifest() to see categories")
  })

  it('renders a page that left entries behind with its continuation offset', () => {
    const outcome: AetherDiscoverOutcome = {
      kind: 'value',
      value: { categories: [{ category: 'Core' }], ontology: 'manifest' },
      discovery: { shape: 'manifest', offset: 0, shown: 1, total: 5, nextOffset: 1, truncated: true },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    }
    expect(renderDiscovery(outcome)).toBe('{"categories":[{"category":"Core"}],"ontology":"manifest"}\n[showing 1 of 5; continue with offset 1]')
  })

  it('names the example cap when a builtin page merely dropped examples', () => {
    const outcome: AetherDiscoverOutcome = {
      kind: 'value',
      value: { builtin: 'pwd' },
      discovery: { shape: 'builtin', query: 'pwd', truncated: true },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    }
    expect(renderDiscovery(outcome)).toBe('{"builtin":"pwd"}\n[examples truncated to the page size]')
  })

  it('renders a failure, a denial, and an interruption through the shared text', () => {
    expect(renderDiscovery({
      kind: 'error',
      error: { message: 'boom', code: 'E_X' },
      process: facts(),
      sandbox: sandbox(),
      stderr: diagnostics(),
    })).toBe('aether error (E_X): boom')
    expect(renderDiscovery({
      kind: 'denied',
      sandbox: sandbox({ mode: 'workspace-write', denied: true }),
      process: facts(),
      stderr: diagnostics(),
    })).toBe('[sandbox: file access denied under workspace-write mode]')
    expect(renderDiscovery({
      kind: 'interrupted',
      timedOut: false,
      aborted: true,
      sandbox: sandbox(),
      process: facts({ aborted: true }),
      stderr: diagnostics(),
    })).toBe('[stopped: the plugin unloaded]')
  })
})
