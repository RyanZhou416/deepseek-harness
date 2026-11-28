import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldBounds } from './config'
import { asRecord } from './record'
import { serviceIdentityOf } from './serviceIdentity'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { buildTimelineDetail, buildTimelineHead } from './foldWire'
import { withCost, withDetailCost, type CostSource } from './cost'
import { DetailShadow, foldLog } from './detailShadow'
import { makeFoldCache } from './foldCache'
import { HEAD_VIEW_KEYS, headViewsOf, headViewsOfValues, type HeadViews } from './headViews'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply, revisionOf } from './postRoute'
import type { ContextTimelineDetail, Snapshot } from '../shared/types'
import type { TimelineState } from './foldState'

export const DETAIL_ROUTE = '/api/dsh-context/detail'

const PAYLOAD_CACHE_MAX = 4

// DeepSeek Harness fork modification: a stored session's head costs one metadata
// stat and its detail a bounded tail window; only an explicit `full` folds the
// whole durable log. See ../../FORK_MAINTENANCE.md.
const DETAIL_WINDOW_EVENTS = 400

const TIMELINE_KEY = 'contextTimeline'

type QuickEvent = Parameters<typeof foldLog>[0][number]

interface ColdPayload {
  persistence: unknown
  revision: string
  value: ContextTimelineDetail
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
  observeSessionMetadata?(id: string, options: unknown): Promise<unknown>
  readWindow?(id: string, options: unknown): Promise<unknown>
}

interface HeaderFace {
  version?: unknown
  createdAt?: unknown
}

interface ServeOptions {
  headOnly: boolean
  full: boolean
  signal: AbortSignal
  cost?: CostSource
}

function cancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

function headPayloadOf(state: TimelineState, cost?: CostSource, views: HeadViews = {}): { rev: number; head: Snapshot } {
  return { rev: state.detailRev ?? 0, head: withCost(cost, buildTimelineHead(state)), ...views }
}

export interface DetailChannelGate {
  live: boolean
  retain(key: string, registration: unknown): void
  stateOf(session: unknown, key: string): unknown
}

interface ProjectionHandleLike {
  stateOf(session: unknown): unknown
}

function handleOf(value: unknown): ProjectionHandleLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const stateOf = (value as { stateOf?: unknown }).stateOf
  return typeof stateOf === 'function' ? value as ProjectionHandleLike : undefined
}

export function createDetailGate(ctx: Context): DetailChannelGate {
  const handles = new Map<string, ProjectionHandleLike>()
  return {
    live: false,
    retain(key: string, registration: unknown): void {
      if (registration === null || (typeof registration !== 'object' && typeof registration !== 'function')) return
      const then = (registration as { then?: unknown }).then
      if (typeof then !== 'function') return
      void Promise.resolve(registration as Promise<unknown>).then(
        (handle) => {
          const retained = handleOf(handle)
          if (retained !== undefined) handles.set(key, retained)
        },
        (error: unknown) => { ctx.logger.error(error) },
      )
    },
    stateOf(session: unknown, key: string): unknown {
      const handle = handles.get(key)
      if (handle !== undefined) return handle.stateOf(session)
      const projections = ctx.sessionProjections as unknown as { stateOf?(session: unknown, key: string): unknown } | undefined
      return typeof projections?.stateOf === 'function' ? projections.stateOf(session, key) : undefined
    },
  }
}

interface SessionsHostFace {
  get?(id: string): unknown
}

/** The header a metadata observation carries, or `undefined` when it is absent or malformed. */
function headerOf(metadata: unknown): HeaderFace | undefined {
  const header = asRecord(asRecord(metadata)?.header)
  if (header === null) return undefined
  if (typeof header.version !== 'number' || typeof header.createdAt !== 'number') return undefined
  return header
}

/** The cached `contextTimeline` wire value a metadata observation serves, when the host has one. */
function cachedHeadOf(metadata: unknown): Record<string, unknown> | undefined {
  const values = asRecord(asRecord(asRecord(metadata)?.projections)?.values)
  return values === null ? undefined : asRecord(values[TIMELINE_KEY]) ?? undefined
}

/** The head views the same metadata observation serves, when the host has them. */
function cachedHeadViewsOf(metadata: unknown): HeadViews {
  return headViewsOfValues(asRecord(asRecord(asRecord(metadata)?.projections)?.values))
}

/** The rev the cached head serves, or undefined when it carries none. */
function revOfHead(head: Record<string, unknown> | undefined): number | undefined {
  const rev = head?.detailRev
  return typeof rev === 'number' && Number.isFinite(rev) && rev >= 0 ? rev : undefined
}

