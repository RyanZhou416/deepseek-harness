/**
 * Recording-service behavior: a prepared request enters the session log before
 * anything is sent, its own sequence number is its identity, and a durability
 * result that is false, rejected or late forbids the send without cancelling the
 * listener's write.
 *
 * Each case drives the real `SessionStore` and the real provider; the only test
 * double is a `session/flush` listener whose settlement the test controls.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionRequestRecordProvider, {
  reconstructRequestSystem,
  requestRecordDigest,
  validateRequestRecord,
} from '@deepseek-ai/dsh-llm-request-record'
import type { LlmRequestRecordPayload } from '@deepseek-ai/dsh-llm-request-record'

/** A settlement one test controls, so a durability wait is observed rather than raced. */
interface Gate {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function gate(): Gate {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: () => { release?.() } }
}

/** The ordered system text one prepared Claude request emitted. */
const SYSTEM_BLOCKS = ['billing header', 'identity header', 'You are a harness agent.']

function payload(overrides: Partial<LlmRequestRecordPayload> = {}): LlmRequestRecordPayload {
  return {
    provider: 'claude',
    model: 'claude-opus-5',
    purpose: 'conversation',
    systemBlocks: [...SYSTEM_BLOCKS],
    wireLibrary: '@tormentalabs/claude-code-wire-compat@0.0.0-fixture',
    profile: 'claude-code-2.1.288',
    ...overrides,
  }
}

async function mount(flushTimeoutMs = 2_000): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRequestRecordProvider, { flushTimeoutMs })
  return ctx
}

/** Every record the session log accepted, in log order. */
function recordsIn(events: readonly SessionEvent[]): SessionEvent<'llm/request-record'>[] {
  return events.filter((event): event is SessionEvent<'llm/request-record'> => event.type === 'llm/request-record')
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('recordPreparedRequest', () => {
  it('appends the record and answers with that event own sequence number', async () => {
    context = await mount()
    const session = context.sessions.create()
    const seen: SessionEvent[] = []
    context.on('session/event', (_session, event) => { seen.push(event) })
    let flushed = 0
    context.on('session/flush', () => { flushed += 1 })

    const outcome = await context.llmRequestRecord.recordPreparedRequest(
      { sessionId: session.id },
      payload(),
    )

    const records = recordsIn(seen)
    expect(outcome).toEqual({ ok: true, preparedId: records[0]!.seq })
    expect(flushed).toBe(1)
    expect(records[0]!.data).toEqual({
      v: 1,
      phase: 'prepared',
      provider: 'claude',
      model: 'claude-opus-5',
      purpose: 'conversation',
      systemBlocks: SYSTEM_BLOCKS,
      systemDigest: requestRecordDigest(SYSTEM_BLOCKS),
      wireLibrary: '@tormentalabs/claude-code-wire-compat@0.0.0-fixture',
      profile: 'claude-code-2.1.288',
    })
  })

  it('keeps one record per attempt, so a resend is never paired one-to-one with a send', async () => {
    context = await mount()
    const session = context.sessions.create()
    const seen: SessionEvent[] = []
    context.on('session/event', (_session, event) => { seen.push(event) })
    context.on('session/flush', () => {})

    const first = await context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())
    const second = await context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())

    const records = recordsIn(seen)
    expect(records).toHaveLength(2)
    expect(first).toEqual({ ok: true, preparedId: records[0]!.seq })
    expect(second).toEqual({ ok: true, preparedId: records[1]!.seq })
    expect(records[1]!.seq).not.toBe(records[0]!.seq)
  })

  it('forbids the send when no durability listener participates, and still records the attempt', async () => {
    context = await mount()
    const session = context.sessions.create()
    const seen: SessionEvent[] = []
    context.on('session/event', (_session, event) => { seen.push(event) })

    const outcome = await context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())

    expect(outcome).toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })
    // The record is prepared either way: the log states the attempt, not the send.
    expect(recordsIn(seen)).toHaveLength(1)
    expect(recordsIn(seen)[0]!.data.phase).toBe('prepared')
  })

  it('forbids the send when a durability listener rejects', async () => {
    context = await mount()
    const session = context.sessions.create()
    const seen: SessionEvent[] = []
    context.on('session/event', (_session, event) => { seen.push(event) })
    context.on('session/flush', () => { throw new Error('durability backend refused the write') })

    const outcome = await context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())

    expect(outcome).toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })
    expect(recordsIn(seen)).toHaveLength(1)
  })

  it('forbids the send when a durability listener throws a value that is not an Error', async () => {
    context = await mount()
    const session = context.sessions.create()
    const seen: SessionEvent[] = []
    context.on('session/event', (_session, event) => { seen.push(event) })
    // A Cordis listener may throw any value; the durability result stays a refusal.
    context.on('session/flush', () => { throw 'durability backend refused the write' })

    const outcome = await context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())

    expect(outcome).toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })
    expect(recordsIn(seen)).toHaveLength(1)
  })

  it('bounds the durability wait and leaves the listener write uncancelled', async () => {
    context = await mount(30)
    const session = context.sessions.create()
    const write = gate()
    let finished = false
    context.on('session/flush', async () => {
      await write.promise
      finished = true
    })

    const record = context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())
    // The deadline bounds the WAIT: the record resolves without the listener settling.
    await expect(record).resolves.toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })

    const disposal = context.fiber.dispose()
    context = undefined
    write.resolve()
    await disposal

    // Disposal joined the write the provider still owned instead of cancelling it.
    expect(finished).toBe(true)
  })

  it('releases disposal when an owned flush never settles', async () => {
    context = await mount(30)
    const session = context.sessions.create()
    // Never settles: without the drain bound, disposal would hang and this case would time out.
    context.on('session/flush', () => new Promise<void>(() => {}))

    void context.llmRequestRecord.recordPreparedRequest({ sessionId: session.id }, payload())
    await context.fiber.dispose()
    context = undefined
  })

  it('refuses to load without a usable durability bound', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    await expect(ctx.plugin(SessionRequestRecordProvider, { flushTimeoutMs: 0 })).rejects.toThrow()

    await ctx.fiber.dispose()
  })

  it('refuses a direct construction whose durability bound is unusable', async () => {
    const ctx = new Context()
    try {
      // Loader configuration is validated by the schema; direct construction owns the same bound.
      expect(() => new SessionRequestRecordProvider(ctx, { flushTimeoutMs: 0 }))
        .toThrow(/positive safe integer/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a malformed payload without appending a record', async () => {
    context = await mount()
    const session = context.sessions.create()
    const seen: SessionEvent[] = []
    context.on('session/event', (_session, event) => { seen.push(event) })

    const outcome = await context.llmRequestRecord.recordPreparedRequest(
      { sessionId: session.id },
      payload({ model: '' }),
    )

    expect(outcome).toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })
    expect(seen).toEqual([])
  })

  it('refuses a session that is not live in the store', async () => {
    context = await mount()

    const outcome = await context.llmRequestRecord.recordPreparedRequest(
      { sessionId: SessionId('never-created') },
      payload(),
    )

    expect(outcome).toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })
  })

  it('stops admitting records once disposal begins', async () => {
    context = await mount()
    const session = context.sessions.create()
    const service = context.llmRequestRecord
    await context.fiber.dispose()

    const outcome = await service.recordPreparedRequest({ sessionId: session.id }, payload())

    expect(outcome).toEqual({ ok: false, code: 'REQUEST_RECORD_UNAVAILABLE' })
  })
})

