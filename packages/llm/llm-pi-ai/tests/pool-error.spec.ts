import { describe, expect, it } from 'vitest'
import {
  POOL_CAPACITY_CODE,
  POOL_ERROR_CODE,
  POOL_NO_ACCOUNT_CODE,
  POOL_RATE_LIMITED_CODE,
  POOL_REQUEST_CLOSED_CODE,
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
  POOL_ERROR_FALLBACK_MESSAGE,
  POOL_ERROR_MESSAGE_MAX_LENGTH,
  ProviderErrorCapture,
} from '../src/pool-error.ts'

/** The pool envelope as the online gateway writes it: `<status> <body>`. */
function poolEnvelope(error: Record<string, unknown>, status = 429): string {
  return `${status} ${JSON.stringify({
    type: 'error',
    error: { origin: 'pool', scope: 'pool', ...error },
  })}`
}

/** The readiness refusal's detail: an unverified lease egress path, reported as pool maintenance. */
const READINESS_DETAIL = 'the egress path is not verified for this lease; worker detail:'
  + ' capability_not_ready: the lease maintenance is not ready (retry after 10.7s)'

/**
 * The pool's readiness refusal as the online gateway writes it: a body request
 * id and a non-retryable error, with neither a `cc_pool_*` code nor `origin`.
 */
function readinessEnvelope(
  error: Record<string, unknown> = {},
  poolRequestId: string | undefined = 'pool-request-readiness',
): string {
  return `503 ${JSON.stringify({
    ...poolRequestId === undefined ? {} : { pool_request_id: poolRequestId },
    type: 'error',
    error: { message: READINESS_DETAIL, type: 'api_error', retryable: false, ...error },
  })}`
}

/** The generic display sentence for a refusal whose own message is unusable. */
function fallback(code: string): string {
  return `${POOL_ERROR_FALLBACK_MESSAGE} (${code}).`
}

/** Catalog machine fields that both the pool envelope and the DSH classifier must agree on. */
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
  },
  {
    type: 'cc_pool_request_closed',
    code: POOL_REQUEST_CLOSED_CODE,
    origin: 'pool',
    httpStatus: 409,
    scope: 'request',
    retryable: true,
    clientAction: 'retry_same',
    poolAction: 'terminal',
    messageKey: 'pool.error.request_closed',
    clientGuidance: 'the pool already closed this client request id; only a new attempt with a fresh id is safe',
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
  'cc_pool_outcome_unknown',
] as const

describe('pool error envelope', () => {
  it('reads the code, origin, scope, retry facts, terminal marker, and message from the body', () => {
    const parsed = parseProviderErrorEnvelope(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      code: 'cc_pool_capacity_exhausted',
      kind: 'capacity',
      retryable: true,
      terminal: false,
      client_action: 'retry_after',
      message: 'all accounts are at their 2-session limit',
    }))

    expect(parsed).toEqual({
      code: 'cc_pool_capacity_exhausted',
      type: 'cc_pool_capacity_exhausted',
      kind: 'capacity',
      origin: 'pool',
      scope: 'pool',
      retryable: true,
      terminal: false,
      clientAction: 'retry_after',
      message: 'all accounts are at their 2-session limit',
    })
  })

  it('ignores non-boolean retry facts and returns undefined for a message without a JSON object', () => {
    expect(parseProviderErrorEnvelope('500 {"error":{"retryable":"yes","terminal":"yes"}}')).toEqual({})
    expect(parseProviderErrorEnvelope('429 status code (no body)')).toBeUndefined()
    expect(parseProviderErrorEnvelope('provider timed out')).toBeUndefined()
    expect(parseProviderErrorEnvelope('500 {not json}')).toBeUndefined()
  })

  it('reads an in-range integer error.status and ignores anything else', () => {
    expect(parseProviderErrorEnvelope('503 {"error":{"status":503}}')).toEqual({ status: 503 })
    expect(parseProviderErrorEnvelope('500 {"error":{"status":507,"retryable":"yes"}}')).toEqual({ status: 507 })
    expect(parseProviderErrorEnvelope('500 {"error":{"status":99}}')).toEqual({})
    expect(parseProviderErrorEnvelope('500 {"error":{"status":600}}')).toEqual({})
    expect(parseProviderErrorEnvelope('500 {"error":{"status":5.5}}')).toEqual({})
    expect(parseProviderErrorEnvelope('500 {"error":{"status":"503"}}')).toEqual({})
  })
})

