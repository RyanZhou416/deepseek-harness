/**
 * Durable relay account storage.
 *
 * The relay domain, username, password, personal client key, and the
 * auto-connect preference live in one credential record owned by
 * `dsh-relay/account`. Nothing secret ever leaves this module's value: the RPC
 * status reports only whether a password or key is stored.
 *
 * @module dsh-relay/account
 */
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { relayError } from './errors.ts'
import type { RelayAccountView } from './shared.ts'
import { normalizeDomain, validateClientKey, validateUsername } from './validation.ts'

export type { RelayAccountView }
export { normalizeDomain, validateClientKey, validateUsername }

/** Credential record address of the relay account. */
export const RELAY_ACCOUNT_KEY = credentialKey('dsh-relay', 'account')

/** Stored payload version. */
const RECORD_VERSION = 1

/** The stored account, secrets included; never crosses the RPC boundary. */
export interface RelayAccount {
  readonly domain: string
  readonly username: string
  readonly password: string
  readonly clientKey: string
  readonly autoConnect: boolean
}

/** A save request; an absent or empty password/clientKey keeps the stored one. */
export interface RelayAccountPatch {
  readonly domain: string
  readonly username: string
  readonly password?: string
  readonly clientKey?: string
  readonly autoConnect?: boolean
}

/** Persisted payload format. */
interface RelayAccountPayload {
  readonly version: typeof RECORD_VERSION
  readonly domain: string
  readonly username: string
  readonly password: string
  readonly clientKey: string
  readonly autoConnect: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the stored payload from a credential record.
 * @param record - stored record, or undefined.
 * @returns the account, or undefined when no record is stored.
 * @throws RelayError `credentials-unavailable` when a stored record has an unsupported format.
 */
export function parseAccountRecord(record: CredentialRecord | undefined): RelayAccount | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)) {
    throw relayError('credentials-unavailable', 'the stored relay record has an unsupported format')
  }
  const payload = record.payload
  if (payload.version !== RECORD_VERSION
    || typeof payload.domain !== 'string'
    || typeof payload.username !== 'string'
    || typeof payload.password !== 'string'
    || typeof payload.clientKey !== 'string'
    || typeof payload.autoConnect !== 'boolean') {
    throw relayError('credentials-unavailable', 'the stored relay record has an unsupported format')
  }
  return {
    domain: payload.domain,
    username: payload.username,
    password: payload.password,
    clientKey: payload.clientKey,
    autoConnect: payload.autoConnect,
  }
}

/**
 * Build the response value for the settings page.
 * @param account - stored account, or undefined.
 * @returns presence facts only.
 */
export function accountView(account: RelayAccount | undefined): RelayAccountView {
  return {
    ...account === undefined ? {} : { domain: account.domain, username: account.username },
    hasPassword: account !== undefined && account.password.length > 0,
    hasClientKey: account !== undefined && account.clientKey.length > 0,
    autoConnect: account?.autoConnect ?? false,
  }
}

/**
 * Whether every field a connection needs is stored.
 * @param account - stored account, or undefined.
 * @returns true when domain, username, password, and client key are all present.
 */
export function accountIsConfigured(account: RelayAccount | undefined): account is RelayAccount {
  return account !== undefined
    && account.domain.length > 0
    && account.username.length > 0
    && account.password.length > 0
    && account.clientKey.length > 0
}

/**
 * The credential half this store needs; tests provide an in-memory implementation.
 */
export type RelayCredentialStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>

/** Read and write the single relay account record. */
export class RelayAccountStore {
  /**
   * @param credentials - DSH credential service.
   */
  constructor(private readonly credentials: RelayCredentialStore) {}

  /**
   * Read the stored account.
   * @returns the account, or undefined when none is stored.
   * @throws RelayError `credentials-unavailable` when the stored record is malformed.
   */
  async read(): Promise<RelayAccount | undefined> {
    return parseAccountRecord(await this.credentials.readRecord(RELAY_ACCOUNT_KEY))
  }

  /**
   * Read the settings-page view.
   * @returns presence facts only.
   */
  async view(): Promise<RelayAccountView> {
    return accountView(await this.read())
  }

  /**
   * Store a save request, keeping an omitted or empty secret.
   *
   * The record is written through `modifyRecord`, so a concurrent reader sees
   * either the old or the new record and never a partially merged one.
   * @param patch - validated user input.
   * @returns the view after the write.
   * @throws RelayError for invalid fields or when a secret is required on first save.
   */
  async save(patch: RelayAccountPatch): Promise<RelayAccountView> {
    const domain = normalizeDomain(patch.domain)
    const username = validateUsername(patch.username)
    const password = patch.password === undefined || patch.password === '' ? undefined : patch.password
    const clientKey = patch.clientKey === undefined || patch.clientKey === '' ? undefined : validateClientKey(patch.clientKey)
    const next = await this.credentials.modifyRecord(RELAY_ACCOUNT_KEY, async (current) => {
      let account: RelayAccount | undefined
      try {
        account = parseAccountRecord(current)
      } catch {
        account = undefined
      }
      const resolvedPassword = password ?? account?.password
      if (resolvedPassword === undefined || resolvedPassword.length === 0) {
        throw relayError('password-required', 'enter the account password')
      }
      const resolvedClientKey = clientKey ?? account?.clientKey
      if (resolvedClientKey === undefined || resolvedClientKey.length === 0) {
        throw relayError('client-key-format-invalid', 'enter the personal client key')
      }
      const payload: RelayAccountPayload = {
        version: RECORD_VERSION,
        domain,
        username,
        password: resolvedPassword,
        clientKey: resolvedClientKey,
        autoConnect: patch.autoConnect ?? account?.autoConnect ?? false,
      }
      return { kind: 'grant', payload }
    })
    return accountView(parseAccountRecord(next))
  }

  /**
   * Store the auto-connect preference without touching the secrets.
   * @param enabled - whether the next DSH start connects automatically.
   */
  async setAutoConnect(enabled: boolean): Promise<void> {
    await this.credentials.modifyRecord(RELAY_ACCOUNT_KEY, async (current) => {
      const account = parseAccountRecord(current)
      if (account === undefined) return undefined
      const payload: RelayAccountPayload = {
        version: RECORD_VERSION,
        domain: account.domain,
        username: account.username,
        password: account.password,
        clientKey: account.clientKey,
        autoConnect: enabled,
      }
      return { kind: 'grant', payload }
    })
  }
}
