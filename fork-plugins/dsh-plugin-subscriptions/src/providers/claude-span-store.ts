/**
 * The durable owner of the Claude wire identity, the ATIS pin state and the account's capture
 * arbitration.
 *
 * In one process these facts already exist as module-level maps. They are not enough: the wire
 * session id decides both `X-Claude-Code-Session-Id` and the billing `cc_prompt_id` derived from
 * it, so a restart that minted a new id would render different model-visible bytes for the same
 * conversation. This store is therefore the durable owner of that identity, and a request may not
 * be built until the identity for its span is committed.
 *
 * **Every ready identity is already committed.** {@link ClaudeSpanBindingStore.prepare} writes the
 * wire session id in the same locked read-modify-write that decides it, for a new span and for a
 * restored one alike, so a later freeze can never mint a second identity for a request that
 * already declared the first. A restored span whose own record is absent takes the identity a
 * verified durable log fact states, or a fresh one when the caller has no such fact; either way
 * its pin is committed empty, because the conversation continued without a fact saying what it
 * used, and a bootstrap read that lands later must not fill it in. A restored span whose record
 * exists but holds no pin is committed empty on the same terms. Only a new span is left unfrozen,
 * and its first freeze takes the account's own arbitration.
 *
 * The rules the in-memory owner applies are preserved rather than re-decided here. A pin freezes
 * to the capture that was newest when that request was prepared — the token a bootstrap read
 * disclosed, or the empty pin when the read disclosed nothing usable — and what it froze to never
 * changes, so a later read cannot replace what the span sends. The newest capture attempt owns the
 * account, so an older capture that finishes late commits nothing and cannot revive a frozen or
 * evicted pin. Spans are bounded per account, oldest first. A discard bumps the account's
 * capture generation, which revokes in-flight tickets, and drops the account's spans.
 *
 * The store is fail-closed. A document that cannot be read, parsed or verified, and a lock that
 * cannot be owned, report the same fixed refusal, and the caller must send nothing: a temporary
 * random identity would silently change the conversation's model-visible bytes and its ATIS
 * state. A refusal that will pass — a held lock, an elapsed deadline, an operation still settling
 * — is answered again on the next call rather than becoming a permanent verdict.
 *
 * @module dsh-plugin-subscriptions/providers/claude-span-store
 */

import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  ContinuationDeadline,
  ContinuationFiles,
  ContinuationUnavailable,
  ContinuationWaitHost,
} from './claude-continuation-io.js'
import {
  ContinuationIo,
  continuationUnavailable,
  nodeContinuationFiles,
  systemContinuationWaits,
} from './claude-continuation-io.js'
import { isClaudeAccountRef, sameClaudeAccountRef } from '../claude-core/account-ref.js'
import type { ClaudeAccountRef } from '../claude-core/account-ref.js'

export { LOCAL_CONTINUATION_STATE_UNAVAILABLE } from './claude-continuation-io.js'

/** The document version this build writes and reads. */
export const CLAUDE_SPAN_STORE_VERSION = 1

/** At most this many spans per account; the oldest is evicted first. */
export const CLAUDE_SPAN_LIMIT = 256

