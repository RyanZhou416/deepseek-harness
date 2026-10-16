/**
 * The continuation salt: the plugin's own durable material for naming an account.
 *
 * The chain, the wire identity and the pin state are keyed by an `accountRef` derived from this
 * salt, so the salt is what makes "the same account" a checkable fact rather than a comparison of
 * whatever string an account happened to be stored under. The salt never leaves this module: it
 * is not returned to a caller, not written into a record, not logged, and the reference derived
 * from it carries neither the account key nor the salt. The reference type, its shape check and
 * its comparison live in the pure `claude-core/account-ref` module and are re-exported here for
 * this store's callers.
 *
 * One operation is one read-modify-write inside the plugin's own lock, and creating the document
 * is that same critical section: two processes that start together therefore leave one identity,
 * and neither can expose a half-written document. Writing replaces the document through an
 * exclusively created owner-only temporary file renamed into place.
 *
 * **A refusal that will pass is not a distrust.** A lock another holder owns, a wait that reached
 * its configured bound, and a salt removed underneath a running process are reported as
 * {@link ContinuationUnavailable}: the next call reads the document again, and the installation's
 * identity is unchanged when the same material is there. Only a document this build cannot verify,
 * and material that is not the one this store adopted, make it `untrusted`, and that verdict
 * stands for the lifetime of this store: replacing a salt silently would re-name every account,
 * and reading on from it would derive references that match nothing that was written.
 *
 * Losing the salt means every previously derived reference stops matching. A replacement salt
 * cannot recompute an old one, so the plugin starts a new identity generation and sends no chain
 * rather than guessing which stored rows belonged to the account.
 *
 * The lock and the rename are the plugin's own guarantees between its own processes.
 * Coordination with another holder of the same path is not claimed.
 *
 * @module dsh-plugin-subscriptions/providers/claude-salt-store
 */

import { createHash, randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ClaudeAccountRef } from '../claude-core/account-ref.js'
import { CLAUDE_ACCOUNT_REF_VERSION } from '../claude-core/account-ref.js'
import type {
  ContinuationDeadline,
  ContinuationFiles,
  ContinuationUnavailable,
  ContinuationWaitHost,
} from './claude-continuation-io.js'
import {
  LOCAL_CONTINUATION_STATE_UNAVAILABLE,
  ContinuationIo,
  continuationUnavailable,
  nodeContinuationFiles,
  systemContinuationWaits,
} from './claude-continuation-io.js'

export { CLAUDE_ACCOUNT_REF_VERSION, isClaudeAccountRef } from '../claude-core/account-ref.js'
export type { ClaudeAccountRef } from '../claude-core/account-ref.js'

/** The document version this build writes and reads. */
export const CLAUDE_SALT_VERSION = 1

/**
 * Whether this installation can name accounts.
 *
 * The material itself is deliberately absent from every member: nothing outside this module may
 * hold, copy or log the salt, so callers learn only whether references can be derived.
 */
export type ClaudeSaltStatus =
  /** A salt is available: references can be derived and compared. */
  | { readonly kind: 'ready'; readonly version: typeof CLAUDE_SALT_VERSION }
  /** A salt exists but cannot be trusted; no reference may be derived from it. */
  | { readonly kind: 'untrusted'; readonly reason: string }
  /** The state could not be used right now; the next call reads it again. */
  | ContinuationUnavailable

/** What deriving one account reference produced. */
export type ClaudeAccountRefResult =
  /** The reference this installation derives for that account. */
  | { readonly kind: 'derived'; readonly accountRef: ClaudeAccountRef }
  /** No reference may be derived; the caller must not send a chained request. */
  | { readonly kind: 'failed'; readonly code: typeof LOCAL_CONTINUATION_STATE_UNAVAILABLE; readonly reason: string }

