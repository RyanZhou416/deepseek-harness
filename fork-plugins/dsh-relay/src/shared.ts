/**
 * Types and constants shared by both plugin halves.
 *
 * The browser half imports this module too, so it stays free of Node builtins
 * and host services.
 *
 * @module dsh-relay/shared
 */

/** Failure codes this client produces, plus every code the relay protocol returns. */
export const RELAY_ERROR_CODES = [
  'client-key-invalid',
  'client-key-mismatch',
  'credentials-invalid',
  'username-invalid',
  'password-too-short',
  'password-unchanged',
  'dsh-invalid',
  'port-pool-exhausted',
  'bad-request',
  'internal',
  'network-unreachable',
  'network-timeout',
  'network-invalid-response',
  'network-cancelled',
  'not-configured',
  'domain-invalid',
  'password-required',
  'client-key-format-invalid',
  'web-server-unavailable',
  'credentials-unavailable',
  'frpc-unsupported',
  'frpc-hash-mismatch',
  'frpc-download-failed',
  'frpc-start-failed',
  'frpc-exited',
] as const

/** One relay failure code. */
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]

/** Connection phase the settings page renders. */
export type RelayPhase = 'unconfigured' | 'disconnected' | 'downloading' | 'connecting' | 'connected' | 'failed'

/** Download progress while frpc is fetched. */
export interface RelayDownload {
  /** Bytes received so far. */
  readonly received: number
  /** Total bytes when the server stated a length. */
  readonly total?: number
}

/** The account facts the settings page may see. */
export interface RelayAccountView {
  readonly domain?: string
  readonly username?: string
  readonly hasPassword: boolean
  readonly hasClientKey: boolean
  readonly autoConnect: boolean
}

/** One status snapshot; contains no secret. */
export interface RelayStatus {
  /** Current phase. */
  readonly phase: RelayPhase
  /** Presence facts for the stored account. */
  readonly account: RelayAccountView
  /** Public user address, once the relay reported it. */
  readonly url?: string
  /** Remote port the relay assigned. */
  readonly remotePort?: number
  /** frp release in use. */
  readonly frpcVersion?: string
  /** Instant of the last successful proxy start, ISO 8601. */
  readonly lastConnectedAt?: string
  /** Instant the relay last accepted this machine's DSH cookie, ISO 8601. */
  readonly lastRegisteredAt?: string
  /** Typed failure code while the phase is `failed`. */
  readonly errorCode?: RelayErrorCode
  /** Safe failure context; never a secret. */
  readonly errorDetail?: string
  /** Whether the supervisor keeps retrying after a process failure. */
  readonly reconnecting?: boolean
  /** Download progress while the phase is `downloading`. */
  readonly download?: RelayDownload
}

/** One save request; an absent or empty password/clientKey keeps the stored one. */
export interface RelaySaveRequest {
  readonly domain: string
  readonly username: string
  readonly password?: string
  readonly clientKey?: string
  readonly autoConnect?: boolean
}

/** Change-password request. */
export interface RelayPasswordRequest {
  readonly currentPassword: string
  readonly newPassword: string
}
