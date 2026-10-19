/** Deployment admission and timer bounds for live sessions and background jobs. */
import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { queryExecutionTimeout, resolveConfig } from '../src/config.ts'

describe('aether lifecycle configuration', () => {
  it('separates default foreground waiting from optional hard query execution limits', () => {
    expect(resolveConfig().promoteOnTimeout).toBe(true)
    expect(resolveConfig({ promoteOnTimeout: false }).promoteOnTimeout).toBe(false)
    expect(queryExecutionTimeout(undefined, resolveConfig())).toBe(0)
    expect(queryExecutionTimeout(900, resolveConfig())).toBe(900)
    const capped = resolveConfig({ maxBackgroundRuntimeMs: 700 })
    expect(queryExecutionTimeout(undefined, capped)).toBe(700)
    expect(queryExecutionTimeout(900, capped)).toBe(700)
    expect(queryExecutionTimeout(500, capped)).toBe(500)
    expect(queryExecutionTimeout(MAX_TIMER_DELAY_MS, resolveConfig())).toBe(MAX_TIMER_DELAY_MS)
  })

  it.each([0, -1, 1.5, Number.NaN, Infinity, MAX_TIMER_DELAY_MS + 1])('rejects invalid query execution deadline %s before execution', value => {
    expect(() => queryExecutionTimeout(value, resolveConfig())).toThrowError(expect.objectContaining({ code: 'E_INPUT_TIMEOUT' }))
  })
  it('resolves explicit defaults without imposing a background deadline', () => {
    expect(resolveConfig()).toMatchObject({
      maxSessionsPerOwner: 4,
      sessionIdleTimeoutMs: 1_800_000,
      sessionStartupTimeoutMs: 30_000,
      maxBackgroundRuntimeMs: 0,
    })
  })

  it('accepts disabled idle reaping and the exact host timer ceiling', () => {
    expect(resolveConfig({
      maxSessionsPerOwner: 1,
      sessionIdleTimeoutMs: 0,
      sessionStartupTimeoutMs: MAX_TIMER_DELAY_MS,
      maxBackgroundRuntimeMs: MAX_TIMER_DELAY_MS,
    })).toMatchObject({
      maxSessionsPerOwner: 1,
      sessionIdleTimeoutMs: 0,
      sessionStartupTimeoutMs: MAX_TIMER_DELAY_MS,
      maxBackgroundRuntimeMs: MAX_TIMER_DELAY_MS,
    })
  })

  for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects unusable session admission limit ${value}`, () => {
      expect(() => resolveConfig({ maxSessionsPerOwner: value })).toThrow('maxSessionsPerOwner')
    })
  }

  for (const field of ['sessionIdleTimeoutMs', 'sessionStartupTimeoutMs', 'maxBackgroundRuntimeMs'] as const) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      it(`rejects unusable ${field} ${value}`, () => {
        expect(() => resolveConfig({ [field]: value })).toThrow(field)
      })
    }
  }

  it('requires a nonzero startup deadline', () => {
    expect(() => resolveConfig({ sessionStartupTimeoutMs: 0 })).toThrow('sessionStartupTimeoutMs')
  })
})
