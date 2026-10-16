/**
 * Owner-fenced, in-memory retention of one oversized AetherShell result.
 *
 * A call, a pipeline, or an evaluated program whose complete value does not fit
 * the deployment's result budget is kept here instead of being discarded, and
 * the model receives an opaque id it pages with `aether_result_page`. The value
 * is the interpreter's own already-fidelity-checked JSON: this store never
 * re-runs the program, never replays a command, and never re-reads a stream, so
 * paging a result has no effect beyond reading it.
 *
 * The store holds nothing but plugin process memory. It writes no file, so it
 * needs no cache directory, no permission, and no path — a result can therefore
 * never be half-written, and a retrieval id can never name a location. A result
 * does not outlive the harness process or the plugin fiber that holds it; it is
 * memory, not storage. Ids are host-generated UUIDs carrying
 * {@link AetherResultId}, and every lookup is a map hit or a coded refusal; no
 * model-supplied id ever reaches a path join.
 *
 * Four lifecycle rules hold here, mirroring the persistent-session manager.
 *
 * A result belongs to the exact live Agent whose call produced it. Retention and
 * every later page re-check that the calling object is the live registered Agent
 * for its own id, so a caller cannot page or drop another agent's result, and a
 * result whose owner went away is released with it.
 *
 * One effect per owner, registered on the owner's own context before the value
 * is stored: disposing the agent because its scope unwound, its session ended,
 * or this plugin unloaded releases every result it held.
 *
 * Every bound is a deployment `Config` field. The caps limit the serialized
 * UTF-8 bytes this store holds and the number of results one owner may hold;
 * they are accounting bounds over the encoded value, not a measurement of V8
 * heap, so the process footprint is bounded by the caps times a small constant.
 *
 * Nothing is evicted to make room. A result is released when it expires idle,
 * when its owner drops it, when its owner is disposed, or when the plugin
 * unloads — never silently to admit a newer one, because losing a value the
 * model still holds an id for is the failure this store exists to prevent.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/results
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig } from './config.ts'
import type { AetherFailure, AetherRetainedFacts } from './outcome.ts'
import { isJsonObject } from './outcome.ts'
import { RESULT_LIMIT_CODE } from './limit.ts'

/**
 * Opaque retrieval identity for one retained result.
 *
 * The id is host-generated and resolves only inside the store that minted it, so
 * it carries no process, sequence, or path fact a caller could act on.
 */
export type AetherResultId = Branded<'AetherResultId'>

/**
 * Brand one host-generated retrieval identity.
 * @param value - the opaque value minted for a retained result.
 * @returns the same string with the result-id brand.
 */
export function aetherResultId(value: string): AetherResultId {
  return brandString<AetherResultId>(value)
}

/** Failure code reported when a retrieval id names no retained result. */
export const RESULT_NOT_FOUND_CODE = 'E_RESULT_NOT_FOUND'

/** Failure code reported when a retrieval id belongs to another agent. */
export const RESULT_FOREIGN_CODE = 'E_RESULT_FOREIGN'

/** Failure code reported when retention or retrieval has no usable owner. */
export const RESULT_OWNER_CODE = 'E_RESULT_OWNER'

/** Failure code reported when one element does not fit a page that must hold whole elements. */
export const RESULT_ITEM_TOO_LARGE_CODE = 'E_RESULT_ITEM_TOO_LARGE'

/** Failure code reported when a page argument is not the shape this tool accepts. */
export const RESULT_PAGE_ARG_CODE = 'E_BAD_ARG'

/** How one page addresses the retained value. */
export type AetherResultFormat = 'items' | 'json'

/**
 * The unit a page's `offset`, `shown`, `total`, and `nextOffset` are counted in.
 *
 * `items` is an element or field count, used only when a container is paged by
 * whole elements. `utf8_bytes` is a byte offset into the retained value's
 * canonical JSON encoding, used for every other page so a single element larger
 * than a page can still be fetched in unbroken pieces.
 */
export type AetherResultUnit = 'items' | 'utf8_bytes'

