/** Node half: the empty host apply (Loader governance + dsh.client discovery placeholder). */
import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'

describe('node half', () => {
  it('apply is a no-op host placeholder', () => {
    apply(undefined)
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('validates and defaults the live-window rebase threshold', () => {
    expect(Config({})).toEqual({ liveWindowRebaseEventThreshold: 20_000 })
    expect(Config({ liveWindowRebaseEventThreshold: 7 })).toEqual({
      liveWindowRebaseEventThreshold: 7,
    })
    expect(() => Config({ liveWindowRebaseEventThreshold: 0 })).toThrow()
  })
})
