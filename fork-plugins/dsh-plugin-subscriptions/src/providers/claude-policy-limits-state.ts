/**
 * Durable `policy_limits` state: the safe projection of one account's accepted document, so a
 * normal restart keeps what the account already confirmed instead of reading it again.
 *
 * The file is the `policy_limits` owner's own store, separate from the settings namespace and
 * from the maintenance state: two writers of different documents never merge into one file.
 *
 * It holds no credential and no raw remote value. A restriction is stored as the bool the
 * document stated, for the keys the pinned registry knows; a monitoring notice, a non-empty
 * `defaults` map, core skill names and any restriction key outside the registry are stored as
 * existence facts only — never as the value that carried them — and each one is a blocker the
 * restored account keeps until a fresh verified read replaces the record. A file that exists
 * but cannot be trusted is never read as an empty one: the caller learns the state is
 * unavailable and fails closed instead of silently losing a restriction an earlier run read.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { policyRegistration } from '../claude-core/policy-registry.js'
import { withStoreLockOwned } from '../auth/store-lock.js'
import type { LockTiming } from '../auth/store-lock.js'

/** The outer bound on the state file this module will read or write, in characters. */
export const CLAUDE_POLICY_LIMITS_STATE_LIMIT = 1_048_576

/** The store version this module writes and accepts. */
export const CLAUDE_POLICY_LIMITS_STATE_VERSION = 1

/** The fixed codes every failure of this store reports. */
export type ClaudePolicyLimitsStateCode =
  /** A file exists but could not be read at all. */
  | 'state_unreadable'
  /** A file exists but is not the document this module wrote, in shape or in values. */
  | 'state_corrupt'
  /** The stored version is not one this build accepts. */
  | 'state_version_unsupported'
  /** The stored file is larger than the accepted bound. */
  | 'state_oversized'
  /** A write was refused because the document it would replace cannot be trusted. */
  | 'state_untrusted_write'
  /** Another process holds the store lock and could not be waited out. */
  | 'state_locked'
  /** The write itself failed. */
  | 'state_write_failed'

/** One store failure, as a fixed code plus this plugin's own detail text. */
export interface ClaudePolicyLimitsStateError {
  /** The stable machine code. */
  readonly code: ClaudePolicyLimitsStateCode
  /** This module's own description of the failure; never a remote value. */
  readonly detail: string
}

/** A store failure reported by throwing, so one write cannot fail silently. */
export class ClaudePolicyLimitsStateFailure extends Error {
  /**
   * @param code - the stable machine code.
   * @param detail - this module's own description of the failure.
   */
  constructor(
    readonly code: ClaudePolicyLimitsStateCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'ClaudePolicyLimitsStateFailure'
  }
}

/**
 * The identity one stored record belongs to.
 *
 * It is the same fence the in-memory owner keys a state by: the account key alone is never
 * enough, because a new login keeps the account key and changes the identity.
 */
export interface ClaudePersistedPolicyLimitsIdentity {
  /** Canonical account key. */
  readonly account: string
  /** Organization UUID the credential stated, when it stated one. */
  readonly accountUuid?: string | undefined
  /** Confirmed organization, when one is known. */
  readonly organization?: string | undefined
  /** Endpoint origin the record was read from. */
  readonly origin: string
  /** Protocol-profile fingerprint the record was read under. */
  readonly profileFingerprint: string
  /** Credential lease epoch, when the caller has one. */
  readonly epoch?: string | undefined
}

/** One registered key's stored verdict. */
export interface ClaudePersistedPolicyLimitsRestriction {
  /** A key the pinned registry knows. */
  readonly key: string
  /** The verdict the accepted document stated for it. */
  readonly allowed: boolean
}

/** One stored capability default. */
export interface ClaudePersistedPolicyLimitsDefault {
  /** A defaults key whose value type this module knows. */
  readonly key: string
  /** The bool the accepted document stated for it. */
  readonly value: boolean
}

/**
 * The `defaults` keys this store may keep by name.
 *
 * The pinned typed reader resolves a defaults entry as a per-key boolean, and the only bound
 * consumer in the analyzed build is the startup remote-control capability, which this plugin
 * does not provide either. A key outside this set, or a value that is not a boolean, is stored
 * as a count only: a remote string is never written to disk here.
 */