/** Constructor options for {@link ClaudeSaltStore}. */
export interface ClaudeSaltStoreOptions {
  /** File holding the salt; absent uses the plugin's own home directory. */
  readonly path?: string
  /** How long one operation may wait before its caller is refused. */
  readonly deadlineMs: number
  /** How long one operation may wait for the owned lock. */
  readonly lockTimeoutMs: number
  /** Sink for a diagnostic about the store itself; never used for a credential. */
  readonly onWarn?: (message: string) => void
  /** The private file operations; a test injects one to hold a write. */
  readonly files?: ContinuationFiles
  /** The timers and abort listeners one bounded wait uses; a test injects one to observe it. */
  readonly waits?: ContinuationWaitHost
}

/** What reading the document produced, including the material this module keeps private. */
type SaltRead =
  | { readonly kind: 'ready'; readonly salt: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'untrusted'; readonly reason: string }

/** What a read-or-create produced: the material, or why none may be used. */
type SaltOutcome =
  | { readonly kind: 'ready'; readonly salt: string }
  | { readonly kind: 'untrusted'; readonly reason: string }
  | ContinuationUnavailable

/** One persisted salt document. */
interface StoredSalt {
  readonly version: typeof CLAUDE_SALT_VERSION
  readonly salt: string
  /** ISO instant the salt was created, for diagnostics only. */
  readonly createdAt: string
}

/** The one file this installation's continuation state lives under. */
function defaultPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'claude-continuation', 'salt.json')
}

/**
 * Validate a value read back from disk.
 * @param value - the parsed document.
 * @returns true when every required field is present and well typed.
 */
function isStoredSalt(value: unknown): value is StoredSalt {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['version'] === CLAUDE_SALT_VERSION
    && typeof record['salt'] === 'string' && record['salt'].length > 0
    && typeof record['createdAt'] === 'string'
}

/**
 * Derive one account reference from a salt.
 *
 * The account key is length-prefixed so two accounts cannot produce the same preimage by
 * overlapping at a separator.
 * @param salt - this installation's salt.
 * @param account - the canonical account key.
 * @returns the reference this installation derives for that account.
 */
export function claudeAccountRef(salt: string, account: string): ClaudeAccountRef {
  const digest = createHash('sha256')
    .update(`claude-account-ref:1:${String(salt.length)}:${salt}:${String(account.length)}:${account}`)
    .digest('hex')
  return { kind: 'salt-sha256', version: CLAUDE_ACCOUNT_REF_VERSION, ref: digest }
}

/**
 * Parse one document, distinguishing an absent one from an untrustworthy one.
 * @param text - the document text, or undefined when it is absent.
 * @returns the salt, that it is absent, or why it cannot be trusted.
 */
function parseSalt(text: string | undefined): SaltRead {
  if (text === undefined) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Only the parse is swallowed: an unparseable document is reported as untrusted.
    return { kind: 'untrusted', reason: 'the continuation salt is not valid JSON' }
  }
  if (!isStoredSalt(parsed)) return { kind: 'untrusted', reason: 'the continuation salt document is not one this build writes' }
  return { kind: 'ready', salt: parsed.salt }
}

/**
 * The durable salt of one plugin installation.
 *
 * Every operation is one guarded read-modify-write: it reads, decides and writes inside the
 * plugin's own lock, bounded by the caller's deadline and cancellation. The material is held
 * privately and never returned, and only a document this build cannot verify, or material that is
 * not the one this store adopted, is remembered as untrusted; a busy lock, an elapsed wait or a
 * removed document is answered again on the next call rather than becoming a permanent verdict.
 */
export class ClaudeSaltStore {
  private readonly path: string
  private readonly io: ContinuationIo
  private material: string | undefined
  private damaged: string | undefined
  private warned = false

