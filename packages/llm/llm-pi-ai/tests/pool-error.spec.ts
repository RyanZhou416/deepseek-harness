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
  POOL_ERROR_CATALOG,
  POOL_ERROR_CATALOG_SHA256,
  POOL_ERROR_CATALOG_VERSION,
} from '../src/pool-error-catalog.generated.ts'
import {
  classifyPoolFailure,
  parseProviderErrorEnvelope,
  ProviderErrorCapture,
} from '../src/pool-error.ts'

/** The pool envelope as the online gateway writes it: `<status> <body>`. */
function poolEnvelope(error: Record<string, unknown>, status = 429): string {
  return `${status} ${JSON.stringify({
    type: 'error',
    error: { origin: 'pool', scope: 'pool', ...error },
  })}`
}

/** Catalog fields that both the pool envelope and the DSH classifier must agree on. */
const CATALOG_EXPECTED = [
  {
    type: 'cc_pool_capacity_exhausted',
    code: POOL_CAPACITY_CODE,
    origin: 'pool',
    httpStatus: 429,
    scope: 'pool',
    retryable: true,
    clientAction: 'retry_after',
    poolAction: 'none',
    messageKey: 'pool.error.capacity_exhausted',
    clientGuidance: 'all pool session slots are in use',
  },
  {
    type: 'cc_pool_rate_limited',
    code: POOL_RATE_LIMITED_CODE,
    origin: 'pool',
    httpStatus: 429,
    scope: 'session',
    retryable: true,
    clientAction: 'retry_after',
    poolAction: 'session_backoff',
    messageKey: 'pool.error.rate_limited',
    clientGuidance: 'the pool rate limit applies to this request',
  },
  {
    type: 'cc_pool_session_busy',
    code: POOL_SESSION_BUSY_CODE,
    origin: 'pool',
    httpStatus: 409,
    scope: 'session',
    retryable: false,
    clientAction: 'stop',
    poolAction: 'none',
    messageKey: 'pool.error.session_busy',
    clientGuidance: 'wait for the current turn to finish before retrying',
  },
  {
    type: 'cc_pool_no_available_account',
    code: POOL_NO_ACCOUNT_CODE,
    origin: 'pool',
    httpStatus: 503,
    scope: 'pool',
    retryable: true,
    clientAction: 'retry_after',
    poolAction: 'none',
    messageKey: 'pool.error.no_available_account',
    clientGuidance: 'no healthy pool account is currently available',
  },
] as const

/**
 * Pool codes that are not catalog entries: the retired direct codes and the
 * direct-internal codes that never publish catalog fields.
 */
const NON_CATALOG_POOL_CODES = [
  'cc_pool_direct_lease_conflict',
  'cc_pool_direct_no_account',
  'cc_pool_quota_exhausted',
  'cc_pool_account_unavailable',
  'cc_pool_model_denied',
  'cc_pool_request_in_flight',
  'cc_pool_request_closed',
  'cc_pool_outcome_unknown',
] as const

describe('pool error envelope', () => {
  it('reads the code, origin, scope, retry decision, and message from the body', () => {
    const parsed = parseProviderErrorEnvelope(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      code: 'cc_pool_capacity_exhausted',
      retryable: true,
      client_action: 'retry_after',
      message: 'all accounts are at their 2-session limit',
    }))

    expect(parsed).toEqual({
      code: 'cc_pool_capacity_exhausted',
      type: 'cc_pool_capacity_exhausted',
      origin: 'pool',
      scope: 'pool',
      retryable: true,
      clientAction: 'retry_after',
      message: 'all accounts are at their 2-session limit',
    })
  })

  it('returns undefined for a message without a JSON object', () => {
    expect(parseProviderErrorEnvelope('429 status code (no body)')).toBeUndefined()
    expect(parseProviderErrorEnvelope('provider timed out')).toBeUndefined()
    expect(parseProviderErrorEnvelope('500 {not json}')).toBeUndefined()
  })
})

