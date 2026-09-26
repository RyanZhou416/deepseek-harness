/**
 * Translate between the harness message vocabulary and the Anthropic Messages
 * API wire format used by the claude provider: request message assembly, tool
 * schema mapping, and a push-model SSE-event → StreamChunk state machine
 * ({@link AnthropicStreamTranslator}) so tests need no streams.
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../compat.js'
import type {
  ContentBlock,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.js'
import type { ResolvedToolResultBlock, TranslatableMessage } from './resolved.js'

/**
 * The Claude Code identity block. The subscription endpoint rejects requests
 * that do not present as Claude Code, so this block is REQUIRED as the first
 * system entry on every request.
 */
export const CLAUDE_CODE_IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.'

/** Tags wrapping a mid-conversation system message where it sits in the history. */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>'
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * Positions between message breakpoints.
 *
 * A breakpoint looks back at most 20 positions, counting itself as the first,
 * so a write more than 19 positions earlier is invisible. Consecutive
 * `tool_use` blocks count as one position, and so do consecutive
 * `tool_result` blocks. Stepping the full 19 keeps a later turn's lookback
 * on this write for as long as three breakpoints allow.
 */
export const CACHE_POSITION_STRIDE = 19

/**
 * Message breakpoints per request. Anthropic allows four in total and the
 * last `system` block takes the fourth, so three are left for the history.
 */
export const MESSAGE_CACHE_BREAKPOINTS = 3

/** One Anthropic request message. */
export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system'
  content: Record<string, unknown>[]
}

/**
 * Image source. Under the vision limit this is base64; a Files API upload
 * uses the documented `{ type: "file", file_id }` source.
 */
export function anthropicImageSource(part: { mediaType: string; dataBase64: string; fileId?: string }): Record<string, unknown> {
  if (part.fileId !== undefined && part.fileId.length > 0) return { type: 'file', file_id: part.fileId }
  return { type: 'base64', media_type: part.mediaType, data: part.dataBase64 }
}

/** Prompt-caching guide: Fable 5/5.1, Mythos 5/5.1, Opus 4.8, and Opus 5. Not Sonnet 5 or Opus 5.5. */
function midConversationSystem(model: string | undefined): boolean {
  if (model === undefined) return false
  if (model.startsWith('claude-fable-5') || model.startsWith('claude-mythos-5') || model.startsWith('claude-opus-4-8')) return true
  return model === 'claude-opus-5' || (model.startsWith('claude-opus-5-') && !model.startsWith('claude-opus-5-5'))
}

/** Preserve native image blocks, retaining the existing text-only wire shape. */
function toolResultContent(block: ResolvedToolResultBlock): string | Record<string, unknown>[] {
  if (!block.content.some(part => part.type === 'image' && 'dataBase64' in part)) {
    return block.content.map(part => (part.type === 'text' ? part.text : '')).join('')
  }
  const content: Record<string, unknown>[] = []
  for (const part of block.content) {
    if (part.type === 'text' && part.text.length > 0) content.push({ type: 'text', text: part.text })
    if (part.type === 'image' && 'dataBase64' in part) {
      content.push({ type: 'image', source: anthropicImageSource(part) })
    }
  }
  return content
}

/** Parse a tool call's raw JSON arguments into Anthropic's object-shaped `input`. */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    // The model produced malformed JSON; an empty object keeps the request valid.
    return {}
  }
}

/**
 * Move a user message's `tool_result` blocks into one contiguous run at the
 * front, preserving the relative order of both groups.
 *
 * Anthropic answers every `tool_use` against the blocks that *lead* the next
 * message, so a block of any other kind before or between the results reads
 * as a call left unanswered and the request is rejected. The harness merges
 * everything queued for one user turn into a single message, and a parallel
 * tool batch arrives as one result message per call, so any context spliced
 * mid-batch lands between two results. Restoring the run here keeps that
 * independent of delivery order. Order *among* the results does not matter.
 * @param message - one assembled user message, reordered in place.
 */
