import { describe, expect, it } from 'vitest'
import {
  encodeSessionNameHeader,
  MAX_SESSION_NAME_HEADER_LENGTH,
  sanitizeSessionName,
} from '../src/session-name.ts'

/** Inclusive integer range used to build the scalar tables. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
}

/** Format one scalar for a table-driven test label. */
function scalarLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * Every scalar the pool's member-header validation refuses, mirroring
 * `MemberSessionName.isDisplayUnsafe` and `isBidiOrZeroWidth`: C0 controls,
 * DEL and C1 controls, the Unicode line/paragraph separators, and the bidi and
 * zero-width formatting set.
 */
const REFUSED_SCALARS: readonly number[] = [
  ...range(0x0000, 0x001f),
  ...range(0x007f, 0x009f),
  0x061c,
  ...range(0x200b, 0x200f),
  0x2028,
  0x2029,
  ...range(0x202a, 0x202e),
  ...range(0x2060, 0x2064),
  ...range(0x2066, 0x2069),
  0xfeff,
]

describe('session name sanitization', () => {
  it.each(REFUSED_SCALARS.map(codePoint => [scalarLabel(codePoint), String.fromCodePoint(codePoint)] as const))(
    'drops the pool-refused scalar %s from a name',
    (_label, scalar) => {
      expect(sanitizeSessionName(`a${scalar}b`)).toBe('ab')
    },
  )

  it('drops the joiner from a ZWJ emoji instead of letting the pool refuse the request', () => {
    // The pool refuses ZWJ outright; the remaining adjacent emoji are a usable
    // display label, while the raw name would be a typed 400.
    expect(sanitizeSessionName('👨‍👩‍👧')).toBe('👨👩👧')
    expect(sanitizeSessionName('👨‍💻')).toBe('👨💻')
  })

  it('removes a stray ZWSP or BOM around otherwise ordinary text', () => {
    expect(sanitizeSessionName('\u200B发布会话')).toBe('发布会话')
    expect(sanitizeSessionName('release\uFEFF')).toBe('release')
  })

  it('keeps an ordinary name, including its surrounding whitespace', () => {
    // The pool trims only to compare reserved placeholders; the decoded name it
    // displays keeps the caller's whitespace.
    expect(sanitizeSessionName('Fix café 100% / a+b&c=d?e#f')).toBe('Fix café 100% / a+b&c=d?e#f')
    expect(sanitizeSessionName(' 发布 ')).toBe(' 发布 ')
  })

  it.each([
    ['the reserved free-slot placeholder', '空闲'],
    ['the reserved unknown placeholder', '未知'],
    ['a padded placeholder', ' 空闲 '],
    ['a tab/newline-padded placeholder', '\t未知\n'],
    ['an ideographic-space-padded placeholder', '\u3000空闲\u3000'],
    ['a placeholder with an embedded ZWSP', '空\u200B闲'],
    ['a placeholder with an embedded word joiner', '未\u2060知'],
  ])('sends no header for %s', (_label, name) => {
    expect(sanitizeSessionName(name)).toBeUndefined()
  })

  it.each([
    '空闲的房间',
    '未知世界',
    '空闲 未知',
    'Release 空闲',
  ])('keeps a name that only contains a reserved placeholder as text: %s', (name) => {
    expect(sanitizeSessionName(name)).toBe(name)
  })

  it.each([
    ['an empty name', ''],
    ['only spaces', '   '],
    ['only refused scalars', '\u0000\u001F\u202E\uFEFF'],
    ['only whitespace and a BOM', ' \u3000\uFEFF '],
  ])('sends no header for %s once sanitized', (_label, name) => {
    expect(sanitizeSessionName(name)).toBeUndefined()
  })
})

describe('mechanical session name header encoding', () => {
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

  it('encodes rather than filters a scalar the pool refuses, leaving sanitation to the sanitizer', () => {
    expect(encodeSessionNameHeader('a\u0001b')).toBe('a%01b')
    expect(encodeSessionNameHeader(sanitizeSessionName('a\u0001b') ?? '')).toBe('ab')
    expect(encodeSessionNameHeader(sanitizeSessionName('👨‍💻') ?? ''))
      .toBe('%F0%9F%91%A8%F0%9F%92%BB')
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
})
