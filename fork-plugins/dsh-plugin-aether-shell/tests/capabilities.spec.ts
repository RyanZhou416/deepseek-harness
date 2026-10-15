/**
 * The typed-channel capability contract and the preflight that enforces it.
 *
 * `structuredDataMode: 'typed-v1'` is trusted configuration, so the plugin's
 * promise is narrower than "the deployment said so": before any argument data is
 * sent, the plugin asks the interpreter itself and accepts only a reply that
 * satisfies every required field. The pure reply checks below pin that
 * comparison; the tool-level cases pin the property that matters, which is that a
 * wrong or missing reply stops the call before the data reaches the interpreter
 * and never falls back to the converting channel.
 *
 * The fixture's `--fixture-capabilities=<profile>` marker supplies an interpreter
 * of a known generation, so each refusal is exercised end to end rather than
 * asserted against a hand-built outcome.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CAPABILITY_PROTOCOL, REQUIRED_TYPED_FEATURES, parseTypedCapabilities } from '../src/capabilities.ts'
import type { Config } from '../src/config.ts'
import { AETHER_FIXTURE, createHarness, text, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

/** Every feature the typed channel requires, reported exactly true. */
const ALL_FEATURES: Record<string, JsonValue> = {
  explicit_null_pipeline_input_v1: true,
  typed_arguments_v1: true,
  typed_pipeline_input_v1: true,
}

/**
 * One capability reply carrying the named top-level fields.
 * @param fields - the fields to replace; an empty record is the verified reply.
 * @returns the reply a suite feeds to the parser.
 */
function reply(fields: Record<string, JsonValue>): JsonValue {
  return {
    protocol: CAPABILITY_PROTOCOL,
    protocol_version: 1,
    features: { ...ALL_FEATURES },
    ...fields,
  }
}

describe('aether-shell capability reply', () => {
  it('accepts exactly the record the typed channel requires', () => {
    expect(parseTypedCapabilities(reply({}))).toEqual({
      protocol: CAPABILITY_PROTOCOL,
      protocolVersion: 1,
      features: [...REQUIRED_TYPED_FEATURES],
    })
  })

  it('refuses a reply that is not a record, naming what arrived', () => {
    expect(() => parseTypedCapabilities('capabilities unavailable')).toThrowError(/with string, not a record/)
    expect(() => parseTypedCapabilities(null)).toThrowError(/with null, not a record/)
    expect(() => parseTypedCapabilities([1])).toThrowError(/with array, not a record/)
  })

  it('refuses a protocol or version this plugin does not implement', () => {
    expect(() => parseTypedCapabilities(reply({ protocol: 'other-shell' }))).toThrowError(/other-shell/)
    expect(() => parseTypedCapabilities(reply({ protocol_version: 2 }))).toThrowError(/named protocol version 2, not 1/)
    // The same number written as text describes a different contract.
    expect(() => parseTypedCapabilities(reply({ protocol_version: '1' }))).toThrowError(/named protocol version "1", not 1/)
    expect(() => parseTypedCapabilities({ protocol: CAPABILITY_PROTOCOL })).toThrowError(/protocol version nothing/)
  })

  it('refuses a missing, mistyped, or incomplete feature set', () => {
    expect(() => parseTypedCapabilities(reply({ features: 'typed' }))).toThrowError(/carries string in "features", not a record/)
    expect(() => parseTypedCapabilities({ protocol: CAPABILITY_PROTOCOL, protocol_version: 1 })).toThrowError(/no "features" record/)
    for (const missing of REQUIRED_TYPED_FEATURES) {
      const features: Record<string, JsonValue> = { ...ALL_FEATURES }
      delete features[missing]
      expect(() => parseTypedCapabilities(reply({ features }))).toThrowError(new RegExp(missing))
    }
    // Exactly true, so a truthy stand-in is not a capability.
    for (const substitute of ['true', 1, null] as const) {
      expect(() => parseTypedCapabilities(reply({ features: { ...ALL_FEATURES, typed_arguments_v1: substitute } })))
        .toThrowError(/typed_arguments_v1/)
    }
  })

  it('names the required channel and the deliberate alternative in every refusal', () => {
    expect(() => parseTypedCapabilities({})).toThrowError(/structuredDataMode "typed-v1"/)
    expect(() => parseTypedCapabilities({})).toThrowError(/set structuredDataMode to "legacy"/)
  })
})