function leadWithToolResults(message: AnthropicMessage): void {
  const firstOther = message.content.findIndex(block => block.type !== 'tool_result')
  if (firstOther === -1) return
  if (!message.content.slice(firstOther).some(block => block.type === 'tool_result')) return
  message.content = [
    ...message.content.filter(block => block.type === 'tool_result'),
    ...message.content.filter(block => block.type !== 'tool_result'),
  ]
}

/**
 * Index of the first non-system message; `messages.length` when every message
 * is a system one.
 *
 * A system message before the conversation starts is the operator's opening
 * instruction and belongs in the `system` slot. One that arrives later is
 * mid-conversation context, and hoisting it into `system` would move bytes in
 * front of the whole history — invalidating every cached turn behind it — so
 * it stays where it is, as a reminder block in `messages`.
 * @param messages - ordered conversation messages.
 * @returns the boundary index separating the two.
 */
function conversationStart(messages: readonly TranslatableMessage[]): number {
  const index = messages.findIndex(message => message.role !== 'system')
  return index === -1 ? messages.length : index
}

/** Per-block Claude replay metadata stored on the assistant message. */
interface ClaudeThinkingReplay {
  signature?: string
  redacted?: string
}

/**
 * Read thinking signatures captured from an earlier Claude response.
 *
 * The envelope is this adapter's own: another provider's replay state, or a
 * signature minted for a different model, is ignored. Thinking blocks are
 * bound to the model that produced them.
 */
function claudeReplayBlocks(message: TranslatableMessage, model: string | undefined): readonly ClaudeThinkingReplay[] {
  const source = message.source
  if (source?.kind !== 'model' || source.provider !== 'claude') return []
  if (model !== undefined && source.model !== model) return []
  const envelope = source.replayState
  if (typeof envelope !== 'object' || envelope === null) return []
  const record = envelope as { response?: { kind?: unknown; version?: unknown }; blocks?: unknown }
  if (record.response?.kind !== 'claude' || record.response.version !== 1 || !Array.isArray(record.blocks)) return []
  return record.blocks.map((entry): ClaudeThinkingReplay => {
    if (typeof entry !== 'object' || entry === null) return {}
    const raw = entry as Record<string, unknown>
    const signature = typeof raw.signature === 'string' && raw.signature.length > 0 ? raw.signature : undefined
    const redacted = typeof raw.redacted === 'string' && raw.redacted.length > 0 ? raw.redacted : undefined
    return {
      ...signature === undefined ? {} : { signature },
      ...redacted === undefined ? {} : { redacted },
    }
  })
}

/**
 * Convert harness messages into Anthropic messages. Consecutive same-role
 * messages merge into one message with multiple content blocks; tool results
 * arrive as user messages with `tool_result` blocks, which a merged user
 * message keeps in one leading run ({@link leadWithToolResults}); system-role
 * messages before the conversation starts are handled by
 * {@link toAnthropicSystem} and skipped here, while a later one rides in
 * place as a user-role `<system-reminder>` block.
 * Signed thinking blocks are replayed for the same Claude model; unsigned
 * reasoning is omitted because the API rejects a thinking block with no
 * signature. Images must arrive pre-resolved ({@link TranslatableMessage});
 * an unresolved ImageBlock is skipped because its bytes are unreachable here.
 * @param messages - ordered conversation messages with resolved images.
 * @param model - the model this request targets. Thinking signatures are
 *   model-bound, so a signature from another model is not replayed.
 * @returns Anthropic messages in conversation order.
 */
