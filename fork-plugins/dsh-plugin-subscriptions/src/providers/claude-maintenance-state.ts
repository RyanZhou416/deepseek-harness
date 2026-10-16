/**
 * Durable account-maintenance state: the profile freshness record and the accepted remote
 * policy, so a normal restart reuses what the account already confirmed instead of
 * re-reading it.
 *
 * Two rules shape the file. It holds no credential and no remote value: the policy side
 * keeps only this plugin's own validated vocabulary — the accepted checksum, the key
 * dispositions and the blocker codes — never the server's document, which may carry
 * environment or hook values. And a file that exists but cannot be trusted is not read as
 * an empty one: a caller learns the state is unavailable and refuses the operations that
 * depended on it, rather than silently losing a restriction an earlier run enforced.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { withStoreLockOwned } from '../auth/store-lock.js'
import type { LockTiming } from '../auth/store-lock.js'
import { CLAUDE_PROFILE_COMPLETENESS_VERSION } from './claude-account-state.js'

/** The outer bound on the state file this module will read or write. */
export const CLAUDE_MAINTENANCE_STATE_LIMIT = 1_048_576

/** One key's recorded disposition, in this plugin's own vocabulary. */
export interface ClaudePersistedKey {
  key: string
  scope: string
  disposition: string
  detail: string
}

/** One recorded blocker, in this plugin's own vocabulary. */
export interface ClaudePersistedBlocker {
  key: string
  scope: string
  code: string
  detail: string
}

/** One account's durable maintenance record. */
export interface ClaudePersistedAccount {
  /** Canonical account key. */
  account: string
  /** Provider origin the record was made under. */
  origin: string
  /** Protocol-configuration fingerprint the record was made under. */
  protocolFingerprint: string
  /** Confirmed organization, when one is known. */
  organization?: string
  /** The accepted profile fields, when a read succeeded. */
  profile?: {
    accountUuid?: string
    emailAddress?: string
    subscriptionType?: string | null
    capturedAt: number
    complete: boolean
    /**
     * The completeness contract `complete` was computed under. Absent marks a record
     * written before the evidence-based check: its fields are kept, but it reads as
     * incomplete, so one bounded read replaces it.
     */
    completenessVersion?: number
    credentialRevision: number
  }
  /**
   * The accepted remote policy as this plugin projected it.
   *
   * `restrictions` are not stored: a restriction's value belongs to its consumer and may
   * quote a remote document. A policy whose keys were enforced is therefore restored as
   * needing re-verification, which is a blocker until a fresh read confirms it again.
   */
  policy?: {
    checksum: string
    revision: string
    acceptedAt: number
    keys: ClaudePersistedKey[]
    blockers: ClaudePersistedBlocker[]
    /** Whether any accepted key was enforced, so the projection cannot be restored as-is. */
    enforced: boolean
  }
}

/** What a load produced. */
export type ClaudeMaintenanceLoadResult =
  /** Nothing was ever stored for this home. */
  | { readonly status: 'cold' }
  /** The stored records, validated. */
  | { readonly status: 'loaded'; readonly records: readonly ClaudePersistedAccount[] }
  /** A file exists but cannot be trusted; the caller must fail closed, not read it as empty. */
  | { readonly status: 'unavailable'; readonly reason: string }

/** Where the controller keeps its durable state. */
export interface ClaudeMaintenancePersistence {
  /**
   * Read the stored records.
   * @returns the validated records, or why they cannot be trusted.
   */
  load(): Promise<ClaudeMaintenanceLoadResult>
  /**
   * Store these records, merging them into whatever the file already holds for accounts
   * this call does not name, so two processes writing different accounts keep both.
   * @param records - the accounts to write.
   */
  save(records: readonly ClaudePersistedAccount[]): Promise<void>
  /**
   * Drop one account's record, for a logout or an account removal.
   * @param account - the canonical account key.
   */
  remove?(account: string): Promise<void>
}

/** The on-disk document root. */
interface StoredDocument {
  version: 1
  accounts: ClaudePersistedAccount[]
}

/** The store version this module writes and accepts. */
const STATE_VERSION = 1

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A string that may legally be empty, or undefined. */
function anyString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A finite number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** One recorded key, as read back. */
function readKey(value: unknown): ClaudePersistedKey | undefined {
  if (!isRecord(value)) return undefined
  const key = nonEmptyString(value.key)
  const scope = nonEmptyString(value.scope)
  const disposition = nonEmptyString(value.disposition)
  const detail = typeof value.detail === 'string' ? value.detail : undefined
  if (key === undefined || scope === undefined || disposition === undefined || detail === undefined) return undefined
  return { key, scope, disposition, detail }
}

