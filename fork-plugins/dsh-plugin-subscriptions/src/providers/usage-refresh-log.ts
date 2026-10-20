/**
 * Append-only diagnostics for explicit usage refresh attempts.
 *
 * The log identifies whether a Settings-page Refresh reached the Host, how
 * long its read took, and the safe outcome the cache observed. It deliberately
 * never carries a provider message, request body, token, or profile data.
 * @module usage-refresh-log
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Which explicit refresh path the client requested. */
export type UsageRefreshMode = 'force' | 'refresh'

/** One line of the usage refresh log. */
export interface UsageRefreshTrace {
  /** Epoch milliseconds the request started. */
  at: number
  /** Provider route the read targeted. */
  provider: string
  /** Canonical account key, as stored in the usage cache. */
  account: string
  /** Explicit refresh mode; local snapshot reads are not logged. */
  mode: UsageRefreshMode
  /** Whether this line records the start, success, or failure. */
  phase: 'start' | 'ok' | 'error'
  /** Whole milliseconds spent in the read, on `ok`/`error` lines. */
  durationMs?: number
  /** Usage cache state reported by a completed read. */
  state?: string
  /** Safe failure classification reported by the usage cache. */
  reason?: string
  /** HTTP status observed by a failed read. */
  status?: number
  /** Bounded provider OAuth code observed by a failed read. */
  code?: string
  /** Stable harness error code when the read threw before producing usage. */
  errorCode?: string
  /** Safe origin class of the failure. */
  cause?: string
  /** Platform transport code when the origin was a transport failure. */
  causeCode?: string
}

/** A fixed, bounded code is safe to write; free-form text is not. */
function safeCode(value: string | undefined): string | undefined {
  return value !== undefined && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value : undefined
}

/**
 * Serialize one trace line without optional empty fields.
 * @param trace - the event to serialize.
 * @returns one JSON line ending in a newline.
 */
export function formatUsageRefreshTrace(trace: UsageRefreshTrace): string {
  const code = safeCode(trace.code)
  const errorCode = safeCode(trace.errorCode)
  const causeCode = safeCode(trace.causeCode)
  return `${JSON.stringify({
    v: 1,
    at: trace.at,
    provider: trace.provider,
    account: trace.account,
    mode: trace.mode,
    phase: trace.phase,
    ...trace.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(trace.durationMs)) },
    ...trace.state === undefined ? {} : { state: trace.state },
    ...trace.reason === undefined ? {} : { reason: trace.reason },
    ...trace.cause === undefined ? {} : { cause: trace.cause },
    ...trace.status === undefined ? {} : { status: trace.status },
    ...code === undefined ? {} : { code },
    ...errorCode === undefined ? {} : { errorCode },
    ...causeCode === undefined ? {} : { causeCode },
  })}\n`
}

/**
 * Append one safe refresh line. The parent directory is created on first use.
 * @param file - absolute log path.
 * @param trace - the event to append.
 */
export async function appendUsageRefreshTrace(file: string, trace: UsageRefreshTrace): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, formatUsageRefreshTrace(trace), { mode: 0o600 })
}
