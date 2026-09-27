import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { TerminalRetention } from '../src/retention.ts'

afterEach(() => { vi.useRealTimers() })

describe('terminal job retention', () => {
  it('prunes reported records by exact owner while preserving unread results', async () => {
    vi.useFakeTimers()
    const owner = {} as Agent
    const other = {} as Agent
    const removed: JobId[] = []
    const retention = new TerminalRetention(undefined, 1, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('a'), owner, 1, false)
      retention.track(JobId('b'), owner, 2, false)
      retention.track(JobId('other'), other, 3, true)
      expect(removed).toEqual([])
      retention.report(JobId('a'))
      expect(removed).toEqual([JobId('a')])
      retention.track(JobId('c'), owner, 4, true)
      expect(removed, 'the settling job remains addressable through its final signal').toEqual([JobId('a')])
      await vi.advanceTimersByTimeAsync(1)
      expect(removed).toEqual([JobId('a'), JobId('c')])
    } finally {
      retention.dispose()
    }
  })

  it('expires unread jobs on one unref timer and cancels it when the last record leaves', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const removed: JobId[] = []
    const retention = new TerminalRetention(50, undefined, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('expire'), undefined, Date.now(), false)
      await vi.advanceTimersByTimeAsync(49)
      expect(removed).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(removed).toEqual([JobId('expire')])
      expect(vi.getTimerCount()).toBe(0)
      retention.track(JobId('removed'), undefined, Date.now(), false)
      retention.forget(JobId('removed'))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      retention.dispose()
    }
  })

  it('deferred pruning releases a freshly reported zero-target result after delivery', async () => {
    vi.useFakeTimers()
    const removed: JobId[] = []
    const retention = new TerminalRetention(undefined, 0, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('fresh'), undefined, Date.now(), true)
      expect(removed).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(removed).toEqual([JobId('fresh')])
    } finally {
      retention.dispose()
    }
  })

  it('bounds stale expiry references after explicit removals', () => {
    vi.useFakeTimers()
    const retention = new TerminalRetention(60_000, undefined, () => {}, setTimeout)
    try {
      for (let index = 0; index < 200; index++) {
        const id = JobId(`job-${index}`)
        retention.track(id, undefined, Date.now(), false)
        if (index === 0) {
          const expiry = Object.getOwnPropertyDescriptor(retention, 'expiry')?.value as { peek(): object }
          const head = expiry.peek()
          expect(Object.hasOwn(head, 'owner'), 'stale heap entries cannot retain an Agent graph').toBe(false)
        }
        retention.forget(id)
      }
      const expiry = Object.getOwnPropertyDescriptor(retention, 'expiry')?.value as { size: number }
      expect(expiry.size).toBeLessThanOrEqual(64)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      retention.dispose()
    }
  })

  it('prunes by finish time with registration order breaking ties, regardless of insertion order', () => {
    const removed: JobId[] = []
    const times = [80, 20, 60, 40, 10, 70, 30, 50, 20, 90]
    const retention = new TerminalRetention(undefined, times.length, (id) => { removed.push(id) }, setTimeout)
    try {
      times.forEach((time, index) => {
        retention.track(JobId(`read-${index}`), undefined, time, true)
      })
      expect(removed).toEqual([])
      times.forEach((_, index) => {
        retention.track(JobId(`unread-${index}`), undefined, 100 + index, false)
      })
      expect(removed).toEqual([4, 1, 8, 6, 3, 7, 2, 5, 0, 9].map(index => JobId(`read-${index}`)))
      retention.report(JobId('unread-0'))
      retention.track(JobId('overflow'), undefined, 200, false)
      expect(removed.at(-1)).toBe(JobId('unread-0'))
    } finally {
      retention.dispose()
    }
  })

  it('compacts stale count and expiry references while keeping read and unread survivors', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const removed: JobId[] = []
    const retention = new TerminalRetention(1_000, 500, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('kept-read'), undefined, 1_000, true)
      retention.track(JobId('kept-unread'), undefined, 1_000, false)
      for (let index = 0; index < 200; index++) {
        retention.track(JobId(`discard-${index}`), undefined, 1_200 - index, true)
      }
      for (let index = 0; index < 200; index++) retention.forget(JobId(`discard-${index}`))
      const expiry = Object.getOwnPropertyDescriptor(retention, 'expiry')?.value as { size: number }
      const buckets = Object.getOwnPropertyDescriptor(retention, 'buckets')?.value as Map<Agent | undefined, {
        ids: Set<JobId>
        reported: { size: number }
      }>
      expect(expiry.size).toBeLessThanOrEqual(2 * 2 + 64)
      expect(buckets.get(undefined)?.reported.size).toBeLessThanOrEqual(2 * 2 + 64)
      expect(buckets.get(undefined)?.ids).toEqual(new Set([JobId('kept-read'), JobId('kept-unread')]))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(removed).toEqual([JobId('kept-read'), JobId('kept-unread')])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      retention.dispose()
    }
  })

  it('ignores forgotten reported records when later unread jobs exceed the owner target', () => {
    const removed: JobId[] = []
    const retention = new TerminalRetention(undefined, 2, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('forgotten'), undefined, 1, true)
      retention.track(JobId('oldest-live'), undefined, 2, true)
      retention.forget(JobId('forgotten'))
      retention.track(JobId('unread-a'), undefined, 3, false)
      retention.track(JobId('unread-b'), undefined, 4, false)
      expect(removed).toEqual([JobId('oldest-live')])
    } finally {
      retention.dispose()
    }
  })

  it('keeps later expiry deadlines after the earliest record is explicitly removed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const removed: JobId[] = []
    const retention = new TerminalRetention(20, undefined, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('forgotten'), undefined, 1_000, false)
      retention.track(JobId('later'), undefined, 1_020, false)
      retention.forget(JobId('forgotten'))
      retention.track(JobId('last'), undefined, 1_040, false)
      await vi.advanceTimersByTimeAsync(20)
      expect(removed).toEqual([])
      await vi.advanceTimersByTimeAsync(20)
      expect(removed).toEqual([JobId('later')])
      await vi.advanceTimersByTimeAsync(20)
      expect(removed).toEqual([JobId('later'), JobId('last')])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      retention.dispose()
    }
  })

  it('replaces the expiry timer when a later registration has an earlier deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const removed: JobId[] = []
    const retention = new TerminalRetention(50, undefined, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('late'), undefined, 1_100, false)
      retention.track(JobId('early'), undefined, 1_050, false)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(99)
      expect(removed).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(removed).toEqual([JobId('early')])
      await vi.advanceTimersByTimeAsync(50)
      expect(removed).toEqual([JobId('early'), JobId('late')])
    } finally {
      retention.dispose()
    }
  })

  it('coalesces deferred pruning across owners and skips owners whose records were removed', async () => {
    vi.useFakeTimers()
    const removed: JobId[] = []
    const first = {} as Agent
    const second = {} as Agent
    const retention = new TerminalRetention(undefined, 0, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('forgotten'), first, 1, true)
      retention.track(JobId('remaining'), second, 2, true)
      retention.forget(JobId('forgotten'))
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(removed).toEqual([JobId('remaining')])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      retention.dispose()
    }
  })

  it('cancels both retention timers on disposal before any deferred removal', async () => {
    vi.useFakeTimers()
    const removed: JobId[] = []
    const retention = new TerminalRetention(50, 0, (id) => { removed.push(id) }, setTimeout)
    try {
      retention.track(JobId('pending'), undefined, Date.now(), true)
      expect(vi.getTimerCount()).toBe(2)
      retention.dispose()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(removed).toEqual([])
    } finally {
      retention.dispose()
    }
  })

  it('leaves no deferred prune when a removal listener also removes the fresh record', () => {
    vi.useFakeTimers()
    const removed: JobId[] = []
    const retention = new TerminalRetention(undefined, 1, (id) => {
      removed.push(id)
      retention.forget(JobId('fresh'))
    }, setTimeout)
    try {
      retention.track(JobId('old'), undefined, 1, true)
      retention.track(JobId('fresh'), undefined, 2, true)
      expect(removed).toEqual([JobId('old')])
      expect(vi.getTimerCount()).toBe(0)
      retention.report(JobId('fresh'))
      retention.forget(JobId('fresh'))
    } finally {
      retention.dispose()
    }
  })
})
