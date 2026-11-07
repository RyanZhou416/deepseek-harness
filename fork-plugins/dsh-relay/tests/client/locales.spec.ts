import { describe, expect, it } from 'vitest'
import { RELAY_ERROR_CODES } from '../../src/shared.ts'
import { en, zh } from '../../src/client/locales.ts'
import { errorKey, phaseKey } from '../../src/client/state.ts'

describe('relay locale dictionaries', () => {
  it('keeps Chinese and English key sets identical with no empty text', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of [...Object.values(en), ...Object.values(zh)]) expect(value.trim()).not.toBe('')
  })

  it('maps every failure code to its own message', () => {
    const keys = RELAY_ERROR_CODES.map(code => errorKey(code))
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
  })

  it('falls back for an unknown code and maps phases', () => {
    expect(errorKey('from-a-newer-host')).toBe('errorUnknown')
    expect(errorKey(undefined)).toBe('errorUnknown')
    expect(phaseKey('connected')).toBe('statusConnected')
    expect(phaseKey('downloading')).toBe('statusDownloading')
  })
})