/** The bounded tail window a `readWindow` observation carries, or `undefined` when unusable. */
function windowOf(read: unknown): { events: QuickEvent[]; hasMore: boolean } | undefined {
  const window = asRecord(asRecord(read)?.window)
  if (window === null || !Array.isArray(window.events)) return undefined
  return { events: window.events as QuickEvent[], hasMore: window.hasMore === true }
}

function firstSeqOf(events: readonly QuickEvent[]): number | undefined {
  let first: number | undefined
  for (const event of events) {
    const seq = asRecord(event)?.seq
    if (typeof seq === 'number' && (first === undefined || seq < first)) first = seq
  }
  return first
}

export function watchDetailChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate = makeColdReadGate(),
  gate: DetailChannelGate = createDetailGate(ctx),
  shadow: DetailShadow = new DetailShadow(ctx, bounds, coldReads, () => observeOf(ctx)),
  cost?: CostSource,
  options: { idleSweepMs?: number } = {},
): DetailChannelGate {
  const payloads = makeFoldCache<ColdPayload>(ctx, { maxEntries: PAYLOAD_CACHE_MAX, idleMs: options.idleSweepMs })
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessions'],
    path: DETAIL_ROUTE,
    label: 'dsh-context: detail route',
    gate,
    handler: (c) => {
      const sessions = c.get('sessions') as SessionsHostFace | undefined
      const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
      if (getSession === undefined) return undefined

      return async (request: Request): Promise<Response> => {
        payloads.touch()
        const read = await readBody(request)
        if (!read.ok) return read.response
        const body = read.body
        const sessionId = body !== null && typeof body === 'object'
          ? (body as { sessionId?: unknown }).sessionId
          : undefined
        const headOnly = body !== null && typeof body === 'object' && (body as { head?: unknown }).head === true
        const full = body !== null && typeof body === 'object' && (body as { full?: unknown }).full === true
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('dsh-context/bad-request', 'missing sessionId')
        }
        const signal = request.signal
        try {
          const session = getSession(sessionId)
          if (session !== undefined && session !== null) {
            const state = gate.stateOf(session, TIMELINE_KEY) as TimelineState | undefined
            if (state === undefined) return reply({ ok: true, value: null })
            if (headOnly) return reply({ ok: true, value: headPayloadOf(state, cost, headViewsOf(ctx, session)) })
            const detailState = await shadow.stateOf(sessionId)
            if (detailState !== null) return reply({ ok: true, value: withDetailCost(cost, buildTimelineDetail(detailState, bounds)) })
            // Above the fold cap a live Session's detail comes from its stored tail window, as for a cold one.
          }
          const query = c.get('sessionQuery') as SessionQueryFace | undefined
          const value = await serveCold(ctx, query, sessionId, bounds, coldReads, payloads, {
            headOnly,
            full,
            signal,
            ...(cost === undefined ? {} : { cost }),
          })
          if (cancelled(signal)) return failure('dsh-context/aborted', 'request cancelled')
          return reply({ ok: true, value: value ?? null })
        } catch (err) {
          if (cancelled(signal)) return failure('dsh-context/aborted', 'request cancelled')
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
  return gate
}

/**
 * Serve one stored session: the head from its projection checkpoint with no log
 * read, the detail from a bounded tail window marked `partial`, and the whole
 * log only for an explicit `full` request.
 */
async function serveCold(
  ctx: Context,
  query: SessionQueryFace | undefined,
  sessionId: string,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  payloads: ReturnType<typeof makeFoldCache<ColdPayload>>,
  options: ServeOptions,
): Promise<unknown> {
  const { headOnly, full, signal, cost } = options
  if (query === undefined) return null
  let metadata: unknown
  if (typeof query.observeSessionMetadata === 'function') {
    try {
      metadata = await query.observeSessionMetadata(sessionId, {
        signal,
        projectionKeys: [TIMELINE_KEY, ...HEAD_VIEW_KEYS],
      })
    } catch {
      if (cancelled(signal)) return null
      metadata = undefined
    }
  }
  if (cancelled(signal)) return null
  const header = headerOf(metadata)
  const cachedHead = cachedHeadOf(metadata)
  const cachedViews = cachedHeadViewsOf(metadata)
  if (typeof query.observeSessionMetadata !== 'function') {
    // A host that predates the log-free projection stat keeps the legacy whole-log fold.
    return serveLegacyCold(ctx, query, sessionId, bounds, coldReads, payloads, headOnly, signal, cost)
  }
  if (headOnly) {
    if (cachedHead === undefined) return null
    return {
      rev: revOfHead(cachedHead) ?? 0,
      head: withCost(cost, cachedHead),
      ...cachedViews,
    }
  }
  if (full) return serveFullDetail(ctx, query, sessionId, bounds, coldReads, payloads, signal, cost)
  if (header === undefined) return null
  if (typeof query.readWindow !== 'function') return null
  let read: unknown
  try {
    read = await query.readWindow(sessionId, { signal, maxEvents: DETAIL_WINDOW_EVENTS })
  } catch {
    if (cancelled(signal)) return null
    read = undefined
  }
  if (cancelled(signal)) return null
  const window = windowOf(read)
  if (window === undefined) return null
  const folded = await foldLog(window.events, bounds, () => cancelled(signal))
  /* v8 ignore next 1 */
  if (cancelled(signal)) return null
  const detail = buildTimelineDetail(folded.state, bounds)
  const rev = revOfHead(cachedHead)
  const first = firstSeqOf(window.events)
  const partial = first === undefined || !window.hasMore ? undefined : { fromSeq: first }
  return withDetailCost(cost, {
    ...detail,
    ...(rev === undefined ? {} : { rev }),
    ...(cachedHead === undefined ? {} : { head: withCost(cost, cachedHead) }),
    ...(partial === undefined ? {} : { partial }),
  })
}

/** Fold the complete durable log for an explicit `full` request; the only whole-log read left. */
async function serveFullDetail(
  ctx: Context,
  query: SessionQueryFace,
  sessionId: string,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  payloads: ReturnType<typeof makeFoldCache<ColdPayload>>,
  signal: AbortSignal,
  cost?: CostSource,
): Promise<unknown> {
  const observe = typeof query.observeSession === 'function' ? query.observeSession.bind(query) : undefined
  if (observe === undefined) return null
  const value = await coldReads.admit(async () => {
    const observation = await observe(sessionId, { projectionMode: 'none', signal })
    const release = leaseOf(observation)
    try {
      const persistence = serviceIdentityOf(ctx.get('sessionPersistence'))
      const revision = revisionOf(observation)
      if (revision !== undefined) {
        const hit = payloads.get(sessionId, cached => cached.revision === revision && cached.persistence === persistence)
        if (hit !== undefined) return withDetailCost(cost, hit.value)
      }
      const events = asRecord(observation)?.events
      if (!Array.isArray(events)) return null
      const folded = await foldLog(events, bounds, () => cancelled(signal))
      if (cancelled(signal)) return null
      const detail = buildTimelineDetail(folded.state, bounds)
      if (revision === undefined) return withDetailCost(cost, detail)
      payloads.set(sessionId, { persistence, revision, value: detail })
      return withDetailCost(cost, detail)
    } finally {
      release()
    }
  })
  return value ?? null
}
/** Serve a host without the metadata face: one whole-log fold, head included. */
async function serveLegacyCold(
  ctx: Context,
  query: SessionQueryFace,
  sessionId: string,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  payloads: ReturnType<typeof makeFoldCache<ColdPayload>>,
  headOnly: boolean,
  signal: AbortSignal,
  cost?: CostSource,
): Promise<unknown> {
  const observe = typeof query.observeSession === 'function' ? query.observeSession.bind(query) : undefined
  if (observe === undefined) return null
  const value = await coldReads.admit(async () => {
    const observation = await observe(sessionId, { projectionMode: 'none', signal })
    const release = leaseOf(observation)
    try {
      const persistence = serviceIdentityOf(ctx.get('sessionPersistence'))
      const revision = revisionOf(observation)
      if (revision !== undefined) {
        const hit = payloads.get(sessionId, cached => cached.revision === revision && cached.persistence === persistence)
        if (hit !== undefined) {
          if (headOnly) {
            /* v8 ignore next 2 */
            return hit.value.head === undefined
              ? { rev: hit.value.rev }
              : { rev: hit.value.rev, head: withCost(cost, hit.value.head) }
          }
          return withDetailCost(cost, hit.value)
        }
      }
      const events = asRecord(observation)?.events
      if (!Array.isArray(events)) return null
      const folded = await foldLog(events as SessionEvent[], bounds, () => signal.aborted)
      /* v8 ignore next 1 */
      if (cancelled(signal)) return null
      if (headOnly) return headPayloadOf(folded.state, cost)
      const detail = buildTimelineDetail(folded.state, bounds)
      if (revision === undefined) return withDetailCost(cost, detail)
      payloads.set(sessionId, { persistence, revision, value: detail })
      return withDetailCost(cost, detail)
    } finally {
      release()
    }
  })
  return value ?? null
}
