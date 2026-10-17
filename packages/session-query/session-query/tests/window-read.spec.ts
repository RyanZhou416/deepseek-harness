/**
 * Independent coverage of the SessionQuery window read consumed by cold
 * history, including which stored projection checkpoints may become the
 * opening baseline.
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionWindow, SessionWindowRequest } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { TestSessionQueryEngine } from './test-service.ts'

const SESSION = SessionId('window-read')

function header(id: SessionId = SESSION): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
  }
}

function messageEvent(seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: createUserMessage({
      content: [{ type: 'text', text: `message ${seq}` }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

/** One stored window whose events start at `firstSeq`, like an inherited or tail generation slice. */
function storedWindow(meta: SessionHeader = header(), firstSeq = 0, count = 2): SessionWindow {
  const events = Array.from({ length: count }, (_, index) => messageEvent(firstSeq + index))
  return {
    header: structuredClone(meta),
    inheritedEventCount: SessionLogOffset(0),
    events,
    cursor: SessionSeq(firstSeq + count - 1),
    hasMore: firstSeq > 0,
  }
}

async function queryContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestSessionQueryEngine)
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

describe('SessionQueryEngine.readWindow delegation', () => {
  it('returns the backend window by reference after passing the caller request through', async () => {
    const ctx = await queryContext()
    const expected = storedWindow()
    const controller = new AbortController()
    const readWindow = vi.fn().mockResolvedValue(expected)
    ctx.provide('sessionPersistence', { readWindow } as never)
    const request: SessionWindowRequest = { beforeSeq: 9, maxEvents: 2, signal: controller.signal }

    const result = await ctx.sessionQuery.readWindow(SESSION, request)

    expect(readWindow).toHaveBeenCalledExactlyOnceWith(SESSION, request)
    expect(result?.window).toBe(expected)
    // No projection cache is mounted, so the read carries no baseline at all.
    expect(Object.keys(result ?? {})).toEqual(['window'])
  })

  it('supplies one empty request when the caller omits the argument', async () => {
    const ctx = await queryContext()
    const readWindow = vi.fn().mockResolvedValue(storedWindow())
    ctx.provide('sessionPersistence', { readWindow } as never)

    await ctx.sessionQuery.readWindow(SESSION)

    expect(readWindow).toHaveBeenCalledOnce()
    expect(readWindow.mock.calls[0]?.[0]).toBe(SESSION)
    expect(readWindow.mock.calls[0]?.[1]).toEqual({})
  })

  it('returns undefined without entering the full read path when no persistence is mounted', async () => {
    const ctx = await queryContext()
    const observeSession = vi.spyOn(ctx.sessionQuery, 'observeSession')

    await expect(ctx.sessionQuery.readWindow(SESSION)).resolves.toBeUndefined()

    expect(observeSession).not.toHaveBeenCalled()
  })

  it('returns undefined when the mounted persistence declares no window capability', async () => {
    const ctx = await queryContext()
    const stat = vi.fn()
    const open = vi.fn()
    const list = vi.fn()
    ctx.provide('sessionPersistence', { stat, open, list } as never)
    const observeSession = vi.spyOn(ctx.sessionQuery, 'observeSession')

    await expect(ctx.sessionQuery.readWindow(SESSION)).resolves.toBeUndefined()

    expect(stat).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(observeSession).not.toHaveBeenCalled()
  })

  it('propagates a backend failure unchanged for the caller to classify', async () => {
    const ctx = await queryContext()
    const failure = new SessionQueryError('stored session is unreadable', 'SESSION_QUERY_PERSISTENCE_FAILED')
    ctx.provide('sessionPersistence', { readWindow: () => Promise.reject(failure) } as never)

    await expect(ctx.sessionQuery.readWindow(SESSION)).rejects.toBe(failure)
  })

  it('honors caller cancellation that lands while the backend resolves', async () => {
    const ctx = await queryContext()
    const expected = storedWindow()
    const controller = new AbortController()
    const reason = new Error('history opening cancelled')
    ctx.provide('sessionPersistence', {
      readWindow: () => {
        controller.abort(reason)
        return Promise.resolve(expected)
      },
    } as never)

    await expect(ctx.sessionQuery.readWindow(SESSION, { signal: controller.signal })).rejects.toBe(reason)
  })
})

