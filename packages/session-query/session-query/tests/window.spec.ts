import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionWindow } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { TestSessionQueryEngine } from './test-service.ts'

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

function messageEvent(seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: createUserMessage({
      content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

function storedWindow(meta: SessionHeader, count = 2): SessionWindow {
  const events = Array.from({ length: count }, (_, seq) => messageEvent(seq))
  return {
    header: structuredClone(meta),
    inheritedEventCount: SessionLogOffset(0),
    events,
    cursor: events.length - 1,
    hasMore: true,
  }
}

async function queryContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestSessionQueryEngine)
  return ctx
}

describe('SessionQueryEngine.readWindow', () => {
  it('delegates the request to the mounted persistence window capability', async () => {
    const ctx = await queryContext()
    const meta = header('window-delegation')
    const expected = storedWindow(meta)
    const controller = new AbortController()
    const readWindow = vi.fn().mockResolvedValue(expected)
    ctx.provide('sessionPersistence', { readWindow } as never)
    const request = { beforeSeq: 9, maxEvents: 2, signal: controller.signal }

    await expect(ctx.sessionQuery.readWindow(meta.id, request)).resolves.toEqual({ window: expected })
    expect(readWindow).toHaveBeenCalledWith(meta.id, request)
    await ctx.fiber.dispose()
  })

  it('returns undefined when the backend cannot serve a validated window', async () => {
    const ctx = await queryContext()
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(undefined) } as never)

    await expect(ctx.sessionQuery.readWindow(SessionId('window-unavailable'))).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('returns undefined when no persistence service is mounted', async () => {
    const ctx = await queryContext()

    await expect(ctx.sessionQuery.readWindow(SessionId('window-no-backend'))).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('returns undefined without entering the full read path when the capability is absent', async () => {
    const ctx = await queryContext()
    const stat = vi.fn()
    const open = vi.fn()
    const list = vi.fn()
    ctx.provide('sessionPersistence', { stat, open, list } as never)

    await expect(ctx.sessionQuery.readWindow(SessionId('window-no-capability'))).resolves.toBeUndefined()
    expect(stat).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('attaches the stored projection checkpoint baseline for the window header', async () => {
    const ctx = await queryContext()
    const meta = header('window-baseline')
    const expected = storedWindow(meta)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    const baseline: ProjectionSnapshot = { asOfSeq: SessionSeq(0), values: { title: 'checkpointed' } }
    const cachedSnapshot = vi.fn().mockReturnValue(baseline)
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)

    const result = await ctx.sessionQuery.readWindow(meta.id)

    expect(cachedSnapshot).toHaveBeenCalledWith(expected.header)
    expect(result).toEqual({ window: expected, projections: baseline })
    // The baseline keeps its own stored watermark and never claims the window cursor.
    expect(result?.projections?.asOfSeq).toBe(0)
    expect(result?.window.cursor).toBe(1)
    await ctx.fiber.dispose()
  })

  it('omits the baseline when no projection cache is mounted', async () => {
    const ctx = await queryContext()
    const meta = header('window-no-cache')
    const expected = storedWindow(meta)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)

    await expect(ctx.sessionQuery.readWindow(meta.id)).resolves.toEqual({ window: expected })
    await ctx.fiber.dispose()
  })

  it('omits the baseline when the cache holds no record for the lifecycle', async () => {
    const ctx = await queryContext()
    const meta = header('window-stale-cache')
    const expected = storedWindow(meta)
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(expected) } as never)
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined } as never)

    await expect(ctx.sessionQuery.readWindow(meta.id)).resolves.toEqual({ window: expected })
    await ctx.fiber.dispose()
  })

  it('rejects a window whose header belongs to another session', async () => {
    const ctx = await queryContext()
    const meta = header('window-requested')
    const foreign = storedWindow(header('window-other'))
    ctx.provide('sessionPersistence', { readWindow: () => Promise.resolve(foreign) } as never)

    await expect(ctx.sessionQuery.readWindow(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_SOURCE_CONFLICT',
      message: `session persistence returned "${foreign.header.id}" for "${meta.id}"`,
    })
    await ctx.fiber.dispose()
  })

  it('preserves caller cancellation when the backend ignores the aborted signal', async () => {
    const ctx = await queryContext()
    const meta = header('window-aborted')
    const readWindow = vi.fn().mockResolvedValue(storedWindow(meta))
    ctx.provide('sessionPersistence', { readWindow } as never)
    const controller = new AbortController()
    const reason = new Error('window read cancelled')
    controller.abort(reason)

    await expect(ctx.sessionQuery.readWindow(meta.id, { signal: controller.signal })).rejects.toBe(reason)
    await ctx.fiber.dispose()
  })
})
