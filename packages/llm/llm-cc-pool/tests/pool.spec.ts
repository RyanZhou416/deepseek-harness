/** The mac-pool provider facts and catalogue resolved through the generic pi-ai resolver. */

import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { createSystemMessage } from '@deepseek-ai/dsh-llm'
import {
  POOL_CAPACITY_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_REQUEST_CLOSED_CODE,
  POOL_SESSION_BUSY_CODE,
} from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { CAPABILITIES_URL } from '../src/discovery.ts'
import * as CcPool from '../src/index.ts'
import type { CcPoolCachePolicy, CcPoolCacheTtl, CcPoolModel, CcPoolReasoningLevel } from '../src/pool.ts'
import {
  API_KEY_REF,
  BASE_URL,
  CACHE_TTLS,
  DEFAULT_CACHE_POLICY,
  DISPLAY_NAME,
  MODELS,
  PROVIDER,
  REASONING_EFFORTS,
  REQUEST_HEADERS,
  poolProviderProfile,
  resolvePoolCachePolicy,
  resolvePoolModels,
  resolvePoolProfiles,
} from '../src/pool.ts'
import { anthropicSuccessResponse, assemble, capturePoolFetch, user } from './harness.ts'
import type { CapturedRequest, PoolFetchCapture } from './harness.ts'

/**
 * One policy without the three-marker opt-in, for the transport placement cases.
 * @param cacheTtl - the marker lifetime.
 * @param overrides - the other policy fields.
 * @returns the policy a profile is built from.
 */
function legacyPolicy(cacheTtl: CcPoolCacheTtl, overrides: Partial<CcPoolCachePolicy> = {}): CcPoolCachePolicy {
  return { cacheTtl, extendedCacheBeta: false, ...overrides }
}