export function toAnthropicMessages(messages: readonly TranslatableMessage[], model?: string): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const start = conversationStart(messages)
  for (const [index, message] of messages.entries()) {
    // A leading system message is an opening instruction; toAnthropicSystem
    // owns those. A later one rides here so the cached prefix ahead of it
    // stays byte-identical.
    if (message.role === 'system' && index < start) continue
    const inHistory = message.role === 'system' && midConversationSystem(model)
    const role = message.role === 'system' && !inHistory ? 'user' : message.role
    const replay = claudeReplayBlocks(message, model)
    const blocks: Record<string, unknown>[] = []
    for (const [blockIndex, block] of message.content.entries()) {
      switch (block.type) {
        case 'text':
          blocks.push({
            type: 'text',
            text: message.role === 'system' && !inHistory
              ? `${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}`
              : block.text,
          })
          break
        case 'tool-call':
          // Anthropic accepts `tool_use` only in assistant messages, and only
          // when a matching `tool_result` follows. A tool call in any other
          // role is replayed narrative — a settled subagent's closing message
          // spliced into the parent as a user-role notice carries the calls it
          // died holding, which no result will ever answer — so it rides as
          // descriptive text instead of a call the API would reject.
          blocks.push(role === 'assistant'
            ? {
                type: 'tool_use',
                id: String(block.id),
                name: block.name,
                input: parseToolInput(block.arguments),
              }
            : { type: 'text', text: `[tool call ${block.name}: ${block.arguments}]` })
          break
        case 'tool-result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: String(block.toolCallId),
            content: toolResultContent(block),
            ...block.isError === true ? { is_error: true } : {},
          })
          break
        case 'image':
          if ('dataBase64' in block) {
            blocks.push({ type: 'image', source: anthropicImageSource(block) })
          }
          // An unresolved ImageBlock carries only an attachment reference; the
          // adapter resolves images before translation, so this is skipped.
          break
        case 'reasoning': {
          const prior = replay[blockIndex]
          if (prior?.redacted !== undefined) {
            blocks.push({ type: 'redacted_thinking', data: prior.redacted })
            break
          }
          if (prior?.signature !== undefined) {
            blocks.push({ type: 'thinking', thinking: block.text, signature: prior.signature })
          }
          // Unsigned reasoning cannot be replayed: the API rejects a thinking
          // block that has no signature.
          break
        }
        default:
          break
      }
    }
    if (blocks.length === 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const message of out) {
    if (message.role === 'user') leadWithToolResults(message)
  }
  return out
}

/**
 * Mark the conversation's cache breakpoints in place.
 *
 * The newest mark is the last block whose prefix the next request can reuse.
 * The other marks sit {@link CACHE_POSITION_STRIDE} positions earlier, so a
 * turn that appends more than the lookback can still see a write this request
 * left behind. Thinking blocks reject `cache_control`, so a mark moves to the
 * nearest earlier block that accepts it.
 * @param messages - assembled Anthropic messages, marked in place.
 */
function acceptsMessageCache(block: Record<string, unknown>): boolean {
  return block.type !== 'thinking' && block.type !== 'redacted_thinking'
}

/** One lookback position. A run of the same tool block type shares one slot, and the mark goes on its last block. */
interface CachePosition {
  block: Record<string, unknown>
  cacheable: boolean
}

function cachePositions(blocks: readonly Record<string, unknown>[]): CachePosition[] {
  const positions: CachePosition[] = []
  for (const block of blocks) {
    const type = block.type
    const previous = positions.at(-1)
    const collapses = previous !== undefined && (
      (type === 'tool_use' && previous.block.type === 'tool_use')
      || (type === 'tool_result' && previous.block.type === 'tool_result')
    )
    if (collapses && previous !== undefined) {
      previous.block = block
      if (acceptsMessageCache(block)) previous.cacheable = true
      continue
    }
    positions.push({ block, cacheable: acceptsMessageCache(block) })
  }
  return positions
}

export function markMessageCache(messages: readonly AnthropicMessage[]): void {
  const positions = cachePositions(messages.flatMap(message => message.content))
  let cursor = positions.length - 1
  for (let mark = 0; mark < MESSAGE_CACHE_BREAKPOINTS && cursor >= 0; mark++) {
    while (cursor >= 0 && !positions[cursor].cacheable) cursor--
    if (cursor < 0) return
    positions[cursor].block.cache_control = { type: 'ephemeral' }
    cursor -= CACHE_POSITION_STRIDE
  }
}

