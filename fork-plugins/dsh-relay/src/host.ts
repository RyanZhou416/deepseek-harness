/**
 * Host facts the relay tunnel needs: the DSH Web listener's loopback
 * authority and the configured browser-cookie lifetime.
 *
 * @module dsh-relay/host
 */
import { relayError } from './errors.ts'

/** The host context facts this plugin reads; the Cordis context satisfies it structurally. */
export interface RelayHostContext {
  get(name: string): unknown
}

/** The web server service facts this plugin reads; owned by `dsh-host-webserver`. */
export interface HostWebServer {
  /** Listening port after the socket bound; undefined before that. */
  readonly port: number | undefined
  /** Listener protocol. */
  readonly protocol?: 'http:' | 'https:'
}

/** Default browser-cookie lifetime of the token plugin, used when nothing overrides it. */
export const DEFAULT_COOKIE_MAX_AGE_DAYS = 30

/**
 * Loader entry name of the plugin whose config carries `cookieMaxAgeDays`.
 * Since 0.2.3-alpha.2 the token plugin owns browser authentication and its
 * cookie lifetime; the connection plugin carries neither.
 */
const TOKEN_ENTRY_NAME = '@deepseek-ai/dsh-host-authentication-token'

/** Structural face of one Loader entry this plugin reads. */
interface LoaderEntryLike {
  readonly options?: {
    readonly name?: string
    readonly config?: unknown
  }
}

/** Structural face of the Loader service. */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/**
 * Build the authority the relay sends as Host and Origin.
 *
 * The listener address is always loopback: the relay's upstream dials
 * `127.0.0.1:<remotePort>`, and DSH accepts `127.0.0.1:<port>` as a trusted
 * authority. A missing or unbound port fails loud rather than defaulting.
 * @param port - the DSH web server's listening port.
 * @returns `127.0.0.1:<port>`.
 * @throws RelayError `web-server-unavailable` when the port is not a bound TCP port.
 */
export function relayAuthority(port: number | undefined): string {
  if (port === undefined || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw relayError('web-server-unavailable', 'the DSH web server has not bound a TCP port yet')
  }
  return `127.0.0.1:${String(port)}`
}

/**
 * Read the token plugin's configured browser-cookie lifetime.
 *
 * The token plugin does not expose it as a service, so the value is read from
 * the Loader entry that mounted it. A deployment without the entry (or without
 * an override) falls back to the plugin's own default.
 * @param ctx - plugin context.
 * @returns a positive whole number of days.
 */
export function hostCookieMaxAgeDays(ctx: RelayHostContext): number {
  const loader = ctx.get('loader') as LoaderLike | undefined
  if (loader === undefined) return DEFAULT_COOKIE_MAX_AGE_DAYS
  for (const entry of loader.entries()) {
    if (entry.options?.name !== TOKEN_ENTRY_NAME) continue
    const config = entry.options.config
    if (typeof config !== 'object' || config === null) continue
    const value = (config as Record<string, unknown>).cookieMaxAgeDays
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  }
  return DEFAULT_COOKIE_MAX_AGE_DAYS
}
