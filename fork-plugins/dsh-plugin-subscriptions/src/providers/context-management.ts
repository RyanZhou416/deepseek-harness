/**
 * The context-management edits this route sends, planned the way the genuine client plans them.
 *
 * The client clears twice over: thinking blocks whenever a request carries thinking, and old
 * tool results once the conversation shows a long break. Both are server-side edits — the
 * request states the policy and the API applies it — so this module only decides whether an
 * edit is worth stating and with which thresholds.
 *
 * A tool result counts toward the clearing decision only when it carries enough text to be
 * worth reclaiming, and the decision fires only when the count is high enough that clearing
 * leaves a useful history behind. The numbers are the client's own.
 */

import type { ContextManagementConfig } from '@tormentalabs/claude-code-wire-compat'

import type { TranslatableBlock, TranslatableMessage } from '../translate/resolved.js'

/** Tool uses kept after clearing; newer results stay for the model to keep working with. */
const KEEP_TOOL_USES = 5
/** The client triggers clearing `3` below the clearable count. */
const TRIGGER_TOOL_USES_BELOW_COUNT = 3
/** Clearing needs at least this many clearable tool uses, in addition to the keep count. */
const MIN_TRIGGER_TOOL_USES = 20
/** Clearing must reclaim at least this many input tokens to be worth stating. */
const CLEAR_AT_LEAST_TOKENS = 20_000
/** Tool results shorter than this are not worth reclaiming. */
const MIN_TOOL_RESULT_CHARS = 64
/** The client's token estimate: four characters per token. */
const CHARS_PER_TOKEN = 4
/**
 * Silence before a request that makes the conversation's earlier tool results stale.
 *
 * The client looks for this gap between consecutive transcript messages. This route cannot see
 * transcript timestamps, and does not need them: no request is issued during silence, so the
 * adapter's own record of its previous request measures the same gap.
 */
export const STALE_TOOL_RESULT_IDLE_MS = 3_900_000

/**
 * Estimates the tokens a tool result occupies, or undefined when it is not worth reclaiming.
 *
 * @param content - the result's blocks.
 * @returns the estimate in tokens, or undefined for a short text-only result.
 */
function estimateToolResultTokens(content: readonly TranslatableBlock[]): number | undefined {
  let chars = 0
  let carriesAttachment = false
  for (const block of content) {
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      chars += block.text.length
    } else if (block.type === 'image' || block.type === 'file') {
      // The client's rule counts a result as reclaimable whatever its text length when it
      // carries an image or a document; this harness represents both as resolved blocks.
      carriesAttachment = true
    }
  }
  if (!carriesAttachment && chars < MIN_TOOL_RESULT_CHARS) return undefined
  return Math.round(chars / CHARS_PER_TOKEN)
}

/**
 * The tool names a request's history used, in call order, paired with their results.
 *
 * @param messages - the request's translated history.
 * @returns each tool call's name and its result content, when the history holds one.
 */
function toolCallResults(
  messages: readonly TranslatableMessage[],
): { name: string; content: readonly TranslatableBlock[] | undefined }[] {
  const names = new Map<string, string>()
  const out: { name: string; content: readonly TranslatableBlock[] | undefined }[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool-call' && 'id' in block && 'name' in block) {
        const id = String(block.id)
        names.set(id, String(block.name))
        if (!out.some(entry => entry.name === String(block.name) && entry.content === undefined)) {
          out.push({ name: String(block.name), content: undefined })
        }
        continue
      }
      if (block.type === 'tool-result' && 'toolCallId' in block) {
        const name = names.get(String(block.toolCallId))
        if (name === undefined) continue
        const entry = out.find(candidate => candidate.name === name && candidate.content === undefined)
        if (entry === undefined) continue
        entry.content = block.content
      }
    }
  }
  return out
}

/**
 * Plans the context edits for one request.
 *
 * @param input - whether the request carries thinking, the adapter's measured silence before
 *   this request, and the request's translated history.
 * @returns the edits to state, or undefined when neither applies.
 */
export function planContextManagement(input: {
  readonly hasThinking: boolean
  readonly idleBeforeRequestMs: number | undefined
  readonly messages: readonly TranslatableMessage[]
}): ContextManagementConfig | undefined {
  const edits: NonNullable<ContextManagementConfig['edits']>[number][] = []
  if (input.hasThinking) {
    // Clearing thinking keeps the most recent turns and drops the rest, which the client states
    // as `all`: earlier thinking is not replayed, so nothing depends on it staying.
    edits.push({ type: 'clear_thinking_20251015', keep: 'all' })
  }
  if (input.idleBeforeRequestMs !== undefined && input.idleBeforeRequestMs >= STALE_TOOL_RESULT_IDLE_MS) {
    const results = toolCallResults(input.messages)
    const clearable = results.filter(entry => entry.content !== undefined
      && estimateToolResultTokens(entry.content) !== undefined).length
    const trigger = clearable - TRIGGER_TOOL_USES_BELOW_COUNT
    if (trigger > KEEP_TOOL_USES && trigger >= MIN_TRIGGER_TOOL_USES) {
      edits.push({
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'tool_uses', value: trigger },
        keep: { type: 'tool_uses', value: KEEP_TOOL_USES },
        clear_at_least: { type: 'input_tokens', value: CLEAR_AT_LEAST_TOKENS },
      })
    }
  }
  return edits.length === 0 ? undefined : { edits }
}
