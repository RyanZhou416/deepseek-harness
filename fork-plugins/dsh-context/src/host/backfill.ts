/**
 * The projection warm-up: a one-pass background backfill that gives every
 * stored session its `contextActivity` + `contextTimeline` rows — run on
 * demand, the first time its only reader opens.
 *
 * The overview's heatmap, KPI band, and session cards read the session
 * list's projection column, which serves durable cache rows only (zero-I/O).
 * A session folded before a projection unit existed — `contextActivity` on
 * upgrade, `contextTimeline` for a session that predates the plugin — or
 * whose rows went version-stale (a `stateVersion` bump, e.g. the timeline's
 * `lastUser` preview) has no usable row until it next goes live, so the
 * heatmap would stay empty, the KPI band would undercount, and the cards
 * would show their no-data note and no preview indefinitely. The cache's
 * cold-read ladder (`sessionProjectionCache.coldSnapshot`) closes exactly
 * that gap: read the stored log once, seed each unit from its cached rows,
 * fold the remainder, and write the refreshed checkpoint back (the cache
 * does the write-back itself).
 *
 * The pass runs when summoned, not at boot. The dashboard is the rows' only
 * reader, so an at-startup warm-up would make every deployment cold-read its
 * whole corpus on every boot whether the dashboard is ever opened or not —
 * and a legacy log the running harness refuses to migrate (a v0 artifact
 * carrying events outside the released migration surface) would re-attempt
 * and re-report on every boot, for nothing. Instead the client POSTs
 * `/api/dsh-context/backfill` when the dashboard first opens
 * (overviewPanel.tsx); the host answers at once and runs the pass once per
 * process — later opens (and later POSTs) are no-ops, and the pass arms
 * regardless of which of the two halves composes first.
 *
 * OPTIONAL BY CONTRACT: the connection / sessionQuery / sessionProjectionCache
 * / sessionPersistence / sessions services compose on every standard
 * deployment, but a deployment may strip any of them — both halves ride
 * deferred injects, every face is re-proved structurally before use, and
 * each session's read is isolated (one unreadable log costs just itself,
 * logged). A deployment whose client cannot mount the trigger route (no
 * connection service, no exact-route registry) simply never runs the pass —
 * the same deployments could not open the dashboard to read the rows anyway.
 * Live sessions are skipped: they fold every unit themselves and checkpoint
 * on the mandatory points, so a cold write would only race them. Skips are
 * accounted, not spammed: a log the harness refuses to migrate is permanent
 * and source-side — its per-session detail drops to debug and the pass ends
 * with one summary info line; only unexpected per-session failures keep
 * their own warn.
 */

import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** The plugin's warm-up trigger route, under the authenticated `/api` fence. */
export const BACKFILL_ROUTE = '/api/dsh-context/backfill'

/** The corpus listing face, as consumed (re-proved at runtime). */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

/** The cache's two cold-path verbs, as consumed. */
interface ProjectionCacheLike {
  cachedSnapshot(header: SessionHeader, inheritedEventCount: unknown, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

/** One persistence read handle, as consumed (mirrors dsh-session-query's readColdSessionLog). */
interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
}

/** The host `connection` service, as far as the trigger route consumes it. */
interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Response | Promise<Response>
    }): () => void
  }
}

/**
 * Inter-session pacing so a multi-hundred-session backfill never starve the
 * host: each cold read is a full durable-log decode, and a boot-time host
 * under sustained read pressure stalls its own client handshake (the
 * workspace sidebar rides it), so the pass breathes between sessions.
 */
const YIELD_MS = 100

/**
 * The `name` family dsh raises for a durable log it cannot interpret. The
 * format edge throws `SessionFormatUnsupportedMigrationError`, but the
 * persistence seam translates it — together with every other "intact yet not
 * interpretable" refusal — into `SessionFormatUnsupportedError` before the
 * error escapes (issue #75): classify by the family prefix, since either
 * exact name may be the one that arrives.
 */
const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** One listed record's header, re-proved: id and cwd are the two fields the run relies on. */
function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

/** Whether the cache already serves BOTH projection rows for this header (nothing to backfill). */
function servesRows(cache: ProjectionCacheLike, header: SessionHeader): boolean {
  try {
    // Unseeded sessions carry no inherited prefix (cut 0); a seeded (forked)
    // header's real cut only arrives with the log read below, so the probe
    // misses and the session takes the cold-read path — correct either way.
    // Both keys must be served: a version-stale row (the timeline's head
    // gained `lastUser` at stateVersion 20) reads as absent here, so the
    // session's stale rows get their one cold refold at startup.
    const block = asRecord(cache.cachedSnapshot(header, SessionLogOffset(0), ['contextActivity', 'contextTimeline']))
    const values = asRecord(block?.values)
    return values !== null
      && values.contextActivity !== undefined
      && values.contextTimeline !== undefined
  } catch {
    return false
  }
}

