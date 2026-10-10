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

// The finish-reason map is merge-extensible so an adapter can surface a provider's own
// reasons. A refusal is one: the model answered, declined, and stopped, which a caller
// must be able to tell apart from a turn that completed.
declare module '@deepseek-ai/dsh-llm' {
  interface FinishReasonMap {
    'refusal': { kind: 'refusal' }
  }
}
import type {
  ContentBlock,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type {
  JsonValue,
  MessageContent,
  TextBlock,
  ToolDefinition as ClaudeToolDefinition,
  ToolResultBlock,
} from '@tormentalabs/claude-code-wire-compat'

/**
 * Block types the public package surface derives but does not name directly.
 * Each alias extracts from an exported union so the shapes cannot drift.
 */
type WireBlock = Exclude<MessageContent, string>[number]
type WireImageBlock = Extract<WireBlock, { type: 'image' }>
type WireResultBlock = Extract<NonNullable<ToolResultBlock['content']>, readonly unknown[]>[number]
type WireSchemaTool = Extract<ClaudeToolDefinition, { input_schema: unknown }>
type WireBase64MediaType = Extract<WireImageBlock['source'], { type: 'base64' }>['media_type']
import { parseSse } from './sse.js'
import type { ResolvedToolResultBlock, TranslatableMessage } from './resolved.js'

/**
 * Tags wrapping a mid-conversation system message where it sits in the history.
 */
export // The genuine client substitutes this when stripping blank text leaves a message empty.
const NO_CONTENT_TEXT = '(no content)'
const SYSTEM_REMINDER_OPEN = '<system-reminder>'
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * The genuine client's own text for the `tool_result` it synthesizes when a
 * `tool_use` in the request has no result to answer it.
 */
export const MISSING_TOOL_RESULT_TEXT = '[Tool result missing due to internal error]'

/**
 * One Anthropic request message. The Claude Code identity and billing blocks
 * are emitted by the wire builder, never here.
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system'
  /**
   * A mid-conversation system message carries its text as a plain string, which is what
   * the genuine client sends; every other message carries blocks.
   */
  content: WireBlock[] | string
  /** Clears a mid-conversation system message once the next user message arrives. */
  clear_at?: 'next_user_message'
}

/**
 * Image source. Under the vision limit this is base64; a Files API upload
 * uses the documented `{ type: "file", file_id }` source.
 */
export function anthropicImageSource(part: { mediaType: string; dataBase64: string; fileId?: string }): WireImageBlock['source'] {
  if (part.fileId !== undefined && part.fileId.length > 0) return { type: 'file', file_id: part.fileId }
  // The attachment service verifies the MIME type; the wire validator narrows
  // it to the four image media types the API accepts.
  return { type: 'base64', media_type: part.mediaType as WireBase64MediaType, data: part.dataBase64 }
}

/** Preserve native image blocks, retaining the existing text-only wire shape. */
function toolResultContent(block: ResolvedToolResultBlock): string | WireResultBlock[] {
  if (!block.content.some(part => part.type === 'image' && 'dataBase64' in part)) {
    return block.content.map(part => (part.type === 'text' ? part.text : '')).join('')
  }
  const content: WireResultBlock[] = []
  for (const part of block.content) {
    if (part.type === 'text' && part.text.length > 0) content.push({ type: 'text', text: part.text })
    if (part.type === 'image' && 'dataBase64' in part) {
      content.push({ type: 'image', source: anthropicImageSource(part) })
    }
  }
  return content
}