describe('generated pool error catalog', () => {
  it('is the five-code single source in catalog order', () => {
    expect(Object.keys(POOL_ERROR_CATALOG)).toEqual(CATALOG_EXPECTED.map(entry => entry.type))
    for (const entry of CATALOG_EXPECTED) {
      expect(POOL_ERROR_CATALOG[entry.type]).toMatchObject(entry)
    }
  })

  it('pins the catalog revision shared with the pool', () => {
    expect(POOL_ERROR_CATALOG_VERSION).toBe('1.1.0')
    // The literal is a deliberate lock: regenerating from a different catalog
    // revision updates the artifact and this test in the same change.
    expect(POOL_ERROR_CATALOG_SHA256)
      .toBe('3f40dfb188bed6a135f3ab148e65079d3f9141282915d68e2622371e05056668')
  })

  it('excludes retired and direct-internal codes', () => {
    for (const code of NON_CATALOG_POOL_CODES) {
      expect(Object.hasOwn(POOL_ERROR_CATALOG, code)).toBe(false)
    }
  })

  it('classifies every catalog code from its machine entry without catalog wording', () => {
    for (const entry of CATALOG_EXPECTED) {
      const providerMessage = `${entry.type} probe`
      const failure = classifyPoolFailure(
        poolEnvelope({ type: entry.type, message: providerMessage }, entry.httpStatus),
      )
      expect(failure).toMatchObject({ code: entry.code, status: entry.httpStatus, message: providerMessage })
      if (entry.clientAction === 'stop') {
        expect(failure?.retryDisposition).toBe('forbid')
      } else {
        expect(failure?.retryDisposition).toBeUndefined()
      }
    }
  })

  it('reads the known code from `code` when `type` is absent', () => {
    const failure = classifyPoolFailure(poolEnvelope({ code: 'cc_pool_session_busy', message: 'busy' }, 409))
    expect(failure).toMatchObject({ code: POOL_SESSION_BUSY_CODE, retryDisposition: 'forbid', message: 'busy' })
  })

  it('reads a known code from `kind` when `code` and `type` are absent', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      kind: 'cc_pool_no_available_account',
      message: 'no healthy account',
    }, 503))
    expect(failure).toMatchObject({ code: POOL_NO_ACCOUNT_CODE, message: 'no healthy account' })
    expect(failure?.retryDisposition).toBeUndefined()
  })
})

