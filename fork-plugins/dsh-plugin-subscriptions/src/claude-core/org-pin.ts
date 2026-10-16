/**
 * The organization pin: parsing a server-stated `forceLoginOrgUUID` and validating the
 * account against it.
 *
 * The pin is an input the caller already adopted from its own policy source; this module
 * reads no policy store, starts no poll and sends nothing when no pin is in force. A pin
 * that is present but unusable denies the operation rather than being treated as absent.
 */

import { coreFailure } from './failures.js'
import type { CoreFailure } from './failures.js'
import { readBoundedBody } from './policy-limits-client.js'
import type { CoreClock, CoreHttpResponse, CoreTransport } from './policy-limits-client.js'

/** The pinned validation bound. */
export const ORG_PIN_TIMEOUT_MS = 10_000

/**
 * The bound on the validation body this reader consumes, in bytes.
 *
 * Like the policy reader's cap, this is this build's own product guard, not a pinned constant
 * of the analyzed client. A body over it denies the operation with `body_over_limit` instead
 * of spending another request on the same oversized answer: the bytes are never carried into
 * a message.
 */
export const ORG_PIN_BODY_LIMIT = 8_192

/**
 * Parsing one pin value.
 *
 * The three states are distinct and must not be collapsed: `none` means the caller's
 * adopted policy stated nothing, `pin` means it stated a usable set, and `invalid` means it
 * stated something unusable. An empty array or a whitespace-only string is `invalid`, never
 * `none`: a malformed pin that were read as absent would silently disable the pin.
 */
export type OrgPinParse =
  /** The policy stated no pin at all. */
  | { readonly kind: 'none' }
  /** The policy stated a usable, non-empty organization set. */
  | { readonly kind: 'pin'; readonly organizations: readonly string[] }
  /** The policy stated something unusable; the operation is denied. */
  | { readonly kind: 'invalid'; readonly failure: CoreFailure }

/**
 * Parse the `forceLoginOrgUUID` a policy stated.
 *
 * A non-empty string is one organization; a non-empty array of non-empty strings is a set,
 * deduplicated in order. An empty array, an empty or whitespace-only string, an array with a
 * non-string or empty member, or any other type is `invalid` — it denies rather than reading
 * as no pin.
 * @param value - the value the adopted policy stated.
 * @returns the three-state parse result.
 */
export function parseOrgPin(value: unknown): OrgPinParse {
  if (value === undefined || value === null) return { kind: 'none' }
  if (typeof value === 'string') {
    const organization = value.trim()
    return organization.length === 0
      ? { kind: 'invalid', failure: coreFailure('invalid_input', { reason: 'empty_org_pin' }) }
      : { kind: 'pin', organizations: Object.freeze([organization]) }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { kind: 'invalid', failure: coreFailure('invalid_input', { reason: 'empty_org_pin' }) }
    }
    const organizations: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return { kind: 'invalid', failure: coreFailure('invalid_input', { reason: 'malformed_org_pin' }) }
      }
      const organization = entry.trim()
      if (!organizations.includes(organization)) organizations.push(organization)
    }
    return { kind: 'pin', organizations: Object.freeze(organizations) }
  }
  return { kind: 'invalid', failure: coreFailure('invalid_input', { reason: 'unusable_org_pin' }) }
}

/** One organization validation. */
export interface OrgPinValidationRequest {
  /** The endpoint, built by the caller from its own base URL. */
  readonly url: string
  /** The access token of the account being validated; the caller selected it. */
  readonly accessToken: string
  /** The user agent for this role. */
  readonly userAgent: string
  /** The pin the caller already adopted; `undefined` or `null` means no pin is in force. */
  readonly pin: unknown
  /** The injected transport. */
  readonly transport: CoreTransport
  /** The injected clock, for the caller's own diagnostics. */
  readonly clock?: CoreClock
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** What one validation resolved to. */
export type OrgPinOutcome =
  /** No pin is in force, so nothing was sent. */
  | { readonly kind: 'no-pin' }
  /** The account belongs to one of the pinned organizations. */
  | { readonly kind: 'allowed'; readonly organization: string }
  /** The operation is denied; the caller reports and stops. */
  | { readonly kind: 'denied'; readonly failure: CoreFailure }

/**
 * Validate the account against the pinned organization set.
 *
 * The request is the pinned one: a bodyless `POST` with the account's bearer token, the
 * role's user agent and a JSON content type, under the ten-second bound. A pin means the
 * account must be provably inside it: a result without an `organization_uuid` is
 * `org_verify_failed`, and an organization outside the set is `org_pin_mismatch`.
 * @param request - the endpoint, credential, adopted pin and injected transport.
 * @returns the outcome; only `allowed` permits the operation.
 */
export async function validateOrgPin(request: OrgPinValidationRequest): Promise<OrgPinOutcome> {
  const parsed = parseOrgPin(request.pin)
  if (parsed.kind === 'none') return { kind: 'no-pin' }
  if (parsed.kind === 'invalid') return { kind: 'denied', failure: parsed.failure }
  const cancelled = (): boolean => request.signal?.aborted === true
  let response: CoreHttpResponse
  try {
    response = await request.transport({
      url: request.url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        'user-agent': request.userAgent,
        'content-type': 'application/json',
      },
      body: null,
      signal: request.signal ?? new AbortController().signal,
      timeoutMs: ORG_PIN_TIMEOUT_MS,
    })
  } catch {
    if (cancelled()) return { kind: 'denied', failure: coreFailure('cancelled') }
    return { kind: 'denied', failure: coreFailure('org_verify_failed', { reason: 'transport' }) }
  }
  if (cancelled()) return { kind: 'denied', failure: coreFailure('cancelled') }
  if (response.status < 200 || response.status >= 300) {
    // The body is consumed on this branch too: a refusal must not leave the connection
    // pinned, and its bytes never reach a message or a cause.
    await readBoundedBody(response, ORG_PIN_BODY_LIMIT).catch(() => undefined)
    if (cancelled()) return { kind: 'denied', failure: coreFailure('cancelled') }
    return {
      kind: 'denied',
      failure: coreFailure('org_verify_failed', { status: response.status, reason: 'http_status' }),
    }
  }
  let body: { text: string; truncated: boolean }
  try {
    body = await readBoundedBody(response, ORG_PIN_BODY_LIMIT)
  } catch {
    return { kind: 'denied', failure: coreFailure('org_verify_failed', { reason: 'unreadable_body' }) }
  }
  if (cancelled()) return { kind: 'denied', failure: coreFailure('cancelled') }
  if (body.truncated) {
    return { kind: 'denied', failure: coreFailure('org_verify_failed', { reason: 'body_over_limit' }) }
  }
  let payload: unknown
  try {
    payload = JSON.parse(body.text)
  } catch {
    return { kind: 'denied', failure: coreFailure('org_verify_failed', { reason: 'unreadable_body' }) }
  }
  const organization = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['organization_uuid']
    : undefined
  if (typeof organization !== 'string' || organization.length === 0) {
    return { kind: 'denied', failure: coreFailure('org_verify_failed', { reason: 'result_missing' }) }
  }
  return parsed.organizations.includes(organization)
    ? { kind: 'allowed', organization }
    : { kind: 'denied', failure: coreFailure('org_pin_mismatch', { reason: 'organization_not_pinned' }) }
}