describe('record data', () => {
  it('digests exactly JSON.stringify(systemBlocks)', () => {
    expect(requestRecordDigest(SYSTEM_BLOCKS)).toBe(
      requestRecordDigest(['billing header', 'identity header', 'You are a harness agent.']),
    )
    expect(requestRecordDigest(SYSTEM_BLOCKS)).not.toBe(requestRecordDigest([...SYSTEM_BLOCKS].reverse()))
  })

  it('completes version, phase and digest instead of accepting them', () => {
    const complete = validateRequestRecord(payload())
    expect(complete.v).toBe(1)
    expect(complete.phase).toBe('prepared')
    expect(complete.systemDigest).toBe(requestRecordDigest(SYSTEM_BLOCKS))
    expect(Object.isFrozen(complete)).toBe(true)
  })

  it('refuses a record whose reader-visible field is empty', () => {
    expect(() => validateRequestRecord(payload({ model: '' }))).toThrow(/model/)
    expect(() => validateRequestRecord(payload({ profile: '' }))).toThrow(/profile/)
    expect(() => validateRequestRecord(payload({ wireLibrary: '' }))).toThrow(/wireLibrary/)
  })

  it('projects the latest recorded system text out of a log, or one named attempt', () => {
    const step: SessionEvent = { type: 'step/start', seq: SessionSeq(0), time: 0, data: { turn: 1, step: 1 } }
    const first: SessionEvent = {
      type: 'llm/request-record',
      seq: SessionSeq(1),
      time: 1,
      data: validateRequestRecord(payload({ systemBlocks: ['first'] })),
    }
    const second: SessionEvent = {
      type: 'llm/request-record',
      seq: SessionSeq(2),
      time: 2,
      data: validateRequestRecord(payload()),
    }
    const log = [step, first, second]

    expect(reconstructRequestSystem(log)).toEqual(SYSTEM_BLOCKS)
    // One request produces one record per attempt, so an attempt is addressable by its own id.
    expect(reconstructRequestSystem(log, SessionSeq(1))).toEqual(['first'])
    expect(reconstructRequestSystem(log, SessionSeq(2))).toEqual(SYSTEM_BLOCKS)
    expect(reconstructRequestSystem(log, SessionSeq(9))).toBeUndefined()
    expect(reconstructRequestSystem([step])).toBeUndefined()
  })
})