/** Constructor options for {@link ClaudeSpanBindingStore}. */
export interface ClaudeSpanBindingStoreOptions {
  /** File holding the state; absent uses the plugin's own home directory. */
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

/** The span identity one request belongs to. */
export interface ClaudeSpanIdentity {
  /** The account this installation derives references for. */
  readonly accountRef: ClaudeAccountRef
  /** The harness session the conversation belongs to. */
  readonly harnessSessionId: string
  /** The identity generation in force when the span was created. */
  readonly spanEpoch: number
}

/** The pin a span sends: unfrozen until its first request freezes it to a token or to empty. */
export type ClaudeSpanPin =
  | { readonly kind: 'unfrozen' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'token'; readonly token: string }

/** Whether a span is created or restored; only a new Session may seed a pin. */
export type ClaudeSpanOrigin = 'initial' | 'resume'

/**
 * The wire identity a restored span's own durable record states, as the caller verified it.
 *
 * The store cannot verify provenance: the caller passes this only when its session log itself
 * states the identity for this span. An unusable value is treated as no fact at all, so the
 * restored span gets a fresh identity and sends no chain rather than adopting a value the store
 * cannot accept.
 */
export interface ClaudeSpanRestoredIdentity {
  /** The wire session id the session log recorded for this span. */
  readonly wireSessionId: string
}

/** What one {@link ClaudeSpanBindingStore.prepare} call may be told and bounded by. */
export interface ClaudeSpanPrepareOptions {
  /** The wire identity a verified log fact states for this restored span. */
  readonly restored?: ClaudeSpanRestoredIdentity
  /** The bound and cancellation the caller resolved for its own preparation chain. */
  readonly deadline?: ContinuationDeadline
}

/** What one prepared span carries. */
export interface ClaudeSpanPrepared {
  /** The stable wire session identity this span commits to. */
  readonly wireSessionId: string
  /** The pin in force, which is unfrozen until the span's first freeze. */
  readonly pin: ClaudeSpanPin
  /** Whether this call created the span; false means it already existed. */
  readonly created: boolean
}

/** A prepared span, or the fixed reason nothing may be sent. */
export type ClaudeSpanPrepareResult =
  | { readonly kind: 'ready'; readonly span: ClaudeSpanPrepared }
  | ContinuationUnavailable

/** What reading one span's pin produced. */
export type ClaudeSpanPinResult =
  /** No span exists for this identity. */
  | { readonly kind: 'absent' }
  /** The pin in force for this span. */
  | { readonly kind: 'pin'; readonly pin: ClaudeSpanPin }
  /** The state cannot be read; the caller must not send. */
  | ContinuationUnavailable

/** What freezing one pin produced. */
export type ClaudeSpanFreezeResult =
  | { readonly kind: 'frozen'; readonly pin: ClaudeSpanPin }
  | ContinuationUnavailable

/** The right to record what one bootstrap read disclosed for an account. */
export interface ClaudeCaptureTicket {
  /** The account the read belongs to. */
  readonly accountRef: ClaudeAccountRef
  /** The generation the ticket was issued under; a later discard revokes it. */
  readonly generation: number
  /** The attempt serial that owns the account while it is the newest. */
  readonly attempt: number
}

/** What claiming a capture right produced. */
export type ClaudeCaptureBeginResult =
  | { readonly kind: 'ticket'; readonly ticket: ClaudeCaptureTicket }
  | ContinuationUnavailable

/** What committing a capture produced. */
export type ClaudeCaptureCommitResult =
  /** The capture was the newest attempt and became the account's candidate. */
  | { readonly kind: 'committed' }
  /** An older or revoked capture owns nothing; the caller keeps the state it read. */
  | { readonly kind: 'refused' }
  | ContinuationUnavailable

/** What discarding one account's state produced. */
export type ClaudeSpanDiscardResult = { readonly kind: 'discarded' } | ContinuationUnavailable

/** One persisted span. */
interface StoredSpan {
  readonly harnessSessionId: string
  readonly spanEpoch: number
  readonly wireSessionId: string
  /** The frozen pin, or null while the span has not frozen one. */
  readonly pin: string | null
  readonly createdAt: string
}

/** One account's persisted continuation state. */
interface StoredAccount {
  readonly accountRef: ClaudeAccountRef
  /** Bumped by every discard, so a ticket from an earlier generation commits nothing. */
  readonly generation: number
  /** The serial of the newest capture attempt. */
  readonly attempt: number
  /** The newest attempt still allowed to commit. */
  readonly latest: number | null
  /** What the newest successful read disclosed; null when it disclosed nothing usable. */
  readonly candidate: string | null
  /** Frozen spans, oldest first. */
  readonly spans: readonly StoredSpan[]
}

/** One persisted document. */
interface StoredDocument {
  readonly version: typeof CLAUDE_SPAN_STORE_VERSION
  readonly accounts: readonly StoredAccount[]
}

/** The path the state lives under when the caller names none. */
function defaultPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'claude-continuation', 'spans.json')
}

/** The token shape the client accepts: non-empty printable ASCII. */
const PRINTABLE_PIN = /^[\x21-\x7e]+$/