export const CLAUDE_POLICY_KNOWN_DEFAULT_KEYS: ReadonlySet<string> = new Set(['remote_control_at_startup'])

/** One account's stored projection of an accepted document. */
export interface ClaudePersistedPolicyLimitsRecord {
  /** The identity the record belongs to. */
  readonly identity: ClaudePersistedPolicyLimitsIdentity
  /**
   * Monotonic adoption counter of that identity, starting at one. It is the strict
   * compare-and-swap token a removal must state, so a removal can never delete a record a
   * later adoption wrote.
   */
  readonly revision: number
  /** The validator of the raw body, or `''` when none was derived. */
  readonly validator: string
  /** When this process adopted the document, in epoch milliseconds. */
  readonly receivedAt: number
  /** The registered keys the document stated, with the bool it stated. */
  readonly restrictions: readonly ClaudePersistedPolicyLimitsRestriction[]
  /** The normalized compliance taints in force; already bounded by the pinned pattern. */
  readonly taints: readonly string[]
  /** Whether normalization dropped at least one taint entry. */
  readonly lossyTaints: boolean
  /** Whether a monitoring notice was in force; its text is never stored. */
  readonly noticePresent: boolean
  /** The capability defaults this build can re-state, with the bool the document gave them. */
  readonly defaults: readonly ClaudePersistedPolicyLimitsDefault[]
  /** How many defaults entries this build cannot type or does not know; their values are not stored. */
  readonly unknownDefaults: number
  /** Whether the document named core skills; the names are never stored. */
  readonly coreSkillsPresent: boolean
  /** How many stated restriction keys are outside the pinned registry; their names are not stored. */
  readonly unknownKeys: number
}

/** What a load produced. */
export type ClaudePolicyLimitsLoadResult =
  /** Nothing was ever stored at this path. */
  | { readonly status: 'cold' }
  /** The stored records, validated. */
  | { readonly status: 'loaded'; readonly records: readonly ClaudePersistedPolicyLimitsRecord[] }
  /** A file exists but cannot be trusted; the caller must fail closed. */
  | { readonly status: 'unavailable'; readonly error: ClaudePolicyLimitsStateError }

/** What a compare-and-swap removal produced. */
export type ClaudePolicyLimitsRemoval =
  /** The record matched the stated identity and revision and is gone. */
  | { readonly status: 'removed' }
  /** No record was stored for the account. */
  | { readonly status: 'absent' }
  /** The stored record is not the one the caller stated; it was left in place. */
  | { readonly status: 'superseded' }
  /** The removal could not be attempted; the record is left in place. */
  | { readonly status: 'retained'; readonly error: ClaudePolicyLimitsStateError }

/** The account whose record one removal names, with the exact token it must still carry. */
export interface ClaudePolicyLimitsRemovalRequest {
  /** Canonical account key. */
  readonly account: string
  /** The identity the caller's in-memory state belongs to. */
  readonly identity: ClaudePersistedPolicyLimitsIdentity
  /** The adoption counter the caller's in-memory state holds. */
  readonly revision: number
}

/** The durable store the owner injects. */
export interface ClaudePolicyLimitsStateStore {
  /**
   * Read the stored records.
   * @returns the validated records, or why they cannot be trusted.
   */
  load(): Promise<ClaudePolicyLimitsLoadResult>
  /**
   * Store these records, merging them into whatever the file already holds for accounts this
   * call does not name, so two processes writing different accounts keep both.
   * @param records - the accounts to write.
   */
  save(records: readonly ClaudePersistedPolicyLimitsRecord[]): Promise<void>
  /**
   * Drop one account's record, only while it is still the exact record the caller states.
   * @param request - the account, its identity and the adoption counter to compare.
   * @returns what the removal did.
   */
  remove(request: ClaudePolicyLimitsRemovalRequest): Promise<ClaudePolicyLimitsRemoval>
}

/** The on-disk document root. */
interface StoredDocument {
  version: number
  accounts: ClaudePersistedPolicyLimitsRecord[]
}