/** One recorded blocker, as read back. */
function readBlocker(value: unknown): ClaudePersistedBlocker | undefined {
  if (!isRecord(value)) return undefined
  const key = nonEmptyString(value.key)
  const scope = nonEmptyString(value.scope)
  const code = nonEmptyString(value.code)
  const detail = typeof value.detail === 'string' ? value.detail : undefined
  if (key === undefined || scope === undefined || code === undefined || detail === undefined) return undefined
  return { key, scope, code, detail }
}

/**
 * Validate one stored account record.
 *
 * A record whose profile alone is unusable keeps its policy and drops the profile: profile
 * freshness is a performance fact and reading it cold is safe. A record whose policy is
 * present but unusable fails the whole load instead, because a restriction an earlier run
 * enforced cannot be assumed absent.
 * @param value - the parsed record.
 * @returns the validated record, `undefined` when it carries nothing usable, or the reason
 *   its policy cannot be trusted.
 */
function readAccount(value: unknown): { record: ClaudePersistedAccount } | { unusable: string } | undefined {
  if (!isRecord(value)) return undefined
  const account = nonEmptyString(value.account)
  const origin = nonEmptyString(value.origin)
  const protocolFingerprint = nonEmptyString(value.protocolFingerprint)
  if (account === undefined || origin === undefined || protocolFingerprint === undefined) return undefined
  const organization = nonEmptyString(value.organization)
  const record: ClaudePersistedAccount = {
    account,
    origin,
    protocolFingerprint,
    ...organization === undefined ? {} : { organization },
  }
  const profile = value.profile
  if (isRecord(profile)) {
    const capturedAt = finiteNumber(profile.capturedAt)
    const credentialRevision = finiteNumber(profile.credentialRevision)
    if (capturedAt !== undefined && credentialRevision !== undefined && credentialRevision >= 0) {
      const accountUuid = nonEmptyString(profile.accountUuid)
      const emailAddress = nonEmptyString(profile.emailAddress)
      const subscriptionType = typeof profile.subscriptionType === 'string'
        ? profile.subscriptionType
        : profile.subscriptionType === null ? null : undefined
      // A record written before the evidence-based completeness contract keeps its fields
      // but is restored as incomplete, so the first bound request reads the profile again.
      const completenessVersion = finiteNumber(profile.completenessVersion)
      record.profile = {
        capturedAt,
        credentialRevision,
        complete: profile.complete === true && completenessVersion === CLAUDE_PROFILE_COMPLETENESS_VERSION,
        ...completenessVersion === undefined ? {} : { completenessVersion },
        ...accountUuid === undefined ? {} : { accountUuid },
        ...emailAddress === undefined ? {} : { emailAddress },
        ...subscriptionType === undefined ? {} : { subscriptionType },
      }
    }
  }
  const policy = value.policy
  if (policy !== undefined) {
    if (!isRecord(policy)) return { unusable: `account "${account}" has an unreadable policy record` }
    // The empty-success sentinel legitimately carries an empty checksum and revision.
    const checksum = anyString(policy.checksum)
    const revision = anyString(policy.revision)
    const acceptedAt = finiteNumber(policy.acceptedAt)
    if (checksum === undefined || revision === undefined || acceptedAt === undefined) {
      return { unusable: `account "${account}" has an incomplete policy record` }
    }
    if (!Array.isArray(policy.keys) || !Array.isArray(policy.blockers)) {
      return { unusable: `account "${account}" has a malformed policy projection` }
    }
    const keys: ClaudePersistedKey[] = []
    for (const entry of policy.keys) {
      const key = readKey(entry)
      if (key === undefined) return { unusable: `account "${account}" has a malformed policy key` }
      keys.push(key)
    }
    const blockers: ClaudePersistedBlocker[] = []
    for (const entry of policy.blockers) {
      const blocker = readBlocker(entry)
      if (blocker === undefined) return { unusable: `account "${account}" has a malformed policy blocker` }
      blockers.push(blocker)
    }
    record.policy = {
      checksum,
      revision,
      acceptedAt,
      keys,
      blockers,
      enforced: policy.enforced === true,
    }
  }
  return { record }
}

/**
 * The plugin's own maintenance state file.
 *
 * Writes are serialized inside a cross-process lock, merged per account key, and swapped
 * into place atomically from an exclusively created temporary file, so one process cannot
 * drop another's account record.
 */
export class FileClaudeMaintenancePersistence implements ClaudeMaintenancePersistence {
  private writeTail: Promise<void> = Promise.resolve()