describe('pool message display', () => {
  it('passthroughs the provider message exactly instead of appending catalog text', () => {
    const providerMessage = 'All accounts are at their 2-session limit.'
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      message: providerMessage,
    }), { status: 429, providerRetryAfterMs: 30_000 })

    expect(failure?.message).toBe(providerMessage)
    expect(failure?.message).not.toContain('all pool session slots')
    expect(failure?.message).not.toContain('POOL_CAPACITY')
    expect(failure).toMatchObject({ code: POOL_CAPACITY_CODE, providerRetryAfterMs: 30_000 })
  })

  it('renders a multi-line message as one line', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'first line\n\tsecond   line\r\nthird',
    }))

    expect(failure?.message).toBe('first line second line third')
  })

  it('falls back when the provider message is missing or empty', () => {
    const missing = classifyPoolFailure(poolEnvelope({ type: 'cc_pool_capacity_exhausted' }))
    const empty = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      message: '  \n\t ',
    }))

    expect(missing?.message).toBe(fallback(POOL_CAPACITY_CODE))
    expect(empty?.message).toBe(fallback(POOL_CAPACITY_CODE))
  })

  it('rejects an oversized provider message', () => {
    const atLimit = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      message: 'a'.repeat(POOL_ERROR_MESSAGE_MAX_LENGTH),
    }))
    const oversized = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      message: 'a'.repeat(POOL_ERROR_MESSAGE_MAX_LENGTH + 1),
    }))

    expect(atLimit?.message).toBe('a'.repeat(POOL_ERROR_MESSAGE_MAX_LENGTH))
    expect(oversized?.message).toBe(fallback(POOL_CAPACITY_CODE))
  })

  it('rejects markup and HTML entities in a provider message', () => {
    const markup = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      message: 'pool <img src=x onerror=alert(1)> failure',
    }))
    const entity = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      message: 'pool &lt;script&gt; failure',
    }))

    expect(markup?.message).toBe(fallback(POOL_CAPACITY_CODE))
    expect(entity?.message).toBe(fallback(POOL_CAPACITY_CODE))
  })

  it('rejects credential-like material in a provider message', () => {
    const bearer = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'rejected Authorization: Bearer sk-live-abcdefgh',
    }))
    const assignment = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'request failed with api_key=super-secret-value',
    }))
    const query = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'request failed at /v1/messages?token=query-secret',
    }))

    expect(bearer?.message).toBe(fallback(POOL_RATE_LIMITED_CODE))
    expect(assignment?.message).toBe(fallback(POOL_RATE_LIMITED_CODE))
    expect(query?.message).toBe(fallback(POOL_RATE_LIMITED_CODE))
  })

  it('keeps the pool\'s own redaction placeholders displayable', () => {
    const assignment = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'upstream rejected the credential: api_key=[redacted]',
    }))
    const query = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      message: 'request reached /v1/messages?token=[redacted]&model=x',
    }))

    expect(assignment?.message).toBe('upstream rejected the credential: api_key=[redacted]')
    expect(query?.message).toBe('request reached /v1/messages?token=[redacted]&model=x')
  })

  it('names the canonical failure code in the fallback for an unknown pool failure', () => {
    const retryable = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_engine_starting',
    }, 503))
    const terminal = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_bad_route',
    }, 400))

    expect(retryable?.message).toBe(fallback(POOL_TRANSIENT_CODE))
    expect(terminal?.message).toBe(fallback(POOL_ERROR_CODE))
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
      message: 'all accounts are at their 2-session limit; no capacity until a session finishes',
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
      message: 'account token bucket is empty',
      code: POOL_RATE_LIMITED_CODE,
      status: 429,
      providerRetryAfterMs: 12_000,
    })
    expect(failure?.retryDisposition).toBeUndefined()
  })

  it('forbids an automatic resend while the session is busy, even though the pool marks it retryable', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_session_busy',
      retryable: true,
      message: 'this session already has an in-flight request',
    }, 409))

    expect(failure).toMatchObject({
      message: 'this session already has an in-flight request',
      code: POOL_SESSION_BUSY_CODE,
      status: 409,
      retryDisposition: 'forbid',
    })
  })

  it('recovers a closed client request id with a fresh attempt instead of ending the turn', () => {
    // The real envelope: the pool closed this request id, marks the envelope
    // terminal, and still asks for a retry with a fresh id. `terminal` refuses a
    // replay of the closed id, not the fresh ledger entry a deliberate retry
    // creates, so the catalog's retry_same action keeps the failure retryable.
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_request_closed',
      code: 'cc_pool_request_closed',
      retryable: true,
      terminal: true,
      client_action: 'retry_same',
      message: 'request already recorded',
    }, 409))

    expect(failure).toMatchObject({
      code: POOL_REQUEST_CLOSED_CODE,
      status: 409,
    })
    expect(failure?.retryDisposition).toBeUndefined()
    expect(failure?.message).toBe('request already recorded')
  })

  it('honors a pool that withdraws retryability on the closed-request code', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_request_closed',
      retryable: false,
      terminal: true,
      client_action: 'retry_same',
    }, 409))

    expect(failure).toMatchObject({
      code: POOL_REQUEST_CLOSED_CODE,
      status: 409,
      retryDisposition: 'forbid',
    })
  })

  it('honors a closed-request withdrawal without the terminal marker', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_request_closed',
      retryable: false,
      client_action: 'retry_same',
    }, 409))

    expect(failure).toMatchObject({
      code: POOL_REQUEST_CLOSED_CODE,
      status: 409,
      retryDisposition: 'forbid',
    })
  })

  it('leaves a native provider failure alone without a pool-authored withdrawal', () => {
    const withoutPoolMarkers = classifyPoolFailure(`529 ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', origin: 'claude', retryable: false, message: 'Overloaded' },
    })}`, { status: 529 })
    const withoutWithdrawal = classifyPoolFailure(`529 ${JSON.stringify({
      pool_request_id: 'pool-request-native',
      type: 'error',
      error: { type: 'api_error', origin: 'claude', message: 'Overloaded' },
    })}`, { status: 529 })

    expect(withoutPoolMarkers).toBeUndefined()
    expect(withoutWithdrawal).toBeUndefined()
  })

  it('honors a withdrawal on an unrecognized retry_same failure', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_request_in_flight',
      retryable: false,
      client_action: 'retry_same',
    }, 409))

    expect(failure).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid' })
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
      message: 'no healthy account can serve this model',
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

  it('reads error.status when neither the response nor the message supplies one', () => {
    const failure = classifyPoolFailure(JSON.stringify({
      type: 'error',
      error: {
        type: 'cc_pool_rate_limited',
        origin: 'pool',
        status: 429,
        message: 'slow down',
      },
    }))

    expect(failure).toMatchObject({ code: POOL_RATE_LIMITED_CODE, status: 429 })
  })

  it('keeps the captured response status ahead of error.status', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_rate_limited',
      status: 429,
      message: 'slow down',
    }, 503), { status: 503 })

    expect(failure).toMatchObject({ code: POOL_RATE_LIMITED_CODE, status: 503 })
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

  it('keeps an explicit terminal marker authoritative outside the closed-request action', () => {
    const unknown = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_engine_starting',
      retryable: true,
      terminal: true,
      message: 'the pool gave up',
    }, 503))
    const known = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_capacity_exhausted',
      retryable: true,
      terminal: true,
      message: 'capacity exhausted',
    }, 429))

    expect(unknown).toMatchObject({
      message: 'the pool gave up',
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
    })
    expect(known).toMatchObject({
      message: 'capacity exhausted',
      code: POOL_CAPACITY_CODE,
      retryDisposition: 'forbid',
    })
  })

  it('keeps an explicit terminal=false from adding a retry decision', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_engine_starting',
      terminal: false,
      message: 'starting',
    }, 400))

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
    const native = `429 ${JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    })}`

    expect(classifyPoolFailure(claude)).toBeUndefined()
    expect(classifyPoolFailure(native)).toBeUndefined()
    expect(classifyPoolFailure('429 rate limit exceeded')).toBeUndefined()
  })

  it('distinguishes origin=pool from a native error carrying the same type', () => {
    const failure = classifyPoolFailure(`429 ${JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', origin: 'pool', retryable: true, message: 'pool slow down' },
    })}`)

    expect(failure).toMatchObject({ code: POOL_TRANSIENT_CODE, message: 'pool slow down' })
  })

  it('recognizes the online envelope, which carries a pool code but no origin', () => {
    const failure = classifyPoolFailure(`429 ${JSON.stringify({
      type: 'error',
      error: { type: 'cc_pool_session_busy', retryable: true, message: 'busy' },
    })}`)

    expect(failure).toMatchObject({ code: POOL_SESSION_BUSY_CODE, status: 429, message: 'busy' })
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

    expect(retry).toMatchObject({ code: POOL_TRANSIENT_CODE, message: fallback(POOL_TRANSIENT_CODE) })
    expect(refresh).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid', message: 'sign in again' })
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

  it('treats a 429 status as retryable for an unrecognized pool failure with no retry facts', () => {
    const failure = classifyPoolFailure(poolEnvelope({
      type: 'cc_pool_engine_starting',
      message: 'try later',
    }, 429))

    expect(failure).toMatchObject({ code: POOL_TRANSIENT_CODE, status: 429 })
    expect(failure?.retryDisposition).toBeUndefined()
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

    expect(failure).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid', message: 'no route' })
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

describe('pool readiness refusal', () => {
  it('reads the body request id beside the error fields', () => {
    expect(parseProviderErrorEnvelope(readinessEnvelope())).toEqual({
      poolRequestId: 'pool-request-readiness',
      type: 'api_error',
      retryable: false,
      message: READINESS_DETAIL,
    })
  })

  it('forbids resending the refusal so the ledger never sees a repeated request id', () => {
    const failure = classifyPoolFailure(readinessEnvelope(), { status: 503 })

    expect(failure).toMatchObject({
      code: POOL_ERROR_CODE,
      status: 503,
      retryDisposition: 'forbid',
    })
    expect(failure?.message).toBe(READINESS_DETAIL)
  })

  it('recognizes the capability_not_ready lease detail without the egress wording', () => {
    const failure = classifyPoolFailure(readinessEnvelope({
      message: 'worker detail: capability_not_ready: the lease maintenance is not ready',
    }))

    expect(failure).toMatchObject({ code: POOL_ERROR_CODE, retryDisposition: 'forbid' })
    expect(failure?.status).toBe(503)
  })

  it('reads the readiness status from its own message prefix when no response was captured', () => {
    expect(classifyPoolFailure(readinessEnvelope())).toMatchObject({
      code: POOL_ERROR_CODE,
      status: 503,
      retryDisposition: 'forbid',
    })
  })

  it('recognizes the readiness detail when the message carries no status prefix', () => {
    const message = JSON.stringify({
      pool_request_id: 'pool-request-readiness',
      type: 'error',
      error: { message: READINESS_DETAIL, type: 'api_error', retryable: false },
    })

    expect(classifyPoolFailure(message)).toMatchObject({
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
    })
  })

  it.each([
    ['a Claude api_error 5xx', `503 ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: 'Anthropic API is temporarily overloaded', retryable: false },
    })}`],
    ['a third-party 503 body', `503 ${JSON.stringify({
      error: { type: 'server_error', message: 'The server is overloaded' },
    })}`],
    ['the readiness detail without a pool request id', `503 ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', retryable: false, message: READINESS_DETAIL },
    })}`],
    ['a readiness-looking 503 without a pool retry decision', `503 ${JSON.stringify({
      pool_request_id: 'pool-request-unknown',
      type: 'error',
      error: { type: 'api_error', message: READINESS_DETAIL },
    })}`],
  ])('leaves %s to the text classifier', (_label, message) => {
    expect(classifyPoolFailure(message)).toBeUndefined()
  })

  it('requires the pool non-retryable decision before it recognizes a readiness refusal', () => {
    expect(classifyPoolFailure(readinessEnvelope({ retryable: true }))).toBeUndefined()
  })

  it('forbids a pool-marked 5xx whose detail drifted from the readiness wording', () => {
    // The pool echoes pool_request_id on every error body, including a native
    // provider failure, so the id and `retryable: false` identify a withdrawal
    // rather than the readiness refusal; the refusal keeps its own lease detail.
    const drifted = 'the lease is still being verified; retry this request later'
    expect(classifyPoolFailure(readinessEnvelope({ message: drifted }), { status: 503 })).toMatchObject({
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
      message: drifted,
    })
  })

  it('forbids a marker-only 5xx without the lease detail', () => {
    expect(classifyPoolFailure(readinessEnvelope({ message: undefined }), { status: 503 })).toMatchObject({
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
    })
  })

  it('forbids the pool wire-parity refusal from its marker alone', () => {
    // The mac-pool refusal carries neither `origin: pool` nor a `cc_pool_*` code,
    // and its body may state no retry decision at all. The response marker is the
    // whole fact, so it must outrank the text classifier's retryable SERVER.
    const envelope = `503 ${JSON.stringify({
      type: 'error',
      error: {
        type: 'cc_wire_parity_unavailable',
        message: 'the selected worker does not advertise ccWireParity',
      },
    })}`
    expect(classifyPoolFailure(envelope, { status: 503, wireParityUnavailable: true })).toMatchObject({
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
      message: 'the selected worker does not advertise ccWireParity',
    })

    for (const markerOnly of [
      `503 ${JSON.stringify({ type: 'error', error: {} })}`,
      '503 ',
      '',
    ]) {
      expect(classifyPoolFailure(markerOnly, { status: 503, wireParityUnavailable: true })).toMatchObject({
        code: POOL_ERROR_CODE,
        retryDisposition: 'forbid',
      })
    }

    // Without the marker these bodies are native failures; the text classifier
    // may retry them, which is why the marker fact must reach classification.
    expect(classifyPoolFailure(envelope, { status: 503 })).toBeUndefined()
  })

  it('forbids a native provider 5xx carrying the pool request id and retryable:false', () => {
    // The pool decorates every error body with pool_request_id and may withdraw
    // the retry there; the text classifier would otherwise call this 5xx
    // retryable, which is exactly what the pool refused.
    const native = `503 ${JSON.stringify({
      pool_request_id: 'pool-request-native',
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Anthropic API is temporarily overloaded',
        retryable: false,
      },
    })}`

    for (const response of [undefined, { status: 503 }]) {
      expect(classifyPoolFailure(native, response)).toMatchObject({
        code: POOL_ERROR_CODE,
        retryDisposition: 'forbid',
        message: 'Anthropic API is temporarily overloaded',
      })
    }
  })

  it('identifies the refusal by its lease detail regardless of the HTTP status', () => {
    const rejection = `400 ${JSON.stringify({
      pool_request_id: 'pool-request-rejected',
      type: 'error',
      error: { type: 'api_error', retryable: false, message: READINESS_DETAIL },
    })}`
    // The readiness detail identifies the pool's own refusal at any status.
    const markerOnly = JSON.stringify({
      pool_request_id: 'pool-request-marker',
      type: 'error',
      error: { type: 'api_error', retryable: false },
    })

    expect(classifyPoolFailure(rejection, { status: 400 })).toMatchObject({
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
    })
    // A marker-only 400 is a native failure: the withdrawal is 5xx-only so the
    // text classifier can see context overflow and compact.
    expect(classifyPoolFailure(markerOnly, { status: 400 })).toBeUndefined()
  })

  it.each([
    ['400', 'prompt is too long: 250000 tokens > 200000 maximum'],
    ['413', 'request_too_large: the prompt exceeds the context window'],
  ])('leaves a native %s context overflow for the text classifier', (code, message) => {
    const overflow = JSON.stringify({
      pool_request_id: 'pool-request-overflow',
      type: 'error',
      error: { type: 'invalid_request_error', message, retryable: false },
    })
    const status = Number(code)
    expect(classifyPoolFailure(`${code} ${overflow}`, { status })).toBeUndefined()
  })

  it('honors the withdrawal on a body that also names a claude origin', () => {
    expect(classifyPoolFailure(readinessEnvelope({ origin: 'claude' }))).toMatchObject({
      code: POOL_ERROR_CODE,
      retryDisposition: 'forbid',
    })
  })

  it('keeps a retryable pool code retryable when the body also echoes a request id', () => {
    const failure = classifyPoolFailure(`429 ${JSON.stringify({
      pool_request_id: 'pool-request-33',
      type: 'error',
      error: { type: 'cc_pool_rate_limited', retryable: true, message: 'account token bucket is empty' },
    })}`, { status: 429, providerRetryAfterMs: 12_000 })

    expect(failure).toMatchObject({
      code: POOL_RATE_LIMITED_CODE,
      status: 429,
      providerRetryAfterMs: 12_000,
    })
    expect(failure?.retryDisposition).toBeUndefined()
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

  it('retains the pool A-unavailable marker only when the response carries it', async () => {
    const marked = new ProviderErrorCapture(async () => new Response('no', {
      status: 503,
      headers: { 'x-cc-wire-parity-unavailable': '1' },
    }))
    await marked.fetch('http://127.0.0.1/unused', {})
    expect(marked.readResponse()).toEqual({ status: 503, wireParityUnavailable: true })
    // Classification reads the failed response, so the marker rides along.
    expect(marked.read()).toEqual({ status: 503, wireParityUnavailable: true })

    // The status alone is not the fact: an unmarked 503 retains no marker, and a
    // value outside the pool's stable `1` is not that refusal either.
    const unmarked = new ProviderErrorCapture(async () => new Response('no', { status: 503 }))
    await unmarked.fetch('http://127.0.0.1/unused', {})
    expect(unmarked.readResponse()).toEqual({ status: 503 })
    expect(unmarked.read()).toEqual({ status: 503 })

    const other = new ProviderErrorCapture(async () => new Response('no', {
      status: 503,
      headers: { 'x-cc-wire-parity-unavailable': 'true' },
    }))
    await other.fetch('http://127.0.0.1/unused', {})
    expect(other.readResponse()).toEqual({ status: 503 })
  })

  it('retains the response status and pool request id for diagnostics', async () => {
    const capture = new ProviderErrorCapture(async () => new Response('ok', {
      status: 201,
      headers: { 'x-cc-pool-request-id': 'pool-request-4' },
    }))

    await capture.fetch('http://127.0.0.1/one', {})

    expect(capture.readResponse()).toEqual({ status: 201, poolRequestId: 'pool-request-4' })
    expect(capture.read()).toBeUndefined()

    const plain = new ProviderErrorCapture(async () => new Response('ok', { status: 200 }))
    await plain.fetch('http://127.0.0.1/two', {})
    expect(plain.readResponse()).toEqual({ status: 200 })
  })

  it('retains the transport Error that rejected the fetch', async () => {
    const failure = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    const capture = new ProviderErrorCapture(() => Promise.reject(failure))

    await expect(capture.fetch('http://127.0.0.1:1/unused', {})).rejects.toBe(failure)

    expect(capture.readTransportError()).toBe(failure)
    expect(capture.readResponse()).toBeUndefined()
    expect(capture.read()).toBeUndefined()

    const connected = new ProviderErrorCapture(async () => new Response('ok'))
    await connected.fetch('http://127.0.0.1/unused', {})
    expect(connected.readTransportError()).toBeUndefined()
  })
})