/** The wire identity shape this store persists: non-empty printable ASCII, bounded. */
const WIRE_SESSION_ID = /^[\x21-\x7e]{1,256}$/

/**
 * Validate one span read back from disk.
 * @param value - the parsed entry.
 * @returns true when every required field is present and well typed.
 */
function isStoredSpan(value: unknown): value is StoredSpan {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const pin = record['pin']
  return typeof record['harnessSessionId'] === 'string' && record['harnessSessionId'].length > 0
    && typeof record['spanEpoch'] === 'number' && Number.isSafeInteger(record['spanEpoch']) && record['spanEpoch'] >= 0
    && typeof record['wireSessionId'] === 'string' && record['wireSessionId'].length > 0
    && (pin === null || typeof pin === 'string')
    && typeof record['createdAt'] === 'string'
}

/**
 * Validate one account read back from disk.
 * @param value - the parsed entry.
 * @returns true when every required field is present and well typed.
 */
function isStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const latest = record['latest']
  const candidate = record['candidate']
  return isClaudeAccountRef(record['accountRef'])
    && typeof record['generation'] === 'number' && Number.isSafeInteger(record['generation'])
    && typeof record['attempt'] === 'number' && Number.isSafeInteger(record['attempt'])
    && (latest === null || (typeof latest === 'number' && Number.isSafeInteger(latest)))
    && (candidate === null || typeof candidate === 'string')
    && Array.isArray(record['spans']) && record['spans'].every(isStoredSpan)
}

/**
 * Validate a whole document read back from disk.
 * @param value - the parsed document.
 * @returns true when every required field is present and well typed.
 */
function isStoredDocument(value: unknown): value is StoredDocument {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['version'] === CLAUDE_SPAN_STORE_VERSION
    && Array.isArray(record['accounts']) && record['accounts'].every(isStoredAccount)
}

/** The account entry for one reference, when the document holds it. */
function findAccount(document: StoredDocument, accountRef: ClaudeAccountRef): StoredAccount | undefined {
  return document.accounts.find(account => sameClaudeAccountRef(account.accountRef, accountRef))
}

/** The document with one account's entry replaced or appended, every other account kept. */
function replaceAccount(document: StoredDocument, account: StoredAccount): StoredDocument {
  const accounts = document.accounts.filter(entry => !sameClaudeAccountRef(entry.accountRef, account.accountRef))
  accounts.push(account)
  return { version: CLAUDE_SPAN_STORE_VERSION, accounts }
}

/** Drop the oldest spans until one more fits inside the per-account bound. */
function evict(spans: readonly StoredSpan[]): readonly StoredSpan[] {
  if (spans.length < CLAUDE_SPAN_LIMIT) return spans
  return spans.slice(spans.length - CLAUDE_SPAN_LIMIT + 1)
}

/** Project a stored pin into the pin a request reads. */
function pinOf(stored: string | null): ClaudeSpanPin {
  if (stored === null) return { kind: 'unfrozen' }
  return stored.length > 0 ? { kind: 'token', token: stored } : { kind: 'empty' }
}

/** The span one identity names, when the account holds it. */
function findSpan(account: StoredAccount | undefined, identity: ClaudeSpanIdentity): StoredSpan | undefined {
  return account?.spans.find(span => span.harnessSessionId === identity.harnessSessionId
    && span.spanEpoch === identity.spanEpoch)
}

/** One account's state, with a new entry's fields defaulted when the document holds none. */
function accountState(account: StoredAccount | undefined, accountRef: ClaudeAccountRef): StoredAccount {
  return account ?? { accountRef, generation: 0, attempt: 0, latest: null, candidate: null, spans: [] }
}

/** The account with one span replaced, or appended and bounded when it is new. */
function withSpan(
  account: StoredAccount | undefined,
  accountRef: ClaudeAccountRef,
  span: StoredSpan,
  replacing: StoredSpan | undefined,
): StoredAccount {
  const base = accountState(account, accountRef)
  const spans = replacing === undefined
    ? [...evict(base.spans), span]
    : base.spans.map(entry => entry === replacing ? span : entry)
  return { ...base, spans }
}

