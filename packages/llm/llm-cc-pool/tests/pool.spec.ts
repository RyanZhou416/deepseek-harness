/** The mac-pool provider facts and catalogue resolved through the generic pi-ai resolver. */

import { describe, expect, it } from 'vitest'
import {
  POOL_CAPACITY_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_REQUEST_CLOSED_CODE,
  POOL_SESSION_BUSY_CODE,
} from '@deepseek-ai/dsh-llm'
import { Config } from '../src/config.ts'
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
    // The schema still accepts the lifetime enum; resolution refuses the values
    // the configured policy cannot combine.
    expect(Config({ cacheTtl: '5m' }).cacheTtl).toBe('5m')
    expect(() => Config({ cacheTtl: '24h' } as never)).toThrow(/cacheTtl/)
    expect(() => Config({ cacheTtl: '5min' } as never)).toThrow(/cacheTtl/)
  })

  it('refuses a policy whose lifetime or beta cannot serve a request', () => {
    const explicit: CcPoolCachePolicy = { cacheTtl: '1h', extendedCacheBeta: true }
    expect(() => resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: '5m' }))
      .toThrow(/cacheMarkerPolicy "cc3" requires cacheTtl "1h"/)
    expect(() => resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: 'none' }))
      .toThrow(/cacheMarkerPolicy "cc3" requires cacheTtl "1h"/)
    expect(() => resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3', extendedCacheBeta: false }))
      .toThrow(/cacheMarkerPolicy "cc3" requires extendedCacheBeta: true/)
    expect(() => resolvePoolCachePolicy({ ...explicit, extendedCacheBeta: false }))
      .toThrow(/cacheTtl "1h" requires extendedCacheBeta: true/)
    // Valid combinations: the default three-marker policy, and a non-policy layout.
    expect(resolvePoolCachePolicy({ ...explicit, cacheMarkerPolicy: 'cc3' }))
      .toMatchObject({ cacheMarkerPolicy: 'cc3' })
    expect(resolvePoolCachePolicy(legacyPolicy('5m'))).toMatchObject({ cacheTtl: '5m' })
    expect(resolvePoolCachePolicy(legacyPolicy('none'))).toMatchObject({ cacheTtl: 'none' })
    // Profile and profile-set resolution reject the same combination.
    expect(() => poolProviderProfile(MODELS, { ...explicit, cacheMarkerPolicy: 'cc3', cacheTtl: '5m' }))
      .toThrow(/requires cacheTtl "1h"/)
    expect(() => resolvePoolProfiles(MODELS, { ...explicit, cacheMarkerPolicy: 'cc3', extendedCacheBeta: false }))
      .toThrow(/requires extendedCacheBeta: true/)
  })
})
