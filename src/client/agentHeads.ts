/**
 * The sessions-feed plumbing shared by the session-list consumers — the
 * Agent network card (agentGraph.tsx) and the stats board's subagent-cost
 * cell (statsContext.tsx): the list-snapshot React seat, and the page-scope
 * cache of cold-relative slim-head fetches.
 *
 * The cache: one in-flight-or-settled promise per session id for the
 * factory's lifetime (page scope). A settled null — transport failure,
 * hostile payload, route absent, session left the live set — is sticky, so a
 * broken relative never retries per snapshot tick. One cache serves every
 * consumer, so a relative's head is fetched once no matter how many cards
 * read it.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import type { ClientCtx } from './services'
import type { SessionsFaceLike } from './agentTree'
import { makeDetailFetcher } from './timelineSource'

export interface AgentHeads {
  /** The session's slim head off the (deduplicated) detail route; null when absent or failed. */
  headOf(id: string): Promise<ContextTimeline | null>
}

/** One page-scope fetch cache, shared by every consumer the caller wires it into. */
export function makeAgentHeads(ctx: ClientCtx): AgentHeads {
  const heads = new Map<string, Promise<ContextTimeline | null>>()
  return {
    headOf(id: string): Promise<ContextTimeline | null> {
      const cached = heads.get(id)
      if (cached !== undefined) return cached
      const fetcher = makeDetailFetcher(ctx, id)
      const pending = fetcher !== undefined ? fetcher().then(d => d?.head ?? null) : Promise.resolve(null)
      heads.set(id, pending)
      return pending
    },
  }
}

/** The session-list snapshot as a React seat (null without the face). */
export function useSessionsSnapshot(face: SessionsFaceLike | null): unknown {
  const subscribe = useCallback((fn: () => void) => {
    if (face === null) return () => {}
    /* v8 ignore next 2 -- sessionsFaceOf returns a face only after proving list.subscribe. */
    if (face.list === undefined) return () => {}
    return face.list.subscribe(fn)
  }, [face])
  const getSnapshot = useCallback(() => {
    if (face === null) return null
    /* v8 ignore next 2 -- sessionsFaceOf proves list before returning the face. */
    if (face.list === undefined) return null
    return face.list.getSnapshot()
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}