/** The wire identity a caller's verified fact states, when it is one this store can persist. */
function trustedWireSessionId(restored: ClaudeSpanRestoredIdentity | undefined): string | undefined {
  if (restored === undefined) return undefined
  return WIRE_SESSION_ID.test(restored.wireSessionId) ? restored.wireSessionId : undefined
}

/** Parse one document, distinguishing an absent one from an untrustworthy one. */
function parseDocument(text: string | undefined): { kind: 'parsed'; document: StoredDocument } | { kind: 'untrusted'; reason: string } {
  if (text === undefined) return { kind: 'parsed', document: { version: CLAUDE_SPAN_STORE_VERSION, accounts: [] } }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Only the parse is swallowed: an unparseable document is reported as untrusted.
    return { kind: 'untrusted', reason: 'the continuation state is not valid JSON' }
  }
  if (!isStoredDocument(parsed)) return { kind: 'untrusted', reason: 'the continuation state document is not one this build writes' }
  return { kind: 'parsed', document: parsed }
}

/**
 * The durable wire identity, pin and capture owner for Claude account spans.
 *
 * Every operation reads and changes the document inside the plugin's own lock, so two processes
 * cannot interleave a discard with a commit or drop each other's account, and a decision is never
 * made from a document a pending write may still replace.
 */
export class ClaudeSpanBindingStore {
  private readonly path: string
  private readonly io: ContinuationIo
  private damaged: string | undefined
  private warned = false