/** Read one stored log through a read handle, mirroring dsh-session-query's readColdSessionLog. */
async function readColdLog(
  persistence: PersistenceLike,
  id: string,
  signal: AbortSignal,
): Promise<{ header: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }> {
  const handle = await persistence.open(id, 'read', { signal })
  let events: readonly SessionEvent[]
  try {
    const raw: unknown = await handle.read(0, undefined, { signal })
    // The handle's read result is re-proved: a hostile persistence serves an empty log, never a throw.
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result : []
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch { /* the read failure is the actionable cause */ }
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
  }
}

/**
 * Whether one session is live (folds for itself — a cold write would only
 * race its own checkpoints). A throwing registry read conservatively skips
 * the session too: better to leave a row unfolded than to write over a
 * possibly-live one.
 */
function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

/**
 * Whether the cold read failed because the running harness refuses this log's
 * format — a permanent, source-side refusal (the artifact is left unchanged,
 * so retrying cannot succeed). Matched by the error's documented `name`, so no
 * dsh symbol needs importing and every supported baseline classifies alike: an
 * unknown error shape just falls to the warn path.
 */
function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

/** The error's printable form — a hostile error may throw on its own toString. */
function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/**
 * Arm the warm-up behind its trigger route. The route flips `requested`
 * when the dashboard first opens; the cold-path faces compose `launch`.
 * Either half may land first; the first request after both launches the one
 * pass, and every later request is a no-op. Returns the deferred injects'
 * disposer (abort on unload).
 */
export function watchActivityBackfill(ctx: Context): () => void {
  let requested = false
  let started = false
  let launch: (() => void) | null = null
  const tryLaunch = (): void => {
    if (!requested || started || launch === null) return
    started = true
    launch()
  }

  const routeFiber = ctx.inject(['connection'], (c) => {
    const connection = c.get('connection') as ConnectionHostFace | undefined
    // Bind at extraction (an unbound hand-off loses `this` on the real face).
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (register === undefined) return
    try {
      c.effect(() => register({
        path: BACKFILL_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: () => {
          requested = true
          tryLaunch()
          return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
        },
      }), 'dsh-context: backfill route')
    } catch {
      // A hostile or rejecting registry leaves the route absent — the pass
      // simply never arms.
      return
    }
  })

  const runnerFiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
    const injected = raw as unknown as {
      sessionQuery?: unknown
      sessionProjectionCache?: unknown
      sessionPersistence?: unknown
      sessions?: unknown
    }
    const query = asRecord(injected.sessionQuery)
    const cache = asRecord(injected.sessionProjectionCache)
    const persistence = asRecord(injected.sessionPersistence)
    if (query === null || typeof query.listSessions !== 'function') return
    if (cache === null
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function') return
    if (persistence === null || typeof persistence.open !== 'function') return
    const sessions = asRecord(injected.sessions)

    const abort = new AbortController()
    const run = async (): Promise<void> => {
      const listed = await (query as unknown as SessionQueryLike).listSessions(abort.signal)
      if (!Array.isArray(listed)) return
      let folded = 0
      let refused = 0
      for (const record of listed) {
        if (abort.signal.aborted) return
        const header = headerOf(record)
        if (header === null || typeof header.cwd !== 'string') continue
        if (isLive(sessions, header.id)) continue
        if (servesRows(cache as unknown as ProjectionCacheLike, header)) continue
        try {
          const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, abort.signal)
          // The handle's header is authoritative (fixed at open); the listed
          // one was only the probe's identity witness.
          ;(cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
          folded++
        } catch (error: unknown) {
          if (isUnsupportedFormat(error)) {
            // Permanent and source-side: the per-session detail drops to
            // debug; the summary below is the pass's only above-debug word.
            refused++
            ctx.logger.debug(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          } else {
            ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          }
        }
        // Pace the pass: hundreds of cold reads in one breath would starve the host.
        await new Promise(resolve => setTimeout(resolve, YIELD_MS))
      }
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
      if (refused > 0) {
        ctx.logger.info(`dsh-context: projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
    }
    launch = () => {
      void run().catch((error: unknown) => {
        if (!abort.signal.aborted) ctx.logger.warn(`dsh-context: projection backfill stopped early (${messageOf(error)})`)
      })
    }
    tryLaunch()
    return () => { abort.abort() }
  })

  return () => {
    for (const fiber of [routeFiber, runnerFiber]) {
      const handle = fiber as { dispose?: () => unknown } | undefined
      void handle?.dispose?.()
    }
  }
}
