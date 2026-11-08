import { useCallback, useSyncExternalStore } from 'react'
import type { ContextBreakdown, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { DETAIL_ROUTE } from './apiRoutes'
import { lruTouch, lruTrim } from './lru'
import { asRecord, contextBreakdownOf, contextPressureOf, timelineOf, tokenUsageOf } from './services'

export interface AgentHead {
  timeline: ContextTimeline
  pressure: ContextPressure | null
  breakdown: ContextBreakdown | null
  usage?: TokenUsage | null
}

export interface AgentHeads {
  /**
   * Read one agent's head, cached per activity time: the control stream
   * carries no detail projections for Sessions this client has not opened,
   * so a newer `updatedAt` reads the head again.
   * @param id - Session id.
   * @param updatedAt - the row's activity time; omitted reuses any cached head.
   * @returns the head, or null when the Host has none.
   */
  headOf(id: string, updatedAt?: number): Promise<AgentHead | null>
}

export function makeHeadFetcher(sessionId: string): (() => Promise<AgentHead | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, head: true }),
    })
    if (!response.ok) throw new Error(`dsh-context: head route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-context: head read failed')
    if (r.value === null) return null
    const value = asRecord(r.value)
    const head = timelineOf(value?.head)
    if (head === null) throw new Error('dsh-context: head read malformed')
    return {
      timeline: head,
      pressure: contextPressureOf(value?.pressure),
      breakdown: contextBreakdownOf(value?.breakdown),
      usage: tokenUsageOf(value?.usage),
    }
  }
}

const HEADS_MAX = 128

export function makeAgentHeads(): AgentHeads {
  const heads = new Map<string, Promise<AgentHead | null>>()
  return {
    headOf(id: string, updatedAt?: number): Promise<AgentHead | null> {
      const key = updatedAt === undefined ? id : `${id}@${String(updatedAt)}`
      const cached = heads.get(key)
      if (cached !== undefined) {
        lruTouch(heads, key)
        return cached
      }
      const fetcher = makeHeadFetcher(id)
      const pending = fetcher !== undefined ? fetcher() : Promise.resolve(null)
      heads.set(key, pending)
      lruTrim(heads, HEADS_MAX)
      return pending
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