/** One page of a retained result. */
export interface AetherResultPage {
  readonly kind: 'page'
  /** The retrieval id this page came from. */
  readonly id: string
  /** The format this page was produced in. */
  readonly format: AetherResultFormat
  /** The unit `offset`, `shown`, `total`, and `nextOffset` are counted in. */
  readonly unit: AetherResultUnit
  /** Index or byte offset of this page's first unit. */
  readonly offset: number
  /** Units included in this page. */
  readonly shown: number
  /** Units the complete value holds, in `unit`. */
  readonly total: number
  /** `offset` to pass as the next page's `offset`; null once the value is exhausted. */
  readonly nextOffset: number | null
  /** True when this page includes the value's last unit. */
  readonly complete: boolean
  /**
   * This page's content: an array of elements, a record of whole fields, one
   * whole scalar, or an unbroken byte chunk of the canonical JSON encoding —
   * a `String` under a byte unit.
   */
  readonly data: JsonValue
}

/** The receipt for one dropped retained result. */
export interface AetherResultDropped {
  readonly kind: 'dropped'
  readonly id: string
  readonly dropped: true
}

/** One refused page or drop. */
export interface AetherResultFailure {
  readonly kind: 'error'
  readonly error: AetherFailure
}

/** Every canonical result `aether_result_page` returns. */
export type AetherResultPageOutcome = AetherResultPage | AetherResultDropped | AetherResultFailure

/** One stored result's model-facing summary plus the receipt that releases it. */
export interface AetherRetainedValue {
  /** The summary the caller publishes in place of the value. */
  readonly summary: AetherRetainedFacts
  /** Release this result; idempotent, and used when its summary cannot be published. */
  discard(): void
}

/** What one `retain` call decided. */
export type AetherRetainOutcome =
  | { readonly kind: 'stored'; readonly value: AetherRetainedValue }
  | { readonly kind: 'refused'; readonly reason: string }

/** One page request, already validated by the calling tool. */
export interface AetherResultPageRequest {
  /** The retrieval id to page. */
  readonly id: AetherResultId
  /** Index or byte offset to start at; defaults to the beginning. */
  readonly offset?: number
  /** Most units to include; the default is every remaining unit that fits. */
  readonly limit?: number
  /** Most bytes this page may occupy; defaults to the deployment's result budget. */
  readonly maxBytes?: number
  /** Page format; defaults to `items`, which pages containers by whole elements. */
  readonly format?: AetherResultFormat
}

/** Deployment bounds for retained results. */
export interface AetherResultsSettings {
  /** Results one owner may hold at once. */
  readonly maxResultsPerOwner: number
  /** Serialized bytes one owner's retained results may occupy. */
  readonly maxStoredResultBytesPerOwner: number
  /** Serialized bytes every owner's retained results may occupy together. */
  readonly maxStoredResultBytes: number
  /** Release a result unused for this long; `0` disables expiry. */
  readonly resultIdleTimeoutMs: number
}

/** Capability services and plugin-owned state the store reads. */
export interface AetherResultsDependencies {
  /** Resolved deployment configuration, supplying the default page budget. */
  readonly config: ResolvedConfig
  /**
   * The live-agent registry, read lazily on every call. Retention is refused
   * while none is mounted, so a deployment without it keeps the coded limit
   * failure it returned before this store existed instead of advertising an id
   * nothing can resolve.
   */
  readonly registry: () => AgentRegistry | undefined
  /** Exact model-facing text one page renders to, so a page is bounded in both forms. */
  readonly renderPage: (page: AetherResultPage) => string
  /** Receives non-fatal retention diagnostics; never model-facing. */
  readonly report: (message: string) => void
  /** Wall clock; defaults to `Date.now`, so a test can age entries deterministically. */
  readonly now?: () => number
}

/** One retained result and the facts retention is accounted against. */
interface AetherStoredResult {
  readonly owner: Agent
  /** The owned copy of the value; nothing outside this store holds a reference to it. */
  readonly value: JsonValue
  /** Serialized UTF-8 byte length, computed once at retention. */
  readonly bytes: number
  /** Element or field count for a container, else 1. */
  readonly items: number
  /** The unit this value's own shape implies for a default page. */
  readonly unit: AetherResultUnit
  lastUsedAt: number
}