/** The pinned taint shape the core normalizes to. */
const TAINT_PATTERN = /^[a-z0-9_-]{1,64}$/

/** The pinned taint limit. */
const TAINT_LIMIT = 16

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A string, empty allowed, or undefined. */
function anyString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A finite integer at or above the bound, or undefined. */
function boundedInteger(value: unknown, min: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined
}

/** Whether two stored identities are the same fence. */
export function samePolicyLimitsIdentity(
  left: ClaudePersistedPolicyLimitsIdentity,
  right: ClaudePersistedPolicyLimitsIdentity,
): boolean {
  return left.account === right.account
    && left.accountUuid === right.accountUuid
    && left.organization === right.organization
    && left.origin === right.origin
    && left.profileFingerprint === right.profileFingerprint
    && left.epoch === right.epoch
}

/**
 * Validate one stored identity.
 * @param value - the parsed member.
 * @returns the identity, or undefined when it is not a usable fence.
 */
function readIdentity(value: unknown): ClaudePersistedPolicyLimitsIdentity | undefined {
  if (!isRecord(value)) return undefined
  const account = nonEmptyString(value.account)
  const origin = nonEmptyString(value.origin)
  const profileFingerprint = nonEmptyString(value.profileFingerprint)
  if (account === undefined || origin === undefined || profileFingerprint === undefined) return undefined
  const accountUuid = nonEmptyString(value.accountUuid)
  const organization = nonEmptyString(value.organization)
  const epoch = nonEmptyString(value.epoch)
  return {
    account,
    origin,
    profileFingerprint,
    ...accountUuid === undefined ? {} : { accountUuid },
    ...organization === undefined ? {} : { organization },
    ...epoch === undefined ? {} : { epoch },
  }
}

/**
 * Validate one stored record.
 *
 * A restriction key or a defaults key this build does not know is dropped and counted, never
 * kept as a name: the file must not carry a remote string, and the count is what a restored
 * account reports as a capability it cannot apply.
 * @param value - the parsed record.
 * @returns the record, `undefined` when it carries nothing usable, or the reason it cannot be trusted.
 */
function readRecord(value: unknown): { record: ClaudePersistedPolicyLimitsRecord } | { unusable: string } | undefined {
  if (!isRecord(value)) return undefined
  const identity = readIdentity(value.identity)
  if (identity === undefined) return undefined
  const revision = boundedInteger(value.revision, 1)
  const validator = anyString(value.validator)
  const receivedAt = boundedInteger(value.receivedAt, 0)
  if (revision === undefined || validator === undefined || receivedAt === undefined) {
    return { unusable: `account "${identity.account}" has an incomplete record` }
  }
  if (!Array.isArray(value.restrictions)) return { unusable: `account "${identity.account}" has no restriction list` }
  if (!Array.isArray(value.taints)) return { unusable: `account "${identity.account}" has no taint list` }
  if (!Array.isArray(value.defaults)) return { unusable: `account "${identity.account}" has no defaults list` }
  const flags = ['lossyTaints', 'noticePresent', 'coreSkillsPresent'] as const
  for (const flag of flags) {
    if (typeof value[flag] !== 'boolean') return { unusable: `account "${identity.account}" has a malformed ${flag} member` }
  }
  const unknownKeys = boundedInteger(value.unknownKeys, 0)
  const unknownDefaults = boundedInteger(value.unknownDefaults, 0)
  if (unknownKeys === undefined) return { unusable: `account "${identity.account}" has a malformed unknown-key count` }
  if (unknownDefaults === undefined) return { unusable: `account "${identity.account}" has a malformed unknown-default count` }
  const restrictions: ClaudePersistedPolicyLimitsRestriction[] = []
  let unknown = unknownKeys
  for (const entry of value.restrictions) {
    if (!isRecord(entry)) return { unusable: `account "${identity.account}" has a malformed restriction` }
    const key = nonEmptyString(entry.key)
    if (key === undefined || typeof entry.allowed !== 'boolean') {
      return { unusable: `account "${identity.account}" has a malformed restriction` }
    }
    if (policyRegistration(key) === undefined) {
      unknown += 1
      continue
    }
    restrictions.push({ key, allowed: entry.allowed })
  }
  const defaults: ClaudePersistedPolicyLimitsDefault[] = []
  let unknownDefaultsCount = unknownDefaults
  for (const entry of value.defaults) {
    if (!isRecord(entry)) return { unusable: `account "${identity.account}" has a malformed default` }
    const key = nonEmptyString(entry.key)
    if (key === undefined || typeof entry.value !== 'boolean') {
      return { unusable: `account "${identity.account}" has a malformed default` }
    }
    if (!CLAUDE_POLICY_KNOWN_DEFAULT_KEYS.has(key)) {
      unknownDefaultsCount += 1
      continue
    }
    defaults.push({ key, value: entry.value })
  }
  const taints: string[] = []
  let lossyTaints = value.lossyTaints === true
  for (const entry of value.taints) {
    if (typeof entry !== 'string' || !TAINT_PATTERN.test(entry) || taints.includes(entry)) {
      // A taint this build cannot re-state is not silently dropped: it becomes the blocker
      // that keeps the restored account unsettled until a fresh read confirms it.
      lossyTaints = true
      continue
    }
    if (taints.length >= TAINT_LIMIT) {
      lossyTaints = true
      continue
    }
    taints.push(entry)
  }
  return {
    record: {
      identity,
      revision,
      validator,
      receivedAt,
      restrictions,
      taints,
      lossyTaints,
      noticePresent: value.noticePresent === true,
      defaults,
      unknownDefaults: unknownDefaultsCount,
      coreSkillsPresent: value.coreSkillsPresent === true,
      unknownKeys: unknown,
    },
  }
}

