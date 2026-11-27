/** Bounded log-fold slots and the opening gate behind paged projection reads. */

import { describe, expect, it } from 'vitest'
import { FoldSlots } from '../src/history/fold-slots.ts'

/** Let queued promise continuations run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

describe('FoldSlots', () => {
  it('runs at most the limit at once and hands each freed slot to the next waiter in order', async () => {
    const slots = new FoldSlots(1)
    const signal = new AbortController().signal
    const order: string[] = []
    const first = Promise.withResolvers<undefined>()
    const running = slots.run(signal, async () => {
      order.push('first')
      await first.promise
      return 1
    })
    const second = slots.run(signal, async () => { order.push('second'); return 2 })
    const third = slots.run(signal, async () => { order.push('third'); return 3 })
    await settle()
    expect(order).toEqual(['first'])
    first.resolve(undefined)
    await expect(Promise.all([running, second, third])).resolves.toEqual([1, 2, 3])
    expect(order).toEqual(['first', 'second', 'third'])
    // The slot is free again after the queue drains.
    await expect(slots.run(signal, async () => 'again')).resolves.toBe('again')
  })

  it('releases the slot when a fold fails', async () => {
    const slots = new FoldSlots(1)
    const signal = new AbortController().signal
    const failure = new Error('fold failed')
    await expect(slots.run(signal, async () => { throw failure })).rejects.toBe(failure)
    await expect(slots.run(signal, async () => 'next')).resolves.toBe('next')
  })

  it('rejects a cancelled waiter without running it and keeps the queue for the others', async () => {
    const slots = new FoldSlots(1)
    const held = Promise.withResolvers<undefined>()
    const running = slots.run(new AbortController().signal, async () => { await held.promise })
    const cancelled = new AbortController()
    const reason = new Error('page closed')
    let ran = false
    const waiting = slots.run(cancelled.signal, async () => { ran = true })
    const after = slots.run(new AbortController().signal, async () => 'after')
    cancelled.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    held.resolve(undefined)
    await running
    await expect(after).resolves.toBe('after')
    expect(ran).toBe(false)
    // A signal aborted before the call never queues.
    await expect(slots.run(cancelled.signal, async () => 'never')).rejects.toBe(reason)
  })

  it('ignores cancellation once a waiter holds its slot', async () => {
    const slots = new FoldSlots(1)
    const held = Promise.withResolvers<undefined>()
    const running = slots.run(new AbortController().signal, async () => { await held.promise })
    const controller = new AbortController()
    const granted = Promise.withResolvers<undefined>()
    const waiting = slots.run(controller.signal, async () => {
      granted.resolve(undefined)
      await held.promise
      return 'kept'
    })
    held.resolve(undefined)
    await running
    await granted.promise
    controller.abort(new Error('late'))
    await expect(waiting).resolves.toBe('kept')
  })

  it('holds reads until every opening ends, and lets a cancelled read leave', async () => {
    const slots = new FoldSlots(1)
    const signal = new AbortController().signal
    await expect(slots.afterOpenings(signal)).resolves.toBeUndefined()
    const endFirst = slots.beginOpening()
    const endSecond = slots.beginOpening()
    let released = false
    const waiting = slots.afterOpenings(signal).then(() => { released = true })
    const cancelled = new AbortController()
    const leaving = slots.afterOpenings(cancelled.signal)
    const reason = new Error('page closed')
    cancelled.abort(reason)
    await expect(leaving).rejects.toBe(reason)
    endFirst()
    endFirst()
    await settle()
    expect(released).toBe(false)
    endSecond()
    await waiting
    expect(released).toBe(true)
    // A new opening after the quiet point holds later reads again.
    const endThird = slots.beginOpening()
    let later = false
    const next = slots.afterOpenings(signal).then(() => { later = true })
    await settle()
    expect(later).toBe(false)
    endThird()
    await next
    await expect(slots.afterOpenings(cancelled.signal)).rejects.toBe(reason)
  })
})
