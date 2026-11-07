import { describe, expect, it } from 'vitest'
import { RelayError } from '../../src/errors.ts'
import { deriveRelayAddress, normalizeDomain, validateClientKey, validateUsername } from '../../src/validation.ts'

describe('relay input validation', () => {
  it('normalizes a bare domain and an https URL form', () => {
    expect(normalizeDomain(' Relay.Example.COM. ')).toBe('relay.example.com')
    expect(normalizeDomain('https://relay.example.com/')).toBe('relay.example.com')
  })

  it('refuses non-https schemes, paths, ports, and single labels', () => {
    for (const value of ['http://relay.example.com', 'relay.example.com/path', 'relay.example.com:8443', 'localhost', '']) {
      expect(() => normalizeDomain(value)).toThrow(RelayError)
    }
    expect(() => normalizeDomain('http://relay.example.com')).toThrow(/bare domain/u)
  })

  it('validates the protocol username grammar', () => {
    expect(validateUsername('ryan')).toBe('ryan')
    expect(validateUsername('a')).toBe('a')
    expect(validateUsername('r')).toBe('r')
    for (const value of ['R', '1ryan', 'ryan_', '-ryan', 'ryan-', 'a'.repeat(33)]) {
      expect(() => validateUsername(value)).toThrow(/username/u)
    }
  })

  it('validates the client key format', () => {
    expect(validateClientKey('dshk_' + 'A'.repeat(43))).toBe('dshk_' + 'A'.repeat(43))
    for (const value of ['dshk_short', 'x'.repeat(48), 'dshk_' + 'A'.repeat(44)]) {
      expect(() => validateClientKey(value)).toThrow(/client key/u)
    }
  })

  it('derives the public address only when both fields are valid', () => {
    expect(deriveRelayAddress('relay.example.com', 'ryan')).toBe('https://ryan.relay.example.com/')
    expect(deriveRelayAddress('bad domain', 'ryan')).toBeUndefined()
    expect(deriveRelayAddress('relay.example.com', 'Ryan')).toBeUndefined()
  })
})