/**
 * Project one record onto what this store may write.
 *
 * The same narrowing the load applies is applied on the way in, so the file's invariants hold
 * by construction: only a key the pinned registry knows keeps its name, a taint the pinned
 * pattern cannot re-state is dropped and counted into the record's own lossy flag, and a
 * defaults entry is kept only for a key whose value type this module knows.
 * @param record - the record a caller asked to store.
 * @returns the record as it may appear on disk.
 */
function normalizeRecord(record: ClaudePersistedPolicyLimitsRecord): ClaudePersistedPolicyLimitsRecord {
  const restrictions: ClaudePersistedPolicyLimitsRestriction[] = []
  let unknownKeys = record.unknownKeys
  for (const entry of record.restrictions) {
    if (policyRegistration(entry.key) === undefined) {
      unknownKeys += 1
      continue
    }
    restrictions.push({ key: entry.key, allowed: entry.allowed })
  }
  const taints: string[] = []
  let lossyTaints = record.lossyTaints
  for (const taint of record.taints) {
    if (!TAINT_PATTERN.test(taint) || taints.includes(taint) || taints.length >= TAINT_LIMIT) {
      lossyTaints = true
      continue
    }
    taints.push(taint)
  }
  const defaults: ClaudePersistedPolicyLimitsDefault[] = []
  let unknownDefaults = record.unknownDefaults
  for (const entry of record.defaults) {
    if (!CLAUDE_POLICY_KNOWN_DEFAULT_KEYS.has(entry.key)) {
      unknownDefaults += 1
      continue
    }
    defaults.push({ key: entry.key, value: entry.value })
  }
  return { ...record, restrictions, taints, lossyTaints, defaults, unknownDefaults, unknownKeys }
}

/**
 * The plugin's own `policy_limits` state file.
 *
 * Writes are serialized inside a cross-process lock, merged per account key, and swapped into
 * place atomically from an exclusively created temporary file, so one process cannot drop
 * another's record and a reader never observes a half-written document.
 */
export class FileClaudePolicyLimitsState implements ClaudePolicyLimitsStateStore {
  private writeTail: Promise<void> = Promise.resolve()

  /**
   * @param options - the file to use, the lock timing, and a diagnostic sink.
   */
  constructor(private readonly options: {
    /**
     * The absolute file path. The caller injects it from the harness home it already
     * configures; a test injects a private path so no real home is touched.
     */
    path?: string
    timing?: LockTiming
    onWarn?: (message: string) => void
  } = {}) {}

