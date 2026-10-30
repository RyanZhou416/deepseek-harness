/** Per-session queueing and the bounded session-busy retry. */

import { POOL_CAPACITY_CODE, POOL_RATE_LIMITED_CODE, POOL_SESSION_BUSY_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSerialGate } from '../src/session-gate.ts'

/** Every test starts from real timers; a bounded-retry case may replace them. */
afterEach(() => { vi.useRealTimers() })

/** One promise plus its resolver, for holding a stream open from the test. */
interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

/**
 * A promise the test settles when it wants the held work to continue.
 * @returns the promise and its resolver.
 */
function deferred(): Deferred {
  let settle: () => void = () => {}
  const promise = new Promise<void>((resolve) => { settle = resolve })
  return { promise, resolve: () => { settle() } }
}

/** One stream whose open and end the shared log records. */
interface HeldStream {
  readonly stream: AsyncIterable<StreamChunk>
  release(): void
}

/**
 * A stream that opens immediately and finishes only when released.
 * @param label - text the stream forwards and log prefix.
 * @param log - shared event log.
 * @returns the stream and its release.
 */
function heldStream(label: string, log: string[]): HeldStream {
  const open = deferred()
  return {
    release: () => { open.resolve() },
    stream: {
      async *[Symbol.asyncIterator]() {
        log.push(`${label}:open`)
        await open.promise
        yield { type: 'text-delta', index: 0, text: label }
        log.push(`${label}:end`)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

/**
 * One fixed stream of already-decided chunks.
 * @param chunks - chunks the stream yields in order.
 * @returns the stream.
 */
function scripted(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

/**
 * Collect every chunk of one stream.
 * @param stream - stream to consume.
 * @returns the chunks in order.
 */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * Let pending microtask work run until `condition` holds. Fake timers leave
 * only the retry delay pending, so this is how a test observes that delay
 * before advancing the clock.
 * @param condition - state the stream must reach.
 */
async function settleUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000 && !condition(); turn += 1) await Promise.resolve()
  if (!condition()) throw new Error('the stream did not reach the expected state')
}

/** The terminal chunk the pool sends when a session already has a request in flight. */
const BUSY: StreamChunk = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: { message: 'this session already has an in-flight request', code: POOL_SESSION_BUSY_CODE },
  },
}

/** The terminal chunk a pool at its global slot limit sends, with the provider's wait. */
const RATE_LIMITED: StreamChunk = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      message: 'all pool slots are in use',
      code: POOL_RATE_LIMITED_CODE,
      status: 429,
      providerRetryAfterMs: 30_000,
    },
  },
}

/** The terminal chunk a pool with no free session slot sends. */
const CAPACITY: StreamChunk = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      message: 'no free pool session slot',
      code: POOL_CAPACITY_CODE,
      status: 429,
      providerRetryAfterMs: 5_000,
    },
  },
}

/** Pool refusals the gate must deliver unchanged instead of retrying. */
const UNRETRIED_REFUSALS: readonly [string, StreamChunk][] = [
  ['a rate-limit refusal', RATE_LIMITED],
  ['a capacity refusal', CAPACITY],
]