/** Parse a tool call's raw JSON arguments into Anthropic's object-shaped `input`. */
function parseToolInput(raw: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // JSON.parse yields JSON by construction; the cast narrows the parse boundary.
      return parsed as JsonValue
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
  // A mid-conversation system message carries its text as a string, so it has nothing
  // to reorder; every other message reaching here carries blocks.
  if (!Array.isArray(message.content)) return
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
 * One server-tool block an earlier response captured, with the position it must
 * be re-emitted at.
 */
interface ClaudeServerReplay {
  /**
   * Harness-visible blocks already open when the block arrived: it is re-emitted
   * ahead of the harness block at this index.
   */
  index: number
  /** The response block, replayed unchanged. */
  block: unknown
}

/** Replay state recovered from one Claude assistant message. */
interface ClaudeReplay {
  /** One entry per harness block, aligned with the message's own blocks. */
  blocks: readonly ClaudeThinkingReplay[]
  /** Server-tool blocks to splice back in, in arrival order. */
  serverBlocks: readonly ClaudeServerReplay[]
}

/** Nothing to replay: another provider's message, another model, or no envelope. */
const NO_CLAUDE_REPLAY: ClaudeReplay = { blocks: [], serverBlocks: [] }

/**
 * The block types captured for replay. Nothing else recorded in the envelope is
 * sent back: an unrecognized payload has no defined place in a request.
 */
const SERVER_BLOCK_TYPES: ReadonlySet<string> = new Set(['server_tool_use', 'tool_search_tool_result'])

/**
 * Read the replay state captured from an earlier Claude response.
 *
 * The envelope is this adapter's own: another provider's replay state, or a
 * signature minted for a different model, is ignored. Thinking blocks are
 * bound to the model that produced them.
 */
function claudeReplayBlocks(message: TranslatableMessage, model: string | undefined): ClaudeReplay {
  const source = message.source
  if (source?.kind !== 'model' || source.provider !== 'claude') return NO_CLAUDE_REPLAY
  if (model !== undefined && source.model !== model) return NO_CLAUDE_REPLAY
  const envelope = source.replayState
  if (typeof envelope !== 'object' || envelope === null) return NO_CLAUDE_REPLAY
  const record = envelope as {
    response?: { kind?: unknown; version?: unknown; serverBlocks?: unknown }
    blocks?: unknown
  }
  if (record.response?.kind !== 'claude' || record.response.version !== 1 || !Array.isArray(record.blocks)) return NO_CLAUDE_REPLAY
  return {
    blocks: record.blocks.map((entry): ClaudeThinkingReplay => {
      if (typeof entry !== 'object' || entry === null) return {}
      const raw = entry as Record<string, unknown>
      const signature = typeof raw.signature === 'string' && raw.signature.length > 0 ? raw.signature : undefined
      const redacted = typeof raw.redacted === 'string' && raw.redacted.length > 0 ? raw.redacted : undefined
      return {
        ...signature === undefined ? {} : { signature },
        ...redacted === undefined ? {} : { redacted },
      }
    }),
    serverBlocks: claudeServerReplayBlocks(record.response.serverBlocks),
  }
}

/**
 * Read the server-tool blocks a response captured.
 *
 * These entries are durable adapter data on their way back to the wire, so each
 * position and each block is checked first; an entry of any other shape is
 * dropped rather than replayed unvalidated.
 */
function claudeServerReplayBlocks(value: unknown): readonly ClaudeServerReplay[] {
  if (!Array.isArray(value)) return []
  const entries: ClaudeServerReplay[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const index = raw.index
    const block = raw.block
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) continue
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const type = (block as Record<string, unknown>).type
    if (typeof type !== 'string' || !SERVER_BLOCK_TYPES.has(type)) continue
    entries.push({ index, block })
  }
  return entries
}

/**
 * Retake one captured response block as wire content.
 *
 * The envelope carries the block exactly as the response sent it, and both
 * captured types are members of the wire library's message-content union, so
 * the capture goes back onto the wire unchanged.
 * @param entry - the replay entry recorded in the envelope.
 * @returns the captured block as message content.
 */
function serverReplayBlock(entry: ClaudeServerReplay): WireBlock {
  return entry.block as WireBlock
}

/**
 * Convert harness messages into Anthropic messages. Consecutive same-role
 * messages merge into one message with multiple content blocks; tool results
 * arrive as user messages with `tool_result` blocks, which a merged user
 * message keeps in one leading run ({@link leadWithToolResults}); system-role
 * messages before the conversation starts are handled by
 * {@link toAnthropicSystem} and skipped here, while a later one rides in
 * place as a user-role `<system-reminder>` block (the wire contract models no
 * system-role message).
 * Signed thinking blocks are replayed for the same Claude model; unsigned
 * reasoning is omitted because the API rejects a thinking block with no
 * signature. Images must arrive pre-resolved ({@link TranslatableMessage});
 * an unresolved ImageBlock is skipped because its bytes are unreachable here.
 * A tool result whose `tool_use` was narrated away (a settled subagent's
 * closing message) is narrated the same way, because the wire validator
 * rejects any `tool_result` whose call id is not in the request; conversely a
 * `tool_use` with no result is answered by the synthesized error result the
 * genuine client adds ({@link MISSING_TOOL_RESULT_TEXT}). Both repairs touch
 * only the assembled request, never the history.
 * @param messages - ordered conversation messages with resolved images.
 * @param model - the model this request targets. Thinking signatures are
 *   model-bound, so a signature from another model is not replayed.
 * @param midConversationSystem - whether this model accepts a mid-conversation system
 *   message. The caller answers with the same predicate that decides the beta header, so
 *   the message and the header cannot disagree.
 * @returns Anthropic messages in conversation order.
 */
