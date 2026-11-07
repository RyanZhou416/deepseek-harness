/**
 * Pure view-state helpers for the relay settings page.
 *
 * @module dsh-relay/client/state
 */
import type { RelayAccountView, RelayDownload, RelayErrorCode, RelayPhase, RelaySaveRequest, RelayStatus } from '../shared.ts'
import { deriveRelayAddress } from '../validation.ts'
import type { RelayKey } from './locales.ts'

/** Editable form values. Secrets are always empty until the user types a replacement. */
export interface RelayDraft {
  domain: string
  username: string
  password: string
  clientKey: string
  autoConnect: boolean
}

/**
 * Draft for a status snapshot.
 * @param status - current host status, or undefined before the first read.
 * @returns form values with empty secret inputs.
 */
export function draftFromStatus(status: RelayStatus | undefined): RelayDraft {
  return {
    domain: status?.account.domain ?? '',
    username: status?.account.username ?? '',
    password: '',
    clientKey: '',
    autoConnect: status?.account.autoConnect ?? false,
  }
}

/**
 * Whether the stored account has every field a connection needs.
 * @param account - presence facts from the host.
 * @returns true when the account is complete.
 */
export function savedAccountConfigured(account: RelayAccountView | undefined): boolean {
  return account !== undefined
    && account.domain !== undefined
    && account.username !== undefined
    && account.hasPassword
    && account.hasClientKey
}

/**
 * Save request for the current draft; empty secret inputs keep the stored value.
 * @param draft - form values.
 * @returns the request payload.
 */
export function saveRequest(draft: RelayDraft): RelaySaveRequest {
  return {
    domain: draft.domain,
    username: draft.username,
    autoConnect: draft.autoConnect,
    ...draft.password === '' ? {} : { password: draft.password },
    ...draft.clientKey === '' ? {} : { clientKey: draft.clientKey },
  }
}

/**
 * Public address for the draft, when both fields are valid.
 * @param draft - form values.
 * @returns the address, or undefined while a field is unusable.
 */
export function draftAddress(draft: RelayDraft): string | undefined {
  return deriveRelayAddress(draft.domain, draft.username)
}

/**
 * Locale key for one connection phase.
 * @param phase - host phase.
 * @returns the status label key.
 */
export function phaseKey(phase: RelayPhase): RelayKey {
  switch (phase) {
    case 'unconfigured': return 'statusUnconfigured'
    case 'disconnected': return 'statusDisconnected'
    case 'downloading': return 'statusDownloading'
    case 'connecting': return 'statusConnecting'
    case 'connected': return 'statusConnected'
    case 'failed': return 'statusFailed'
  }
}

const ERROR_KEYS: Readonly<Record<RelayErrorCode, RelayKey>> = {
  'client-key-invalid': 'errorClientKeyInvalid',
  'client-key-mismatch': 'errorClientKeyMismatch',
  'credentials-invalid': 'errorCredentialsInvalid',
  'username-invalid': 'errorUsernameInvalid',
  'password-too-short': 'errorPasswordTooShort',
  'password-unchanged': 'errorPasswordUnchanged',
  'dsh-invalid': 'errorDshInvalid',
  'port-pool-exhausted': 'errorPortPoolExhausted',
  'bad-request': 'errorBadRequest',
  'internal': 'errorInternal',
  'network-unreachable': 'errorNetworkUnreachable',
  'network-timeout': 'errorNetworkTimeout',
  'network-invalid-response': 'errorNetworkInvalidResponse',
  'network-cancelled': 'errorNetworkCancelled',
  'not-configured': 'errorNotConfigured',
  'domain-invalid': 'errorDomainInvalid',
  'password-required': 'errorPasswordRequired',
  'client-key-format-invalid': 'errorClientKeyFormatInvalid',
  'web-server-unavailable': 'errorWebServerUnavailable',
  'credentials-unavailable': 'errorCredentialsUnavailable',
  'frpc-unsupported': 'errorFrpcUnsupported',
  'frpc-hash-mismatch': 'errorFrpcHashMismatch',
  'frpc-download-failed': 'errorFrpcDownloadFailed',
  'frpc-start-failed': 'errorFrpcStartFailed',
  'frpc-exited': 'errorFrpcExited',
}

/**
 * Locale key for one host failure code.
 * @param code - code reported by the host, possibly from a newer host build.
 * @returns the localized error key, or `errorUnknown`.
 */
export function errorKey(code: string | undefined): RelayKey {
  if (code === undefined || !Object.hasOwn(ERROR_KEYS, code)) return 'errorUnknown'
  return ERROR_KEYS[code as RelayErrorCode]
}

/**
 * Whether the phase is still moving toward a connection.
 * @param phase - host phase.
 * @returns true for `downloading` and `connecting`.
 */
export function isBusyPhase(phase: RelayPhase | undefined): boolean {
  return phase === 'downloading' || phase === 'connecting'
}

/**
 * Whole-percent download progress.
 * @param download - byte progress from the host.
 * @returns 0 through 100, or undefined when the total is unknown.
 */
export function downloadPercent(download: RelayDownload | undefined): number | undefined {
  if (download === undefined || download.total === undefined || download.total <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((download.received / download.total) * 100)))
}

/**
 * Localized timestamp for an ISO instant.
 * @param iso - ISO 8601 instant.
 * @param locale - BCP 47 locale of the page.
 * @returns the localized date and time, or the original text when unparsable.
 */
export function formatInstant(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale)
}