/**
 * Build the Anthropic `system` array: the mandatory Claude Code identity
 * block, then the explicit system prompt, then any system-role messages.
 * @param system - explicit system prompt, when set.
 * @param messages - conversation messages; the system-role text preceding the
 * conversation is appended, and a later one is left to {@link toAnthropicMessages}.
 * @returns the system content blocks.
 */
export function toAnthropicSystem(system?: string, messages?: readonly TranslatableMessage[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }]
  if (system !== undefined && system.length > 0) blocks.push({ type: 'text', text: system })
  const history = messages ?? []
  for (const message of history.slice(0, conversationStart(history))) {
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
  }
  // `tools` renders ahead of `system`, so this one marker caches both. It is
  // deliberately separate from the message marks: a tool_choice or thinking
  // change invalidates the messages tier only, and this entry survives it.
  // `ttl` is omitted, so the breakpoint uses the documented 5-minute default.
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
  return blocks
}

/**
 * Map harness tool schemas to Anthropic tools, in name order.
 *
 * `tools` renders at position 0 of the cached prefix, so any reordering
 * invalidates every cache entry behind it — `system` and the whole
 * conversation included. Registration order belongs to the caller and plugin
 * load order can differ between processes, so the wire order is fixed here
 * instead. Anthropic selects a tool by name; the array order carries nothing.
 * @param tools - tool schemas from the request.
 * @returns Anthropic `tools` array entries, ordered by tool name.
 */
/** Official tool-search tool. Included only when some tool sets `defer_loading`. */
export const CLAUDE_TOOL_SEARCH = {
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex',
} as const

export function toAnthropicTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  const mapped = [...tools]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      ...tool.deferLoading === true ? { defer_loading: true } : {},
    }))
  if (!tools.some(tool => tool.deferLoading === true)) return mapped
  return [CLAUDE_TOOL_SEARCH, ...mapped]
}

function thinkingTokens(usage: AnthropicUsage | undefined): number | undefined {
  const value = usage?.output_tokens_details?.thinking_tokens
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Usage fields this translator reads. `thinking_tokens` requires beta `thinking-token-count-2026-05-13`. */
interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

/** The subset of Anthropic SSE event shapes this translator reads. */
export interface AnthropicStreamEvent {
  type: string
  index?: number
  message?: {
    usage?: AnthropicUsage
  }
  content_block?: {
    type?: string
    id?: string
    name?: string
    /** Opaque payload of a `redacted_thinking` block. Must be replayed verbatim. */
    data?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    /** Cryptographic signature the next request must send back unchanged. */
    signature?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

/** One open harness block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId: string
  name?: string
  /** Concatenated `signature_delta` payload for a thinking block. */
  signature: string
  /** `redacted_thinking.data`, when this block is a redacted thinking block. */
  redacted?: string
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: ToolCallId(block.callId),
        name: block.name ?? '',
        arguments: block.text,
      }
  }
}

/**
 * Classify an Anthropic `error` event into a thrown LlmError.
 * @param error - the wire error object.
 * @returns the mapped error.
 */
export function anthropicFailure(error: { type?: string; message?: string } | undefined): LlmError {
  const type = error?.type ?? 'unknown_error'
  const message = error?.message ?? `Anthropic reported ${type}`
  if (type === 'invalid_request_error' && /prompt is too long/i.test(message)) {
    return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE)
  }
  if (type === 'rate_limit_error') return new LlmError(message, 'RATE_LIMIT')
  if (type === 'authentication_error') return new LlmError(message, 'AUTH')
  return new LlmError(message, 'SERVER')
}

/**
 * Push-model Anthropic SSE translator: feed each parsed event object to
 * {@link push} and collect the emitted harness StreamChunks. Block indexes
 * are allocated in first-seen order; `usage` is emitted before the terminal
 * `finish`, and nothing is emitted after it. `error` events throw
 * {@link LlmError}.
 */
