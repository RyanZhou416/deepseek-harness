import { describe, expect, it } from 'vitest'
import {
  draftFromStatus,
  draftAddress,
  downloadPercent,
  formatInstant,
  isBusyPhase,
  phaseKey,
  savedAccountConfigured,
  saveRequest,
} from '../../src/client/state.ts'
import type { RelayStatus } from '../../src/shared.ts'

const STATUS: RelayStatus = {
  phase: 'disconnected',
  account: {
    domain: 'relay.example.com',
    username: 'ryan',
    hasPassword: true,
    hasClientKey: true,
    autoConnect: true,
  },
}

describe('relay page state', () => {
  it('builds a draft without echoing stored secrets', () => {
    const draft = draftFromStatus(STATUS)
    expect(draft).toEqual({
      domain: 'relay.example.com',
      username: 'ryan',
      password: '',
      clientKey: '',
      autoConnect: true,
    })
  })

  it('keeps secrets out of the save request when the inputs are empty', () => {
    const draft = draftFromStatus(STATUS)
    expect(saveRequest(draft)).toEqual({
      domain: 'relay.example.com',
      username: 'ryan',
      autoConnect: true,
    })
    expect(saveRequest({ ...draft, password: 'new password', clientKey: 'key' })).toEqual({
      domain: 'relay.example.com',
      username: 'ryan',
      autoConnect: true,
      password: 'new password',
      clientKey: 'key',
    })
  })

  it('recognizes complete accounts and derives the public address', () => {
    expect(savedAccountConfigured(STATUS.account)).toBe(true)
    expect(savedAccountConfigured({ ...STATUS.account, hasPassword: false })).toBe(false)
    expect(savedAccountConfigured(undefined)).toBe(false)
    expect(draftAddress({ ...draftFromStatus(STATUS) })).toBe('https://ryan.relay.example.com/')
    expect(draftAddress({ ...draftFromStatus(STATUS), username: 'R' })).toBeUndefined()
  })

  it('formats download progress and busy phases', () => {
    expect(downloadPercent({ received: 50, total: 100 })).toBe(50)
    expect(downloadPercent({ received: 50 })).toBeUndefined()
    expect(downloadPercent({ received: 200, total: 100 })).toBe(100)
    expect(isBusyPhase('downloading')).toBe(true)
    expect(isBusyPhase('connecting')).toBe(true)
    expect(isBusyPhase('connected')).toBe(false)
    expect(phaseKey('failed')).toBe('statusFailed')
  })

  it('formats a valid timestamp and keeps an invalid one verbatim', () => {
    expect(formatInstant('2026-01-02T03:04:05.000Z', 'en-US')).toContain('2026')
    expect(formatInstant('not-a-date', 'en-US')).toBe('not-a-date')
  })
})