/** How one page addresses a retained value: whole elements, or encoded bytes. */
type AetherPageShape =
  | { readonly kind: 'items'; readonly container: JsonValue[] | Record<string, JsonValue> }
  | { readonly kind: 'bytes'; readonly bytes: Buffer }

/** One coded refusal, in the failure vocabulary every tool already carries. */
function failure(code: string, message: string, hint?: string): AetherResultFailure {
  return {
    kind: 'error',
    error: {
      code,
      message,
      ...hint === undefined ? {} : { hint },
      retryable: false,
    },
  }
}

/**
 * Whether a value pages by whole elements rather than by encoded bytes.
 * @param value - any decoded interpreter value.
 * @returns true for an array or a JSON object.
 */
function isContainer(value: JsonValue): value is JsonValue[] | Record<string, JsonValue> {
  return Array.isArray(value) || isJsonObject(value)
}

/** Element or field count for a container, else 1. */
function unitCount(value: JsonValue): number {
  if (Array.isArray(value)) return value.length
  if (isJsonObject(value)) return Object.keys(value).length
  return 1
}

/** Whether a byte offset starts a UTF-8 character rather than continuing one. */
function isCharacterBoundary(bytes: Buffer, offset: number): boolean {
  if (offset <= 0 || offset >= bytes.length) return true
  return (bytes.readUInt8(offset) & 0b1100_0000) !== 0b1000_0000
}

/** The first character boundary at or after one byte offset. */
function boundaryAtOrAfter(bytes: Buffer, offset: number): number {
  let at = Math.min(offset, bytes.length)
  while (at < bytes.length && !isCharacterBoundary(bytes, at)) at += 1
  return at
}

/**
 * Resolve how one retained value is addressed under a requested format.
 * @param value - the retained value.
 * @param format - the requested page format.
 * @returns whole elements for a container under `items`, encoded bytes otherwise.
 */
function pageShape(value: JsonValue, format: AetherResultFormat): AetherPageShape {
  if (format === 'json' || !isContainer(value)) {
    return { kind: 'bytes', bytes: Buffer.from(JSON.stringify(value), 'utf8') }
  }
  return { kind: 'items', container: value }
}

/** One page of whole array elements or whole record fields. */
function itemPage(
  container: JsonValue[] | Record<string, JsonValue>,
  id: AetherResultId,
  start: number,
  shown: number,
  total: number,
): AetherResultPage {
  const data: JsonValue = Array.isArray(container)
    ? container.slice(start, start + shown)
    : Object.fromEntries(Object.entries(container).slice(start, start + shown))
  return {
    kind: 'page',
    id,
    format: 'items',
    unit: 'items',
    offset: start,
    shown,
    total,
    nextOffset: start + shown < total ? start + shown : null,
    complete: start + shown >= total,
    data,
  }
}

/** One unbroken byte page of the retained value's canonical JSON encoding. */
function bytePage(
  id: AetherResultId,
  format: AetherResultFormat,
  bytes: Buffer,
  start: number,
  shown: number,
): AetherResultPage {
  return {
    kind: 'page',
    id,
    format,
    unit: 'utf8_bytes',
    offset: start,
    shown,
    total: bytes.length,
    nextOffset: start + shown < bytes.length ? start + shown : null,
    complete: start + shown >= bytes.length,
    data: bytes.subarray(start, start + shown).toString('utf8'),
  }
}

/**
 * Owns every retained result this plugin's tools hand out.
 *
 * The store is the single owner of retrieval identity, ownership, accounting,
 * idle expiry, and teardown. It registers no tool of its own: the caller
 * registers the retrieval tool and disposes this store from the plugin fiber, so
 * removal order stays the caller's decision.
 */
export class AetherResults {
  private readonly byId = new Map<AetherResultId, AetherStoredResult>()
  private readonly ownerEffects = new Map<Agent, () => void>()
  /** Owners whose scope already unwound; nothing can be tied to them again. */
  private readonly disposedOwners = new WeakSet<Agent>()
  private expiryTimer: NodeJS.Timeout | undefined
  /** Serialized bytes every owner holds together. */
  private heldBytes = 0
  private disposed = false
  private readonly now: () => number

