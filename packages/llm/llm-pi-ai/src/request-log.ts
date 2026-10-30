/**
 * Append-only NDJSON file for request diagnostics.
 *
 * The process logger keeps its bounded in-memory ring; this sink is the durable
 * copy a deployment can read after the fact, for example when a request never
 * reached the pool. It writes one JSON object per line with the identity and
 * outcome fields the logger records, and it writes nothing else: no messages,
 * request bodies, credentials, token counts, or session titles. The endpoint is
 * the route's origin and path only, and provider failure text is not persisted,
 * because either can carry a credential or request content that outlives the
 * process; the process logger remains the place for live failure text.
 *
 * Files rotate by size, the oldest rotation is dropped first, and the retained
 * set is bounded so a long-running host cannot grow the log without limit. A
 * failed write never reaches the caller: the first failure is reported once
 * through the supplied warning channel, and later records keep trying so a
 * transient failure recovers on its own.
 *
 * @module dsh-llm-pi-ai/request-log
 */
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { PiAiRequestDiagnostic } from './adapter.ts'

/** Bytes one request-log file holds before it rotates (16 MiB). */
export const DEFAULT_REQUEST_LOG_MAX_FILE_BYTES = 16 * 1024 * 1024

/** Files a request log retains, including the active one (8). */
export const DEFAULT_REQUEST_LOG_MAX_FILES = 8

/** Upper bound on everything a request log retains (128 MiB). */
export const MAX_REQUEST_LOG_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * The fields one persisted record may carry, in written order.
 *
 * `message` and `cause` are deliberately absent: they are provider-authored
 * text that can echo request content or credentials, and no bounded filter can
 * take that back out of a file that outlives the process. The process logger
 * still records them for live diagnosis.
 */
const RECORD_FIELDS = [
  'kind',
  'provider',
  'model',
  'endpoint',
  'sessionId',
  'clientRequestId',
  'stream',
  'attempt',
  'status',
  'poolRequestId',
  'code',
] as const

/** One diagnostic value read through the persisted vocabulary. */
type RecordValues = Partial<Record<(typeof RECORD_FIELDS)[number], unknown>>

/**
 * Default request-log path: the harness home's `logs` directory, beside the
 * launch diagnostics a deployment already collects.
 * @param owner - file-name prefix; the pi-ai adapter owns the default so a
 *   fixed-route plugin passes its own name and never shares one file.
 * @returns the absolute default NDJSON file path.
 */
export function defaultRequestLogPath(owner: string = 'llm-pi-ai'): string {
  return join(resolveDshHome(), 'logs', `${owner}-requests.jsonl`)
}

/**
 * Remove credentials and query secrets from one endpoint URL.
 *
 * The durable record only needs to identify where a request went, while a
 * configured `baseURL` may embed a credential in its userinfo or query string.
 * Origin and path stay, so routes on one host remain distinguishable.
 * @param endpoint - the route's effective endpoint URL.
 * @returns the endpoint without userinfo, query, or fragment.
 */
