import { describe, expect, it } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {
  LLM_FAILURE_CODES,
  resolveRetryPolicy,
  RETRY_CODE_CHOICES,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

describe('provider retry policy', () => {
  it('separates the disclosed-wait ceiling from the local backoff ceiling', () => {
    const policy = resolveRetryPolicy({
      mode: 'normal',
      backoff: { initialDelayMs: 500, maxDelayMs: 32_000, providerWaitMaxMs: 6 * 3_600_000, jitterRatio: 0.25 },
    }, 'provider.retryPolicy')

    // A provider may ask for hours while the route's own backoff stays seconds apart.
    expect(policy.maxDelayMs).toBe(32_000)
    expect(policy.providerWaitMaxMs).toBe(6 * 3_600_000)
  })

  it('rejects a disclosed-wait ceiling that is not a usable delay', () => {
    for (const providerWaitMaxMs of [0, -1, Number.NaN, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveRetryPolicy({
        mode: 'normal',
        backoff: { providerWaitMaxMs },
      }, 'provider.retryPolicy')).toThrow(/providerWaitMaxMs/)
    }
  })

  it('resolves immutable normal defaults', () => {
    const policy = resolveRetryPolicy(undefined, 'provider.retryPolicy')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      providerWaitMaxMs: 10_000,
      jitterRatio: 0.1,
    })
    expect(Object.isFrozen(policy)).toBe(true)
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(Object.isFrozen(policy.retryableCodes)).toBe(true)
  })

  it('resolves and detaches a configured normal policy', () => {
    const retryableCodes = ['BUSY']
    const config: RetryPolicyConfig = {
      mode: 'normal',
      maxRetries: 4,
      retryableCodes,
      backoff: {
        initialDelayMs: 25,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
    }

    const policy = resolveRetryPolicy(config, 'provider.retryPolicy')
    retryableCodes.push('LATE')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['BUSY'],
      initialDelayMs: 25,
      maxDelayMs: 100,
      providerWaitMaxMs: 100,
      jitterRatio: 0,
    })
  })

  it('keeps an omitted retryable-code list absent through schema validation', () => {
    const parsed = RetryPolicySchema({ mode: 'normal', maxRetries: 2 })

    // An adapter reads the absence as "not configured"; materializing the
    // default here would erase that distinction before resolution.
    expect(parsed).not.toHaveProperty('retryableCodes')
    const policy = resolveRetryPolicy(parsed, 'provider.retryPolicy')
    expect(policy.mode).toBe('normal')
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(policy.maxRetries).toBe(2)
    expect(policy.retryableCodes).toEqual(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  })

  it('resolves always mode with default backoff', () => {
    expect(resolveRetryPolicy({ mode: 'always' }, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      providerWaitMaxMs: 10_000,
      jitterRatio: 0.1,
    })
    expect(RetryPolicySchema).toBeDefined()
  })

  it('ignores normal-only fields retained after switching to always mode', () => {
    const layered = {
      mode: 'always',
      maxRetries: 5,
      retryableCodes: ['SERVER'],
    } as unknown as RetryPolicyConfig

    expect(resolveRetryPolicy(layered, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      providerWaitMaxMs: 10_000,
      jitterRatio: 0.1,
    })
  })

  it.each([
    [{ mode: 'normal', maxRetries: -1 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: 1.5 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: Number.MAX_SAFE_INTEGER + 1 }, /maxRetries/],
    [{ mode: 'always', backoff: { initialDelayMs: 0 } }, /initialDelayMs/],
    [{ mode: 'normal', backoff: { maxDelayMs: Number.POSITIVE_INFINITY } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /initialDelayMs/],
    [{ mode: 'always', backoff: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: 20, maxDelayMs: 10 } }, /less than or equal/],
    [{ mode: 'always', backoff: { jitterRatio: 1.1 } }, /jitterRatio/],
    [{ mode: 'normal', retryableCodes: [] }, /must not be empty/],
    [{ mode: 'normal', retryableCodes: ['SERVER', 'SERVER'] }, /duplicates/],
    [{ mode: 'normal', retryableCodes: [''] }, /non-empty strings/],
    [{ mode: 'normal', retryableCodes: [429] }, /non-empty strings/],
    [{ mode: 'normal', maxRetires: 1 }, /unknown key "maxRetires"/],
    [{ mode: 'always', backoff: { initialDelay: 1 } }, /unknown key "initialDelay"/],
    [{ mode: 'sometimes' }, /mode must be "normal" or "always"/],
  ] as const)('rejects invalid policy %#', (config, message) => {
    expect(() => {
      resolveRetryPolicy(config as unknown as RetryPolicyConfig, 'provider.retryPolicy')
    }).toThrow(message)
  })

  it.each<[string, RetryPolicyConfig]>([
    ['a zero delay', { mode: 'always', backoff: { initialDelayMs: 0 } }],
    ['an empty code list', { mode: 'normal', retryableCodes: [] }],
    ['a blank code', { mode: 'normal', retryableCodes: [''] }],
  ])('declares the resolver bound on %s in the schema', (_name, config) => {
    expect(() => RetryPolicySchema(config)).toThrow()
  })

  it('accepts the smallest values inside the schema bounds and still defaults the codes', () => {
    expect(RetryPolicySchema({ mode: 'normal', retryableCodes: ['X'], backoff: { initialDelayMs: Number.MIN_VALUE } }))
      .toMatchObject({ retryableCodes: ['X'], backoff: { initialDelayMs: Number.MIN_VALUE } })
    expect(RetryPolicySchema({ mode: 'normal' })).toMatchObject({
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    })
  })

  it('publishes the retry choices through the serialized schema and still admits other codes', () => {
    const restored = new Schema(JSON.parse(JSON.stringify(RetryPolicySchema.toJSON())) as Schema<RetryPolicyConfig>)
    const normal = restored.list?.find(branch => branch.dict?.['mode']?.value === 'normal')
    const item = normal?.dict?.['retryableCodes']?.inner
    const choices = item?.list?.flatMap((branch): unknown[] => {
      const value: unknown = branch.value
      return branch.type === 'const' ? [value] : []
    })
    expect(choices).toEqual([...RETRY_CODE_CHOICES])
    expect(RETRY_CODE_CHOICES).toEqual(
      Object.keys(LLM_FAILURE_CODES).filter(code => 'retryChoice' in LLM_FAILURE_CODES[code as keyof typeof LLM_FAILURE_CODES]),
    )
    expect(restored({ mode: 'normal', retryableCodes: ['SERVER', 'Overloaded_529'] }))
      .toMatchObject({ retryableCodes: ['SERVER', 'Overloaded_529'] })
    expect(() => restored({ mode: 'normal', retryableCodes: [''] })).toThrow()
    // Being a choice does not make a code retried by default.
    expect(RETRY_CODE_CHOICES).toContain('STREAM_CLOSED')
    const defaults = resolveRetryPolicy(undefined, 'provider.retryPolicy')
    expect(defaults.mode === 'normal' ? defaults.retryableCodes : []).not.toContain('STREAM_CLOSED')
  })
})
