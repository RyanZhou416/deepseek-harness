/**
 * DSH browser-session cookie minting.
 *
 * The relay injects one DSH cookie as the `Cookie` header of every proxied
 * request, so the minted name and signature must be exactly what
 * `packages/client/connection/src/browser-auth.ts` accepts. The signing secret
 * is the same durable record that module created under
 * `client-connection/browser-session`; it is read through the credential
 * service, never parsed out of `.credentials.yaml`.
 *
 * @module dsh-relay/cookie
 */
import { createHash, createHmac } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { relayError } from './errors.ts'

/** Credential record the DSH connection plugin stores its signing secret in. */
export const BROWSER_SESSION_KEY = credentialKey('client-connection', 'browser-session')

/** Cookie payload version this client mints; the connection plugin verifies it. */
const COOKIE_VERSION = 1

/** Signing secret length in bytes. */
const SECRET_BYTES = 32

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000

/** Cookie name prefix used by the connection plugin. */
const COOKIE_PREFIX = 'dsh-auth-'

/** Base64url alphabet; the empty string is accepted and rejected by the length check. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u

/** A minted browser cookie. */
export interface BrowserCookie {
  /** Cookie name, `dsh-auth-<base64url(sha256(authority))>`. */
  readonly name: string
  /** Signed cookie value, `v1.<body>.<signature>`. */
  readonly value: string
  /** `name=value` header value for the relay request. */
  readonly header: string
  /** Absolute expiry in Unix milliseconds. */
  readonly expiresAt: number
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode the signing secret stored in the connection plugin's credential record.
 * @param record - the stored `client-connection/browser-session` record.
 * @returns the 32-byte HMAC secret.
 * @throws RelayError `credentials-unavailable` when the record is absent or malformed.
 */
export function browserSessionSecret(record: CredentialRecord | undefined): Buffer {
  if (record === undefined) {
    throw relayError('credentials-unavailable', 'the DSH browser-session key is not stored yet; open the DSH web page once')
  }
  if (record.kind !== 'grant' || !isRecord(record.payload) || record.payload.version !== 1
    || typeof record.payload.secret !== 'string') {
    throw relayError('credentials-unavailable', 'the DSH browser-session record has an unsupported format')
  }
  const secret = decodeBase64Url(record.payload.secret)
  if (secret === undefined || secret.byteLength !== SECRET_BYTES) {
    throw relayError('credentials-unavailable', 'the DSH browser-session record holds an invalid key')
  }
  return secret
}

/**
 * Read and decode the connection plugin's signing secret.
 * @param credentials - DSH credential service.
 * @returns the 32-byte HMAC secret.
 * @throws RelayError `credentials-unavailable` when the record is absent or malformed.
 */
export async function readBrowserSessionSecret(
  credentials: Pick<CredentialProvider, 'readRecord'>,
): Promise<Buffer> {
  return browserSessionSecret(await credentials.readRecord(BROWSER_SESSION_KEY))
}

/**
 * Cookie name the connection plugin derives for one authority.
 * @param authority - `127.0.0.1:<port>` the relay sends upstream.
 * @returns the deterministic cookie name.
 */
export function browserCookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * Cookie lifetime to mint from the Host's configured maximum.
 *
 * One day of headroom keeps a freshly minted cookie inside the Host's
 * `expiresAt - issuedAt <= cookieMaxAgeDays` verification rule; the floor of one
 * day keeps a Host configured with a single day usable.
 * @param hostMaxAgeDays - the connection plugin's `cookieMaxAgeDays`.
 * @returns the lifetime in whole days, at least 1.
 */
export function resolveCookieMaxAgeDays(hostMaxAgeDays: number): number {
  if (!Number.isSafeInteger(hostMaxAgeDays) || hostMaxAgeDays < 1) {
    throw relayError('credentials-unavailable', 'the Host cookie lifetime is not a positive whole number of days')
  }
  return Math.max(1, hostMaxAgeDays - 1)
}

/**
 * Mint a DSH browser-session cookie for one authority.
 *
 * The payload and signature are byte-for-byte those of the connection plugin's
 * `encodeCookie`: `v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256)>`.
 * The authority embedded in the payload is the same string the cookie name is
 * derived from and the same one reported to the relay, as the protocol
 * requires.
 * @param secret - 32-byte HMAC secret.
 * @param authority - `127.0.0.1:<port>` reported to the relay.
 * @param maxAgeDays - lifetime in whole days.
 * @param now - issue instant in Unix milliseconds.
 * @returns the minted cookie.
 * @throws RelayError `credentials-unavailable` for an invalid secret or lifetime.
 */
export function mintBrowserCookie(
  secret: Buffer,
  authority: string,
  maxAgeDays: number,
  now: number = Date.now(),
): BrowserCookie {
  if (secret.byteLength !== SECRET_BYTES) {
    throw relayError('credentials-unavailable', 'the DSH browser-session key has the wrong length')
  }
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1) {
    throw relayError('credentials-unavailable', 'the cookie lifetime must be at least one day')
  }
  if (authority === '' || /[\s;=]/u.test(authority)) {
    throw relayError('credentials-unavailable', 'the DSH authority cannot carry a cookie name')
  }
  const issuedAt = now
  const expiresAt = issuedAt + maxAgeDays * DAY_MS
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    throw relayError('credentials-unavailable', 'the cookie lifetime exceeds the safe timestamp range')
  }
  const payload = { version: COOKIE_VERSION, authority, issuedAt, expiresAt }
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest())
  const name = browserCookieName(authority)
  const value = `v${COOKIE_VERSION}.${body}.${signature}`
  return { name, value, header: `${name}=${value}`, expiresAt }
}
