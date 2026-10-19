import { describe, expect, it } from 'vitest'
import {
  POOL_CAPACITY_CODE,
  POOL_ERROR_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_SESSION_BUSY_CODE,
  POOL_TRANSIENT_CODE,
} from '@deepseek-ai/dsh-llm'
import { assertServiceable, Config, resolveProfiles, type Options } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})

describe('retry policy pool codes', () => {
  const policyOf = (retryPolicy?: unknown) => resolveProfiles({
    'cc-pool': {
      api: 'anthropic-messages',
      baseURL: 'https://pool.test',
      models: [{ id: 'm' }],
      ...retryPolicy === undefined ? {} : { retryPolicy: retryPolicy as never },
    },
  }).get('cc-pool')!.retryPolicy

  /**
   * Resolve one route the way production does: the `Config` schema parses the
   * raw profile first, the resolved value is detached, and only then does
   * `resolveProfiles` see it.
   */
  const parsedPolicyOf = (retryPolicy?: unknown) => {
    const parsed = Config({
      providers: {
        'cc-pool': {
          api: 'anthropic-messages',
          baseURL: 'https://pool.test',
          models: [{ id: 'm' }],
          ...retryPolicy === undefined ? {} : { retryPolicy: retryPolicy as never },
        },
      },
    }).providers.get() as NonNullable<Options['providers']>
    const policy = resolveProfiles(structuredClone(parsed)).get('cc-pool')!.retryPolicy
    return { parsed, policy }
  }

  it('extends the default policy with every retryable code its own classifier emits', () => {
    const policy = policyOf()
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.maxRetries).toBe(5)
    for (const code of [POOL_CAPACITY_CODE, POOL_RATE_LIMITED_CODE, POOL_NO_ACCOUNT_CODE, POOL_TRANSIENT_CODE]) {
      expect(policy.retryableCodes).toContain(code)
    }
    // A failure that must stop is never made retryable by the default.
    expect(policy.retryableCodes).not.toContain(POOL_SESSION_BUSY_CODE)
    expect(policy.retryableCodes).not.toContain(POOL_ERROR_CODE)
  })

  it('extends a policy that configures only its budget or backoff', () => {
    const policy = policyOf({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1 } })
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.maxRetries).toBe(2)
    expect(policy.initialDelayMs).toBe(1)
    expect(policy.retryableCodes).toContain(POOL_CAPACITY_CODE)
  })

  it('keeps an explicitly configured retryable-code list exactly', () => {
    const policy = policyOf({ mode: 'normal', retryableCodes: ['SERVER'] })
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.retryableCodes).toEqual(['SERVER'])
  })

  it('extends a policy the configuration schema parsed without retryableCodes', () => {
    const { parsed, policy } = parsedPolicyOf({ mode: 'normal', maxRetries: 2 })
    // Parsing must not materialize the harness list: only its absence says the
    // deployment configured no list.
    expect(parsed['cc-pool']?.retryPolicy).not.toHaveProperty('retryableCodes')
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.maxRetries).toBe(2)
    for (const code of [POOL_CAPACITY_CODE, POOL_RATE_LIMITED_CODE, POOL_NO_ACCOUNT_CODE, POOL_TRANSIENT_CODE]) {
      expect(policy.retryableCodes).toContain(code)
    }
  })

  it('keeps a retryable-code list the configuration schema parsed exactly', () => {
    const { policy } = parsedPolicyOf({ mode: 'normal', retryableCodes: ['SERVER'] })
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.retryableCodes).toEqual(['SERVER'])
  })
})
