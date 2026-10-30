import { describe, expect, it } from 'vitest'
import {
  POOL_CAPACITY_CODE,
  POOL_ERROR_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_SESSION_BUSY_CODE,
  POOL_TRANSIENT_CODE,
} from '@deepseek-ai/dsh-llm'
import {
  assertServiceable,
  Config,
  resolveProfiles,
  resolveSessionHeaders,
  type Options,
  type PiAiCcWireParityProofs,
  type PiAiProviderProfile,
  type ResolvedPiAiProviderProfile,
} from '../src/config.ts'

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

/**
 * The capability proof a fixed-route plugin would supply for the test route: the
 * capability endpoint on the route's own origin, naming a pool build.
 */
const POOL_PROOF = { endpoint: 'https://pool.test/v1/capabilities', buildId: 'test-build' } as const

/** The proof map a fixed-route plugin supplies for the single `pool` route. */
const POOL_PROOFS: PiAiCcWireParityProofs = new Map([['pool', POOL_PROOF]])

/** Resolve one parity A route, with the caller's fields layered onto it. */
const wireParityRoute = (
  profile: PiAiProviderProfile,
  proofs: PiAiCcWireParityProofs = POOL_PROOFS,
): ResolvedPiAiProviderProfile | undefined =>
  resolveProfiles({
    pool: {
      api: 'anthropic-messages',
      baseURL: 'https://pool.test',
      models: [{ id: 'm' }],
      ...profile,
    },
  }, 'strict', proofs).get('pool')

describe('CC wire parity member headers', () => {
  it.each([
    'x-cc-request-class',
    'x-cc-system-layout',
    'x-cc-cache-intent',
    'X-CC-System-Layout',
  ])('refuses a profile header spelled %s on every route', (header) => {
    // The adapter composes all three member headers or none, so a profile value
    // would race its set or leave a partial one; resolution refuses it even on a
    // route that never enables wire parity.
    expect(() => resolveProfiles({
      route: {
        api: 'anthropic-messages',
        baseURL: 'https://pool.test',
        models: [{ id: 'm' }],
        headers: { [header]: 'main' },
      },
    })).toThrow(new RegExp(`sets header "${header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}", which this adapter owns`))
  })
})

describe('CC wire parity capability proof', () => {
  it('refuses the flag on a configured profile, which carries no proof', () => {
    // The generic plugin resolves loader configuration without any probe result,
    // so a profile can request the body but never grant itself the wire.
    expect(() => wireParityRoute({ ccWireParity: true }, new Map()))
      .toThrow(/ccWireParity.*proved the capability|capability proof/)
  })

  it('refuses a proof whose endpoint does not cover the route origin', () => {
    expect(() => wireParityRoute({ ccWireParity: true }, new Map([['pool', {
      endpoint: 'https://other.test/v1/capabilities',
      buildId: 'test-build',
    }]]))).toThrow(/does not cover baseURL/)
  })

  it('redacts userinfo and query from the endpoints a proof refusal names', () => {
    const baseURL = 'https://member:secret@pool.test/v1?api_key=hidden'
    const endpoint = 'https://member:secret@other.test/v1/capabilities?token=hidden'
    let reported = ''
    try {
      wireParityRoute({ ccWireParity: true, baseURL }, new Map([['pool', { endpoint, buildId: 'test-build' }]]))
    } catch (error) {
      reported = error instanceof Error ? error.message : String(error)
    }
    expect(reported).toContain('https://pool.test/v1')
    expect(reported).toContain('https://other.test/v1/capabilities')
    expect(reported).not.toContain('secret')
    expect(reported).not.toContain('api_key')
    expect(reported).not.toContain('hidden')

    expect(() => wireParityRoute({ ccWireParity: true }, new Map([['pool', {
      endpoint: 'not a url?token=secret',
      buildId: 'test-build',
    }]]))).toThrow(/not an absolute URL: "not a url"/u)
  })

  it('refuses ccWireParity without an absolute baseURL a proof could cover', () => {
    expect(() => resolveProfiles({
      pool: { api: 'anthropic-messages', ccWireParity: true, models: [{ id: 'm' }] },
    }, 'strict', POOL_PROOFS)).toThrow(/names no absolute baseURL a capability proof could cover/)
  })

  it('refuses a proof for a route that does not request the wire', () => {
    expect(() => wireParityRoute({}, POOL_PROOFS))
      .toThrow(/capability proof.*does not set ccWireParity/)
  })

  it('refuses a proof naming a route no profile declares', () => {
    expect(() => resolveProfiles({}, 'strict', new Map([['pool', POOL_PROOF]])))
      .toThrow(/names route "pool", which no profile declares/)
  })

  it('refuses a proof without a usable endpoint or build identity', () => {
    expect(() => wireParityRoute({ ccWireParity: true }, new Map([['pool', {
      endpoint: 'not a url',
      buildId: 'test-build',
    }]]))).toThrow(/not an absolute URL/)
    expect(() => wireParityRoute({ ccWireParity: true }, new Map([['pool', {
      endpoint: 'https://pool.test/v1/capabilities',
      buildId: '',
    }]]))).toThrow(/empty build id/)
  })

  it('enables the wire only with a proof covering the route', () => {
    expect(wireParityRoute({ ccWireParity: true })?.ccWireParity).toBe(true)
    expect(wireParityRoute({}, new Map())?.ccWireParity).toBeUndefined()
  })
})

describe('CC wire parity cache intent', () => {
  it('accepts both intents on a parity A route and resolves the default', () => {
    expect(wireParityRoute({ ccWireParity: true, ccWireParityCache: 'off' })?.ccWireParityCache).toBe('off')
    expect(wireParityRoute({ ccWireParity: true, ccWireParityCache: 'main' })?.ccWireParityCache).toBe('main')
    // Omission is the `main` plan, resolved once with the rest of the profile so
    // the adapter reads a decided value rather than defaulting per request. A
    // route that never enables A carries the same resolved default, unread.
    expect(wireParityRoute({ ccWireParity: true })?.ccWireParityCache).toBe('main')
    expect(wireParityRoute({}, new Map())?.ccWireParityCache).toBe('main')
  })

  it('refuses an intent on a route that never sends the A headers', () => {
    expect(() => wireParityRoute({ ccWireParityCache: 'off' })).toThrow(/ccWireParityCache.*ccWireParity/)
    expect(() => wireParityRoute({ ccWireParityCache: 'main' })).toThrow(/ccWireParityCache.*ccWireParity/)
  })

  it('never lets the profile name the helper intent', () => {
    // `helper` is a helper request's own declaration, not a route choice, and
    // `disabled` is the rejected wire token rather than a profile value.
    for (const value of ['helper', 'disabled']) {
      expect(() => Config({ providers: { pool: {
        api: 'anthropic-messages',
        ccWireParity: true,
        ccWireParityCache: value,
      } } } as never), value).toThrow()
    }
  })
})