/** The success chunks every served retry ends with. */
const ANSWERED: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'answered' },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('same-session ordering', () => {
  it("opens one session's streams in request order", async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const second = heldStream('second', log)

    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    const secondDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => second.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })
    expect(gate.activeSessions).toBe(1)

    first.release()
    await firstDone
    await vi.waitFor(() => { expect(log).toContain('second:open') })
    second.release()
    await secondDone
    expect(log).toEqual(['first:open', 'first:end', 'second:open', 'second:end'])
    expect(gate.activeSessions).toBe(0)
  })

  it('runs different sessions concurrently', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('a', log)
    const second = heldStream('b', log)

    const firstDone = drain(gate.serialize({ sessionId: 'a', signal: undefined, open: () => first.stream }))
    const secondDone = drain(gate.serialize({ sessionId: 'b', signal: undefined, open: () => second.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['a:open', 'b:open']) })
    expect(gate.activeSessions).toBe(2)

    first.release()
    second.release()
    await Promise.all([firstDone, secondDone])
    expect(gate.activeSessions).toBe(0)
  })

  it('takes no lane until its stream is read, so a dropped iterable cannot wedge the session', async () => {
    const gate = new SessionSerialGate()
    let droppedOpened = 0
    const dropped = gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => {
        droppedOpened += 1
        return scripted(...ANSWERED)
      },
    })
    // Creating the iterable is not a request: nothing has been sent, so the
    // session stays free even if its consumer never reads or closes it.
    expect(gate.activeSessions).toBe(0)
    void dropped

    const sameSession = gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => scripted(...ANSWERED),
    })
    expect(await drain(sameSession)).toEqual(ANSWERED)
    expect(droppedOpened).toBe(0)
    expect(gate.activeSessions).toBe(0)
  })

  it('leaves no lane behind for a stream stopped before its first read', async () => {
    const gate = new SessionSerialGate()
    const iterator = gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => scripted(...ANSWERED),
    })[Symbol.asyncIterator]()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    await iterator.return()
    expect(gate.activeSessions).toBe(0)
  })

  it('hands the session to the next request when a stream fails', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const second = heldStream('second', log)
    const failing: AsyncIterable<StreamChunk> = {
      async *[Symbol.asyncIterator]() {
        log.push('failing:open')
        throw new Error('upstream exploded')
      },
    }

    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => failing }))
    const secondDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => second.stream }))
    await expect(firstDone).rejects.toThrow('upstream exploded')
    await vi.waitFor(() => { expect(log).toContain('second:open') })
    second.release()
    await secondDone
    expect(gate.activeSessions).toBe(0)
  })
})

describe('queue cancellation and cleanup', () => {
  it('drops an aborted wait without opening its stream', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const third = heldStream('third', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    const abort = new AbortController()
    let opened = 0
    const abortedDone = drain(gate.serialize({
      sessionId: 's',
      signal: abort.signal,
      open: () => { opened += 1; return third.stream },
    }))
    abort.abort()
    await expect(abortedDone).rejects.toMatchObject({ code: 'ABORTED' })
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(1)

    // The removed waiter must not hold the lane: the next request runs once the
    // holder releases, without waiting for a queue entry that no longer exists.
    const thirdDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => third.stream }))
    first.release()
    await firstDone
    await vi.waitFor(() => { expect(log).toContain('third:open') })
    third.release()
    await thirdDone
    expect(log).toEqual(['first:open', 'first:end', 'third:open', 'third:end'])
    expect(gate.activeSessions).toBe(0)
  })

  it('does not queue a stream that is abandoned before it is read', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const third = heldStream('third', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    const abandoned = gate.serialize({ sessionId: 's', signal: undefined, open: () => third.stream })
    const iterator = abandoned[Symbol.asyncIterator]()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    await iterator.return()
    // Only the holder's lane exists: the abandoned stream never took a slot.
    expect(gate.activeSessions).toBe(1)

    const thirdDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => third.stream }))
    first.release()
    await firstDone
    await vi.waitFor(() => { expect(log).toContain('third:open') })
    third.release()
    await thirdDone
    expect(gate.activeSessions).toBe(0)
  })

  it('aborts queued requests and drops every lane on dispose', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    let opened = 0
    const queuedDone = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { opened += 1; return first.stream },
    }))
    gate.dispose()
    await expect(queuedDone).rejects.toMatchObject({ code: 'ABORTED' })
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(0)

    first.release()
    await firstDone
  })

  it('refuses a request whose caller aborted before it queued', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    const abort = new AbortController()
    abort.abort()
    let opened = 0
    const open = (): AsyncIterable<StreamChunk> => { opened += 1; return scripted(...ANSWERED) }
    // A stream stopped without reading releases the already-aborted turn it
    // never awaited; a read on a fresh queue entry reports the cancellation.
    const abandoned = gate.serialize({ sessionId: 's', signal: abort.signal, open })
    const iterator = abandoned[Symbol.asyncIterator]()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    await iterator.return()
    await expect(drain(gate.serialize({ sessionId: 's', signal: abort.signal, open })))
      .rejects.toMatchObject({ code: 'ABORTED' })
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(1)

    first.release()
    await firstDone
    expect(gate.activeSessions).toBe(0)
  })

  it('stops an already-aborted turn it never awaited without opening it', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    const abort = new AbortController()
    abort.abort()
    let opened = 0
    const iterator = gate.serialize({
      sessionId: 's',
      signal: abort.signal,
      open: () => { opened += 1; return scripted(...ANSWERED) },
    })[Symbol.asyncIterator]()
    const pending = iterator.next()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    // The stop lands after the slot was taken but before its already-aborted
    // turn resumed: skipping that turn has nothing to release or open.
    const stopping = iterator.return()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await stopping
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(1)

    first.release()
    await firstDone
    expect(gate.activeSessions).toBe(0)
  })

  it('hands a session to a queued request and releases it before its turn ran', async () => {
    const gate = new SessionSerialGate()
    let opened = 0
    const open = (): AsyncIterable<StreamChunk> => { opened += 1; return scripted(...ANSWERED) }
    const holder = gate.serialize({ sessionId: 's', signal: undefined, open })
    const holderIterator = holder[Symbol.asyncIterator]()
    const queued = gate.serialize({ sessionId: 's', signal: undefined, open })
    const queuedIterator = queued[Symbol.asyncIterator]()
    const holderNext = holderIterator.next()
    const queuedNext = queuedIterator.next()
    if (holderIterator.return === undefined || queuedIterator.return === undefined) {
      throw new Error('the queue stream must expose return')
    }

    // The holder never opened its upstream, so its stop is synchronous: the
    // queued turn is granted and stopped in the same tick, before either stream
    // resumes. The stopped turn releases the lane, and the resumed read releases
    // it again instead of opening an upstream for a turn it no longer owns.
    const holderStop = holderIterator.return()
    const queuedStop = queuedIterator.return()
    await expect(holderNext).resolves.toEqual({ done: true, value: undefined })
    await expect(queuedNext).resolves.toEqual({ done: true, value: undefined })
    await Promise.all([holderStop, queuedStop])
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(0)
  })

  it('releases an acquired stream stopped before its first read', async () => {
    const gate = new SessionSerialGate()
    let opened = 0
    const iterator = gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { opened += 1; return scripted(...ANSWERED) },
    })[Symbol.asyncIterator]()
    const pending = iterator.next()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')

    // The stop lands before the granted turn resumes, so both the stop and the
    // resumed read release the same session; the second release must not hand
    // the lane over twice.
    const stopping = iterator.return()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await stopping
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(0)
  })

  it('settles a queued read as done when its stream is stopped while it waits', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    const queued = gate.serialize({ sessionId: 's', signal: undefined, open: () => scripted(...ANSWERED) })
    const iterator = queued[Symbol.asyncIterator]()
    const pending = iterator.next()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    await iterator.return()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    // Only the holder's lane remains; the stopped request left the queue.
    expect(gate.activeSessions).toBe(1)

    first.release()
    await firstDone
    expect(gate.activeSessions).toBe(0)
  })

  it('aborts an acquired request whose caller cancels before the stream opens', async () => {
    const gate = new SessionSerialGate()
    const abort = new AbortController()
    let opened = 0
    const iterator = gate.serialize({
      sessionId: 's',
      signal: abort.signal,
      open: () => { opened += 1; return scripted(...ANSWERED) },
    })[Symbol.asyncIterator]()
    const pending = iterator.next()
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(opened).toBe(0)
    expect(gate.activeSessions).toBe(0)
  })
})