  /** Absolute path of the state file. */
  private path(): string {
    return this.options.path ?? dshHomePath('plugins', 'subscriptions', 'claude-policy-limits.json')
  }

  /**
   * Read the stored records.
   * @returns the validated records, or why they cannot be trusted.
   */
  async load(): Promise<ClaudePolicyLimitsLoadResult> {
    return this.readDocument()
  }

  /**
   * Merge these records into the stored ones and write the result under the store lock.
   * @param records - the accounts to write.
   */
  async save(records: readonly ClaudePersistedPolicyLimitsRecord[]): Promise<void> {
    await this.enqueue(async () => {
      await this.mergeUnderOwnedLock(records)
    })
  }

  /**
   * Drop one account's record while it still matches the caller's identity and revision.
   * @param request - the account, its identity and the adoption counter to compare.
   * @returns what the removal did.
   */
  async remove(request: ClaudePolicyLimitsRemovalRequest): Promise<ClaudePolicyLimitsRemoval> {
    let outcome: ClaudePolicyLimitsRemoval = { status: 'absent' }
    try {
      await this.enqueue(async () => {
        outcome = await this.removeUnderOwnedLock(request)
      })
    } catch (error: unknown) {
      // A removal is a cleanup: a store that cannot perform it leaves the record in place,
      // which is the safe direction, and reports the fixed code instead of throwing.
      const failure = error instanceof ClaudePolicyLimitsStateFailure
        ? { code: error.code, detail: error.detail }
        : { code: 'state_write_failed' as const, detail: 'the policy_limits state removal failed' }
      return { status: 'retained', error: failure }
    }
    return outcome
  }

  /**
   * Remove one record while this process owns the lock, comparing identity and revision first.
   *
   * The comparison is the whole point: a release that arrives after a later login or a later
   * adoption must not delete the state those wrote. A document that cannot be trusted is left
   * exactly as it is.
   * @param request - the account, its identity and the adoption counter to compare.
   * @returns what the removal did.
   */
  private async removeUnderOwnedLock(request: ClaudePolicyLimitsRemovalRequest): Promise<ClaudePolicyLimitsRemoval> {
    const path = this.path()
    const locked = await withStoreLockOwned(path, async () => {
      const current = await this.readDocument()
      if (current.status === 'unavailable') {
        return { status: 'retained', error: current.error } as ClaudePolicyLimitsRemoval
      }
      if (current.status === 'cold') return { status: 'absent' } as ClaudePolicyLimitsRemoval
      const stored = current.records.find(record => record.identity.account === request.account)
      if (stored === undefined) return { status: 'absent' } as ClaudePolicyLimitsRemoval
      if (!samePolicyLimitsIdentity(stored.identity, request.identity) || stored.revision !== request.revision) {
        return { status: 'superseded' } as ClaudePolicyLimitsRemoval
      }
      const kept = current.records.filter(record => record.identity.account !== request.account)
      await this.writeDocument(kept)
      return { status: 'removed' } as ClaudePolicyLimitsRemoval
    }, this.options.timing)
    if (!locked.acquired) {
      return { status: 'retained', error: { code: 'state_locked', detail: 'the policy_limits state lock is held by another process' } }
    }
    return locked.value
  }