export function toAnthropicMessages(
  messages: readonly TranslatableMessage[],
  model?: string,
  midConversationSystem = false,
): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const start = conversationStart(messages)
  for (const [index, message] of messages.entries()) {
    // A leading system message is an opening instruction; toAnthropicSystem
    // owns those. A later one rides here so the cached prefix ahead of it
    // stays byte-identical.
    if (message.role === 'system' && index < start) continue
    if (message.role === 'system' && midConversationSystem) {
      // The genuine client sends mid-conversation context as a system message the server
      // drops once the next user message arrives, which is what keeps the cached prefix
      // ahead of it intact. Gating this on the model's capability is what the client does
      // too, and the same predicate decides the beta header, so the two agree.
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      if (text.trim().length > 0) {
        out.push({ role: 'system', content: text, clear_at: 'next_user_message' })
      }
      continue
    }
    const role = message.role === 'system' ? 'user' : message.role
    const replay = claudeReplayBlocks(message, model)
    const blocks: WireBlock[] = []
    let droppedBlankText = false
    let serverCursor = 0
    for (const [blockIndex, block] of message.content.entries()) {
      // A captured server-tool block is re-emitted ahead of the harness block at the
      // position it recorded, which is where the response carried it.
      while (serverCursor < replay.serverBlocks.length && replay.serverBlocks[serverCursor].index <= blockIndex) {
        blocks.push(serverReplayBlock(replay.serverBlocks[serverCursor]))
        serverCursor += 1
      }
      switch (block.type) {
        case 'text':
          // The genuine client drops a text block whose content is absent or
          // whitespace-only before sending, and substitutes a placeholder when that
          // leaves a message with no blocks. The API rejects such a block outright
          // ("text content blocks must contain non-whitespace text"), so forwarding
          // one fails the whole conversation rather than the single block.
          if (block.text.trim().length === 0) {
            droppedBlankText = true
            break
          }
          blocks.push({
            type: 'text',
            text: message.role === 'system'
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
          const prior = replay.blocks[blockIndex]
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
    // A captured block that arrived after the last harness block still belongs after it.
    while (serverCursor < replay.serverBlocks.length) {
      blocks.push(serverReplayBlock(replay.serverBlocks[serverCursor]))
      serverCursor += 1
    }
    if (blocks.length === 0 && droppedBlankText) {
      // Stripping blank text left nothing behind: the genuine client keeps the message
      // and substitutes a placeholder rather than sending an empty content array.
      blocks.push({ type: 'text', text: NO_CONTENT_TEXT })
    }
    if (blocks.length === 0) continue
    const last = out[out.length - 1]
    if (
      last !== undefined &&
      last.role === role &&
      Array.isArray(last.content)
    ) {
      last.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }
  synthesizeMissingToolResults(out)
  for (const message of out) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      leadWithToolResults(message)
    }
  }
  narrateOrphanToolResults(out)
  return out
}

/**
 * Answer every `tool_use` the assembled request carries with a `tool_result`.
 *
 * The wire contract requires the result of a call in the message that follows
 * it, and a history can keep a call without one — a crash whose tail repair ran
 * before the closed step, a fork seed. The genuine client answers such a call
 * with a fixed error result; this adds it either ahead of the content of the
 * message that follows the call, or as the user message that follows it. A call
 * whose result is present anywhere in the request is left alone, as in
 * `reconcileResponsesToolCalls`. The repair is local to the assembled request:
 * the durable history is never written.
 * @param messages - the assembled messages, repaired in place.
 */
function synthesizeMissingToolResults(messages: AnthropicMessage[]): void {
  const calls = new Set<string>()
  const answered = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.add(String(block.id))
      if (block.type === 'tool_result') answered.add(String(block.tool_use_id))
    }
  }
  const missing = new Set([...calls].filter(id => !answered.has(id)))
  if (missing.size === 0) return
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const repair: WireBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !missing.delete(String(block.id))) continue
      repair.push({
        type: 'tool_result',
        tool_use_id: String(block.id),
        content: MISSING_TOOL_RESULT_TEXT,
        is_error: true,
      })
    }
    if (repair.length === 0) continue
    const next = messages[index + 1]
    if (next?.role === 'user' && Array.isArray(next.content)) {
      next.content = [...repair, ...next.content]
      continue
    }
    messages.splice(index + 1, 0, { role: 'user', content: repair })
  }
}