describe('lease-release refusal', () => {
  it('forwards the usage sample of a served attempt unchanged', async () => {
    const gate = new SessionSerialGate()
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
    const chunks = await drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => scripted(usage, ...ANSWERED),
    }))
    expect(chunks).toEqual([usage, ...ANSWERED])
    expect(gate.activeSessions).toBe(0)
  })

  it('retries a queued request once the pool releases its previous lease', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    let attempts = 0
    const secondDone = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => {
        attempts += 1
        return attempts === 1 ? scripted(BUSY) : scripted(...ANSWERED)
      },
    }))
    first.release()
    await firstDone
    expect(await secondDone).toEqual(ANSWERED)
    expect(attempts).toBe(2)
    expect(gate.activeSessions).toBe(0)
  })

  it("drops the refused attempt's usage sample with the stream it replaced", async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    const refusedUsage: StreamChunk = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    let attempts = 0
    const secondDone = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => {
        attempts += 1
        return attempts === 1 ? scripted(refusedUsage, BUSY) : scripted(...ANSWERED)
      },
    }))
    first.release()
    await firstDone
    expect(await secondDone).toEqual(ANSWERED)
    expect(attempts).toBe(2)
    expect(gate.activeSessions).toBe(0)
  })

  it('retries a session-busy refusal on a request that never queued', async () => {
    const gate = new SessionSerialGate()
    let attempts = 0
    const chunks = await drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => {
        attempts += 1
        return attempts === 1 ? scripted(BUSY) : scripted(...ANSWERED)
      },
    }))
    expect(chunks).toEqual(ANSWERED)
    expect(attempts).toBe(2)
    expect(gate.activeSessions).toBe(0)
  })

  it('opens a session-busy retry with a fresh attempt nonce', async () => {
    const gate = new SessionSerialGate()
    const nonces: (string | undefined)[] = []
    const chunks = await drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: (retryNonce) => {
        nonces.push(retryNonce)
        return nonces.length === 1 ? scripted(BUSY) : scripted(...ANSWERED)
      },
    }))
    expect(chunks).toEqual(ANSWERED)
    // The first attempt keeps the caller's attempt identity; the refused
    // attempt's ledger entry is already closed at the pool, so the retry must
    // carry a different nonce instead of reusing its request id.
    expect(nonces).toHaveLength(2)
    expect(nonces[0]).toBeUndefined()
    expect(nonces[1]).toEqual(expect.any(String))
    expect(nonces[1]).not.toBe('')
  })

  it('forwards a session-busy refusal after content was already forwarded', async () => {
    const gate = new SessionSerialGate()
    const partial: StreamChunk = { type: 'text-delta', index: 0, text: 'partial' }
    let attempts = 0
    const chunks = await drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => {
        attempts += 1
        return scripted(partial, BUSY)
      },
    }))
    // Repeating the attempt would duplicate forwarded model content, so the
    // refusal is delivered as the stream's terminal chunk instead.
    expect(chunks).toEqual([partial, BUSY])
    expect(attempts).toBe(1)
    expect(gate.activeSessions).toBe(0)
  })

  it('bounds an unqueued session-busy retry at eight attempts', async () => {
    vi.useFakeTimers()
    const gate = new SessionSerialGate()
    let attempts = 0
    const done = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { attempts += 1; return scripted(BUSY) },
    }))
    await settleUntil(() => vi.getTimerCount() === 1)
    await vi.advanceTimersByTimeAsync(1_800)
    expect(await done).toEqual([BUSY])
    expect(attempts).toBe(9)
    expect(gate.activeSessions).toBe(0)
  })

  it('aborts a session-busy retry when the caller cancels', async () => {
    vi.useFakeTimers()
    const gate = new SessionSerialGate()
    const abort = new AbortController()
    let attempts = 0
    const done = drain(gate.serialize({
      sessionId: 's',
      signal: abort.signal,
      open: () => { attempts += 1; return scripted(BUSY) },
    }))
    await settleUntil(() => vi.getTimerCount() === 1)
    abort.abort()
    await expect(done).rejects.toMatchObject({ code: 'ABORTED' })
    expect(attempts).toBe(1)
    expect(gate.activeSessions).toBe(0)
  })

  it('stops a session-busy retry whose refused attempt closes after the caller aborted', async () => {
    const gate = new SessionSerialGate()
    const abort = new AbortController()
    const closing = deferred()
    let closeStarted = false
    const refused: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        return {
          next: () => Promise.resolve({ done: false, value: BUSY }),
          async return() {
            closeStarted = true
            await closing.promise
            return { done: true, value: undefined }
          },
        }
      },
    }
    const done = drain(gate.serialize({ sessionId: 's', signal: abort.signal, open: () => refused }))
    await settleUntil(() => closeStarted)
    // The refusal is already being closed when the caller cancels, so the next
    // retry delay starts from an aborted signal and settles as cancellation.
    abort.abort()
    closing.resolve()
    await expect(done).rejects.toMatchObject({ code: 'ABORTED' })
    expect(gate.activeSessions).toBe(0)
  })

  it('retries a session-busy attempt whose upstream exposes no return', async () => {
    const gate = new SessionSerialGate()
    let attempts = 0
    const refused: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        return { next: () => Promise.resolve({ done: false, value: BUSY }) }
      },
    }
    const chunks = await drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { attempts += 1; return attempts === 1 ? refused : scripted(...ANSWERED) },
    }))
    expect(chunks).toEqual(ANSWERED)
    expect(attempts).toBe(2)
    expect(gate.activeSessions).toBe(0)
  })

  it.each(UNRETRIED_REFUSALS)('never retries %s on a request that waited', async (_label, refusal) => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const first = heldStream('first', log)
    const firstDone = drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => first.stream }))
    await vi.waitFor(() => { expect(log).toEqual(['first:open']) })

    let attempts = 0
    const secondDone = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { attempts += 1; return scripted(refusal) },
    }))
    first.release()
    await firstDone
    expect(await secondDone).toEqual([refusal])
    expect(attempts).toBe(1)
    expect(gate.activeSessions).toBe(0)
  })

  it('returns a rate-limit refusal promptly on a request that never queued', async () => {
    const gate = new SessionSerialGate()
    let attempts = 0
    const chunks = await drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { attempts += 1; return scripted(RATE_LIMITED) },
    }))
    expect(chunks).toEqual([RATE_LIMITED])
    expect(attempts).toBe(1)
    expect(gate.activeSessions).toBe(0)
  })
})

