/**
 * Generated from the mac-pool `swift/contracts/error-catalog.json`.
 * Version 1.1.0, sha256 3f40dfb188bed6a135f3ab148e65079d3f9141282915d68e2622371e05056668.
 *
 * generated, do not edit.
 *
 * Regenerate: `python scripts/generate-error-catalog.py --dsh-root <deepseek-harness checkout>`.
 */

/** One entry of the shared pool error catalog. */
export interface PoolErrorCatalogEntry {
  /** Unique wire error code; the only code the pool publishes. */
  readonly type: string
  /** Generated internal constant, shared with the Swift table. */
  readonly code: string
  /** Error producer. */
  readonly origin: 'claude' | 'pool'
  /** HTTP status the pool publishes for this code. */
  readonly httpStatus: number
  /** Failure scope the pool publishes by default. */
  readonly scope: 'request' | 'session' | 'account' | 'model' | 'pool'
  /** Pool-side retry classification. */
  readonly retryable: boolean
  /** Client action the pool publishes. */
  readonly clientAction: 'stop' | 'retry_same' | 'retry_after' | 'refresh'
  /** Pool-side recovery action. */
  readonly poolAction:
    | 'terminal'
    | 'session_backoff'
    | 'account_cooldown'
    | 'refresh'
    | 'rematch_turn_boundary'
    | 'none'
  /** Localization key for the human-readable message. */
  readonly messageKey: string
  /** Client-facing retry guidance appended to the provider message. */
  readonly clientGuidance: string
}

/** Version of the catalog document these entries were generated from. */
export const POOL_ERROR_CATALOG_VERSION = '1.1.0'

/** SHA-256 of the catalog document these entries were generated from. */
export const POOL_ERROR_CATALOG_SHA256 = '3f40dfb188bed6a135f3ab148e65079d3f9141282915d68e2622371e05056668'

/** Catalog entries keyed by their unique wire code. */
export const POOL_ERROR_CATALOG = {
  cc_pool_capacity_exhausted: {
    type: 'cc_pool_capacity_exhausted',
    code: 'POOL_CAPACITY',
    origin: 'pool',
    httpStatus: 429,
    scope: 'pool',
    retryable: true,
    clientAction: 'retry_after',
    poolAction: 'none',
    messageKey: 'pool.error.capacity_exhausted',
    clientGuidance: 'all pool session slots are in use',
  },
  cc_pool_rate_limited: {
    type: 'cc_pool_rate_limited',
    code: 'POOL_RATE_LIMITED',
    origin: 'pool',
    httpStatus: 429,
    scope: 'session',
    retryable: true,
    clientAction: 'retry_after',
    poolAction: 'session_backoff',
    messageKey: 'pool.error.rate_limited',
    clientGuidance: 'the pool rate limit applies to this request',
  },
  cc_pool_session_busy: {
    type: 'cc_pool_session_busy',
    code: 'POOL_SESSION_BUSY',
    origin: 'pool',
    httpStatus: 409,
    scope: 'session',
    retryable: false,
    clientAction: 'stop',
    poolAction: 'none',
    messageKey: 'pool.error.session_busy',
    clientGuidance: 'wait for the current turn to finish before retrying',
  },
  cc_pool_no_available_account: {
    type: 'cc_pool_no_available_account',
    code: 'POOL_NO_ACCOUNT',
    origin: 'pool',
    httpStatus: 503,
    scope: 'pool',
    retryable: true,
    clientAction: 'retry_after',
    poolAction: 'none',
    messageKey: 'pool.error.no_available_account',
    clientGuidance: 'no healthy pool account is currently available',
  },
  cc_pool_request_closed: {
    type: 'cc_pool_request_closed',
    code: 'POOL_REQUEST_CLOSED',
    origin: 'pool',
    httpStatus: 409,
    scope: 'request',
    retryable: true,
    clientAction: 'retry_same',
    poolAction: 'terminal',
    messageKey: 'pool.error.request_closed',
    clientGuidance: 'the pool already closed this client request id; only a new attempt with a fresh id is safe',
  },
} as const satisfies Record<string, PoolErrorCatalogEntry>

/** Wire error codes the catalog defines. */
export type PoolErrorCatalogType = keyof typeof POOL_ERROR_CATALOG