describe('generated pool error catalog', () => {
  it('is the four-code single source in catalog order', () => {
    expect(Object.keys(POOL_ERROR_CATALOG)).toEqual(CATALOG_EXPECTED.map(entry => entry.type))
    expect(Object.values(POOL_ERROR_CATALOG)).toEqual(CATALOG_EXPECTED)
    for (const [type, entry] of Object.entries(POOL_ERROR_CATALOG)) {
      expect(entry.type).toBe(type)
    }
  })

  it('pins the catalog revision shared with the pool', () => {
    expect(POOL_ERROR_CATALOG_VERSION).toBe('1.0.0')
    // The literal is a deliberate lock: regenerating from a different catalog
    // revision updates the artifact and this test in the same change.
    expect(POOL_ERROR_CATALOG_SHA256)
      .toBe('2b31eaed88fddd812586795c22528bfcc8ba15118d5f6cf5ca4e3549c407861e')
  })

  it('excludes retired and direct-internal codes', () => {
    for (const code of NON_CATALOG_POOL_CODES) {
      expect(Object.hasOwn(POOL_ERROR_CATALOG, code)).toBe(false)
    }
  })

  it('classifies every catalog code from its table entry', () => {
    for (const entry of CATALOG_EXPECTED) {
      const failure = classifyPoolFailure(
        poolEnvelope({ type: entry.type, message: `${entry.type} probe` }, entry.httpStatus),
      )
      expect(failure).toMatchObject({ code: entry.code, status: entry.httpStatus })
      expect(failure?.message).toContain(`(${entry.code}: ${entry.clientGuidance}`)
      if (entry.clientAction === 'stop') {
        expect(failure?.retryDisposition).toBe('forbid')
      } else {
        expect(failure?.retryDisposition).toBeUndefined()
      }
    }
  })

  it('reads the known code from `code` when `type` is absent', () => {
    const failure = classifyPoolFailure(poolEnvelope({ code: 'cc_pool_session_busy' }, 409))
    expect(failure).toMatchObject({ code: POOL_SESSION_BUSY_CODE, retryDisposition: 'forbid' })
  })
})