/** One deliberately different deployment catalogue: capacities and defaults the built-in four do not share. */
const CONFIGURED: CcPoolModel[] = [
  { id: 'claude-haiku-5', name: 'Claude Haiku 5', contextWindow: 200_000, maxTokens: 32_000, defaultReasoning: 'low' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (pool)', contextWindow: 1_000_000, maxTokens: 128_000, defaultReasoning: 'max' },
]

/** The proof the member endpoint answers for this deployment's endpoint and build. */
const POOL_PROOF = { endpoint: CAPABILITIES_URL, buildId: 'test-build' } as const

describe('fixed mac-pool route', () => {
  it('resolves one fixed Anthropic Messages route with the deployment facts', () => {
    const profiles = resolvePoolProfiles()
    expect([...profiles.keys()]).toEqual([PROVIDER])
    const profile = profiles.get(PROVIDER)
    expect(profile).toMatchObject({
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      api: 'anthropic-messages',
      baseURL: BASE_URL,
      headers: REQUEST_HEADERS,
    })
    expect(profile?.apiKeyEnv).toBe(API_KEY_REF)
    expect(profile?.modelErrors.size).toBe(0)
    expect(profile?.catalogError).toBeUndefined()
  })

  it('captures the fixed retry policy with the retryable codes used exactly as written', () => {
    const policy = resolvePoolProfiles().get(PROVIDER)?.retryPolicy
    expect(policy).toMatchObject({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'SERVER', POOL_REQUEST_CLOSED_CODE],
    })
    if (policy?.mode !== 'normal') throw new Error('expected normal policy')
    // A TIMEOUT can follow an attempt that already reached the pool, and the
    // pool's own capacity/rate-limit refusals stay with the caller instead of
    // becoming an automatic resend. A closed request id is retryable because the
    // loop stamps a fresh id on the next attempt.
    expect(policy.retryableCodes).not.toContain('TIMEOUT')
    expect(policy.retryableCodes).not.toContain(POOL_CAPACITY_CODE)
    expect(policy.retryableCodes).not.toContain(POOL_RATE_LIMITED_CODE)
    expect(policy.retryableCodes).not.toContain(POOL_SESSION_BUSY_CODE)
  })

  it('materialises the four-model catalogue with capacities and per-model default efforts', () => {
    const profile = resolvePoolProfiles().get(PROVIDER)
    expect([...profile?.configuredMaxTokens ?? []]).toEqual([
      ['claude-sonnet-5-5', 128_000],
      ['claude-opus-5-5', 128_000],
      ['claude-fable-5-1', 64_000],
      ['claude-mythos-5-1', 64_000],
    ])
    expect([...profile?.defaultReasoning ?? []]).toEqual([
      ['claude-sonnet-5-5', 'medium'],
      ['claude-opus-5-5', 'medium'],
      ['claude-fable-5-1', 'high'],
      ['claude-mythos-5-1', 'high'],
    ])

    const models = profile?.piProvider?.getModels() ?? []
    expect(models.map(model => model.id)).toEqual(MODELS.map(model => model.id))
    expect(models.map(model => model.name)).toEqual(MODELS.map(model => model.name))
    expect(models.map(model => model.maxTokens)).toEqual([128_000, 128_000, 64_000, 64_000])
    for (const model of models) {
      expect(model).toMatchObject({
        provider: PROVIDER,
        api: 'anthropic-messages',
        baseUrl: BASE_URL,
        contextWindow: 1_000_000,
        input: ['text', 'image'],
        reasoning: true,
        compat: { forceAdaptiveThinking: true },
      })
      expect(model.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      })
    }
  })

  it('offers the five pool efforts and never off, minimal, speed, or a context-management switch', () => {
    expect(REASONING_EFFORTS).toEqual({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
    const wire = JSON.stringify(poolProviderProfile())
    expect(wire).not.toContain('"off"')
    expect(wire).not.toContain('"minimal"')
    expect(wire).not.toContain('"speed"')
    expect(wire).not.toContain('context_management')
  })
})

describe('configured model catalogue', () => {
  it('serves the built-in four-model catalogue when no override is configured', () => {
    expect(resolvePoolModels()).toBe(MODELS)
    expect(resolvePoolModels(undefined)).toBe(MODELS)
    // The schema default is the read surface a settings page renders, so an
    // untouched profile must report the built-in catalogue as its live value.
    expect(Config({}).models.get()).toEqual(MODELS.map(model => ({ ...model })))
  })

  it('replaces the catalogue wholesale and carries each entry default effort', () => {
    const models = resolvePoolModels(CONFIGURED)
    expect(models.map(model => model.id)).toEqual(['claude-haiku-5', 'claude-opus-5-5'])
    expect(models[1]).toEqual(CONFIGURED[1])
    expect(Object.isFrozen(models)).toBe(true)
    expect(models.every(model => Object.isFrozen(model))).toBe(true)

    const profile = resolvePoolProfiles(models).get(PROVIDER)
    expect([...profile?.configuredMaxTokens ?? []]).toEqual([
      ['claude-haiku-5', 32_000],
      ['claude-opus-5-5', 128_000],
    ])
    expect([...profile?.defaultReasoning ?? []]).toEqual([
      ['claude-haiku-5', 'low'],
      ['claude-opus-5-5', 'max'],
    ])
    const built = profile?.piProvider?.getModels() ?? []
    expect(built.map(model => [model.id, model.name, model.contextWindow, model.maxTokens])).toEqual([
      ['claude-haiku-5', 'Claude Haiku 5', 200_000, 32_000],
      ['claude-opus-5-5', 'Claude Opus 5.5 (pool)', 1_000_000, 128_000],
    ])
    for (const model of built) {
      expect(model).toMatchObject({
        provider: PROVIDER,
        api: 'anthropic-messages',
        baseUrl: BASE_URL,
        input: ['text', 'image'],
        compat: { forceAdaptiveThinking: true },
      })
      expect(model.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      })
    }
  })

  it('refuses a catalogue the route cannot serve, naming the entry', () => {
    const base: CcPoolModel = { id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 100, defaultReasoning: 'low' }
    expect(() => resolvePoolModels([])).toThrow(/at least one model/)
    expect(() => resolvePoolModels([{ ...base, id: '' }])).toThrow(/models\[0\] has an empty id/)
    expect(() => resolvePoolModels([base, { ...base }])).toThrow(/"model" more than once/)
    expect(() => resolvePoolModels([{ ...base, name: '' }])).toThrow(/"model" has an empty name/)
    expect(() => resolvePoolModels([{ ...base, contextWindow: 0 }])).toThrow(/contextWindow must be a positive integer/)
    expect(() => resolvePoolModels([{ ...base, contextWindow: 1.5 }])).toThrow(/contextWindow must be a positive integer/)
    expect(() => resolvePoolModels([{ ...base, maxTokens: -1 }])).toThrow(/maxTokens must be a positive integer/)
    expect(() => resolvePoolModels([{ ...base, maxTokens: 2 ** 53 }])).toThrow(/maxTokens must be a positive integer/)
    expect(() => resolvePoolModels([{ ...base, defaultReasoning: 'off' as CcPoolReasoningLevel }]))
      .toThrow(/defaultReasoning must be one of low, medium, high, xhigh, max/)
    expect(() => resolvePoolModels([{ ...base, defaultReasoning: 'speed' as CcPoolReasoningLevel }]))
      .toThrow(/off, minimal, and speed are not pool levels/)
  })

  it('refuses off, minimal, and speed in the config schema before the resolver runs', () => {
    for (const level of ['off', 'minimal', 'speed']) {
      expect(() => Config({
        models: [{ id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 100, defaultReasoning: level }],
      } as never)).toThrow(/defaultReasoning/)
    }
    // Every field is part of the contract: an entry cannot omit its default effort.
    expect(() => Config({
      models: [{ id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 100 }],
    } as never)).toThrow(/defaultReasoning/)
  })
})