describe('stream failures release the session', () => {
  /**
   * Start a request whose opener fails before its first read, then prove the
   * request queued behind it inherits the lane.
   * @param open - opener that throws synchronously.
   */
  async function expectHandoverAfterSyncFailure(open: () => AsyncIterable<StreamChunk>): Promise<void> {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const follower = heldStream('follower', log)
    const failed = drain(gate.serialize({ sessionId: 's', signal: undefined, open }))
    const followerDone = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => follower.stream,
    }))
    await expect(failed).rejects.toThrow('exploded')
    await vi.waitFor(() => { expect(log).toEqual(['follower:open']) })
    follower.release()
    await followerDone
    expect(gate.activeSessions).toBe(0)
  }

  it('hands the session to the next request when the opener throws synchronously', async () => {
    await expectHandoverAfterSyncFailure(() => { throw new Error('opener exploded') })
  })

  it('hands the session to the next request when the iterator factory throws', async () => {
    await expectHandoverAfterSyncFailure(() => ({
      [Symbol.asyncIterator]() { throw new Error('iterator exploded') },
    }))
  })

  it('leaves no lane behind when the opener throws and nothing is queued', async () => {
    const gate = new SessionSerialGate()
    const failed = drain(gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => { throw new Error('opener exploded') },
    }))
    await expect(failed).rejects.toThrow('opener exploded')
    expect(gate.activeSessions).toBe(0)
  })
})