  /**
   * @param dependencies - the resolved configuration, the live-agent registry lookup, the page renderer, and the diagnostic sink.
   * @param settings - the deployment's retention bounds.
   */
  constructor(
    private readonly dependencies: AetherResultsDependencies,
    private readonly settings: AetherResultsSettings,
  ) {
    this.now = dependencies.now ?? Date.now
  }

  /**
   * Retain one oversized value for one owner.
   *
   * The value is copied into storage by decoding the serialization this call
   * already produced, so the entry owns a private graph and a later mutation of
   * whatever the caller held cannot change what a page returns. Every refusal is
   * a diagnostic and an absent value, never a stored one: the caller then falls
   * back to the coded limit failure it returned before this store existed.
   * @param owner - the calling agent, which must be the live registered Agent for its own id.
   * @param value - the complete JSON value the interpreter produced.
   * @param resultType - the interpreter's own result type name, when it named one.
   * @returns the stored summary, or the reason retention was refused.
   */
  retain(owner: Agent, value: JsonValue, resultType: string | undefined): AetherRetainOutcome {
    // A store that has been disposed must not accept a value: nothing could
    // resolve it afterwards, which is exactly the unreachable id this store
    // exists to prevent. No diagnostic is reported on this path because the
    // plugin's own logging may already be unwound.
    if (this.disposed) return { kind: 'refused', reason: 'the plugin unloaded, so no result can be retained' }
    const ownerFailure = this.ownerFailure(owner)
    if (ownerFailure !== undefined) return this.refused(owner, ownerFailure.message)
    this.sweep()
    const encoded = JSON.stringify(value)
    const bytes = Buffer.byteLength(encoded, 'utf8')
    const reason = this.capacityReason(owner, bytes)
    if (reason !== undefined) return this.refused(owner, reason)
    // Registered before the value is visible: a scope that already unwound must
    // refuse the value rather than hold it under a lifetime nobody owns.
    if (!this.registerOwnerEffect(owner)) {
      return this.refused(owner, 'the calling agent\'s scope is already disposed, so no result lifetime can be tied to it')
    }
    const id = aetherResultId(randomUUID())
    // Decoding the serialization is the copy: it is exactly the JSON graph that
    // was measured, and it is what makes this entry independent of the caller's
    // value. Every number here already passed the exact-number check upstream.
    const stored: AetherStoredResult = {
      owner,
      value: JSON.parse(encoded),
      bytes,
      items: unitCount(value),
      unit: isContainer(value) ? 'items' : 'utf8_bytes',
      lastUsedAt: this.now(),
    }
    this.byId.set(id, stored)
    this.heldBytes += bytes
    this.armExpiry()
    const summary: AetherRetainedFacts = {
      id,
      ...resultType === undefined ? {} : { originalResultType: resultType },
      bytes,
      total: stored.unit === 'items' ? stored.items : stored.bytes,
      unit: stored.unit,
      complete: true,
      inline: false,
    }
    return {
      kind: 'stored',
      value: {
        summary,
        discard: () => { this.remove(id) },
      },
    }
  }

  /**
   * Produce one page of an owner's retained result.
   *
   * A page is bounded in both forms the tool returns it in — its canonical value
   * and its rendered text — against `maxBytes`, and the largest page that fits is
   * found by a bounded bisection rather than by a fixed element count. Whole
   * elements are never split, and a byte page never splits a UTF-8 character, so
   * concatenating the pages of one result always reconstructs it exactly.
   * @param owner - the calling agent.
   * @param request - the validated retrieval id, offset, limit, budget, and format.
   * @returns the page, or a coded refusal naming the correction.
   */
  page(owner: Agent, request: AetherResultPageRequest): AetherResultPageOutcome {
    if (this.disposed) {
      return failure(RESULT_OWNER_CODE, 'the plugin unloaded, so no retained result can be read')
    }
    const ownerFailure = this.ownerFailure(owner)
    if (ownerFailure !== undefined) return { kind: 'error', error: ownerFailure }
    this.sweep()
    const entry = this.byId.get(request.id)
    if (entry === undefined) return this.notFound(request.id)
    if (entry.owner !== owner) return this.foreign(request.id)
    entry.lastUsedAt = this.now()
    this.armExpiry()
    return this.buildPage(entry, request)
  }

