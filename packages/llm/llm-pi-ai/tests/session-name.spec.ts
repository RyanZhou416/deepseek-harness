import { describe, expect, it } from 'vitest'
import { encodeSessionNameHeader, MAX_SESSION_NAME_HEADER_LENGTH } from '../src/session-name.ts'

describe('session name header encoding', () => {
  it('leaves every RFC 3986 unreserved character literal', () => {
    expect(encodeSessionNameHeader('Fix-bug_2.1~alpha')).toBe('Fix-bug_2.1~alpha')
  })

  it('percent-encodes spaces, UTF-8, and reserved characters as uppercase ASCII escapes', () => {
    expect(encodeSessionNameHeader('Fix café 100% / a+b&c=d?e#f'))
      .toBe('Fix%20caf%C3%A9%20100%25%20%2F%20a%2Bb%26c%3Dd%3Fe%23f')
  })

  it('encodes every byte of an astral character', () => {
    expect(encodeSessionNameHeader('🚀 launch')).toBe('%F0%9F%9A%80%20launch')
  })

  it('sends no header for an empty name', () => {
    expect(encodeSessionNameHeader('')).toBeUndefined()
  })

  it('accepts a name whose encoding is exactly the byte limit', () => {
    const name = 'a'.repeat(MAX_SESSION_NAME_HEADER_LENGTH)
    expect(encodeSessionNameHeader(name)).toBe(name)
  })

  it('drops a name whose encoding would exceed the byte limit instead of truncating it', () => {
    // Three UTF-8 bytes each encode to nine ASCII bytes.
    expect(encodeSessionNameHeader('山'.repeat(56))).toBeDefined()
    expect(encodeSessionNameHeader('山'.repeat(57))).toBeUndefined()
  })

  it('skips control characters and line separators the pool would refuse after decoding', () => {
    // Percent-encoding these would still deliver them decoded, so the pool's
    // name check would reject the whole request over a display label.
    expect(encodeSessionNameHeader('a\u0000b\u001fc\u007fd\u0085e\u2028f\u2029g'))
      .toBe('abcdefg')
  })

  it('sends no header when every character is dropped', () => {
    expect(encodeSessionNameHeader('\u0000\u0007\u0080')).toBeUndefined()
  })
})
