import { describe, expect, it } from 'vitest'
import {
  POOL_CAPACITY_CODE,
  POOL_ERROR_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_SESSION_BUSY_CODE,
  POOL_TRANSIENT_CODE,
} from '@deepseek-ai/dsh-llm'
import { assertServiceable, Config, resolveProfiles, resolveSessionHeaders, type Options } from '../src/config.ts'

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
    expect(configWith({ reasoning: 'ultra' })).toThrow(/"off"/)
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

describe('session identity headers', () => {
  it('accepts one route or a list and resolves it as an immutable set', () => {
    expect([...resolveSessionHeaders(undefined)]).toEqual([])
    expect([...resolveSessionHeaders([])]).toEqual([])
    expect([...resolveSessionHeaders('cc-pool')]).toEqual(['cc-pool'])
    expect([...resolveSessionHeaders(['cc-pool', 'acme-gateway'])]).toEqual(['cc-pool', 'acme-gateway'])
    expect(Object.isFrozen(resolveSessionHeaders(['cc-pool']))).toBe(true)
  })

  it('refuses an empty or repeated route name', () => {
    expect(() => resolveSessionHeaders('')).toThrow(/empty provider route/)
    expect(() => resolveSessionHeaders(['cc-pool', 'cc-pool'])).toThrow(/twice/)
    expect(() => Config({ providers: {}, sessionHeaders: '' })).toThrow()
    expect(() => Config({ providers: {}, sessionHeaders: [''] })).toThrow()
  })

  it('parses the route switch beside the provider profiles', () => {
    const parsed = Config({
      sessionHeaders: 'cc-pool',
      providers: {
        'cc-pool': { api: 'anthropic-messages', baseURL: 'https://pool.test', models: [{ id: 'm' }] },
      },
    })
    expect(parsed.sessionHeaders).toBe('cc-pool')
    expect(Config({ providers: {} }).sessionHeaders).toBeUndefined()
  })

  it('leaves every route of an unconfigured composition untouched', () => {
    expect(resolveSessionHeaders(Config({ providers: {} }).sessionHeaders).size).toBe(0)
  })
})

describe('request log schema', () => {
  it('accepts the optional sink and leaves it unset without one', () => {
    const parsed = Config({
      providers: {},
      requestLog: { path: 'requests.jsonl', maxFileBytes: 1024, maxFiles: 3, enabled: true },
    })
    expect(parsed.requestLog).toEqual({ path: 'requests.jsonl', maxFileBytes: 1024, maxFiles: 3, enabled: true })
    // The schema materializes an absent optional object as an empty one; every
    // field inside it still means "unset", which resolution reads as the default.
    expect(Config({ providers: {}, requestLog: {} }).requestLog).toEqual({})
    expect(Config({ providers: {} }).requestLog).toEqual({})
  })

  it.each<[string, Record<string, unknown>]>([
    ['an empty path', { path: '' }],
    ['a fractional per-file bound', { maxFileBytes: 1.5 }],
    ['a zero file count', { maxFiles: 0 }],
    ['a non-boolean switch', { enabled: 'yes' }],
  ])('rejects %s at parse time', (_case, requestLog) => {
    // The invalid value is the case under test; the schema is what refuses it.
    expect(() => Config({ providers: {}, requestLog })).toThrow()
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

  it('honors the persisted pool decision without resending a possibly-issued step', () => {
    // The deployed mac-pool profile pins this exact set. A transport,
    // empty-response, or timeout replay carries no idempotency guarantee — the
    // attempt may already have reached the model — so none may enter the list;
    // an explicit list is also not extended with the pool codes the default
    // policy would add.
    const { policy } = parsedPolicyOf({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'SERVER'],
    })
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.maxRetries).toBe(2)
    expect(policy.retryableCodes).toEqual(['RATE_LIMIT', 'SERVER'])
    expect(policy.retryableCodes).not.toContain('TRANSPORT')
    expect(policy.retryableCodes).not.toContain('EMPTY_RESPONSE')
    expect(policy.retryableCodes).not.toContain('TIMEOUT')
    expect(policy.retryableCodes).not.toContain(POOL_CAPACITY_CODE)
  })
})