describe('pool failure classification', () => {
  it('reports exhausted capacity as its own retryable code and keeps Retry-After', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      retryable: true,
      message: 'all accounts are at their 2-session limit; no capacity until a session finishes',
    }), { status: 429, providerRetryAfterMs: 30_000 })

    expect(failure).toEqual({
      message: 'all accounts are at their 2-session limit; no capacity until a session finishes'
        + ' (POOL_CAPACITY: all pool session slots are in use; retry after 30s)',
      code: POOL_CAPACITY_CODE,
      status: 429,
      providerRetryAfterMs: 30_000,
    })
  })

  it('reports a pool rate limit as its own retryable code', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      retryable: true,
      message: 'account token bucket is empty',
    }), { status: 429, providerRetryAfterMs: 12_000 })

    expect(failure).toMatchObject({
      code: POOL_RATE_LIMITED_CODE,
      status: 429,
      providerRetryAfterMs: 12_000,
    })
    expect(failure?.message).toMatch(/account token bucket is empty.*retry after 12s/)
    expect(failure?.retryDisposition).toBeUndefined()
  })

  it('forbids an automatic resend while the session is busy, even though the pool marks it retryable', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_session_busy',
      retryable: true,
      message: 'this session already has an in-flight request',
    }, 409))

    expect(failure).toMatchObject({
      code: POOL_SESSION_BUSY_CODE,
      status: 409,
      retryDisposition: 'forbid',
    })
    expect(failure?.message).toMatch(/wait for the current turn to finish before retrying/)
  })

  it('retries no-available-account within the finite retry budget', () => {
    // The online pool marks this failure non-retryable for its own account
    // recovery; the client still retries within `maxRetries` after the
    // provider-disclosed wait instead of failing on the first 503.
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_no_available_account',
      retryable: false,
      message: 'no healthy account can serve this model',
    }, 503))

    expect(failure).toMatchObject({
      code: POOL_NO_ACCOUNT_CODE,
      status: 503,
    })
    expect(failure?.retryDisposition).toBeUndefined()
  })

  it('reads the status from the message when no response was captured', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'slow down',
    }, 429))

    expect(failure).toMatchObject({ code: POOL_RATE_LIMITED_CODE, status: 429 })
  })

  it.each([
    ['client_action retry_same', { type: 'cc_pool_request_in_flight', client_action: 'retry_same' }, 409, POOL_TRANSIENT_CODE],
    ['retryable true', { type: 'cc_pool_direct_engine_not_ready', retryable: true }, 503, POOL_TRANSIENT_CODE],
  ])('maps an unrecognized retryable pool failure (%s) to a transient code', (_label, error, status, code) => {
    const failure = classifyPoolFailure(poolEnvelope(error, status))
    expect(failure).toMatchObject({ code })
    expect(failure?.retryDisposition).toBeUndefined()
  })

  it.each([
    ['an explicit stop', { type: 'cc_pool_quota_exhausted', retryable: true, client_action: 'stop' }],
    ['retryable false', { type: 'cc_pool_direct_unavailable', retryable: false }],
  ])('forbids an unrecognized non-retryable pool failure (%s)', (_label, error) => {
    const failure = classifyPoolFailure(poolEnvelope(error, 503))
    expect(failure).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid' })
  })

  it('leaves a Claude-native error alone, even when its envelope names a pool code', () => {
    const claude = `429 ${JSON.stringify({
      type: 'error',
      error: {
        type: 'cc_pool_capacity_exhausted',
        origin: 'claude',
        retryable: true,
        message: 'Number of requests has exceeded your rate limit',
      },
    })}`

    expect(classifyPoolFailure(claude)).toBeUndefined()
  })

  it('leaves a Claude-native rate limit and a non-envelope failure to the text classifier', () => {
    const claude = `429 ${JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', origin: 'claude', retryable: true, message: 'slow down' },
    })}`

    expect(classifyPoolFailure(claude)).toBeUndefined()
    expect(classifyPoolFailure('429 rate limit exceeded')).toBeUndefined()
  })

  it('distinguishes origin=pool from a native error carrying the same type', () => {
    const failure = classifyPoolFailure(`429 ${JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', origin: 'pool', retryable: true, message: 'pool slow down' },
    })}`)

    expect(failure).toMatchObject({ code: POOL_TRANSIENT_CODE })
  })

  it('recognizes the online envelope, which carries a pool code but no origin', () => {
    const failure = classifyPoolFailure(`429 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_session_busy', retryable: true, message: 'busy' },
    })}`)

    expect(failure).toMatchObject({ code: POOL_SESSION_BUSY_CODE, status: 429 })
    expect(failure?.providerRetryAfterMs).toBeUndefined()
  })

  it('reads retryability from client_action for an unrecognized pool code', () => {
    const retry = classifyPoolFailure(`503 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_engine_starting', origin: 'pool', client_action: 'retry_after' },
    })}`)
    const refresh = classifyPoolFailure(`403 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_account_unavailable', origin: 'pool', client_action: 'refresh', message: 'sign in again' },
    })}`)

    expect(retry).toMatchObject({ code: POOL_TRANSIENT_CODE })
    expect(refresh).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid' })
    expect(refresh?.message).toMatch(/re-authenticate this provider route before retrying/)
  })

  it('falls back to the HTTP status only when the envelope states no retry decision', () => {
    const transient = classifyPoolFailure(`503 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_engine_starting', origin: 'pool' },
    })}`)
    const terminal = classifyPoolFailure(`400 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_bad_route', origin: 'pool' },
    })}`)
    const unknownStatus = classifyPoolFailure(JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_bad_route', origin: 'pool', retryable: true },
    }))

    expect(transient).toMatchObject({ code: POOL_TRANSIENT_CODE, status: 503 })
    expect(terminal).toMatchObject({ code: POOL_ERROR_CODE, status: 400, retryDisposition: 'forbid' })
    expect(unknownStatus).toMatchObject({ code: POOL_TRANSIENT_CODE })
    expect(unknownStatus?.status).toBeUndefined()
  })

  it('does not treat an inherited object key as a catalog code', () => {
    const failure = classifyPoolFailure(poolEnvelope({ type: 'constructor', origin: 'pool' }, 500))

    expect(failure).toMatchObject({ code: POOL_TRANSIENT_CODE })
  })

  it('treats an origin-pool envelope with no code by its retry facts', () => {
    const failure = classifyPoolFailure(JSON.stringify({
      type: 'error',
      error: { origin: 'pool', retryable: false, message: 'no route' },
    }))

    expect(failure).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid' })
    expect(failure?.message).toContain('no route')
  })

  it('omits an out-of-range status prefix instead of reporting it', () => {
    const failure = classifyPoolFailure(`999 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_rate_limited', origin: 'pool', message: 'slow down' },
    })}`)

    expect(failure).toMatchObject({ code: POOL_RATE_LIMITED_CODE })
    expect(failure?.status).toBeUndefined()
  })

  it('ignores a JSON body that is not an error envelope', () => {
    expect(parseProviderErrorEnvelope('500 null')).toBeUndefined()
    expect(parseProviderErrorEnvelope('500 {"error":null}')).toBeUndefined()
    expect(classifyPoolFailure('500 {"error":null}')).toBeUndefined()
    expect(parseProviderErrorEnvelope('500 {"error":{"code":"","retryable":"yes"}}')).toEqual({})
  })
})