  /**
   * Release one owned retained result.
   * @param owner - the calling agent.
   * @param id - the retrieval id the caller explicitly dropped.
   * @returns the drop receipt, or a coded refusal.
   */
  drop(owner: Agent, id: AetherResultId): AetherResultPageOutcome {
    if (this.disposed) {
      return failure(RESULT_OWNER_CODE, 'the plugin unloaded, so no retained result can be dropped')
    }
    const ownerFailure = this.ownerFailure(owner)
    if (ownerFailure !== undefined) return { kind: 'error', error: ownerFailure }
    this.sweep()
    const entry = this.byId.get(id)
    if (entry === undefined) return this.notFound(id)
    if (entry.owner !== owner) return this.foreign(id)
    this.remove(id)
    return { kind: 'dropped', id, dropped: true }
  }

  /**
   * Release every retained result and remove every owner registration.
   *
   * Registered as a plugin effect, so an unload releases each value rather than
   * leaving an id that resolves to a store nothing owns.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = undefined
    }
    this.byId.clear()
    this.heldBytes = 0
    const effects = [...this.ownerEffects.values()]
    this.ownerEffects.clear()
    for (const dispose of effects) dispose()
  }

  /** Record one refused retention and hand the reason back. */
  private refused(owner: Agent, reason: string): AetherRetainOutcome {
    this.dependencies.report(`aether-shell: the result for agent ${JSON.stringify(owner.id)} was not retained: ${reason}`)
    return { kind: 'refused', reason }
  }

  /** Release every result one owner holds. */
  private releaseOwnedBy(owner: Agent): void {
    for (const [id, entry] of [...this.byId]) {
      if (entry.owner === owner) this.remove(id)
    }
  }

  /** Remove one entry and its accounting, if it is still held. */
  private remove(id: AetherResultId): void {
    const entry = this.byId.get(id)
    if (entry === undefined) return
    this.byId.delete(id)
    this.heldBytes -= entry.bytes
  }

  /** The refusal for a retrieval id nothing holds. */
  private notFound(id: AetherResultId): AetherResultFailure {
    return failure(
      RESULT_NOT_FOUND_CODE,
      `no retained result ${JSON.stringify(id)} is available to this agent`,
      'a retained result is resolvable only while it is held: it is released when it expires, when its owner drops it, or when this plugin unloads. Re-run the call that produced it and page the id it returns.',
    )
  }

  /** The refusal for a retrieval id another agent holds. */
  private foreign(id: AetherResultId): AetherResultFailure {
    return failure(
      RESULT_FOREIGN_CODE,
      `retained result ${JSON.stringify(id)} belongs to another agent`,
      'only the agent whose call produced a retained result may page or drop it.',
    )
  }

  /**
   * Why this owner may not retain one more value of this size, if it may not.
   * @param owner - the calling agent.
   * @param bytes - the serialized size of the value about to be retained.
   * @returns the refusal reason, or undefined when the value fits every bound.
   */
  private capacityReason(owner: Agent, bytes: number): string | undefined {
    const { maxResultsPerOwner, maxStoredResultBytesPerOwner, maxStoredResultBytes } = this.settings
    const held = this.heldByOwner(owner)
    if (held.count >= maxResultsPerOwner) {
      return `this agent already holds ${held.count} retained results, the maxResultsPerOwner limit of ${maxResultsPerOwner}`
    }
    if (bytes > maxStoredResultBytesPerOwner) {
      return `the result is ${bytes} bytes, over the ${maxStoredResultBytesPerOwner}-byte maxStoredResultBytesPerOwner limit`
    }
    if (held.bytes + bytes > maxStoredResultBytesPerOwner) {
      return `this agent's retained results would occupy ${held.bytes + bytes} bytes, over the ${maxStoredResultBytesPerOwner}-byte maxStoredResultBytesPerOwner limit`
    }
    if (this.heldBytes + bytes > maxStoredResultBytes) {
      return `retaining this ${bytes}-byte result would hold ${this.heldBytes + bytes} bytes, over the ${maxStoredResultBytes}-byte maxStoredResultBytes limit shared by every agent`
    }
    return undefined
  }