/** Narrate tool results whose `tool_use` block did not make it into the request. */
function narrateOrphanToolResults(messages: readonly AnthropicMessage[]): void {
  const calls = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.add(String(block.id))
    }
  }
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'tool_result' || calls.has(String(block.tool_use_id))) continue
      const text = typeof block.content === 'string'
        ? block.content
        : (block.content ?? []).map(part => part.type === 'text' ? part.text : '').join('')
      message.content[index] = { type: 'text', text: `[tool result ${String(block.tool_use_id)}: ${text}]` }
    }
  }
}

/**
 * Build the Anthropic `system` array: the explicit system prompt, then any
 * system-role messages preceding the conversation. The wire builder places
 * the Claude Code billing and identity blocks ahead of these and owns cache
 * breakpoint placement.
 * @param system - explicit system prompt, when set.
 * @param messages - conversation messages; the system-role text preceding the
 *   conversation is appended, and a later one is left to {@link toAnthropicMessages}.
 * @returns the caller system content blocks.
 */
export function toAnthropicSystem(system?: string, messages?: readonly TranslatableMessage[]): TextBlock[] {
  const blocks: TextBlock[] = []
  if (system !== undefined && system.length > 0) blocks.push({ type: 'text', text: system })
  const history = messages ?? []
  for (const message of history.slice(0, conversationStart(history))) {
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
  }
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

export function toAnthropicTools(tools: readonly ToolSchema[]): ClaudeToolDefinition[] {
  const mapped: ClaudeToolDefinition[] = [...tools]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(tool => ({
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      // Harness schemas are JSON by construction; the wire validator re-checks
      // the shape the endpoint accepts.
      input_schema: tool.parameters as WireSchemaTool['input_schema'],
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
/**
 * The server's own account of the context edits it applied to this response.
 *
 * Present only while the context-management beta is active and only when an edit ran, so an
 * absent field means the server applied nothing.
 */
export interface AnthropicContextManagement {
  readonly applied_edits?: readonly {
    readonly type?: string
    readonly cleared_tool_uses?: number
    readonly cleared_input_tokens?: number
  }[]
}

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
    /** `server_tool_use` input: the start object's value, or what `input_json_delta` builds. */
    input?: unknown
    /** `tool_search_tool_result` payload. Opaque; replayed verbatim. */
    content?: unknown
    /** The `server_tool_use` call a `tool_search_tool_result` answers. */
    tool_use_id?: string
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
  /** The edits the server applied to this response, when it applied any. */
  context_management?: AnthropicContextManagement
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

/**
 * One open server-tool block under assembly.
 *
 * It never becomes a harness block: the response's own JSON is remembered and
 * sent back unchanged at the position it occupied.
 */
interface OpenServerBlock {
  /** Harness blocks already open when this block arrived: its re-emission position. */
  index: number
  /** The start object, replayed as it arrived. */
  block: Record<string, unknown>
  /** Concatenated `input_json_delta` payload, for a block that streams its input. */
  input: string
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
  /** Server-tool blocks captured for the next request, in arrival order. */
  private serverBlocks: ClaudeServerReplay[] = []
  /** Open server-tool blocks under assembly, by wire index. */
  private openServerBlocks = new Map<number, OpenServerBlock>()
  private nextIndex = 0
  private sawAnyBlock = false
  private pendingUsage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | undefined
  private outputTokens: number | undefined
  private stopReason: 'stop' | 'tool-calls' | 'max-tokens' | 'refusal' = 'stop'
  private usageEmitted = false
  /** Set once `message_stop` produced the terminal finish chunk. */
  terminated = false

  /**
   * @param requestId - the `request-id` response header this stream answers, recorded on
   *   the finish envelope so the request the model saw and the response it produced stay
   *   checkable from the session log. Omitted when the response carried no such header.
   */
  constructor(private readonly requestId?: string) {}

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

  /** Start capturing a server-tool block, which occupies no harness block index. */
  private openServer(wireIndex: number, block: Record<string, unknown>): void {
    this.openServerBlocks.set(wireIndex, { index: this.nextIndex, block, input: '' })
  }

  /** Finalize one captured server-tool block and keep it for the next request. */
  private closeServer(wireIndex: number): void {
    const open = this.openServerBlocks.get(wireIndex)
    if (open === undefined) return
    this.openServerBlocks.delete(wireIndex)
    // A streamed input replaces whatever the start object carried; without one the start
    // object's own input is the whole value, as it arrived.
    const block = open.input.length === 0
      ? open.block
      : { ...open.block, input: parseToolInput(open.input) }
    this.serverBlocks.push({ index: open.index, block })
  }

  /** The edits the server reported applying to this response, when it reported any. */
  private appliedEdits: AnthropicContextManagement | undefined

  /**
   * Replay envelope for a successful response that carried something the adapter
   * must remember: thinking the next turn has to echo, the context edits the
   * server reported applying, a server-tool block the request has to carry back,
   * or the response's own request id. Omitted when the response carried none of
   * them, so a plain text response with no request id stays free of adapter
   * metadata.
   */
  private replayEnvelope(): ReplayEnvelope | undefined {
    let useful = false
    const blocks: ClaudeThinkingReplay[] = []
    for (let index = 0; index < this.nextIndex; index++) {
      const entry = this.replay[index] ?? {}
      if (entry.signature !== undefined || entry.redacted !== undefined) useful = true
      blocks.push(entry)
    }
    if (
      !useful &&
      this.appliedEdits === undefined &&
      this.serverBlocks.length === 0 &&
      this.requestId === undefined
    ) {
      return undefined
    }
    // The recorded edits ride the same envelope as the thinking signatures: both are what the
    // adapter must remember from a response, and both are opaque to the harness. The field is
    // optional, so an envelope written before it existed still reads as itself.
    return {
      response: {
        kind: 'claude',
        version: 1,
        ...this.appliedEdits === undefined ? {} : { contextManagement: this.appliedEdits },
        // Captured server-tool blocks ride here with the harness index each goes back ahead
        // of, beside the per-block entries that stay aligned with the harness blocks. The
        // field is optional too, so an older envelope still reads as itself.
        ...this.serverBlocks.length === 0 ? {} : { serverBlocks: this.serverBlocks },
        // The response's own request id, beside the rest of the response-level metadata.
        // Optional on the same terms: an envelope written before it existed still reads.
        ...this.requestId === undefined ? {} : { requestId: this.requestId },
      },
      blocks,
    }
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
          case 'server_tool_use':
          case 'tool_search_tool_result':
            // A server-run tool block has no harness vocabulary, so it emits no chunk: the
            // response's own JSON is remembered and sent back unchanged where it sat.
            this.openServer(wireIndex, { ...block })
            break
          default:
            break
        }
        return chunks
      }
      case 'content_block_delta': {
        const wireIndex = event.index ?? 0
        const block = this.blocks.get(wireIndex)
        const delta = event.delta
        if (delta === undefined) return chunks
        if (block === undefined) {
          // A server-tool block streams its input the way a tool call streams its arguments.
          const server = this.openServerBlocks.get(wireIndex)
          if (server !== undefined && delta.type === 'input_json_delta') {
            server.input += delta.partial_json ?? ''
          }
          return chunks
        }
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
        if (block === undefined) {
          this.closeServer(wireIndex)
          return chunks
        }
        this.blocks.delete(wireIndex)
        this.remember(block)
        chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
        return chunks
      }
      case 'message_delta': {
        // The server reports what it cleared on the delta that ends the message, which is the
        // same place the client reads it from.
        if (event.context_management !== undefined) this.appliedEdits = event.context_management
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
          case 'refusal':
            // A refusal is a stop the caller must be able to tell apart from a
            // completed turn; reporting it as an ordinary stop would present a
            // declined request as a finished answer.
            this.stopReason = 'refusal'
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
        // A server-tool block the stream never closed is still something the next request
        // has to carry, the same way an unclosed harness block is emitted above.
        for (const wireIndex of [...this.openServerBlocks.keys()]) this.closeServer(wireIndex)
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
 * @param requestId - the response's `request-id` header, when it carried one.
 * @returns the chunk stream; throws when the stream ends before `message_stop`.
 */
export async function* streamAnthropic(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  requestId?: string,
): AsyncGenerator<StreamChunk> {
  const translator = new AnthropicStreamTranslator(requestId)
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
  // The body ended without its terminal event: the wire dropped mid-response, which the
  // client retries as a dropped connection, so this takes the retryable transport code.
  // A payload that cannot be parsed is a different failure and keeps MALFORMED_RESPONSE.
  throw new LlmError('Anthropic SSE stream ended before message_stop', 'TRANSPORT')
}
