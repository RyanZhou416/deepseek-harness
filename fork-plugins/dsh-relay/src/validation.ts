/**
 * Pure input validation shared by the host and the settings page.
 *
 * @module dsh-relay/validation
 */
import { relayError } from './errors.ts'

/** Username grammar from the relay protocol. */
const USERNAME_PATTERN = /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/u

/** Client key grammar from the relay protocol. */
const CLIENT_KEY_PATTERN = /^dshk_[A-Za-z0-9_-]{43}$/u

/** One DNS label. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

/** Presence of a scheme, path, port, credentials, query, or fragment. */
const NON_HOST_PATTERN = /:|\/|\?|#|@|\s/u

/**
 * Normalize a relay base domain.
 *
 * Accepts a bare DNS name or the same name with a leading `https://`; a path,
 * port, credentials, query, or another scheme is refused, and the result is
 * lowercase without a trailing dot.
 * @param input - domain text from the settings page.
 * @returns the normalized domain.
 * @throws RelayError `domain-invalid` when the value cannot be a relay base domain.
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw relayError('domain-invalid', 'the server domain is empty')
  const withoutScheme = trimmed.replace(/^https:\/\//iu, '').replace(/\/+$/u, '')
  if (NON_HOST_PATTERN.test(withoutScheme)) {
    throw relayError('domain-invalid', 'enter a bare domain such as relay.example.com')
  }
  const domain = withoutScheme.toLowerCase().replace(/\.+$/u, '')
  if (domain.length > 253) throw relayError('domain-invalid', 'the server domain is too long')
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every(label => LABEL_PATTERN.test(label))) {
    throw relayError('domain-invalid', 'the server domain must be a public DNS name')
  }
  return domain
}

/**
 * Validate a username against the relay protocol grammar.
 * @param input - username text from the settings page.
 * @returns the username.
 * @throws RelayError `username-invalid` when the value is not a legal subdomain label.
 */
export function validateUsername(input: string): string {
  const username = input.trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw relayError('username-invalid', 'the username must be lowercase letters, digits, and hyphens')
  }
  return username
}

/**
 * Validate a personal client key against the relay protocol grammar.
 * @param input - client key text from the settings page.
 * @returns the key.
 * @throws RelayError `client-key-format-invalid` when the value is not a `dshk_` key.
 */
export function validateClientKey(input: string): string {
  const key = input.trim()
  if (!CLIENT_KEY_PATTERN.test(key)) {
    throw relayError('client-key-format-invalid', 'the client key must look like dshk_ followed by 43 base64url characters')
  }
  return key
}

/**
 * Build the public user address when both fields are valid, for display.
 * @param domain - domain text from the form.
 * @param username - username text from the form.
 * @returns `https://<username>.<domain>/`, or undefined while either field is unusable.
 */
export function deriveRelayAddress(domain: string, username: string): string | undefined {
  try {
    return `https://${validateUsername(username)}.${normalizeDomain(domain)}/`
  } catch {
    return undefined
  }
}