  /** How many results one owner holds and how many serialized bytes they occupy. */
  private heldByOwner(owner: Agent): { count: number; bytes: number } {
    let count = 0
    let bytes = 0
    for (const entry of this.byId.values()) {
      if (entry.owner !== owner) continue
      count += 1
      bytes += entry.bytes
    }
    return { count, bytes }
  }

  /**
   * Reject a caller that is not the exact live registered Agent for its own id.
   * @param owner - the agent that produced or holds the result.
   * @returns the refusal, or undefined when the owner is exactly the live agent.
   */
  private ownerFailure(owner: Agent): AetherFailure | undefined {
    const registered = this.dependencies.registry()?.get(owner.id)
    if (registered === undefined) {
      return {
        code: RESULT_OWNER_CODE,
        message: `agent ${JSON.stringify(owner.id)} is not a live registered agent, so no result lifetime can be tied to it`,
        hint: 'retained results need the deployment\'s live-agent registry; without it an oversized result keeps the coded limit failure it returned before retention existed.',
        retryable: false,
      }
    }
    if (registered !== owner) {
      return {
        code: RESULT_OWNER_CODE,
        message: `the calling object is not the live agent registered for ${JSON.stringify(owner.id)}`,
        hint: 'a retained result belongs to the exact live Agent that produced it.',
        retryable: false,
      }
    }
    if (this.disposedOwners.has(owner)) {
      return {
        code: RESULT_OWNER_CODE,
        message: 'the calling agent\'s scope is already disposed, so no result lifetime can be tied to it',
        hint: 'retained results are released with the agent that owns them.',
        retryable: false,
      }
    }
    return undefined
  }

  /**
   * Tie every result of one owner to that owner's lifetime.
   *
   * One effect per owner, not per result: its disposer releases all of the
   * owner's values, the registration is dropped when the owner unwinds, and an
   * owner whose scope already unwound is marked so nothing can be tied to it
   * later.
   * @param owner - the agent that produced the retained value.
   * @returns false when the owner's scope is already disposed, so retention must be refused.
   */
  private registerOwnerEffect(owner: Agent): boolean {
    if (this.ownerEffects.has(owner)) return true
    if (this.disposedOwners.has(owner)) return false
    try {
      const dispose = owner.ctx.effect(() => () => {
        this.ownerEffects.delete(owner)
        this.disposedOwners.add(owner)
        this.releaseOwnedBy(owner)
      }, 'aether-shell.results.owner')
      this.ownerEffects.set(owner, dispose)
      return true
    } catch {
      // A scope that unwound between the ownership check and this registration
      // cannot own the value, so the caller reports the refusal instead of
      // storing a value under a lifetime nothing holds.
      this.disposedOwners.add(owner)
      return false
    }
  }

  /** Release every result unused past the configured limit. */
  private sweep(): void {
    const idleMs = this.settings.resultIdleTimeoutMs
    if (idleMs <= 0) return
    const now = this.now()
    for (const [id, entry] of [...this.byId]) {
      if (now - entry.lastUsedAt < idleMs) continue
      this.remove(id)
    }
  }

