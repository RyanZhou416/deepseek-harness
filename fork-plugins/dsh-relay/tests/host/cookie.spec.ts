import { createHash, randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { BrowserAuth } from '../../../../packages/client/connection/src/browser-auth.ts'
import {
  BROWSER_SESSION_KEY,
  DAY_MS,
  browserCookieName,
  browserSessionSecret,
  mintBrowserCookie,
  readBrowserSessionSecret,
  resolveCookieMaxAgeDays,
} from '../../src/cookie.ts'
import { MemoryCredentials } from './helpers/memory-credentials.ts'

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBody(value: string): { version: number; authority: string; issuedAt: number; expiresAt: number } {
  const body = value.split('.')[1] as string
  const padded = body.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (body.length % 4)) % 4)
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
    version: number; authority: string; issuedAt: number; expiresAt: number
  }
}

async function seededCredentials(): Promise<{ credentials: MemoryCredentials; secret: Buffer }> {
  const context = new Context()
  const credentials = new MemoryCredentials(context)
  const secret = randomBytes(32)
  await credentials.modifyRecord(BROWSER_SESSION_KEY, async () => ({
    kind: 'grant',
    payload: { version: 1, secret: base64url(secret) },
  }))
  return { credentials, secret }
}

describe('DSH browser-session cookie minting', () => {
  it('produces a cookie the real BrowserAuth accepts for the same authority', async () => {
    const { credentials, secret } = await seededCredentials()
    const auth = await BrowserAuth.create(new Context().root, credentials, 30)
    const authority = '127.0.0.1:3080'
    const cookie = mintBrowserCookie(secret, authority, resolveCookieMaxAgeDays(30), Date.now())
    expect(cookie.header).toBe(`${cookie.name}=${cookie.value}`)
    expect(cookie.name).toBe('dsh-auth-' + base64url(createHash('sha256').update(authority).digest()))
    expect(auth.isAuthenticated({ headers: { host: authority, cookie: cookie.header } }, false)).toBe(true)
  })

  it('binds the cookie to the reported authority', async () => {
    const { credentials, secret } = await seededCredentials()
    const auth = await BrowserAuth.create(new Context().root, credentials, 30)
    const cookie = mintBrowserCookie(secret, '127.0.0.1:3080', 29)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3081', cookie: cookie.header } }, false)).toBe(false)
    expect(browserCookieName('127.0.0.1:3080')).not.toBe(browserCookieName('127.0.0.1:3081'))
  })

  it('embeds the requested lifetime and exact authority', () => {
    const secret = randomBytes(32)
    const now = 1_700_000_000_000
    const cookie = mintBrowserCookie(secret, '127.0.0.1:3080', 29, now)
    const body = decodeBody(cookie.value)
    expect(body).toEqual({ version: 1, authority: '127.0.0.1:3080', issuedAt: now, expiresAt: now + 29 * DAY_MS })
    expect(cookie.expiresAt).toBe(now + 29 * DAY_MS)
  })

  it('keeps one day of headroom and never drops below one day', () => {
    expect(resolveCookieMaxAgeDays(30)).toBe(29)
    expect(resolveCookieMaxAgeDays(2)).toBe(1)
    expect(resolveCookieMaxAgeDays(1)).toBe(1)
    expect(() => resolveCookieMaxAgeDays(0)).toThrow()
    expect(() => resolveCookieMaxAgeDays(1.5)).toThrow()
  })

  it('is rejected when the lifetime exceeds the Host maximum', async () => {
    const { credentials, secret } = await seededCredentials()
    const auth = await BrowserAuth.create(new Context().root, credentials, 30)
    const tooLong = mintBrowserCookie(secret, '127.0.0.1:3080', 31)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080', cookie: tooLong.header } }, false)).toBe(false)
  })

  it('reports the credential record rather than parsing a file', async () => {
    const context = new Context()
    const credentials = new MemoryCredentials(context)
    await expect(readBrowserSessionSecret(credentials)).rejects.toMatchObject({ code: 'credentials-unavailable' })
    await credentials.modifyRecord(BROWSER_SESSION_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, secret: 'not-a-32-byte-key' },
    }))
    await expect(readBrowserSessionSecret(credentials)).rejects.toMatchObject({ code: 'credentials-unavailable' })
    expect(() => browserSessionSecret({ kind: 'api-key' })).toThrow()
  })
})
