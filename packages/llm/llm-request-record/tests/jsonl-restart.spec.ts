/**
 * Restart read-back through the shipped JSONL persistence: one context records
 * prepared requests through the real service, and a second context reads them
 * back from the same private root.
 *
 * The first context is a live composition — the Session store, the recording
 * service and the JSONL backend — and its records reach disk the way a running
 * Host's do: the backend owns a write handle for the session, the service
 * appends, and the service's own `SessionStore.flush` drains that handle.
 * Disposal awaits the backend's teardown, which closes and flushes every open
 * handle before it returns.
 *
 * The second context mounts ONLY the JSONL backend: no Session store, no
 * recording service, no in-memory session and no port or cache from the first
 * run, so an event read there can only have come from the file. Two attempts are
 * recorded and each is selected by its own `preparedId`, which is what shows the
 * projection addresses one attempt rather than "the latest".
 *
 * The copy must have run `gen-persistence-catalog` first: the read path refuses
 * an event type outside the build's known set, and this test deliberately does
 * not set `ignorable` or write a schema version to bypass that rule.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionRequestRecordProvider, {
  reconstructRequestSystem,
  requestRecordDigest,
} from '@deepseek-ai/dsh-llm-request-record'
import type { LlmRequestRecordPayload } from '@deepseek-ai/dsh-llm-request-record'

/** The one session this case writes and reopens. */
const SESSION_ID = SessionId('request-record-restart')

/** Private roots this case owns; each is removed after the case settles. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function payload(systemBlocks: readonly string[]): LlmRequestRecordPayload {
  return {
    provider: 'claude',
    model: 'claude-opus-4-5',
    purpose: 'conversation',
    systemBlocks: [...systemBlocks],
    wireLibrary: '@tormentalabs/claude-code-wire-compat@0.7.2-dsh14-fixture',
    profile: 'claude-code-2.1.288-sdk-0.128.0',
  }
}

/** The prepared records one stored log carries, in log order. */
function recordsIn(events: readonly SessionEvent[]): SessionEvent<'llm/request-record'>[] {
  return events.filter((event): event is SessionEvent<'llm/request-record'> => event.type === 'llm/request-record')
}

describe('request-record JSONL restart read-back', () => {
  it('reads each attempt back from a second context over the same private root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-llm-request-record-jsonl-'))
    roots.push(root)

    let firstPreparedId: SessionSeq | undefined
    let secondPreparedId: SessionSeq | undefined

    const first = new Context()
    try {
      await first.plugin(SessionStore)
      await first.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      await first.plugin(SessionRequestRecordProvider, { flushTimeoutMs: 2_000 })

      const session = first.sessions.create(SESSION_ID)
      // The backend's own write handle for this session is what routes the
      // service's appends; without it a flush would have no durability listener.
      const writer = await first.sessionPersistence.create(session.header)
      try {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('request/header', {
          header: { config: { provider: 'claude', model: 'claude-opus-4-5' } },
          reason: 'initial',
        })

        const one = await first.llmRequestRecord.recordPreparedRequest(
          { sessionId: session.id },
          payload(['first attempt']),
        )
        const two = await first.llmRequestRecord.recordPreparedRequest(
          { sessionId: session.id },
          payload(['second attempt']),
        )
        expect(one.ok).toBe(true)
        expect(two.ok).toBe(true)
        if (!one.ok || !two.ok) throw new Error('both attempts must be recorded durably')
        firstPreparedId = one.preparedId
        secondPreparedId = two.preparedId
        expect(firstPreparedId).not.toBe(secondPreparedId)

        // The durability checkpoint is a participating listener that succeeded,
        // never a silent no-op.
        expect(await first.sessions.flush(session)).toBe(true)

        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        expect(await first.sessions.flush(session)).toBe(true)
      } finally {
        await writer.close()
      }
    } finally {
      // Awaits the backend teardown, which closes and flushes every open handle.
      await first.fiber.dispose()
    }

    const second = new Context()
    try {
      await second.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const reader = await second.sessionPersistence.open(SESSION_ID, 'read')
      try {
        const { events } = await reader.read()
        const records = recordsIn(events)
        expect(records).toHaveLength(2)
        expect(records.map(record => record.seq)).toEqual([firstPreparedId, secondPreparedId])

        // Selecting the first attempt must not return the latest one.
        expect(reconstructRequestSystem(events, firstPreparedId)).toEqual(['first attempt'])
        expect(reconstructRequestSystem(events, secondPreparedId)).toEqual(['second attempt'])
        expect(reconstructRequestSystem(events, firstPreparedId))
          .not.toEqual(reconstructRequestSystem(events, secondPreparedId))
        // With no id the projection is the documented latest-only default.
        expect(reconstructRequestSystem(events)).toEqual(['second attempt'])

        // The complete record survived the restart, digest and metadata included.
        const stored = records.find(record => record.seq === firstPreparedId)
        expect(stored?.data).toEqual({
          v: 1,
          phase: 'prepared',
          provider: 'claude',
          model: 'claude-opus-4-5',
          purpose: 'conversation',
          systemBlocks: ['first attempt'],
          systemDigest: requestRecordDigest(['first attempt']),
          wireLibrary: '@tormentalabs/claude-code-wire-compat@0.7.2-dsh14-fixture',
          profile: 'claude-code-2.1.288-sdk-0.128.0',
        })
      } finally {
        await reader.close()
      }
    } finally {
      await second.fiber.dispose()
    }
  })
})