describe('SessionQueryEngine.readWindow projection checkpoint baseline', () => {
  it('attaches the stored checkpoint of the window header without moving its watermark', async () => {
    const ctx = await queryContext()
    const meta = header()
    // A stored slice starting above seq 0: the checkpoint watermark is strictly
    // below the window cursor and must not be rewritten to it.
    const expected = storedWindow(meta, 5, 2)
    const readWindow = vi.fn().mockResolvedValue(expected)
    ctx.provide('sessionPersistence', { readWindow } as never)
    const baseline: ProjectionSnapshot = {
      asOfSeq: SessionSeq(3),
      values: { title: 'checkpointed' },
    }
    const cachedSnapshot = vi.fn().mockReturnValue(baseline)
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)

    const result = await ctx.sessionQuery.readWindow(SESSION)

    // No registry is mounted, so no client-visible key set exists to prove
    // completeness against: the watermark rule alone decides.
    expect(cachedSnapshot).toHaveBeenCalledExactlyOnceWith(expected.header)
    expect(result?.projections).toEqual(baseline)
    expect(result?.projections?.asOfSeq).toBe(3)
    expect(result?.window.cursor).toBe(6)
    expect(result?.projections?.asOfSeq).not.toBe(result?.window.cursor)
  })

  it('keeps a baseline that carries every registered client-visible key', async () => {
    const ctx = await queryContext()
    const expected = storedWindow(header(), 5, 2)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    const baseline: ProjectionSnapshot = {
      asOfSeq: SessionSeq(4),
      values: { title: 'checkpointed' },
    }
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => baseline } as never)
    ctx.provide('sessionProjections', { wireKeys: () => ['title'] } as never)

    const result = await ctx.sessionQuery.readWindow(SESSION)

    expect(result?.projections).toBe(baseline)
  })

  it('keeps a baseline whose watermark ends exactly at the window cursor', async () => {
    const ctx = await queryContext()
    const expected = storedWindow(header(), 5, 2)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    const baseline: ProjectionSnapshot = {
      asOfSeq: SessionSeq(expected.cursor),
      values: { title: 'checkpointed' },
    }
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => baseline } as never)
    ctx.provide('sessionProjections', { wireKeys: () => ['title'] } as never)

    const result = await ctx.sessionQuery.readWindow(SESSION)

    expect(result?.projections).toBe(baseline)
  })

  it('drops a partial baseline that omits a registered client-visible key', async () => {
    const ctx = await queryContext()
    const expected = storedWindow(header(), 5, 2)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    const cachedSnapshot = vi.fn((): ProjectionSnapshot => ({
      asOfSeq: SessionSeq(4),
      values: { title: 'checkpointed' },
    }))
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)
    // The composition carries another client-visible key whose stored row is
    // unusable, so the block is only a per-key hint: adopting it as the opening
    // baseline would leave that key's client value cleared.
    ctx.provide('sessionProjections', { wireKeys: () => ['title', 'sessionListMetadata'] } as never)

    const result = await ctx.sessionQuery.readWindow(SESSION)

    expect(cachedSnapshot).toHaveBeenCalledOnce()
    expect(result).toEqual({ window: expected })
    expect(result?.projections).toBeUndefined()
  })

  it('drops a complete baseline whose watermark leads the window cursor', async () => {
    const ctx = await queryContext()
    const expected = storedWindow(header(), 5, 2)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    const baseline: ProjectionSnapshot = {
      asOfSeq: SessionSeq(expected.cursor + 1),
      values: { title: 'ahead' },
    }
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => baseline } as never)
    ctx.provide('sessionProjections', { wireKeys: () => ['title'] } as never)

    const result = await ctx.sessionQuery.readWindow(SESSION)

    expect(result).toEqual({ window: expected })
    expect(result?.projections).toBeUndefined()
  })

  it('does not consult the registry when the cache holds no checkpoint', async () => {
    const ctx = await queryContext()
    const expected = storedWindow(header())
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    const cachedSnapshot = vi.fn().mockReturnValue(undefined)
    const wireKeys = vi.fn(() => ['title'])
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)
    ctx.provide('sessionProjections', { wireKeys } as never)

    const result = await ctx.sessionQuery.readWindow(SESSION)

    expect(result).toEqual({ window: expected })
    expect(cachedSnapshot).toHaveBeenCalledOnce()
    expect(wireKeys).not.toHaveBeenCalled()
  })

  it('rejects a window from another Session before reading its checkpoint', async () => {
    const ctx = await queryContext()
    const foreign = storedWindow(header(SessionId('window-read-other')))
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(foreign) } as never)
    const cachedSnapshot = vi.fn()
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)

    await expect(ctx.sessionQuery.readWindow(SESSION)).rejects.toMatchObject({
      code: 'SESSION_QUERY_SOURCE_CONFLICT',
      message: `session persistence returned "${foreign.header.id}" for "${SESSION}"`,
    })
    expect(cachedSnapshot).not.toHaveBeenCalled()
  })
})