let harness: Harness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

/** Harness knobs these cases vary; the typed channel and the fixture interpreter are fixed. */
interface SetupOptions {
  /** Deployment file-effect mode the sandbox policy resolves. */
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Denial dialect the recording backend publishes, so a refused exchange is exercisable. */
  denialSignatures?: readonly string[]
  /** Further plugin configuration overrides. */
  config?: Config
}

/**
 * Mount the plugin with the typed channel and one fixture interpreter generation.
 * @param profile - the fixture capability profile to put in front of the plugin.
 * @param options - the file-effect mode, the backend's denial dialect, and plugin configuration.
 * @returns the mounted harness.
 */
async function setup(profile: string, options: SetupOptions = {}): Promise<Harness> {
  harness = await createHarness({
    mode: options.mode ?? 'danger-full-access',
    ...options.denialSignatures === undefined ? {} : { denialSignatures: options.denialSignatures },
    executableArgs: [AETHER_FIXTURE, `--fixture-capabilities=${profile}`],
    config: { structuredDataMode: 'typed-v1', ...options.config },
  })
  return harness
}

describe('aether-shell typed capability preflight', () => {
  it('sends argument data as data once the interpreter reports the channel', async () => {
    const mounted = await setup('v1')
    const result = await mounted.call('aether_call', {
      builtin: 'fixture_echo_request',
      args: ['a${1 + 2}b', { 'bad-key': 1, '': 2 }],
    })
    expect(result.isError).toBe(false)
    // The value is the request the interpreter decoded, so it shows the exact
    // JSON that arrived rather than what the plugin intended to send.
    const echo = valueOf(result)['value'] as { request: { args: unknown[] } }
    expect(echo.request.args).toEqual(['a${1 + 2}b', { 'bad-key': 1, '': 2 }])
  })

  it('runs the preflight under the same policy and argv as the request it gates', async () => {
    const mounted = await setup('v1', { mode: 'workspace-write' })
    expect(valueOf(await mounted.call('aether_call', { builtin: 'pwd' }))['kind']).toBe('value')
    expect(mounted.confineCalls).toHaveLength(2)
    expect(mounted.confineCalls[0]?.policy).toEqual(mounted.confineCalls[1]?.policy)
    expect(mounted.confineCalls[0]?.argv).toEqual(mounted.confineCalls[1]?.argv)
  })

  it('refuses the call when the interpreter does not implement the action', async () => {
    const mounted = await setup('legacy')
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    // A skipped preflight would have returned the working directory, because the
    // profile changes only how this interpreter answers `capabilities`.
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_CAPABILITY')
    expect(text(result)).toContain('E_PROCESS_EXIT')
  })

  it('never converts argument data to source when the preflight fails', async () => {
    const mounted = await setup('legacy')
    const result = await mounted.call('aether_call', {
      builtin: 'fixture_echo_request',
      args: ['a${1 + 2}b'],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_CAPABILITY')
    // A fallback to the converting channel would have either echoed the text back
    // or refused it as source.
    expect(text(result)).not.toContain('E_INPUT_LITERAL')
  })

  it('refuses a reply whose protocol version this plugin does not implement', async () => {
    const mounted = await setup('version')
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_CAPABILITY')
    expect(text(result)).toContain('named protocol version 2, not 1')
  })

  it('refuses a reply short one required feature', async () => {
    const mounted = await setup('partial')
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('typed_pipeline_input_v1')
  })

  it('refuses a reply that is not a capabilities record', async () => {
    const mounted = await setup('notrecord')
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not a record')
  })

  it('returns a refused preflight as the denied outcome with its sandbox facts', async () => {
    // A file-effect refusal is orthogonal to a capability mismatch, so the caller
    // must see the denial the backend reported rather than a capability verdict.
    // The recording backend publishes this dialect; the fixture's own refusal of
    // the unknown action is what its diagnostic stream carries.
    const mounted = await setup('legacy', { mode: 'read-only', denialSignatures: ['unknown action'] })
    const result = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(result.isError).toBe(false)
    const value = valueOf(result)
    expect(value['kind']).toBe('denied')
    expect(value['sandbox']).toMatchObject({ mode: 'read-only', denied: true })
    expect((value['process'] as { exitCode: number }).exitCode).not.toBe(0)
    // The refusal met the preflight, so the argument request was never sent.
    expect(mounted.confineCalls).toHaveLength(1)
  })

  it('reports a spent overall deadline as the interrupted arm, not as a capability verdict', async () => {
    const mounted = await setup('hang')
    const result = await mounted.call('aether_call', { builtin: 'pwd', timeoutMs: 700 })
    expect(result.isError).toBe(false)
    const value = valueOf(result)
    expect(value['kind']).toBe('interrupted')
    expect(value['timedOut']).toBe(true)
    expect(value['process']).toMatchObject({ timedOut: true, aborted: false })
  })

  it("gates the discovery query on the same preflight", async () => {
    const mounted = await setup('legacy')
    const result = await mounted.call('aether_discover', { query: 'len' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_CAPABILITY')
  })

  it('accepts pipeline data the converting channel refuses', async () => {
    const mounted = await setup('v1')
    const result = await mounted.call('aether_pipeline', {
      steps: [{ builtin: 'pwd', select: 'a-b' }],
      input: null,
    })
    expect(result.isError).toBe(false)
    expect(valueOf(result)['kind']).toBe('value')
  })

  it('takes no preflight for a program, which is source on every channel', async () => {
    const mounted = await setup('legacy')
    const value = valueOf(await mounted.call('aether_eval', { code: '1 + 1' }))
    expect(value).toMatchObject({ kind: 'value', value: 2 })
    expect(mounted.confineCalls).toHaveLength(0)
  })
})

describe('aether-shell converting channel', () => {
  it('sends only the request the model asked for', async () => {
    // The profile refuses a `capabilities` request, so returning a value proves
    // the default channel sends nothing else.
    const mounted = await createHarness({ executableArgs: [AETHER_FIXTURE, '--fixture-capabilities=legacy'] })
    harness = mounted
    const value = valueOf(await mounted.call('aether_call', { builtin: 'pwd' }))
    expect(value['kind']).toBe('value')
    expect(mounted.confineCalls).toHaveLength(0)
  })

  it('keeps refusing the shapes its conversion would re-parse', async () => {
    const mounted = await createHarness({ executableArgs: [AETHER_FIXTURE, '--fixture-capabilities=v1'] })
    harness = mounted
    const result = await mounted.call('aether_call', { builtin: 'echo', args: ['a${1 + 2}b'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('E_INPUT_LITERAL')
  })

  it('refuses the pipeline seed and select forms the typed channel accepts', async () => {
    const mounted = await createHarness({ executableArgs: [AETHER_FIXTURE, '--fixture-capabilities=v1'] })
    harness = mounted
    const seed = await mounted.call('aether_pipeline', { steps: [{ builtin: 'pwd' }], input: null })
    expect(seed.isError).toBe(true)
    expect(text(seed)).toContain('E_INPUT_PIPELINE_NULL')
    const select = await mounted.call('aether_pipeline', { steps: [{ builtin: 'pwd', select: 'a-b' }] })
    expect(select.isError).toBe(true)
    expect(text(select)).toContain('E_INPUT_SELECT')
  })
})