  /**
   * @param options - the file to use, the lock timing, and a diagnostic sink.
   */
  constructor(private readonly options: {
    path?: string
    timing?: LockTiming
    onWarn?: (message: string) => void
  } = {}) {}

  /** Absolute path of the state file. */
  private path(): string {
    return this.options.path ?? dshHomePath('plugins', 'subscriptions', 'claude-maintenance.json')
  }

  /**
   * Read the stored records.
   * @returns the validated records, or why they cannot be trusted.
   */
  async load(): Promise<ClaudeMaintenanceLoadResult> {
    return this.readDocument()
  }

  /**
   * Merge these records into the stored ones and write the result under the store lock.
   * @param records - the accounts to write.
   */
  async save(records: readonly ClaudePersistedAccount[]): Promise<void> {
    await this.enqueue(async () => {
      await this.mergeUnderOwnedLock(records)
    })
  }

  /**
   * Drop one account's record.
   * @param account - the canonical account key.
   */
  async remove(account: string): Promise<void> {
    await this.enqueue(async () => {
      await this.mergeUnderOwnedLock([], account)
    })
  }

  /**
   * Merge these records into the stored document while this process owns the lock.
   *
   * Ownership is a precondition, not a preference: a write that cannot take the lock fails
   * so the caller learns it did not happen, rather than replacing a document another
   * process may be extending. A document this process cannot trust is never replaced by a
   * partial write either — an unrelated account's profile must not erase a restriction an
   * earlier run enforced — so the caller is told the state is unavailable and keeps
   * refusing until an operator repairs or removes the file.
   * @param records - the accounts to write.
   * @param removeAccount - one account to drop, when this is a removal.
   */
  private async mergeUnderOwnedLock(records: readonly ClaudePersistedAccount[], removeAccount?: string): Promise<void> {
    const path = this.path()
    const outcome = await withStoreLockOwned(path, async () => {
      const current = await this.readDocument()
      if (current.status === 'unavailable') {
        throw new Error(`claude maintenance state is unavailable: ${current.reason}`)
      }
      const merged = new Map<string, ClaudePersistedAccount>()
      if (current.status === 'loaded') {
        for (const record of current.records) merged.set(record.account, record)
      }
      for (const record of records) merged.set(record.account, record)
      if (removeAccount !== undefined) merged.delete(removeAccount)
      await this.writeDocument([...merged.values()])
    }, this.options.timing)
    if (!outcome.acquired) {
      throw new Error('claude maintenance state lock is held by another process; the write did not happen')
    }
  }

  /** Serialize this instance's own writes. */
  private async enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(action)
    this.writeTail = next.then(() => undefined, () => undefined)
    await next
  }

  /** Read and validate the file, distinguishing "never written" from "not trustworthy". */
  private async readDocument(): Promise<ClaudeMaintenanceLoadResult> {
    let text: string
    try {
      text = await readFile(this.path(), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'cold' }
      return {
        status: 'unavailable',
        reason: `the maintenance state could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`,
      }
    }
    if (text.length > CLAUDE_MAINTENANCE_STATE_LIMIT) {
      return { status: 'unavailable', reason: 'the maintenance state exceeds the accepted size bound' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { status: 'unavailable', reason: 'the maintenance state is not valid JSON' }
    }
    if (!isRecord(parsed)) return { status: 'unavailable', reason: 'the maintenance state is not a document' }
    if (parsed.version !== STATE_VERSION) {
      return { status: 'unavailable', reason: `unsupported maintenance state version ${String(parsed.version)}` }
    }
    if (!Array.isArray(parsed.accounts)) {
      return { status: 'unavailable', reason: 'the maintenance state carries no account list' }
    }
    const records: ClaudePersistedAccount[] = []
    for (const entry of parsed.accounts) {
      const read = readAccount(entry)
      if (read === undefined) continue
      if ('unusable' in read) return { status: 'unavailable', reason: read.unusable }
      records.push(read.record)
    }
    return { status: 'loaded', records }
  }

  /** Write the complete document atomically. */
  private async writeDocument(records: readonly ClaudePersistedAccount[]): Promise<void> {
    const path = this.path()
    const document: StoredDocument = { version: STATE_VERSION, accounts: [...records] }
    const text = JSON.stringify(document)
    if (text.length > CLAUDE_MAINTENANCE_STATE_LIMIT) {
      this.options.onWarn?.('dsh-plugin-subscriptions: claude maintenance state was not written; it exceeds the accepted size bound')
      return
    }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    try {
      // An exclusively created file no other writer can already hold, at owner-only mode.
      await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
      await rename(tmp, path)
    } catch (error: unknown) {
      await rm(tmp, { force: true })
      throw error
    }
  }
}