  /** Arm the single expiry timer at the earliest deadline any held result carries. */
  private armExpiry(): void {
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = undefined
    }
    const idleMs = this.settings.resultIdleTimeoutMs
    if (this.disposed || idleMs <= 0 || this.byId.size === 0) return
    let earliest: number | undefined
    for (const entry of this.byId.values()) {
      const at = entry.lastUsedAt + idleMs
      if (earliest === undefined || at < earliest) earliest = at
    }
    if (earliest === undefined) return
    const delay = Math.min(Math.max(0, earliest - this.now()), MAX_TIMER_DELAY_MS)
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      this.sweep()
      this.armExpiry()
    }, delay)
    this.expiryTimer.unref()
  }

  /**
   * Build one bounded page, or the refusal that names why no page could be built.
   * @param entry - the stored value being paged.
   * @param request - the validated page request.
   * @returns the page, or a coded refusal.
   */
  private buildPage(entry: AetherStoredResult, request: AetherResultPageRequest): AetherResultPageOutcome {
    const format = isContainer(entry.value) ? request.format ?? 'items' : 'json'
    const shape = pageShape(entry.value, format)
    const total = shape.kind === 'items'
      ? (Array.isArray(shape.container) ? shape.container.length : Object.keys(shape.container).length)
      : shape.bytes.length
    const unit: AetherResultUnit = shape.kind === 'items' ? 'items' : 'utf8_bytes'
    const maxBytes = request.maxBytes ?? this.dependencies.config.maxResultBytes
    const start = request.offset ?? 0
    if (!Number.isSafeInteger(start) || start < 0) {
      return failure(RESULT_PAGE_ARG_CODE, `offset must be a non-negative integer, got ${JSON.stringify(request.offset)}`)
    }
    if (start > total) {
      return failure(RESULT_PAGE_ARG_CODE, `offset ${start} is past the end of this result (${total} ${unit})`)
    }
    if (shape.kind === 'bytes' && !isCharacterBoundary(shape.bytes, start)) {
      return failure(
        RESULT_PAGE_ARG_CODE,
        `offset ${start} lands inside a UTF-8 character, so a byte page from there would not reconstruct the text`,
        'pass back a nextOffset from a previous page instead of computing an offset yourself.',
      )
    }
    const remaining = total - start
    const wanted = request.limit === undefined ? remaining : Math.min(request.limit, remaining)
    const build = (shown: number): AetherResultPage => shape.kind === 'items'
      ? itemPage(shape.container, request.id, start, shown, total)
      : bytePage(request.id, format, shape.bytes, start, shown)
    const fits = (shown: number): boolean => {
      const page = build(shown)
      return Math.max(
        Buffer.byteLength(JSON.stringify(page), 'utf8'),
        Buffer.byteLength(this.dependencies.renderPage(page), 'utf8'),
      ) <= maxBytes
    }
    if (!fits(0)) {
      return failure(
        RESULT_LIMIT_CODE,
        `one page of retained result ${JSON.stringify(request.id)} does not fit the ${maxBytes}-byte page budget even with no content`,
        'raise this deployment\'s maxResultBytes, or raise maxBytes up to that budget.',
      )
    }
    if (wanted === 0) return build(0)
    // A page grows with the count it carries, so the largest count that fits is
    // found by bisection over the requested range; a byte page snaps each
    // candidate up to a character boundary before measuring it.
    let low = 0
    let high = wanted
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = shape.kind === 'items'
        ? middle
        : boundaryAtOrAfter(shape.bytes, start + middle) - start
      if (candidate <= high && fits(candidate)) low = candidate
      else high = middle - 1
    }
    if (low === 0 && shape.kind === 'bytes' && boundaryAtOrAfter(shape.bytes, start + 1) - start > wanted) {
      return failure(RESULT_PAGE_ARG_CODE, `limit ${wanted} is too small to include the next UTF-8 character`, 'increase limit or omit it; a page cannot split a character.')
    }
    if (low === 0) {
      return shape.kind === 'items'
        ? failure(
          RESULT_ITEM_TOO_LARGE_CODE,
          `no single element of retained result ${JSON.stringify(request.id)} fits the ${maxBytes}-byte page budget`,
          'page this result with format "json" instead: it splits the canonical JSON encoding by UTF-8 byte offset, so one element larger than a page can still be read in unbroken pieces.',
        )
        : failure(
          RESULT_LIMIT_CODE,
          `no byte of retained result ${JSON.stringify(request.id)} fits the ${maxBytes}-byte page budget`,
          'raise this deployment\'s maxResultBytes, or raise maxBytes up to that budget.',
        )
    }
    return build(low)
  }
}
