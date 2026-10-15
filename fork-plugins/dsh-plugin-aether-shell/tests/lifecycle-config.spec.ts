/** Deployment admission and timer bounds for live sessions and background jobs. */
import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveConfig } from '../src/config.ts'

describe('aether lifecycle configuration', () => {
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