describe('stream lifecycle', () => {
  it('forwards a usage sample whose attempt ends without a terminal chunk', async () => {
    const gate = new SessionSerialGate()
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    expect(await drain(gate.serialize({ sessionId: 's', signal: undefined, open: () => scripted(usage) })))
      .toEqual([usage])
    expect(gate.activeSessions).toBe(0)
  })

  it('closes the opened upstream when the consumer stops early', async () => {
    const gate = new SessionSerialGate()
    const log: string[] = []
    const partial: StreamChunk = { type: 'text-delta', index: 0, text: 'partial' }
    const upstream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        let read = false
        return {
          next: () => {
            if (read) return Promise.resolve({ done: true, value: undefined })
            read = true
            return Promise.resolve({ done: false, value: partial })
          },
          return: () => { log.push('closed'); return Promise.resolve({ done: true, value: undefined }) },
        }
      },
    }
    const iterator = gate.serialize({ sessionId: 's', signal: undefined, open: () => upstream })[Symbol.asyncIterator]()
    await iterator.next()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    await iterator.return()
    expect(log).toEqual(['closed'])
    expect(gate.activeSessions).toBe(0)
  })

  it('finishes when the opened upstream exposes no return', async () => {
    const gate = new SessionSerialGate()
    const partial: StreamChunk = { type: 'text-delta', index: 0, text: 'partial' }
    const upstream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        return { next: () => Promise.resolve({ done: false, value: partial }) }
      },
    }
    const iterator = gate.serialize({ sessionId: 's', signal: undefined, open: () => upstream })[Symbol.asyncIterator]()
    await iterator.next()
    if (iterator.return === undefined) throw new Error('the queue stream must expose return')
    await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined })
    expect(gate.activeSessions).toBe(0)
  })

  it('answers done for a read after the stream settled', async () => {
    const gate = new SessionSerialGate()
    const iterator = gate.serialize({
      sessionId: 's',
      signal: undefined,
      open: () => scripted(...ANSWERED),
    })[Symbol.asyncIterator]()
    const chunks: StreamChunk[] = []
    for (let item = await iterator.next(); item.done !== true; item = await iterator.next()) chunks.push(item.value)
    expect(chunks).toEqual(ANSWERED)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(gate.activeSessions).toBe(0)
  })
})