export class AnthropicStreamTranslator {
  private blocks = new Map<number, OpenBlock>()
  /** Replay entries aligned with harness block indexes. */
  private replay: ClaudeThinkingReplay[] = []
  private nextIndex = 0
  private sawAnyBlock = false
  private pendingUsage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | undefined
  private outputTokens: number | undefined
  private stopReason: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
  private usageEmitted = false
  /** Set once `message_stop` produced the terminal finish chunk. */
  terminated = false

  private open(wireIndex: number, kind: OpenBlock['kind'], chunks: StreamChunk[], callId = '', name?: string): OpenBlock {
    const block: OpenBlock = {
      index: this.nextIndex++,
      kind,
      text: '',
      callId,
      signature: '',
      ...name === undefined ? {} : { name },
    }
    this.blocks.set(wireIndex, block)
    this.sawAnyBlock = true
    chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  /** Remember the signature or redacted payload for one closed block. */
  private remember(block: OpenBlock): void {
    const signature = block.signature.length > 0 ? block.signature : undefined
    const redacted = block.redacted !== undefined && block.redacted.length > 0 ? block.redacted : undefined
    this.replay[block.index] = {
      ...signature === undefined ? {} : { signature },
      ...redacted === undefined ? {} : { redacted },
    }
  }

  /**
   * Replay envelope for a successful response that carried thinking the next
   * turn must echo. Omitted when nothing was signed or redacted, so a plain
   * text response stays free of adapter metadata.
   */
  private replayEnvelope(): ReplayEnvelope | undefined {
    let useful = false
    const blocks: ClaudeThinkingReplay[] = []
    for (let index = 0; index < this.nextIndex; index++) {
      const entry = this.replay[index] ?? {}
      if (entry.signature !== undefined || entry.redacted !== undefined) useful = true
      blocks.push(entry)
    }
    if (!useful) return undefined
    return { response: { kind: 'claude', version: 1 }, blocks }
  }

  private emitUsage(chunks: StreamChunk[]): void {
    if (this.usageEmitted) return
    this.usageEmitted = true
    const usage: TokenUsage = {
      inputTokens: this.pendingUsage?.inputTokens ?? 0,
      outputTokens: this.outputTokens ?? 0,
      ...this.pendingUsage?.cacheReadTokens !== undefined
        ? { cacheReadTokens: this.pendingUsage.cacheReadTokens }
        : {},
      ...this.pendingUsage?.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: this.pendingUsage.cacheWriteTokens }
        : {},
      ...this.pendingUsage?.reasoningTokens !== undefined
        ? { reasoningTokens: this.pendingUsage.reasoningTokens }
        : {},
    }
    chunks.push({ type: 'usage', usage })
  }