  /**
   * @param options - path override, both configured budgets and the injectable I/O boundary.
   */
  constructor(private readonly options: ClaudeSpanBindingStoreOptions) {
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
   * Prepare the span one request belongs to, committing its wire identity before it is returned.
   *
   * A span that already exists keeps the identity it committed. A new Session creates one. A
   * restored Session whose record is absent takes the caller's verified log identity when it has
   * one and a fresh identity otherwise, and its pin is committed empty either way; a restored span
   * whose record holds no pin is committed empty on the same terms, so a bootstrap read that lands
   * later cannot fill it in.
   * @param identity - the account, session and generation the span is keyed by.
   * @param origin - whether this is a new Session or a restored one.
   * @param options - the restored identity fact and the caller's own bound, when it has them.
   * @returns the committed span, or the fixed reason nothing may be sent.
   */
  async prepare(
    identity: ClaudeSpanIdentity,
    origin: ClaudeSpanOrigin,
    options: ClaudeSpanPrepareOptions = {},
  ): Promise<ClaudeSpanPrepareResult> {
    const trusted = origin === 'resume' ? trustedWireSessionId(options.restored) : undefined
    let prepared: ClaudeSpanPrepared | undefined
    const outcome = await this.run((document) => {
      const account = findAccount(document, identity.accountRef)
      const existing = findSpan(account, identity)
      if (existing !== undefined) {
        if (origin === 'resume' && existing.pin === null) {
          const frozen: StoredSpan = { ...existing, pin: '' }
          prepared = { wireSessionId: existing.wireSessionId, pin: { kind: 'empty' }, created: false }
          return {
            document: replaceAccount(document, withSpan(account, identity.accountRef, frozen, existing)),
            value: undefined,
            changed: true,
          }
        }
        prepared = {
          wireSessionId: existing.wireSessionId,
          pin: pinOf(existing.pin),
          created: false,
        }
        return { document, value: undefined, changed: false }
      }
      const span: StoredSpan = {
        harnessSessionId: identity.harnessSessionId,
        spanEpoch: identity.spanEpoch,
        wireSessionId: origin === 'resume' ? trusted ?? randomUUID() : randomUUID(),
        // Only a new span may still take the account's next candidate; a restored one freezes
        // empty here, because the conversation continued without a fact saying what it used.
        pin: origin === 'resume' ? '' : null,
        createdAt: new Date().toISOString(),
      }
      prepared = { wireSessionId: span.wireSessionId, pin: pinOf(span.pin), created: true }
      return {
        document: replaceAccount(document, withSpan(account, identity.accountRef, span, undefined)),
        value: undefined,
        changed: true,
      }
    }, options.deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (prepared === undefined) return continuationUnavailable('the span identity could not be prepared')
    return { kind: 'ready', span: prepared }
  }

  /**
   * The pin in force for one span, without freezing or creating anything.
   * @param identity - the span to look up.
   * @param deadline - the caller's own bound, when it has one.
   * @returns the pin, that no span exists, or why the state cannot be read.
   */
  async pinFor(identity: ClaudeSpanIdentity, deadline?: ContinuationDeadline): Promise<ClaudeSpanPinResult> {
    let result: ClaudeSpanPinResult | undefined
    const outcome = await this.run((document) => {
      const span = findSpan(findAccount(document, identity.accountRef), identity)
      result = span === undefined ? { kind: 'absent' } : { kind: 'pin', pin: pinOf(span.pin) }
      return { document, value: undefined, changed: false }
    }, deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (result === undefined) return continuationUnavailable('the span state could not be read')
    return result
  }

  /**
   * Freeze one span's pin, which is the span's first request.
   *
   * The value comes from this account's own arbitration — the candidate the newest capture
   * committed, or the empty pin when it disclosed nothing usable — so a caller cannot introduce a
   * second candidate by passing a token of its own. A span that already froze keeps its value, so
   * a bootstrap read that lands later cannot change what the span sends. A span whose identity was
   * never committed is refused rather than given an identity the request never declared.
   * @param identity - the span to freeze.
   * @param deadline - the caller's own bound, when it has one.
   * @returns the frozen pin, or the fixed reason nothing may be sent.
   */
  async freeze(identity: ClaudeSpanIdentity, deadline?: ContinuationDeadline): Promise<ClaudeSpanFreezeResult> {
    let result: ClaudeSpanFreezeResult | undefined
    const outcome = await this.run((document) => {
      const account = findAccount(document, identity.accountRef)
      const existing = findSpan(account, identity)
      if (existing === undefined) {
        result = continuationUnavailable('the span identity was not prepared')
        return { document, value: undefined, changed: false }
      }
      if (existing.pin !== null) {
        result = { kind: 'frozen', pin: pinOf(existing.pin) }
        return { document, value: undefined, changed: false }
      }
      const candidate = account?.candidate ?? null
      const stored = candidate !== null && PRINTABLE_PIN.test(candidate) ? candidate : ''
      const span: StoredSpan = { ...existing, pin: stored }
      result = { kind: 'frozen', pin: pinOf(stored) }
      return {
        document: replaceAccount(document, withSpan(account, identity.accountRef, span, existing)),
        value: undefined,
        changed: true,
      }
    }, deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (result === undefined) return continuationUnavailable('the span pin could not be frozen')
    return result
  }

  /**
   * Claim the right to record what one bootstrap read discloses.
   *
   * The attempt is the newest, so an older read that finishes later commits nothing. A ticket is
   * issued only when the claim was durably recorded: a store that cannot be written has no ticket,
   * and a caller can never mistake a failed claim for an owned attempt.
   * @param accountRef - the account the read belongs to.
   * @param deadline - the caller's own bound, when it has one.
   * @returns the ticket a commit needs, or the fixed refusal.
   */
  async beginCapture(accountRef: ClaudeAccountRef, deadline?: ContinuationDeadline): Promise<ClaudeCaptureBeginResult> {
    let result: ClaudeCaptureBeginResult | undefined
    const outcome = await this.run((document) => {
      const account = accountState(findAccount(document, accountRef), accountRef)
      const attempt = account.attempt + 1
      const next: StoredAccount = { ...account, attempt, latest: attempt }
      result = { kind: 'ticket', ticket: { accountRef, generation: next.generation, attempt } }
      return { document: replaceAccount(document, next), value: undefined, changed: true }
    }, deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (result === undefined) return continuationUnavailable('the capture right could not be claimed')
    return result
  }

  /**
   * Record what a successful read disclosed, when the ticket still owns the account.
   * @param ticket - the ticket {@link beginCapture} returned.
   * @param disclosed - the raw value the document carried, if any.
   * @param deadline - the caller's own bound, when it has one.
   * @returns whether the capture became the account's candidate.
   */
  async commitCapture(
    ticket: ClaudeCaptureTicket,
    disclosed: unknown,
    deadline?: ContinuationDeadline,
  ): Promise<ClaudeCaptureCommitResult> {
    const usable = typeof disclosed === 'string' && PRINTABLE_PIN.test(disclosed) ? disclosed : null
    let result: ClaudeCaptureCommitResult | undefined
    const outcome = await this.run((document) => {
      const account = findAccount(document, ticket.accountRef)
      if (account === undefined
        || account.generation !== ticket.generation
        || account.latest !== ticket.attempt
        || account.attempt !== ticket.attempt) {
        // An older capture that finished late owns nothing: the candidate and the frozen spans
        // stay exactly as the newest attempt left them.
        result = { kind: 'refused' }
        return { document, value: undefined, changed: false }
      }
      result = { kind: 'committed' }
      return { document: replaceAccount(document, { ...account, candidate: usable }), value: undefined, changed: true }
    }, deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (result === undefined) return continuationUnavailable('the capture could not be committed')
    return result
  }

  /**
   * Forget everything this installation holds for one account.
   *
   * A generation bump revokes in-flight tickets, and dropping the spans means a later request for
   * the same account starts without the pins and wire identity an older identity froze.
   * @param accountRef - the account whose state is dropped.
   * @param deadline - the caller's own bound, when it has one.
   * @returns that the state was dropped, or the fixed reason it was not.
   */
  async discard(accountRef: ClaudeAccountRef, deadline?: ContinuationDeadline): Promise<ClaudeSpanDiscardResult> {
    let result: ClaudeSpanDiscardResult | undefined
    const outcome = await this.run((document) => {
      const account = findAccount(document, accountRef)
      if (account === undefined) {
        result = { kind: 'discarded' }
        return { document, value: undefined, changed: false }
      }
      const next: StoredAccount = {
        accountRef,
        generation: account.generation + 1,
        attempt: account.attempt,
        latest: null,
        candidate: null,
        spans: [],
      }
      result = { kind: 'discarded' }
      return { document: replaceAccount(document, next), value: undefined, changed: true }
    }, deadline)
    if (outcome.kind === 'unavailable') return outcome
    if (result === undefined) return continuationUnavailable('the span state could not be discarded')
    return result
  }

  /** Stop accepting operations and wait for the ones already owned to settle. */
  async close(): Promise<void> {
    await this.io.close()
  }

  /**
   * Apply one change under the plugin's own lock.
   * @param change - the pure change, given the current document.
   * @param deadline - the caller's own bound, when it has one.
   * @returns the change's value, or the fixed reason it could not be applied.
   */
  private async run<T>(
    change: (document: StoredDocument) => {
      readonly document: StoredDocument
      readonly value: T
      readonly changed: boolean
    },
    deadline?: ContinuationDeadline,
  ): Promise<{ readonly kind: 'ready'; readonly value: T } | ContinuationUnavailable> {
    let pending: { document: StoredDocument; value: T; changed: boolean } | undefined
    let mustWrite = false
    let untrustedReason: string | undefined
    const outcome = await this.io.update((current) => {
      const parsed = parseDocument(current)
      if (parsed.kind === 'untrusted') {
        untrustedReason = parsed.reason
        return undefined
      }
      const applied = change(parsed.document)
      pending = applied
      if (!applied.changed) return undefined
      const text = JSON.stringify(applied.document)
      mustWrite = text !== (current ?? '')
      return text
    }, deadline)
    if (untrustedReason !== undefined) return this.distrust(untrustedReason)
    if (outcome.kind === 'unavailable') return outcome
    if (pending === undefined) return continuationUnavailable('the span state change produced no value')
    if (mustWrite && !outcome.written) return continuationUnavailable('the span state change was not written')
    return { kind: 'ready', value: pending.value }
  }

  /** Remember a document this build cannot trust, and report it once. */
  private distrust(reason: string): ContinuationUnavailable {
    this.damaged = reason
    this.warnOnce(reason)
    return continuationUnavailable(reason)
  }

  private warnOnce(reason: string): void {
    if (this.warned) return
    this.warned = true
    this.options.onWarn?.(`dsh-plugin-subscriptions: ${reason}`)
  }
}
