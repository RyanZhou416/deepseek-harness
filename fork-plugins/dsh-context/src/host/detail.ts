import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import { buildTimelineDetail, buildTimelineHead } from './foldWire'
import { HEAD_VIEW_KEYS, headViewsOf, headViewsOfValues, registryReaderOf, type HeadViews, type TimelineReader } from './projectionHandle'
import { TIMELINE_STATE_VERSION, timelineStateSchema } from './timeline'
import type { ContextTimelineDetail, Snapshot } from '../shared/types'
import type { TimelineState } from './foldState'

export const DETAIL_ROUTE = '/api/dsh-context/detail'

const FOLD_YIELD_EVENTS = 1_000

const PAYLOAD_CACHE_MAX = 4

// DeepSeek Harness fork modification: a cold detail is served from the persisted projection
// checkpoint, and the fallback reads a bounded tail window instead of the whole durable log.
// See ../../FORK_MAINTENANCE.md.
const CACHE_DOMAIN = 'session_projcache'

const CACHE_TABLE = 'sessions'

const CACHE_KEY = 'contextTimeline'

const DETAIL_WINDOW_EVENTS = 400

interface ColdPayload {
  persistence: unknown
  revision: string
  value: ContextTimelineDetail
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function revisionOf(observation: unknown): string | undefined {
  const revision = asRecord(observation)?.revision
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

function headPayloadOf(state: TimelineState): { rev: number; head: Snapshot } {
  return { rev: state.detailRev ?? 0, head: buildTimelineHead(state) }
}

function headPayloadOfValue(value: Record<string, unknown>): { rev: number; head: unknown } {
  return { rev: typeof value.detailRev === 'number' ? value.detailRev : 0, head: value }
}

export interface DetailChannelGate {
  live: boolean
}

interface SessionsHostFace {
  get?(id: string): unknown
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
  observeSessionMetadata?(id: string, options: unknown): Promise<unknown>
  readWindow?(id: string, options: unknown): Promise<unknown>
}

interface StorageDomainFace {
  get?(name: string): { table?(name: string): { get?(key: string): unknown } } | undefined
}

interface HeaderFace {
  version?: unknown
  createdAt?: unknown
  cwd?: unknown
  isSeeded?: unknown
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
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
  return values === null ? undefined : asRecord(values[CACHE_KEY]) ?? undefined
}

/** The head views the same metadata observation serves, when the host has them. */
function cachedHeadViewsOf(metadata: unknown): HeadViews {
  return headViewsOfValues(asRecord(asRecord(asRecord(metadata)?.projections)?.values))
}

/** The persisted projection state bound to this exact session lifecycle, read with no log I/O. */
function checkpointStateOf(ctx: Context, sessionId: string, header: HeaderFace): TimelineState | undefined {
  let domain: ReturnType<NonNullable<StorageDomainFace['get']>> | undefined
  try {
    domain = (ctx.get('storageDomain') as StorageDomainFace | undefined)?.get?.(CACHE_DOMAIN)
  } catch {
    return undefined
  }
  let table: { get?(key: string): unknown } | undefined
  try {
    table = domain?.table?.(CACHE_TABLE)
  } catch {
    return undefined
  }
  let record: unknown
  try {
    record = table?.get?.(sessionId)
  } catch {
    return undefined
  }
  const identity = asRecord(asRecord(record)?.identity)
  const rows = asRecord(asRecord(record)?.rows)
  if (identity === null || rows === null) return undefined
  if (identity.formatVersion !== header.version) return undefined
  if (identity.createdAt !== header.createdAt) return undefined
  if (identity.cwd !== header.cwd) return undefined
  if ((identity.isSeeded ?? false) !== (header.isSeeded ?? false)) return undefined
  if ((identity.inheritedEventCount ?? 0) !== 0) return undefined
  const row = asRecord(rows[CACHE_KEY])
  if (row === null || row.ver !== TIMELINE_STATE_VERSION) return undefined
  const parsed = timelineStateSchema.safeParse(row.val)
  return parsed.success ? parsed.data : undefined
}

/** The bounded tail window a `readWindow` observation carries, or `undefined` when unusable. */
function windowOf(read: unknown): { events: QuickEvent[]; hasMore: boolean } | undefined {
  const window = asRecord(asRecord(read)?.window)
  if (window === null || !Array.isArray(window.events)) return undefined
  return { events: window.events as QuickEvent[], hasMore: window.hasMore === true }
}

type QuickEvent = Parameters<typeof applyTimeline>[1]

function firstSeqOf(events: readonly QuickEvent[]): number | undefined {
  let first: number | undefined
  for (const event of events) {
    const seq = asRecord(event)?.seq
    if (typeof seq === 'number' && (first === undefined || seq < first)) first = seq
  }
  return first
}

/** Fold a bounded event slice without ever blocking the event loop for more than a chunk. */
async function foldSlice(
  events: readonly QuickEvent[],
  bounds: FoldBounds,
  signal: AbortSignal | undefined,
): Promise<TimelineState | undefined> {
  let state = createTimelineState()
  let folded = 0
  for (const event of events) {
    if (signal?.aborted === true) return undefined
    state = applyTimeline(state, event, bounds)
    if (++folded % FOLD_YIELD_EVENTS === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return state
}

export function watchDetailChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate = makeColdReadGate(),
  timeline: TimelineReader | null = null,
  gate: DetailChannelGate = { live: false },
): DetailChannelGate {
  const readTimeline = timeline ?? registryReaderOf(ctx)
  const payloads = new Map<string, ColdPayload>()
  ctx.inject(['connection', 'sessions'], (c) => {
    const sessions = c.get('sessions') as SessionsHostFace | undefined
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (getSession === undefined) return

    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      let headOnly = false
      let full = false
      try {
        const body: unknown = await request.json()
        sessionId = body !== null && typeof body === 'object'
          ? (body as { sessionId?: unknown }).sessionId
          : undefined
        headOnly = body !== null && typeof body === 'object' && (body as { head?: unknown }).head === true
        full = body !== null && typeof body === 'object' && (body as { full?: unknown }).full === true
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      const signal = request.signal
      try {
        const session = getSession(sessionId)
        if (session !== undefined && session !== null) {
          const state = readTimeline?.(session)
          if (state === undefined) return reply({ ok: true, value: null })
          return reply({
            ok: true,
            value: headOnly
              ? { ...headPayloadOf(state), ...headViewsOf(ctx, session) }
              : buildTimelineDetail(state, bounds),
          })
        }
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        if (query === undefined) return reply({ ok: true, value: null })
        const value = await serveCold(ctx, query, sessionId, bounds, coldReads, payloads, { headOnly, full, signal })
        if (signal.aborted) return failure('dsh-context/aborted', 'request cancelled')
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        if (signal.aborted) return failure('dsh-context/aborted', 'request cancelled')
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    if (!registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, DETAIL_ROUTE, handler, 'dsh-context: detail route')) return
    gate.live = true
    return () => {
      gate.live = false
    }
  })
  return gate
}

interface ServeOptions {
  headOnly: boolean
  full: boolean
  signal: AbortSignal
}

/**
 * Serve one cold session's detail without materializing the durable log: the host's persisted
 * projection checkpoint carries the exact fold state, so the common path costs one persistence
 * stat and one in-memory record read. Only a missing or incompatible checkpoint falls back to a
 * bounded tail window, and only an explicit `full` request folds the complete log.
 */
async function serveCold(
  ctx: Context,
  query: SessionQueryFace,
  sessionId: string,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  payloads: Map<string, ColdPayload>,
  options: ServeOptions,
): Promise<unknown> {
  const { headOnly, full, signal } = options
  let metadata: unknown
  if (typeof query.observeSessionMetadata === 'function') {
    try {
      metadata = await query.observeSessionMetadata(sessionId, { signal, projectionKeys: [CACHE_KEY, ...HEAD_VIEW_KEYS] })
    } catch {
      if (signal.aborted) return null
      metadata = undefined
    }
  }
  const header = headerOf(metadata)
  const cachedHead = cachedHeadOf(metadata)
  const cachedViews = cachedHeadViewsOf(metadata)
  if (headOnly) return cachedHead === undefined ? null : { ...headPayloadOfValue(cachedHead), ...cachedViews }
  if (full) return serveFullDetail(ctx, query, sessionId, bounds, coldReads, payloads, signal)
  if (header !== undefined) {
    const state = checkpointStateOf(ctx, sessionId, header)
    if (state !== undefined) return buildTimelineDetail(state, bounds)
  }
  // A host that predates the log-free projection stat and the bounded window keeps the legacy
  // whole-log fold; both faces arrived together, so one absence means neither cheap rung exists.
  if (typeof query.readWindow !== 'function') {
    return typeof query.observeSessionMetadata === 'function'
      ? null
      : serveFullDetail(ctx, query, sessionId, bounds, coldReads, payloads, signal)
  }
  let read: unknown
  try {
    read = await query.readWindow(sessionId, { signal, maxEvents: DETAIL_WINDOW_EVENTS })
  } catch {
    if (signal.aborted) return null
    read = undefined
  }
  if (signal.aborted) return null
  const window = windowOf(read)
  if (window === undefined) return null
  const state = await foldSlice(window.events, bounds, signal)
  if (state === undefined) return null
  const detail = buildTimelineDetail(state, bounds)
  const first = firstSeqOf(window.events)
  const partial = first === undefined || !window.hasMore ? undefined : { fromSeq: first }
  return {
    ...detail,
    rev: cachedHead === undefined ? detail.rev : headPayloadOfValue(cachedHead).rev,
    ...(cachedHead === undefined ? {} : { head: cachedHead }),
    ...(partial === undefined ? {} : { partial }),
  }
}

/** Fold the complete durable log for an explicit `full` request; the only whole-log read left. */
async function serveFullDetail(
  ctx: Context,
  query: SessionQueryFace,
  sessionId: string,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  payloads: Map<string, ColdPayload>,
  signal: AbortSignal,
): Promise<unknown> {
  const observe = typeof query.observeSession === 'function' ? query.observeSession.bind(query) : undefined
  if (observe === undefined) return null
  const value = await coldReads.admit(async () => {
    const observation = await observe(sessionId, { projectionMode: 'none', signal })
    try {
      const persistence: unknown = ctx.get('sessionPersistence')
      const revision = revisionOf(observation)
      if (revision !== undefined) {
        const hit = payloads.get(sessionId)
        if (hit !== undefined && hit.revision === revision && hit.persistence === persistence) {
          payloads.delete(sessionId)
          payloads.set(sessionId, hit)
          return hit.value
        }
      }
      const events = asRecord(observation)?.events
      if (!Array.isArray(events)) return null
      const state = await foldSlice(events as QuickEvent[], bounds, signal)
      if (state === undefined) return null
      if (revision !== undefined) {
        const detail = buildTimelineDetail(state, bounds)
        payloads.delete(sessionId)
        payloads.set(sessionId, { persistence, revision, value: detail })
        for (const oldest of payloads.keys()) {
          if (payloads.size <= PAYLOAD_CACHE_MAX) break
          payloads.delete(oldest)
        }
        return detail
      }
      return buildTimelineDetail(state, bounds)
    } finally {
      const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
      if (typeof dispose === 'function') dispose.call(observation)
    }
  })
  return value ?? null
}
