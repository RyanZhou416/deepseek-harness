/** Client-only deterministic notification and identity work counts; excludes rendering and network latency. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientSessions } from '../src/client/sessions/service.ts'

/** Fixed catalog breadth and concurrent update sources for the projection workload. */
export const PROJECTION_WORKLOAD = { sessions: 256, activeSessions: 24, acceptedUpdates: 96 } as const

/** Drain the value-store and manager microtask publication stages. */
async function publish(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Count catalog invalidations while rotating accepted and stale frames across active Sessions.
 * @param sessions - real ClientSessions instance with its normal manager and snapshot store.
 * @param afterSetup - reset optional external work counters after the catalog is populated.
 * @returns work counts after every accepted value and ignored replay has passed the publication stages.
 */
export async function measureProjectionUpdateWork(sessions: ClientSessions, afterSetup?: () => void): Promise<{
  notifications: number
  projectionChanges: number
  rowChanges: number
  membershipChanges: number
}> {
  const ids = Array.from({ length: PROJECTION_WORKLOAD.sessions }, (_, index) => `synthetic-projection-${index}` as SessionId)
  for (const [index, sessionId] of ids.entries()) {
    sessions.handleSessionAdded({
      sessionId, agentAvailable: true, running: index < PROJECTION_WORKLOAD.activeSessions,
      blank: false, updatedAt: index,
    })
  }
  sessions.handleControlFrame({ type: 'baseline', value: { projections: Object.fromEntries(ids.map(sessionId => [
    sessionId, { asOfSeq: 0, values: { title: 'Synthetic session' } },
  ])) } })
  await publish()
  afterSetup?.()

  const work = { notifications: 0, projectionChanges: 0, rowChanges: 0, membershipChanges: 0 }
  let previous = sessions.list.getSnapshot()
  const unsubscribe = sessions.list.subscribe(() => {
    const next = sessions.list.getSnapshot()
    work.notifications++
    if (next.ids !== previous.ids) work.membershipChanges++
    for (const sessionId of ids) {
      if (next.byId[sessionId] !== previous.byId[sessionId]) work.rowChanges++
      if (next.projectionsBySession[sessionId] !== previous.projectionsBySession[sessionId]) work.projectionChanges++
    }
    previous = next
  })
  try {
    for (let index = 0; index < PROJECTION_WORKLOAD.acceptedUpdates; index++) {
      const sessionId = ids[index % PROJECTION_WORKLOAD.activeSessions] as SessionId
      const seq = index + 1
      const title = `Synthetic update ${seq}`
      sessions.handleControlFrame({ type: 'projection', sessionId, key: 'title', value: title, seq })
      await publish()
      sessions.handleControlFrame({ type: 'projection', sessionId, key: 'title', value: 'Ignored replay', seq })
      await publish()
      if (sessions.list.getSnapshot().byId[sessionId]?.title !== title) {
        throw new Error('accepted projection was lost during replay')
      }
    }
    return work
  } finally {
    unsubscribe()
  }
}
