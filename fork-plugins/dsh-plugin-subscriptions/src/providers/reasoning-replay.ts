/**
 * Adapter-memory replay of a Responses model's completed reasoning.
 *
 * A reasoning model continuing past a tool call must get its reasoning back,
 * or it restarts from scratch on every tool round trip. A Responses reasoning
 * item cannot ride back in its text form: the provider expects the COMPLETED
 * item — its id, summary, and the ENCRYPTED payload — and the encrypted
 * payload only arrives when the request asked for it. dsh-llm's reasoning
 * ContentBlock is a closed shape that cannot carry those items through the
 * harness, so the codex and copilot adapters capture them off the response
 * stream and replay them on the next request of the same conversation.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ReasoningReplayItem, ResponsesStreamEvent } from '../translate/responses.js'

/**
 * The replayable form of one completed reasoning item: the COMPLETE item as
 * the gateway delivered it on `response.output_item.done` — its ORIGINAL id
 * (captured before any adapter rewrite), summary parts, status, and the
 * encrypted payload. A reasoning item's `id` and `summary` are not optional
 * in the Responses input schema, so an item missing its id or its blob is
 * not replayable and degrades to the no-replay path instead of risking an
 * invalid input item.
 * @param item - the `item` payload of one `response.output_item.done` event.
 * @returns the replayable item, or undefined when the payload cannot be replayed.
 */
export function completedReasoningItem(
  item: NonNullable<ResponsesStreamEvent['item']>,
): ReasoningReplayItem | undefined {
  if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0) return undefined
  if (typeof item.id !== 'string' || item.id.length === 0) return undefined
  return {
    type: 'reasoning',
    id: item.id,
    ...Array.isArray(item.summary) ? { summary: item.summary } : {},
    ...typeof item.status === 'string' && item.status.length > 0 ? { status: item.status } : {},
    encrypted_content: item.encrypted_content,
  }
}

/**
 * Collects one response's function-call ids and completed reasoning items.
 * Both sides are needed to build a replay bundle: items are replayed ahead of
 * the function_call whose call id they belong to, so a response that produced
 * only one of them has nothing to replay.
 */
export class ReasoningCapture {
  private callIds: string[] = []
  private items: ReasoningReplayItem[] = []

  /**
   * @param onCaptured - fired at each `response.completed` that produced BOTH
   *   function calls and completed reasoning items, receiving the response's
   *   call ids and replayable reasoning items so the adapter can replay them
   *   on the next request.
   */
  constructor(private readonly onCaptured?: (callIds: string[], items: ReasoningReplayItem[]) => void) {}

  /**
   * Record one parsed event as it arrived off the wire, before any adapter
   * rewrite: a replay bundle must carry the gateway's own call and item ids.
   * @param event - the event as parsed off the wire.
   */
  push(event: ResponsesStreamEvent): void {
    if (event.type === 'response.output_item.added') {
      const item = event.item
      if (item?.type === 'function_call' && typeof item.call_id === 'string' && item.call_id.length > 0) {
        this.callIds.push(item.call_id)
      }
      return
    }
    if (event.type === 'response.output_item.done') {
      const item = event.item
      if (item?.type === 'reasoning') {
        const captured = completedReasoningItem(item)
        if (captured !== undefined) this.items.push(captured)
      }
      return
    }
    if (event.type === 'response.completed') {
      // Both sides present is the only replayable response; clear either way —
      // one SSE stream may carry multiple responses.
      if (this.callIds.length > 0 && this.items.length > 0) {
        this.onCaptured?.(this.callIds, this.items)
      }
      this.callIds = []
      this.items = []
    }
  }
}

/** One captured replay bundle: a response's completed reasoning items. */
interface ReasoningReplayEntry {
  /** Completed reasoning items in output order, replayed ahead of the response's first function call. */
  items: ReasoningReplayItem[]
  /** Capture time (epoch ms); entries older than the TTL answer as misses. */
  at: number
}

/**
 * The replay scope isolating one ACCOUNT × CONVERSATION × MODEL. The account
 * identity is the session's long-lived credential identity (Copilot's GitHub
 * token, Codex's ChatGPT account id — both stable across access-token
 * refreshes and different per login); the conversation is the loop-stamped
 * `sessionId`, falling back to the first message's id when a hand-built
 * request carries no session stamp; the model separates wire families. A call
 * id captured in one scope is invisible to every other scope, so reused ids
 * cannot leak reasoning across accounts, conversations, or models.
 * @param accountKey - the session's long-lived account identity.
 * @param options - the harness generate options identifying conversation and model.
 * @returns the replay scope key.
 */
