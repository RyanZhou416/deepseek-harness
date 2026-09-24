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
    const retention = new TerminalRetention(undefined, 1, (id) => { removed.push(id) })
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
    const retention = new TerminalRetention(50, undefined, (id) => { removed.push(id) })
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
    const retention = new TerminalRetention(undefined, 0, (id) => { removed.push(id) })
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
    const retention = new TerminalRetention(60_000, undefined, () => {})
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
})