describe('prompt-cache policy', () => {
  it('offers the three lifetimes and maps each to its pi-ai retention tier', () => {
    expect(CACHE_TTLS).toEqual(['5m', '1h', 'none'])
    expect(Object.isFrozen(CACHE_TTLS)).toBe(true)
    expect(poolProviderProfile(MODELS, legacyPolicy('5m')).cacheRetention).toBe('short')
    expect(poolProviderProfile(MODELS, legacyPolicy('1h', { extendedCacheBeta: true })).cacheRetention).toBe('long')
    expect(poolProviderProfile(MODELS, legacyPolicy('none')).cacheRetention).toBe('none')
    // The default states the three-marker, one-hour policy the route serves.
    expect(DEFAULT_CACHE_POLICY).toEqual({
      cacheTtl: '1h',
      extendedCacheBeta: true,
      cacheMarkerPolicy: 'cc3',
    })
    expect(poolProviderProfile()).toMatchObject({
      cacheRetention: 'long',
      extendedCacheBeta: true,
      cacheMarkerPolicy: 'cc3',
    })
    // Marker placement belongs to the policy, so the route declares no tool
    // cache-control compat switch of its own.
    expect(poolProviderProfile().compat).toBeUndefined()
    expect(resolvePoolProfiles(MODELS).get(PROVIDER)?.cacheRetention).toBe('long')
  })

  it('carries the beta on a pool profile without a marker policy', () => {
    const profile = poolProviderProfile(MODELS, legacyPolicy('1h', { extendedCacheBeta: true }))
    expect(profile).toMatchObject({
      cacheRetention: 'long',
      extendedCacheBeta: true,
    })
    expect(profile.cacheMarkerPolicy).toBeUndefined()
    expect(profile.compat).toBeUndefined()
  })

  it('declares the policy on the one pool profile and on no model', () => {
    const profiles = resolvePoolProfiles(MODELS)
    expect([...profiles.keys()]).toEqual([PROVIDER])
    expect(profiles.get(PROVIDER)?.cacheMarkerPolicy).toBe('cc3')
    // The TTL, beta, and marker policy ride on the profile, which the adapter
    // passes to pi-ai; a model descriptor carries none of them.
    for (const model of profiles.get(PROVIDER)?.piProvider?.getModels() ?? []) {
      expect(JSON.stringify(model)).not.toContain('ttl')
      expect(JSON.stringify(model)).not.toContain('extended-cache-ttl')
      expect(JSON.stringify(model)).not.toContain('cacheMarkerPolicy')
    }
  })

  it('defaults the config fields to the three-marker one-hour policy', () => {
    expect(Config({})).toMatchObject({
      cacheTtl: '1h',
      extendedCacheBeta: true,
      cacheMarkerPolicy: 'cc3',
    })
    // The loader offers only the lifetimes its default policy can serve: `cc3`
    // writes one-hour markers for a main or subagent request, so `5m` is not a
    // loader choice. The programmatic set stays three-valued for a profile that
    // omits the marker policy.
    expect(Config({ cacheTtl: 'none' }).cacheTtl).toBe('none')
    expect(() => Config({ cacheTtl: '5m' } as never)).toThrow(/cacheTtl/)
    expect(() => Config({ cacheTtl: '24h' } as never)).toThrow(/cacheTtl/)
    expect(() => Config({ cacheTtl: '5min' } as never)).toThrow(/cacheTtl/)
  })

  it('refuses a policy whose lifetime or beta cannot serve a request', () => {
    const explicit: CcPoolCachePolicy = { cacheTtl: '1h', extendedCacheBeta: true }
    expect(() => resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: '5m' }))
      .toThrow(/cacheMarkerPolicy "cc3" requires cacheTtl "1h"/)
    expect(() => resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', extendedCacheBeta: false }))
      .toThrow(/cacheMarkerPolicy "cc3" requires extendedCacheBeta: true/)
    expect(() => resolvePoolCachePolicy({ ...explicit, extendedCacheBeta: false }))
      .toThrow(/cacheTtl "1h" requires extendedCacheBeta: true/)
    // Valid combinations: the default three-marker policy, a non-policy layout,
    // and the caching-disabled lifetime, where the marker policy is not applicable.
    expect(resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3' }))
      .toMatchObject({ cacheMarkerPolicy: 'cc3' })
    expect(resolvePoolCachePolicy(legacyPolicy('5m'))).toMatchObject({ cacheTtl: '5m' })
    expect(resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: 'none' }))
      .toMatchObject({ cacheTtl: 'none', extendedCacheBeta: false })
    expect(resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: 'none' }))
      .not.toHaveProperty('cacheMarkerPolicy')
    expect(resolvePoolCachePolicy(legacyPolicy('none'))).toMatchObject({ cacheTtl: 'none' })
    // Profile and profile-set resolution reject the same combination.
    expect(() => poolProviderProfile(MODELS, { ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: '5m' }))
      .toThrow(/requires cacheTtl "1h"/)
    expect(() => resolvePoolProfiles(MODELS, { ...explicit, cacheMarkerPolicy: 'cc3', extendedCacheBeta: false }))
      .toThrow(/requires extendedCacheBeta: true/)
  })

  it('declares the parity A cache intent the policy disables or keeps', () => {
    // A writes no marker of its own, so its profile accepts every policy the
    // route's own rules admit; only the declared intent follows the policy.
    expect(poolProviderProfile(MODELS, legacyPolicy('none'), POOL_PROOF)).toMatchObject({
      ccWireParity: true,
      ccWireParityCache: 'off',
    })
    expect(poolProviderProfile(MODELS, legacyPolicy('5m'), POOL_PROOF)).toMatchObject({
      ccWireParity: true,
      ccWireParityCache: 'main',
    })
    expect(poolProviderProfile(MODELS, DEFAULT_CACHE_POLICY, POOL_PROOF)).toMatchObject({
      ccWireParity: true,
      ccWireParityCache: 'main',
    })
    // The resolved profile carries the same mapping, so the plugin's raw profile
    // and the one the adapter reads agree on the intent.
    expect(resolvePoolProfiles(MODELS, legacyPolicy('none'), POOL_PROOF).get(PROVIDER)?.ccWireParityCache).toBe('off')
    // A route that does not ask for A declares no intent at all.
    expect(poolProviderProfile(MODELS, legacyPolicy('none')).ccWireParityCache).toBeUndefined()
  })

  it('refuses a capability proof that does not cover the pool origin', () => {
    // The proof is the gate, not a boolean: evidence for another endpoint never
    // enables this route's body.
    expect(() => resolvePoolProfiles(MODELS, DEFAULT_CACHE_POLICY, {
      endpoint: 'https://other.test/v1/capabilities',
      buildId: 'test-build',
    })).toThrow(/does not cover baseURL/)
  })
})

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** The pinned identity line wire parity emits first, byte-exact. */
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** Stable and session-specific prompt text a main-class request splits at its boundary. */
const WIRE_PARITY_SECTIONS = [
  { name: 'app:instructions', text: 'Stable route instructions.', stable: true },
  { name: 'session:state', text: 'Current session state.', stable: false },
]