  /**
   * @param options - path override, both configured budgets and the injectable I/O boundary.
   */
  constructor(private readonly options: ClaudeSaltStoreOptions) {
    this.path = options.path ?? defaultPath()
    this.io = new ContinuationIo({
      path: this.path,
      lockTimeoutMs: options.lockTimeoutMs,
      deadlineMs: options.deadlineMs,
      files: options.files ?? nodeContinuationFiles,
      waits: options.waits ?? systemContinuationWaits,
    })
  }

  /**
   * Read the salt, creating it in the same critical section when the installation has none.
   * @param deadline - the bound and cancellation the caller resolved for its own chain; absent
   *   uses the configured deadline and no signal.
   * @returns whether references can be derived, or why none may be used.
   */
  async ensure(deadline?: ContinuationDeadline): Promise<ClaudeSaltStatus> {
    const outcome = await this.readOrCreate(deadline)
    if (outcome.kind === 'ready') return { kind: 'ready', version: CLAUDE_SALT_VERSION }
    return outcome
  }

  /**
   * The reference this installation derives for one account.
   *
   * The material is read from the document in the same critical section that decides it, so a
   * substituted or deleted salt is refused rather than masked by a cached value.
   * @param account - the canonical account key.
   * @param deadline - the bound and cancellation the caller resolved for its own chain; absent
   *   uses the configured deadline and no signal.
   * @returns the derived reference, or the fixed refusal that no request may chain.
   */
  async hashRef(account: string, deadline?: ContinuationDeadline): Promise<ClaudeAccountRefResult> {
    if (account.length === 0) return this.failed('the account key is empty')
    const outcome = await this.readOrCreate(deadline)
    if (outcome.kind === 'unavailable') return this.failed(outcome.reason)
    if (outcome.kind === 'untrusted') return this.failed(outcome.reason)
    return { kind: 'derived', accountRef: claudeAccountRef(outcome.salt, account) }
  }

  /** Stop accepting operations and wait for the ones already owned to settle. */
  async close(): Promise<void> {
    await this.io.close()
  }

  /**
   * Read the document, creating it in the same lock when the installation has no salt yet.
   *
   * A document that is absent while this store has already adopted one is a refusal, not a new
   * first use: creating a second salt would silently re-name every account.
   */
  private async readOrCreate(deadline: ContinuationDeadline | undefined): Promise<SaltOutcome> {
    if (this.damaged !== undefined) return { kind: 'untrusted', reason: this.damaged }
    const proposed: StoredSalt = {
      version: CLAUDE_SALT_VERSION,
      salt: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    let observed: SaltRead | undefined
    const outcome = await this.io.update((current) => {
      const parsed = parseSalt(current)
      if (parsed.kind !== 'absent') {
        observed = parsed
        return undefined
      }
      if (this.material !== undefined) {
        observed = parsed
        return undefined
      }
      observed = { kind: 'ready', salt: proposed.salt }
      return JSON.stringify(proposed)
    }, deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (observed === undefined) return continuationUnavailable('the continuation salt read produced no state')
    if (observed.kind === 'absent') {
      return continuationUnavailable('the continuation salt was removed while it was in use')
    }
    if (observed.kind === 'untrusted') return this.distrust(observed.reason)
    if (this.material !== undefined && observed.salt !== this.material) {
      return this.distrust('the continuation salt was replaced while it was in use')
    }
    this.material = observed.salt
    return { kind: 'ready', salt: observed.salt }
  }

  private failed(reason: string): ClaudeAccountRefResult {
    return { kind: 'failed', code: LOCAL_CONTINUATION_STATE_UNAVAILABLE, reason }
  }

  /** Remember a document this build cannot trust, and report it once. */
  private distrust(reason: string): { readonly kind: 'untrusted'; readonly reason: string } {
    this.damaged = reason
    this.warnOnce(reason)
    return { kind: 'untrusted', reason }
  }

  private warnOnce(reason: string): void {
    if (this.warned) return
    this.warned = true
    this.options.onWarn?.(`dsh-plugin-subscriptions: ${reason}`)
  }
}