export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (url.username === '' && url.password === '' && url.search === '' && url.hash === '') return endpoint
    // `URL` normalizes a missing path to `/`; never invent one the endpoint did
    // not spell.
    const root = url.pathname === '/' && /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(endpoint)
    return `${url.origin}${root ? '' : url.pathname}`
  } catch {
    const address = endpoint.replace(/[?#].*$/s, '')
    return address.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1')
  }
}

/**
 * Serialize one diagnostic as a single NDJSON line.
 *
 * The record is projected onto an explicit field list instead of spreading the
 * event: a later adapter field that carries content therefore cannot leak into
 * the file. The endpoint is reduced to its origin and path, and failure text is
 * not part of the record at all. Optional fields are omitted rather than written
 * as `null`, so a request record and a minimal response record stay
 * distinguishable.
 * @param event - the request or settled-response diagnostic to persist.
 * @param now - timestamp to stamp the record with.
 * @returns the record as one line, terminated by `\n`.
 */
export function requestLogLine(event: PiAiRequestDiagnostic, now: Date = new Date()): string {
  const values: RecordValues = event
  const record: Record<string, unknown> = { ts: now.toISOString() }
  for (const field of RECORD_FIELDS) {
    const value = values[field]
    if (value !== undefined) record[field] = value
  }
  // Replacing the value keeps the field at its listed position.
  record['endpoint'] = redactEndpoint(event.endpoint)
  return `${JSON.stringify(record)}\n`
}

/** The path and rotation bounds one request log runs with. */
export interface ResolvedRequestLogConfig {
  /** Absolute NDJSON file path. */
  readonly path: string
  /** Bytes one file holds before it rotates. */
  readonly maxFileBytes: number
  /** Files retained in the rotation, including the active one. */
  readonly maxFiles: number
  /** Whether every route is persisted instead of only `sessionHeaders` routes. */
  readonly allRoutes: boolean
}

/** A rotation step whose path does not exist is not an error. */
async function tolerateMissing(step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
}

/**
 * Durable NDJSON sink for one configuration's request diagnostics.
 *
 * One instance belongs to one mounted plugin: every record it accepts is
 * queued in call order, so the request line always precedes the response line
 * that settles it. Disposal calls {@link close}, which stops new records and
 * waits for the queue, so a clean shutdown does not lose a diagnostic that the
 * session already produced.
 */
export class RequestDiagnosticLog {
  private readonly config: ResolvedRequestLogConfig
  private readonly warn: (message: string) => void
  private queue: Promise<void> = Promise.resolve()
  /** Current active-file size. */
  private bytes = 0
  /** Whether {@link bytes} already reflects the file on disk. */
  private observed = false
  /** Whether the one permitted write-failure warning has been emitted. */
  private warned = false
  /** Whether {@link close} already stopped admission. */
  private closed = false

  /**
   * @param config - resolved file path and rotation bounds.
   * @param warn - receives the first write failure; later failures stay silent.
   */
  constructor(config: ResolvedRequestLogConfig, warn: (message: string) => void) {
    this.config = config
    this.warn = warn
  }

  /**
   * Queue one diagnostic record.
   *
   * This method performs no I/O on the caller's path: it appends to the write
   * queue and returns, so a slow or failing filesystem never delays the model
   * request that produced the record.
   * @param event - the request or settled-response diagnostic to persist.
   */
  append(event: PiAiRequestDiagnostic): void {
    if (this.closed) return
    const line = requestLogLine(event)
    this.queue = this.queue.then(() => this.record(line))
  }

  /**
   * Stop accepting records and wait for every queued write.
   * @returns a promise that settles when the queue has drained.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.queue
  }

  /** Append one line, rotating first when it would cross the file bound. */
  private async record(line: string): Promise<void> {
    try {
      await this.ensureSize()
      const bytes = Buffer.byteLength(line)
      if (this.bytes > 0 && this.bytes + bytes > this.config.maxFileBytes) {
        await this.rotate()
      }
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      await appendFile(this.config.path, line, { mode: 0o600 })
      this.bytes += bytes
    } catch (error: unknown) {
      if (this.warned) return
      this.warned = true
      this.warn(`llm-pi-ai: request log "${this.config.path}" cannot be written (${String(error)})`)
    }
  }

  /** Read the active file size once, treating an absent file as empty. */
  private async ensureSize(): Promise<void> {
    if (this.observed) return
    try {
      this.bytes = (await stat(this.config.path)).size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      this.bytes = 0
    }
    this.observed = true
  }

  /**
   * Move the active file into the rotation and start a fresh one.
   *
   * The oldest rotation is deleted before anything moves, so no retained file
   * is ever overwritten. A single-file rotation simply removes the active file:
   * there is no older file to keep.
   */
  private async rotate(): Promise<void> {
    if (this.config.maxFiles === 1) {
      await tolerateMissing(() => unlink(this.config.path))
    } else {
      await tolerateMissing(() => unlink(`${this.config.path}.${this.config.maxFiles - 1}`))
      for (let index = this.config.maxFiles - 2; index >= 1; index -= 1) {
        await tolerateMissing(() => rename(`${this.config.path}.${index}`, `${this.config.path}.${index + 1}`))
      }
      await tolerateMissing(() => rename(this.config.path, `${this.config.path}.1`))
    }
    this.bytes = 0
  }
}