/**
 * The real harness-owned sections a request carries beside its boundary: the
 * identity line the parity body replaces, the two process-describing sections it
 * never forwards, a caller block holding the pinned identity text, and the
 * static/dynamic pair the body splits at.
 */
const HARNESS_SECTIONS = [
  { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.', stable: true },
  { name: 'harness:source', text: 'The runtime context names the DeepSeek Harness implementation checkout.', stable: true },
  { name: 'app:web-surface', text: 'You are interacting with the user through the DeepSeek Harness Web GUI.', stable: true },
  { name: 'app:instructions', text: 'Stable route instructions.', stable: true },
  { name: 'caller:identity', text: IDENTITY, stable: true },
  { name: 'session:state', text: 'Current session state.', stable: false },
]

/** A main-class request that states the boundary the wire parity body requires. */
const WIRE_PARITY_PROBE = {
  model: 'claude-sonnet-5-5',
  system: WIRE_PARITY_SECTIONS.map(section => section.text).join('\n\n'),
  systemSections: WIRE_PARITY_SECTIONS,
  messages: [user('hello')],
  requestClass: 'main' as const,
}

/**
 * A capability reply in the pool's exact `{protocol, ccWireParity, buildId}`
 * form.
 * @param buildId - the pool build identity to report; `undefined` omits it.
 * @returns the HTTP reply the capability probe parses.
 */
function capabilityReply(buildId?: string): Response {
  return new Response(JSON.stringify({ protocol: 2, ccWireParity: 1, buildId }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The pool's marked refusal of a wire parity request: a `503` carrying the
 * `x-cc-wire-parity-unavailable` marker and its error envelope.
 * @returns the marked refusal response.
 */
function wireParityRefusal(): Response {
  return new Response(JSON.stringify({
    type: 'error',
    error: {
      type: 'cc_wire_parity_unavailable',
      message: 'the selected worker does not advertise ccWireParity',
    },
  }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'x-cc-wire-parity-unavailable': '1' },
  })
}

/**
 * A `503` carrying no wire parity marker, as an upstream or proxy failure would.
 * @returns the bare failure response.
 */
function bareServerError(): Response {
  return new Response('upstream failed', { status: 503 })
}

/** The capability probe requests one capture observed. */
function capabilityCalls(capture: PoolFetchCapture): CapturedRequest[] {
  return capture.calls.filter(call => call.url === CAPABILITIES_URL)
}

/** The model requests one capture observed, in dispatch order. */
function modelCalls(capture: PoolFetchCapture): CapturedRequest[] {
  return capture.calls.filter(call => call.url !== CAPABILITIES_URL)
}

/** Whether one captured request declares the wire parity member headers. */
function declaresWireParity(request: CapturedRequest): boolean {
  return request.headers.has('x-cc-request-class')
}

/**
 * Assert one request was served the route's ordinary cc3 wire, not a partial
 * wire-parity body: no member header and exactly the three one-hour markers
 * plus the extended cache beta.
 * @param request - one captured model request the proof did not cover.
 */
function expectCc3Wire(request: CapturedRequest): void {
  expect(request.headers.has('x-cc-request-class')).toBe(false)
  expect(request.headers.has('x-cc-system-layout')).toBe(false)
  expect(request.headers.has('x-cc-cache-intent')).toBe(false)
  const body = JSON.stringify(request.body)
  expect(body.match(/"cache_control"/gu)).toHaveLength(3)
  expect(body).toContain('"ttl":"1h"')
  expect((request.headers.get('anthropic-beta') ?? '').split(',')).toContain('extended-cache-ttl-2025-04-11')
}

/**
 * Mount the real LLM service and the plugin with the fetch stand-in installed
 * before mount, so the load probe is the one under test answers.
 * @param respond - the response for one recorded request, routed by URL.
 * @param config - extra loader configuration layered over the wire-parity mount.
 * @returns the isolated context and the recorded requests.
 */
async function mountProbed(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
  config: Record<string, unknown> = {},
): Promise<{ ctx: Context; capture: PoolFetchCapture }> {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const capture = capturePoolFetch(respond)
  vi.stubGlobal('fetch', capture.fetch)
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CcPool, { requestLog: { enabled: false }, ccWireParity: true, ...config })
  return { ctx, capture }
}

/**
 * Wait until the route declares the wire parity member headers.
 *
 * The load probe is a fire-and-forget request, so its proof lands at an
 * unspecified microtask after mount. Sending the probe until one request
 * declares the wire waits for the proof through the route's own answer instead
 * of a timer; every attempt is a normal request the capture records.
 * @param ctx - the mounted context.
 * @param capture - the requests the probe and the attempts were recorded into.
 */
async function awaitWireParity(ctx: Context, capture: PoolFetchCapture): Promise<void> {
  await vi.waitFor(async () => {
    await assemble(ctx, WIRE_PARITY_PROBE)
    expect(declaresWireParity(modelCalls(capture).at(-1) as CapturedRequest)).toBe(true)
  }, { timeout: 5_000 })
}

describe('CC wire parity capability proof', () => {
  it('drops the harness-describing sections and emits one pinned identity line', async () => {
    const { ctx, capture } = await mountProbed(request => request.url === CAPABILITIES_URL
      ? capabilityReply('pool-build-1')
      : anthropicSuccessResponse())
    await awaitWireParity(ctx, capture)

    await assemble(ctx, {
      ...WIRE_PARITY_PROBE,
      system: HARNESS_SECTIONS.map(section => section.text).join('\n\n'),
      systemSections: HARNESS_SECTIONS,
    })

    const call = modelCalls(capture).at(-1) as CapturedRequest
    expect(call?.headers.get('x-cc-system-layout')).toBe('boundary:1')
    // The harness identity section is replaced by the pinned line, the two
    // process-describing sections are dropped, and a caller block equal to the
    // pinned line is removed rather than repeated.
    expect(call?.body['system']).toEqual([
      { type: 'text', text: IDENTITY },
      { type: 'text', text: 'Stable route instructions.' },
      { type: 'text', text: 'Current session state.' },
    ])
    const wire = JSON.stringify(call?.body)
    expect(wire).not.toContain('You are an AI agent powered by DeepSeek Harness.')
    expect(wire).not.toContain('The runtime context names the DeepSeek Harness implementation checkout.')
    expect(wire).not.toContain('You are interacting with the user through the DeepSeek Harness Web GUI.')
    expect(wire.match(/You are Claude Code, Anthropic's official CLI for Claude\./gu)).toHaveLength(1)
  })

  it('declares cache intent off and sends the parity body for the caching-disabled lifetime', async () => {
    const { ctx, capture } = await mountProbed(request => request.url === CAPABILITIES_URL
      ? capabilityReply('pool-build-1')
      : anthropicSuccessResponse(), { cacheTtl: 'none' })
    await awaitWireParity(ctx, capture)

    const call = modelCalls(capture).at(-1) as CapturedRequest
    expect(call?.headers.get('x-cc-request-class')).toBe('main')
    expect(call?.headers.get('x-cc-system-layout')).toBe('boundary:1')
    expect(call?.headers.get('x-cc-cache-intent')).toBe('off')
    // `off` withholds the worker's cache plan, not the member body: the same
    // pinned identity and boundary go out with no marker, no TTL, and no beta.
    expect(call?.body['system']).toEqual([
      { type: 'text', text: IDENTITY },
      { type: 'text', text: 'Stable route instructions.' },
      { type: 'text', text: 'Current session state.' },
    ])
    expect(JSON.stringify(call?.body)).not.toContain('cache_control')
    expect(call?.headers.get('anthropic-beta')).toBeNull()
    expect(call?.body['metadata']).toEqual({})
  })

  it('ignores a superseded probe answer that arrives after the newer probe settled', async () => {
    const lateAnswer = Promise.withResolvers<Response>()
    let probes = 0
    const { ctx, capture } = await mountProbed((request) => {
      if (request.url !== CAPABILITIES_URL) return anthropicSuccessResponse()
      probes += 1
      return probes === 1 ? lateAnswer.promise : capabilityReply(undefined)
    })
    await vi.waitFor(() => { expect(capabilityCalls(capture)).toHaveLength(1) })

    // A replaced credential starts a newer probe, which proves nothing; the
    // superseded probe answers later and must not bind the proof it names.
    ctx.emit('credentials/reference-updated', credentialRef(API_KEY_REF))
    await vi.waitFor(() => { expect(capabilityCalls(capture)).toHaveLength(2) })
    lateAnswer.resolve(capabilityReply('late-build'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    await assemble(ctx, WIRE_PARITY_PROBE)
    const after = modelCalls(capture).at(-1) as CapturedRequest
    expect(declaresWireParity(after)).toBe(false)
    expect(JSON.stringify(after.body).match(/"cache_control"/gu)).toHaveLength(3)
    expect(capabilityCalls(capture)).toHaveLength(2)
  })

  it('ignores a probe answer that arrives after the route was disposed', async () => {
    const lateAnswer = Promise.withResolvers<Response>()
    const { ctx, capture } = await mountProbed(request => request.url === CAPABILITIES_URL
      ? lateAnswer.promise
      : anthropicSuccessResponse())
    await vi.waitFor(() => { expect(capabilityCalls(capture)).toHaveLength(1) })

    await ctx.fiber.dispose()
    context = undefined
    lateAnswer.resolve(capabilityReply('late-build'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // Disposal aborted the probe generation: its late answer neither sends a
    // request nor re-registers a route for the proof it names.
    expect(capabilityCalls(capture)).toHaveLength(1)
    expect(modelCalls(capture)).toHaveLength(0)
  })

  it('leaves the proof in place when another credential reference changes', async () => {
    const { ctx, capture } = await mountProbed(request => request.url === CAPABILITIES_URL
      ? capabilityReply('pool-build-1')
      : anthropicSuccessResponse())
    await awaitWireParity(ctx, capture)
    const probes = capabilityCalls(capture).length

    ctx.emit('credentials/reference-updated', credentialRef('OTHER_API_KEY'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(capabilityCalls(capture)).toHaveLength(probes)
    await assemble(ctx, WIRE_PARITY_PROBE)
    expect(declaresWireParity(modelCalls(capture).at(-1) as CapturedRequest)).toBe(true)
  })

  it('serves the wire parity member headers after the endpoint proves a build', async () => {
    const { ctx, capture } = await mountProbed(request => request.url === CAPABILITIES_URL
      ? capabilityReply('pool-build-1')
      : anthropicSuccessResponse())
    await awaitWireParity(ctx, capture)

    const call = modelCalls(capture).at(-1) as CapturedRequest
    expect(call).toBeDefined()
    expect(call?.headers.get('x-cc-request-class')).toBe('main')
    expect(call?.headers.get('x-cc-system-layout')).toBe('boundary:1')
    expect(call?.headers.get('x-cc-cache-intent')).toBe('main')
    // One load probe; a request never asks the endpoint again.
    expect(capabilityCalls(capture)).toHaveLength(1)
  })

  it('serves a proved route the cc3 wire when the request states no coverable boundary', async () => {
    const { ctx, capture } = await mountProbed(request => request.url === CAPABILITIES_URL
      ? capabilityReply('pool-build-1')
      : anthropicSuccessResponse())
    await awaitWireParity(ctx, capture)

    const { requestClass: _requestClass, ...classless } = WIRE_PARITY_PROBE
    const { systemSections: _sections, ...noSections } = WIRE_PARITY_PROBE
    const stableOnly = WIRE_PARITY_SECTIONS.slice(0, 1)
    await assemble(ctx, classless)
    await assemble(ctx, noSections)
    await assemble(ctx, {
      ...WIRE_PARITY_PROBE,
      systemSections: stableOnly,
      system: stableOnly[0]?.text ?? '',
    })
    await assemble(ctx, {
      ...WIRE_PARITY_PROBE,
      messages: [
        createSystemMessage('A prompt committed in history.'),
        ...WIRE_PARITY_PROBE.messages,
      ],
    })

    const fallbacks = modelCalls(capture).slice(-4)
    expect(fallbacks).toHaveLength(4)
    for (const fallback of fallbacks) expectCc3Wire(fallback)
    // The proof is still valid: only these requests could not state the wire.
    expect(capabilityCalls(capture)).toHaveLength(1)
  })

  it('drops the proof when the pool marks a 503 as wire parity unavailable', async () => {
    let refuse = false
    const { ctx, capture } = await mountProbed((request) => {
      if (request.url === CAPABILITIES_URL) return capabilityReply('pool-build-1')
      return refuse ? wireParityRefusal() : anthropicSuccessResponse()
    })
    await awaitWireParity(ctx, capture)

    // The A-on request the pool refuses with its marked 503.
    refuse = true
    await assemble(ctx, WIRE_PARITY_PROBE)
    expect(declaresWireParity(modelCalls(capture).at(-1) as CapturedRequest)).toBe(true)

    // The next request is back on the three-marker wire without asking the
    // endpoint again: the marked refusal is evidence against the proof, not a
    // trigger for another probe.
    refuse = false
    await assemble(ctx, WIRE_PARITY_PROBE)
    const after = modelCalls(capture).at(-1) as CapturedRequest
    expect(declaresWireParity(after)).toBe(false)
    const body = JSON.stringify(after.body)
    expect(body.match(/"cache_control"/gu)).toHaveLength(3)
    expect(body).toContain('"ttl":"1h"')
    expect(capabilityCalls(capture)).toHaveLength(1)
  })

  it('keeps the proof on a 503 that carries no wire parity marker', async () => {
    let fail = false
    const { ctx, capture } = await mountProbed((request) => {
      if (request.url === CAPABILITIES_URL) return capabilityReply('pool-build-1')
      return fail ? bareServerError() : anthropicSuccessResponse()
    })
    await awaitWireParity(ctx, capture)

    // A bare 503 is some other failure; it leaves the proof and the next request
    // on the wire parity form.
    fail = true
    await assemble(ctx, WIRE_PARITY_PROBE)
    expect(declaresWireParity(modelCalls(capture).at(-1) as CapturedRequest)).toBe(true)
    fail = false
    await assemble(ctx, WIRE_PARITY_PROBE)
    expect(declaresWireParity(modelCalls(capture).at(-1) as CapturedRequest)).toBe(true)
    expect(capabilityCalls(capture)).toHaveLength(1)
  })

  it('replaces the proof and keeps the wire when a later probe answers a different build', async () => {
    let probes = 0
    const { ctx, capture } = await mountProbed((request) => {
      if (request.url !== CAPABILITIES_URL) return anthropicSuccessResponse()
      probes += 1
      return capabilityReply(probes === 1 ? 'pool-build-1' : 'pool-build-2')
    })
    await awaitWireParity(ctx, capture)

    // A replaced member credential reopens the question; the new build proves
    // the wire too, and the route serves it from the replaced proof.
    ctx.emit('credentials/reference-updated', credentialRef(API_KEY_REF))
    await awaitWireParity(ctx, capture)
    expect(declaresWireParity(modelCalls(capture).at(-1) as CapturedRequest)).toBe(true)
    expect(capabilityCalls(capture)).toHaveLength(2)
  })

  it('does not carry the old build proof to a replacement probe that proves nothing', async () => {
    let probes = 0
    const { ctx, capture } = await mountProbed((request) => {
      if (request.url !== CAPABILITIES_URL) return anthropicSuccessResponse()
      probes += 1
      // The replacement build answers without a build identity, so it binds
      // nothing and the previous build's proof must not survive it.
      return probes === 1 ? capabilityReply('pool-build-1') : capabilityReply(undefined)
    })
    await awaitWireParity(ctx, capture)

    ctx.emit('credentials/reference-updated', credentialRef(API_KEY_REF))
    await vi.waitFor(() => {
      expect(capabilityCalls(capture)).toHaveLength(2)
    }, { timeout: 5_000 })
    await assemble(ctx, WIRE_PARITY_PROBE)
    const after = modelCalls(capture).at(-1) as CapturedRequest
    expect(declaresWireParity(after)).toBe(false)
    // The fallback is the route's own three-marker bytes, not a partial wire.
    expect(JSON.stringify(after.body).match(/"cache_control"/gu)).toHaveLength(3)
    expect(capabilityCalls(capture)).toHaveLength(2)
  })
})