describe('provider error capture', () => {
  it('records the failed status and Retry-After without consuming the body', async () => {
    const capture = new ProviderErrorCapture(async () => new Response('error body', {
      status: 429,
      headers: { 'retry-after': '7' },
    }))

    const response = await capture.fetch('http://127.0.0.1/unused', {})

    expect(await response.text()).toBe('error body')
    expect(capture.read()).toEqual({ status: 429, providerRetryAfterMs: 7_000 })
  })

  it('accepts an HTTP-date Retry-After', async () => {
    const capture = new ProviderErrorCapture(async () => new Response('busy', {
      status: 503,
      headers: { 'retry-after': new Date(Date.now() + 60_000).toUTCString() },
    }))

    await capture.fetch('http://127.0.0.1/unused', {})

    const response = capture.read()
    expect(response?.status).toBe(503)
    expect(response?.providerRetryAfterMs).toBeGreaterThan(0)
  })

  it('records a failure with no usable Retry-After as status only', async () => {
    const capture = new ProviderErrorCapture(async () => new Response('no', { status: 429 }))
    await capture.fetch('http://127.0.0.1/unused', {})
    expect(capture.read()).toEqual({ status: 429 })

    const invalid = new ProviderErrorCapture(async () => new Response('no', {
      status: 503,
      headers: { 'retry-after': 'soon' },
    }))
    await invalid.fetch('http://127.0.0.1/unused', {})
    expect(invalid.read()).toEqual({ status: 503 })
  })

  it('ignores a Retry-After date that has already passed', async () => {
    const capture = new ProviderErrorCapture(async () => new Response('no', {
      status: 503,
      headers: { 'retry-after': new Date(Date.now() - 60_000).toUTCString() },
    }))

    await capture.fetch('http://127.0.0.1/unused', {})
    expect(capture.read()).toEqual({ status: 503 })
  })

  it('records nothing for a successful response and keeps only the first failure', async () => {
    const capture = new ProviderErrorCapture(async () => new Response('ok'))

    await capture.fetch('http://127.0.0.1/first', {})
    expect(capture.read()).toBeUndefined()

    let calls = 0
    const failing = new ProviderErrorCapture(async () => new Response('no', {
      status: ++calls === 1 ? 429 : 500,
    }))
    await failing.fetch('http://127.0.0.1/one', {})
    await failing.fetch('http://127.0.0.1/two', {})
    expect(failing.read()).toEqual({ status: 429 })
  })
})
