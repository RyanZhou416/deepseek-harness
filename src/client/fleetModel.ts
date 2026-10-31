import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHeads } from './agentHeads'
import { useSessionsSnapshot } from './agentHeads'
import { agentForestOf, sessionTitlesOf, sessionsFaceOf, type AgentForest, type AgentSelfStats } from './agentTree'
import { FleetDetailCache } from './fleetDetail'
import { lruTrim } from './lru'
import { teamOf, type FleetTeam } from './fleetTeam'
import type { ClientCtx } from './services'
import { asRecord } from './services'
import type { ContextTimeline, FleetDetail } from '../shared/types'

export interface FleetModel {
  forest: AgentForest | null
  team: FleetTeam | null
  titles: ReadonlyMap<string, string>
}

export function teamOfSnapshot(snapshot: unknown, forest: AgentForest | null): FleetTeam | null {
  if (forest === null) return null
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null) return null
  for (const n of forest.nodes) {
    const row = asRecord(byId[n.id])
    const team = teamOf(asRecord(row?.projectionValues)?.agentTeam)
    if (team !== null) return team
  }
  return null
}

export function useFleetModel(
  ctx: ClientCtx,
  heads: AgentHeads,
  sessionId: string | undefined,
  self: AgentSelfStats | undefined,
  active: boolean,
  coalesceMs = 0,
): FleetModel {
  const face = useMemo(() => (active ? sessionsFaceOf(ctx) : null), [ctx, active])
  const snapshot = useSessionsSnapshot(face, coalesceMs)

  useEffect(() => {
    if (face === null || typeof sessionId !== 'string' || sessionId === '') return
    if (typeof face.refreshSubagents !== 'function') return
    face.refreshSubagents(sessionId).catch(() => {})
  }, [face, sessionId])

  const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())

  const forest = useMemo(
    () => agentForestOf(snapshot, sessionId, self, landed),
    [snapshot, sessionId, self, landed],
  )

  useEffect(() => {
    if (forest === null) return
    const attach = (pending: Promise<ContextTimeline | null>, id: string): void => {
      void pending.then((head) => {
        if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
      }).catch(() => {})
    }
    for (const n of forest.nodes) {
      if (n.isCurrent || (n.head !== null && n.head.parts.length > 0)) continue
      attach(heads.headOf(n.id), n.id)
    }
  }, [forest, heads])

  const team = useMemo(() => teamOfSnapshot(snapshot, forest), [snapshot, forest])
  const titles = useMemo(() => sessionTitlesOf(snapshot), [snapshot])

  return { forest, team, titles }
}

export interface FleetDetailState {
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>
  fullLanded: ReadonlyMap<string, FleetDetail | null>
  pending: ReadonlySet<string>
  fullPending: ReadonlySet<string>
  request(id: string, updatedAt: number): void
  requestFull(id: string): void
}

const sharedCache = new FleetDetailCache()
const FULL_STATE_MAX = 8

export interface FleetDetailOptions {
  concurrency?: number
  refreshDelayMs?: number
}

export function useFleetDetails(cache: FleetDetailCache = sharedCache, options: FleetDetailOptions = {}): FleetDetailState {
  const maxInflight = options.concurrency ?? Number.POSITIVE_INFINITY
  const refreshDelay = options.refreshDelayMs ?? 0
  const [landed, setLanded] = useState<ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>>(new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const requested = useRef(new Map<string, number>())
  const mounted = useRef(true)
  const active = useRef(0)
  const queue = useRef<Array<{ id: string; stamp: number }>>([])
  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const drain = (): void => {
    while (active.current < maxInflight && queue.current.length > 0) {
      const task = queue.current.shift() as { id: string; stamp: number }
      /* v8 ignore next 1 */
      if (requested.current.get(task.id) !== task.stamp) continue
      active.current++
      void cache.fetch(task.id, task.stamp).then((detail) => {
        if (!mounted.current || requested.current.get(task.id) !== task.stamp) return
        setLanded(prev => new Map(prev).set(task.id, { detail, updatedAt: task.stamp }))
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }).catch(() => {
        /* v8 ignore next 1 */
        if (!mounted.current || requested.current.get(task.id) !== task.stamp) return
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }).finally(() => {
        active.current--
        drain()
      })
    }
  }

  const enqueue = (id: string, stamp: number, silent = false): void => {
    if (!silent) setPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    const at = queue.current.findIndex(task => task.id === id)
    if (at >= 0) {
      queue.current[at] = { id, stamp }
    } else {
      queue.current.push({ id, stamp })
    }
    drain()
  }

  const request = (id: string, updatedAt: number): void => {
    const known = requested.current.get(id)
    if (known !== undefined && known >= updatedAt) return
    requested.current.set(id, updatedAt)
    if (refreshDelay > 0 && landed.has(id)) {
      const armed = refreshTimers.current.get(id)
      if (armed !== undefined) clearTimeout(armed)
      refreshTimers.current.set(id, setTimeout(() => {
        refreshTimers.current.delete(id)
        /* v8 ignore next 1 */
        if (!mounted.current) return
        const target = requested.current.get(id)
        /* v8 ignore next 1 */
        if (target !== undefined) enqueue(id, target, true)
      }, refreshDelay))
      return
    }
    enqueue(id, updatedAt)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queue.current = []
      for (const timer of refreshTimers.current.values()) clearTimeout(timer)
      refreshTimers.current.clear()
    }
  }, [])

  const [fullLanded, setFullLanded] = useState<ReadonlyMap<string, FleetDetail | null>>(new Map())
  const [fullPending, setFullPending] = useState<ReadonlySet<string>>(new Set())
  const fullRequested = useRef(new Map<string, number>())
  const fullKnown = useRef<ReadonlySet<string>>(new Set())
  const fullInFlight = useRef<Set<string>>(new Set())

  const requestFull = (id: string): void => {
    const stamp = requested.current.get(id) ?? 0
    const known = fullRequested.current.get(id)
    if (known !== undefined && known >= stamp && (fullKnown.current.has(id) || fullInFlight.current.has(id))) return
    fullRequested.current.set(id, stamp)
    fullInFlight.current.add(id)
    setFullPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    void cache.fetch(id, stamp, true).then((detail) => {
      if (!mounted.current || fullRequested.current.get(id) !== stamp) return
      fullInFlight.current.delete(id)
      setFullLanded((prev) => {
        const next = new Map(prev)
        next.delete(id)
        next.set(id, detail)
        lruTrim(next, FULL_STATE_MAX)
        fullKnown.current = new Set(next.keys())
        return next
      })
      setFullPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })
  }

  return { landed, fullLanded, pending, fullPending, request, requestFull }
}