  /**
   * Process one parsed Anthropic SSE event.
   * @param event - the parsed event object.
   * @returns the StreamChunks this event produced (possibly none).
   */
  push(event: AnthropicStreamEvent): StreamChunk[] {
    if (this.terminated) return []
    const chunks: StreamChunk[] = []
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage
        if (usage !== undefined) {
          const reasoning = thinkingTokens(usage)
          this.pendingUsage = {
            inputTokens: usage.input_tokens ?? 0,
            ...usage.cache_read_input_tokens !== undefined
              ? { cacheReadTokens: usage.cache_read_input_tokens }
              : {},
            ...usage.cache_creation_input_tokens !== undefined
              ? { cacheWriteTokens: usage.cache_creation_input_tokens }
              : {},
            ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
          }
          this.outputTokens = usage.output_tokens ?? this.outputTokens
        }
        return chunks
      }
      case 'content_block_start': {
        const wireIndex = event.index ?? 0
        const block = event.content_block
        switch (block?.type) {
          case 'text':
            this.open(wireIndex, 'text', chunks)
            break
          case 'thinking':
            this.open(wireIndex, 'reasoning', chunks)
            break
          case 'redacted_thinking': {
            const opened = this.open(wireIndex, 'reasoning', chunks)
            if (typeof block.data === 'string' && block.data.length > 0) opened.redacted = block.data
            break
          }
          case 'tool_use': {
            const opened = this.open(wireIndex, 'tool-call', chunks, block.id ?? '', block.name)
            chunks.push({
              type: 'tool-call-delta',
              index: opened.index,
              id: ToolCallId(opened.callId),
              ...block.name === undefined ? {} : { name: block.name },
              argumentsDelta: '',
            })
            break
          }
          default:
            break
        }
        return chunks
      }
      case 'content_block_delta': {
        const wireIndex = event.index ?? 0
        const block = this.blocks.get(wireIndex)
        const delta = event.delta
        if (block === undefined || delta === undefined) return chunks
        switch (delta.type) {
          case 'text_delta':
            block.text += delta.text ?? ''
            chunks.push({ type: 'text-delta', index: block.index, text: delta.text ?? '' })
            break
          case 'thinking_delta':
            block.text += delta.thinking ?? ''
            chunks.push({ type: 'reasoning-delta', index: block.index, text: delta.thinking ?? '' })
            break
          case 'signature_delta':
            block.signature += delta.signature ?? ''
            break
          case 'input_json_delta':
            block.text += delta.partial_json ?? ''
            chunks.push({
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(block.callId),
              ...block.name === undefined ? {} : { name: block.name },
              argumentsDelta: delta.partial_json ?? '',
            })
            break
          default:
            break
        }
        return chunks
      }
      case 'content_block_stop': {
        const wireIndex = event.index ?? 0
        const block = this.blocks.get(wireIndex)
        if (block === undefined) return chunks
        this.blocks.delete(wireIndex)
        this.remember(block)
        chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
        return chunks
      }
      case 'message_delta': {
        if (event.usage?.output_tokens !== undefined) this.outputTokens = event.usage.output_tokens
        const reasoning = thinkingTokens(event.usage)
        if (reasoning !== undefined) {
          this.pendingUsage = {
            inputTokens: this.pendingUsage?.inputTokens ?? 0,
            ...this.pendingUsage,
            reasoningTokens: reasoning,
          }
        }
        switch (event.delta?.stop_reason) {
          case 'end_turn':
          case 'stop_sequence':
            this.stopReason = 'stop'
            break
          case 'tool_use':
            this.stopReason = 'tool-calls'
            break
          case 'max_tokens':
            this.stopReason = 'max-tokens'
            break
          default:
            break
        }
        return chunks
      }
      case 'message_stop': {
        this.terminated = true
        for (const [wireIndex, block] of [...this.blocks]) {
          this.blocks.delete(wireIndex)
          this.remember(block)
          chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
        }
        this.emitUsage(chunks)
        if (this.stopReason === 'stop' && !this.sawAnyBlock) {
          chunks.push({
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            },
          })
        } else {
          const replayState = this.replayEnvelope()
          chunks.push({
            type: 'finish',
            reason: { kind: this.stopReason },
            ...replayState === undefined ? {} : { replayState },
          })
        }
        return chunks
      }
      case 'error':
        throw anthropicFailure(event.error)
      default:
        // ping and future event types carry no harness content.
        return chunks
    }
  }
}

/**
 * Consume an Anthropic SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns the chunk stream; throws when the stream ends before `message_stop`.
 */
export async function* streamAnthropic(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<StreamChunk> {
  const translator = new AnthropicStreamTranslator()
  for await (const sseEvent of parseSse(stream, onActivity)) {
    let event: AnthropicStreamEvent
    try {
      event = JSON.parse(sseEvent.data) as AnthropicStreamEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    yield* translator.push(event)
    if (translator.terminated) return
  }
  throw new LlmError('Anthropic SSE stream ended before message_stop', 'STREAM_CLOSED')
}