  /**
   * Merge these records into the stored document while this process owns the lock.
   *
   * Ownership is a precondition, not a preference: a write that cannot take the lock fails so
   * the caller learns it did not happen. A document this process cannot trust is never
   * replaced by a partial write either — an account's accepted restriction must not be erased
   * by an unrelated write — so the write is refused and the caller keeps failing closed until
   * an operator repairs or removes the file.
   * @param records - the accounts to write.
   */
  private async mergeUnderOwnedLock(records: readonly ClaudePersistedPolicyLimitsRecord[]): Promise<void> {
    const path = this.path()
    const outcome = await withStoreLockOwned(path, async () => {
      const current = await this.readDocument()
      if (current.status === 'unavailable') {
        throw new ClaudePolicyLimitsStateFailure(
          'state_untrusted_write',
          `the stored state cannot be trusted, so it was not replaced (${current.error.code})`,
        )
      }
      const merged = new Map<string, ClaudePersistedPolicyLimitsRecord>()
      if (current.status === 'loaded') {
        for (const record of current.records) merged.set(record.identity.account, record)
      }
      for (const record of records) {
        const stored = merged.get(record.identity.account)
        // A stale write of the same identity is dropped: another process adopted a later
        // revision, and this one is older evidence about the same account.
        if (stored !== undefined && samePolicyLimitsIdentity(stored.identity, record.identity) && stored.revision > record.revision) {
          continue
        }
        merged.set(record.identity.account, record)
      }
      await this.writeDocument([...merged.values()])
    }, this.options.timing)
    if (!outcome.acquired) {
      throw new ClaudePolicyLimitsStateFailure('state_locked', 'the policy_limits state lock is held by another process')
    }
  }

  /** Serialize this instance's own writes. */
  private async enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(action)
    this.writeTail = next.then(() => undefined, () => undefined)
    await next
  }

  /** Read and validate the file, distinguishing "never written" from "not trustworthy". */
  private async readDocument(): Promise<ClaudePolicyLimitsLoadResult> {
    let text: string
    try {
      text = await readFile(this.path(), 'utf8')
    } catch (error: unknown) {
      // Only a file that is genuinely absent is a cold start; every other read failure is a
      // state this process cannot trust, which the caller must fail closed on.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'cold' }
      return {
        status: 'unavailable',
        error: {
          code: 'state_unreadable',
          detail: `the policy_limits state could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`,
        },
      }
    }
    if (text.length > CLAUDE_POLICY_LIMITS_STATE_LIMIT) {
      return { status: 'unavailable', error: { code: 'state_oversized', detail: 'the policy_limits state exceeds the accepted size bound' } }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { status: 'unavailable', error: { code: 'state_corrupt', detail: 'the policy_limits state is not valid JSON' } }
    }
    if (!isRecord(parsed)) {
      return { status: 'unavailable', error: { code: 'state_corrupt', detail: 'the policy_limits state is not a document' } }
    }
    if (parsed.version !== CLAUDE_POLICY_LIMITS_STATE_VERSION) {
      return {
        status: 'unavailable',
        error: { code: 'state_version_unsupported', detail: `unsupported policy_limits state version ${String(parsed.version)}` },
      }
    }
    if (!Array.isArray(parsed.accounts)) {
      return { status: 'unavailable', error: { code: 'state_corrupt', detail: 'the policy_limits state carries no account list' } }
    }
    const records: ClaudePersistedPolicyLimitsRecord[] = []
    for (const entry of parsed.accounts) {
      const read = readRecord(entry)
      if (read === undefined) continue
      if ('unusable' in read) return { status: 'unavailable', error: { code: 'state_corrupt', detail: read.unusable } }
      records.push(read.record)
    }
    return { status: 'loaded', records }
  }

  /** Write the complete document atomically, from an exclusively created temporary file. */
  private async writeDocument(records: readonly ClaudePersistedPolicyLimitsRecord[]): Promise<void> {
    const path = this.path()
    const document: StoredDocument = {
      version: CLAUDE_POLICY_LIMITS_STATE_VERSION,
      accounts: records.map(normalizeRecord),
    }
    const text = JSON.stringify(document)
    if (text.length > CLAUDE_POLICY_LIMITS_STATE_LIMIT) {
      throw new ClaudePolicyLimitsStateFailure('state_oversized', 'the policy_limits state would exceed the accepted size bound')
    }
    try {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${randomUUID()}.tmp`
      try {
        // An exclusively created file no other writer can already hold, at owner-only mode.
        await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
        await rename(tmp, path)
      } catch (error: unknown) {
        await rm(tmp, { force: true }).catch(() => undefined)
        throw error
      }
    } catch (error: unknown) {
      if (error instanceof ClaudePolicyLimitsStateFailure) throw error
      throw new ClaudePolicyLimitsStateFailure(
        'state_write_failed',
        `the policy_limits state could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`,
      )
    }
  }
}
