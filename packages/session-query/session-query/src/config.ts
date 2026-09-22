/** Public configuration and typed failures for the combined session-query service. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Default maximum `before`/`after` raw-event window. */
export const SESSION_QUERY_READ_WINDOW_MAX = 50

/** Default maximum number of concurrent persisted-log reads in one batch read. */
export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4

/** Default maximum number of cold prepared-Session observations retained for reuse. */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/** Largest physical Session artifact cached after a cold observation by default. */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024

/** Backend-independent configuration inherited by every session-query implementation. */
export interface Config {
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number
  /** Maximum concurrent persisted-log reads in one batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /**
   * Maximum cold prepared-Session observations retained for reuse, keyed by
   * durable revision. Entries pinned by active observation leases do not count
   * against this bound until released. Defaults to 5.
   */
  preparedSessionCacheSize?: number
  /**
   * Maximum physical artifact size retained after a cold observation.
   * Larger artifacts remain readable but release their prepared Session with
   * the last observation lease. Backends without a size report use the entry
   * count only. Defaults to 4 MiB; zero disables reuse for sized artifacts.
   */
  preparedSessionCacheMaxArtifactBytes?: number
}

/** Stable machine-routable failure taxonomy for session reads, traces, and search. */
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

/** Typed session-query failure whose `code` is one closed taxonomy member. */
export class SessionQueryError extends HarnessError {
  declare readonly code: SessionQueryErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
