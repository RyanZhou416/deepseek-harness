import { useCallback, useSyncExternalStore } from 'react'
import type { ContextBreakdown, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { DETAIL_ROUTE, HEADS_ROUTE } from './apiRoutes'
import { byteSizeOf } from './boundedCache'
import { subscribeInvalidations } from './invalidation'
import { registerRetentionCleanup, makeRetentionCache } from './retention'
import { noteCostPending } from './costRefresh'
import { postRoute } from './route'
import { asRecord, contextBreakdownOf, contextPressureOf, timelineOf, tokenUsageOf } from './services'

// DeepSeek Harness fork modification: agent heads carry detail views, cached per
// row activity time. See ../../FORK_MAINTENANCE.md.
export interface AgentHead {
  timeline: ContextTimeline
  pressure: ContextPressure | null
  breakdown: ContextBreakdown | null
  usage: TokenUsage | null
}

export interface AgentHeads {
  headOf(id: string, updatedAt?: number): Promise<AgentHead | null>
  headOfMany?(ids: readonly string[]): Promise<ReadonlyMap<string, AgentHead>>
}

function headOfValue(value: unknown): AgentHead | null {
  const data = asRecord(value)
  const timeline = timelineOf(data?.head)
  if (timeline === null) return null
  return {
    timeline,
    pressure: contextPressureOf(data?.pressure),
    breakdown: contextBreakdownOf(data?.breakdown),
    usage: tokenUsageOf(data?.usage),
  }
}

export function makeHeadFetcher(sessionId: string): (() => Promise<AgentHead | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(DETAIL_ROUTE, { sessionId, head: true }, headOfValue, { label: 'head' })
}

export function headsOf(value: unknown): Map<string, AgentHead> | null {
  const data = asRecord(value)
  if (data === null) return null
  const out = new Map<string, AgentHead>()
  for (const id of Object.keys(data)) {
    const head = headOfValue(data[id])
    if (head !== null) out.set(id, head)
  }
  return out
}

export function makeBatchHeadFetcher(ids: readonly string[]): () => Promise<Map<string, AgentHead> | null> {
  return () => postRoute(HEADS_ROUTE, { ids }, headsOf, { label: 'heads' })
}

export async function readHeads(heads: AgentHeads, ids: readonly string[]): Promise<ReadonlyMap<string, AgentHead>> {
  if (heads.headOfMany !== undefined) return heads.headOfMany(ids)
  const result = new Map<string, AgentHead>()
  const reads = await Promise.allSettled(ids.map(async id => ({ id, head: await heads.headOf(id) })))
  let failure: unknown
  for (const read of reads) {
    if (read.status === 'rejected') {
      failure = failure ?? read.reason
      continue
    }
    if (read.value.head !== null) result.set(read.value.id, read.value.head)
  }
  if (failure !== undefined) throw new Error(failure instanceof Error ? failure.message : 'heads read failed')
  return result
}

const HEAD_BATCH_SIZE = 64

const HEAD_DETAIL_FALLBACK_MAX = 64

const HEAD_DETAIL_FALLBACK_CONCURRENCY = 4

interface HeadEntry {
  promise: Promise<AgentHead | null>
  bytes: number
}

function cacheKeyOf(id: string, updatedAt: number | undefined): string {
  return updatedAt === undefined ? id : `${id}@${String(updatedAt)}`
}

export function makeAgentHeads(): AgentHeads {
  const heads = makeRetentionCache<string, HeadEntry>('agentHeads', { sizeOf: entry => entry.bytes })
  const inflight = new Map<string, HeadEntry>()
  let generation = 0
  const dropId = (id: string): void => {
    inflight.delete(id)
    heads.delete(id)
    heads.forEach((_entry, key) => {
      if (key.startsWith(id + '@')) heads.delete(key)
    })
  }
  const offInvalidation = subscribeInvalidations((event) => {
    if (event.kind === 'pricing') {
      generation++
      heads.clear()
      inflight.clear()
      return
    }
    if (event.kind !== 'heads') return
    generation++
    if (event.sessionId === undefined) {
      heads.clear()
      inflight.clear()
      return
    }
    dropId(event.sessionId)
  })
  registerRetentionCleanup(() => {
    heads.dispose()
    offInvalidation()
  })
  const settle = (id: string, entry: HeadEntry, head: AgentHead | null, startedAt: number): AgentHead | null => {
    if (inflight.get(id) === entry) inflight.delete(id)
    if (startedAt === generation) {
      entry.bytes = head === null ? 0 : byteSizeOf(head)
      heads.set(id, entry)
    }
    noteCostPending(head?.timeline.costRead)
    return head
  }
  return {
    headOf(id: string, updatedAt?: number): Promise<AgentHead | null> {
      const key = cacheKeyOf(id, updatedAt)
      const cached = heads.get(key)
      if (cached !== undefined) return cached.promise
      const running = inflight.get(key)
      if (running !== undefined) return running.promise
      const fetcher = makeHeadFetcher(id)
      const entry: HeadEntry = { promise: Promise.resolve(null), bytes: 0 }
      const pending = fetcher !== undefined ? fetcher() : Promise.resolve(null)
      const startedAt = generation
      entry.promise = pending.then((head) => {
        // The activity-keyed entry is stored under its own key; drop a stale
        // activity key for the same Session so only one is retained.
        if (startedAt === generation && updatedAt !== undefined) heads.delete(id)
        return settle(key, entry, head, startedAt)
      }, (error: unknown) => {
        if (inflight.get(key) === entry) inflight.delete(key)
        throw error
      })
      inflight.set(key, entry)
      return entry.promise
    },
    async headOfMany(ids: readonly string[]): Promise<ReadonlyMap<string, AgentHead>> {
      const result = new Map<string, AgentHead>()
      const needed: string[] = []
      const seen = new Set<string>()
      for (const id of ids) {
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const cached = heads.get(id)
        if (cached !== undefined) {
          const head = await cached.promise
          if (head !== null) result.set(id, head)
          continue
        }
        const running = inflight.get(id)
        if (running !== undefined) {
          const head = await running.promise
          if (head !== null) result.set(id, head)
          continue
        }
        needed.push(id)
      }
      const entries = new Map<string, HeadEntry>()
      for (let offset = 0; offset < needed.length; offset += HEAD_BATCH_SIZE) {
        const chunk = needed.slice(offset, offset + HEAD_BATCH_SIZE)
        const pending = makeBatchHeadFetcher(chunk)()
        for (const id of chunk) {
          const entry: HeadEntry = { promise: Promise.resolve(null), bytes: 0 }
          const startedAt = generation
          entry.promise = pending.then((batch) => {
            return settle(id, entry, batch?.get(id) ?? null, startedAt)
          }, (error: unknown) => {
            if (inflight.get(id) === entry) inflight.delete(id)
            throw error
          })
          inflight.set(id, entry)
          entries.set(id, entry)
        }
      }
      const outcomes = await Promise.allSettled([...entries].map(async ([id, entry]) => ({ id, head: await entry.promise })))
      let failure: unknown
      const missing: string[] = []
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          failure = failure ?? outcome.reason
          continue
        }
        if (outcome.value.head !== null) result.set(outcome.value.id, outcome.value.head)
        else missing.push(outcome.value.id)
      }
      const fallbacks = missing.slice(0, HEAD_DETAIL_FALLBACK_MAX)
      for (let offset = 0; offset < fallbacks.length; offset += HEAD_DETAIL_FALLBACK_CONCURRENCY) {
        const chunk = fallbacks.slice(offset, offset + HEAD_DETAIL_FALLBACK_CONCURRENCY)
        const reads = await Promise.allSettled(chunk.map(async (id) => {
          const startedAt = generation
          const head = await (makeHeadFetcher(id) as () => Promise<AgentHead | null>)()
          if (head === null) return { id, head: null }
          if (startedAt === generation) heads.set(id, { promise: Promise.resolve(head), bytes: byteSizeOf(head) })
          return { id, head }
        }))
        for (const read of reads) {
          if (read.status === 'rejected') continue
          if (read.value.head !== null) result.set(read.value.id, read.value.head)
        }
      }
      if (failure !== undefined) throw new Error(failure instanceof Error ? failure.message : 'heads read failed')
      return result
    },
  }
}

export function useSessionsSnapshot(face: SessionsFaceLike | null, coalesceMs = 0): unknown {
  const subscribe = useCallback((fn: () => void) => {
    if (face === null) return () => {}
    /* v8 ignore next 2 */
    if (face.list === undefined) return () => {}
    if (coalesceMs <= 0) return face.list.subscribe(fn)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = face.list.subscribe(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        fn()
      }, coalesceMs)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [face, coalesceMs])
  const getSnapshot = useCallback(() => {
    if (face === null) return null
    /* v8 ignore next 2 */
    if (face.list === undefined) return null
    return face.list.getSnapshot()
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}