export function reasoningReplayScope(accountKey: string, options: GenerateOptions): string {
  const conversation = options.sessionId !== undefined
    ? `session:${String(options.sessionId)}`
    : options.messages[0] !== undefined
      ? `anchor:${String(options.messages[0].id)}`
      : 'conversation:none'
  return `${accountKey}\u0000${conversation}\u0000${options.model}`
}

/**
 * Per-adapter capture store for completed reasoning items, keyed by replay
 * scope and then by the call ids of the response that produced them. Entries
 * are namespaced per ACCOUNT × CONVERSATION × MODEL, idle out via a sliding
 * TTL, and the whole store is dropped on auth transitions, so replay degrades
 * to the no-replay behavior instead of leaking across contexts.
 */
export class ReasoningReplayStore {
  private readonly byScope = new Map<string, Map<string, ReasoningReplayEntry>>()
  /** Call-id entries kept per scope. */
  private static readonly CALL_LIMIT = 64
  /** Conversation scopes kept at once; bounds memory when many sessions interleave. */
  private static readonly SCOPE_LIMIT = 32
  /** How long a captured entry stays replayable; tool round trips take minutes, not hours. */
  private static readonly TTL_MS = 30 * 60_000

  /**
   * Store one response's completed reasoning items behind every call id it
   * produced, inside one replay scope. Retention: a CONSUMED entry is kept —
   * every later round of the same conversation replays ALL its earlier
   * function_calls — until it idles out of the TTL (see {@link replayFor})
   * or the per-scope entry cap evicts it oldest-first. All calls of one
   * response share ONE entry object: `toResponsesInput` dedupes replays by
   * array reference, so parallel calls replay the items once instead of once
   * per call.
   * @param scope - the replay scope from {@link reasoningReplayScope}.
   * @param callIds - the response's function-call ids.
   * @param items - the response's completed reasoning items, in output order.
   */
  capture(scope: string, callIds: readonly string[], items: readonly ReasoningReplayItem[]): void {
    let entries = this.byScope.get(scope)
    if (entries === undefined) {
      entries = new Map<string, ReasoningReplayEntry>()
      this.byScope.set(scope, entries)
    } else {
      // Refresh the scope's recency so an active conversation is never the
      // scope-cap eviction victim.
      this.byScope.delete(scope)
      this.byScope.set(scope, entries)
    }
    const now = Date.now()
    for (const [callId, entry] of entries) {
      if (now - entry.at >= ReasoningReplayStore.TTL_MS) entries.delete(callId)
    }
    const entry: ReasoningReplayEntry = { items: [...items], at: now }
    for (const callId of callIds) entries.set(callId, entry)
    // Blobs reach tens of kilobytes; cap the ENTRY count and evict the oldest
    // by insertion order rather than tracking bytes — eviction merely degrades
    // ancient calls to the no-replay behavior.
    while (entries.size > ReasoningReplayStore.CALL_LIMIT) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    while (this.byScope.size > ReasoningReplayStore.SCOPE_LIMIT) {
      const oldest = this.byScope.keys().next().value
      if (oldest === undefined) break
      this.byScope.delete(oldest)
    }
  }

  /**
   * The replay items for one call id in one scope, when still fresh. The TTL
   * bounds IDLE time, not total age: a hit refreshes the entry (and its
   * eviction recency), so an ongoing conversation keeps its chain alive
   * while a conversation that stopped asking forgets within the TTL. An
   * absent or aged-out entry answers `undefined` — the no-replay
   * degradation, never an error.
   * @param scope - the replay scope from {@link reasoningReplayScope}.
   * @param callId - the function-call id being replayed.
   * @returns the captured items, or undefined when nothing replayable is held.
   */
  replayFor(scope: string, callId: string): readonly ReasoningReplayItem[] | undefined {
    const entries = this.byScope.get(scope)
    const entry = entries?.get(callId)
    if (entries === undefined || entry === undefined) return undefined
    const now = Date.now()
    if (now - entry.at >= ReasoningReplayStore.TTL_MS) return undefined
    entry.at = now
    entries.delete(callId)
    entries.set(callId, entry)
    this.byScope.delete(scope)
    this.byScope.set(scope, entries)
    return entry.items
  }

  /**
   * Drop every captured replay entry. Lookup correctness never depends on
   * the call — the scope already carries the account identity — but the host
   * wiring invokes this on every auth transition (login, logout, credential
   * death) so a switched account's memory never holds the previous account's
   * encrypted reasoning at all; conversation teardown is bounded by the TTL
   * and the caps.
   */
  clear(): void {
    this.byScope.clear()
  }
}
