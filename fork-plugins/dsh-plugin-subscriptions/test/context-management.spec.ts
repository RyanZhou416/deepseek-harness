/**
 * The context edits this route states, and the conditions under which it states them.
 *
 * The thresholds and the shape of each edit follow the genuine client, so these tests pin the
 * decisions rather than the numbers: thinking is cleared whenever a request carries thinking,
 * and old tool results are cleared only after a break long enough to make them stale, only
 * when enough of them are worth reclaiming, and never below the count that has to survive.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STALE_TOOL_RESULT_IDLE_MS, planContextManagement } from '../src/providers/context-management.js'
import { AnthropicStreamTranslator } from '../src/translate/anthropic.js'
import { ToolCallId } from '../src/compat.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** A history of `count` tool calls, each with a result of `chars` characters. */
function history(count: number, chars = 400): TranslatableMessage[] {
  const messages: TranslatableMessage[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(`call-${String(index)}`), name: 'bash', arguments: '{}' }],
    })
    messages.push({
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(`call-${String(index)}`),
        content: [{ type: 'text', text: 'x'.repeat(chars) }],
      }],
    })
  }
  return messages
}

test('a request carrying thinking states the thinking edit alone', () => {
  const plan = planContextManagement({ hasThinking: true, idleBeforeRequestMs: 10, messages: history(2) })
  assert.deepEqual(plan, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] })
})

test('a request with neither thinking nor a stale history states nothing', () => {
  assert.equal(
    planContextManagement({ hasThinking: false, idleBeforeRequestMs: 10, messages: history(30) }),
    undefined,
  )
  assert.equal(
    planContextManagement({
      hasThinking: false,
      idleBeforeRequestMs: STALE_TOOL_RESULT_IDLE_MS - 1,
      messages: history(30),
    }),
    undefined,
    'a break below the stale threshold states nothing',
  )
})

test('a stale history with enough reclaimable results states the tool edit', () => {
  const plan = planContextManagement({
    hasThinking: false,
    idleBeforeRequestMs: STALE_TOOL_RESULT_IDLE_MS,
    messages: history(25),
  })
  assert.deepEqual(plan, {
    edits: [{
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'tool_uses', value: 22 },
      keep: { type: 'tool_uses', value: 5 },
      clear_at_least: { type: 'input_tokens', value: 20_000 },
    }],
  })
})

test('a stale history below the trigger count states nothing', () => {
  const stale = STALE_TOOL_RESULT_IDLE_MS
  assert.equal(planContextManagement({ hasThinking: false, idleBeforeRequestMs: stale, messages: history(10) }), undefined)
  // 23 results put the trigger at the floor of 20, which is the smallest count that qualifies.
  assert.notEqual(planContextManagement({ hasThinking: false, idleBeforeRequestMs: stale, messages: history(23) }), undefined)
  assert.equal(planContextManagement({ hasThinking: false, idleBeforeRequestMs: stale, messages: history(22) }), undefined)
})

test('short results and results without a call are not reclaimable', () => {
  const short = history(30, 63)
  assert.equal(
    planContextManagement({ hasThinking: false, idleBeforeRequestMs: STALE_TOOL_RESULT_IDLE_MS, messages: short }),
    undefined,
    'a result below the character floor is not worth reclaiming',
  )
  const orphan: TranslatableMessage[] = [{
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: ToolCallId('never-called'),
      content: [{ type: 'text', text: 'x'.repeat(4_000) }],
    }],
  }]
  assert.equal(
    planContextManagement({ hasThinking: false, idleBeforeRequestMs: STALE_TOOL_RESULT_IDLE_MS, messages: orphan }),
    undefined,
    'a result whose call is absent from the history is not counted',
  )
})

test('a result carrying an image counts however short its text', () => {
  // Every result is short text replaced by an image: none reaches the character floor, so the
  // edit can only appear if carrying an attachment is what makes a result reclaimable.
  const messages: TranslatableMessage[] = history(23, 63).map((message): TranslatableMessage => {
    if (message.role !== 'user') return message
    const result = message.content[0]
    if (result?.type !== 'tool-result') return message
    return {
      ...message,
      content: [{
        type: 'tool-result',
        toolCallId: result.toolCallId,
        content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }],
      }],
    }
  })
  const plan = planContextManagement({
    hasThinking: false,
    idleBeforeRequestMs: STALE_TOOL_RESULT_IDLE_MS,
    messages,
  })
  assert.equal(
    plan?.edits?.[0]?.type,
    'clear_tool_uses_20250919',
    'short results carrying an image are reclaimable',
  )
})

test('both edits are stated together when both conditions hold', () => {
  const plan = planContextManagement({
    hasThinking: true,
    idleBeforeRequestMs: STALE_TOOL_RESULT_IDLE_MS * 2,
    messages: history(25),
  })
  assert.equal(plan?.edits?.length, 2)
  assert.equal(plan?.edits[0]?.type, 'clear_thinking_20251015')
  assert.equal(plan?.edits[1]?.type, 'clear_tool_uses_20250919')
})

test('the server\'s applied edits are recorded on the response envelope', () => {
  const translator = new AnthropicStreamTranslator()
  const events: { type: string; [key: string]: unknown }[] = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
      context_management: {
        applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 12, cleared_input_tokens: 30_000 }],
      },
    },
    { type: 'message_stop' },
  ]
  const chunks = events.flatMap(event => translator.push(event as never))
  const finish = chunks.find(chunk => chunk.type === 'finish')
  const envelope = finish?.type === 'finish' ? finish.replayState : undefined
  assert.deepEqual(
    (envelope?.response as { contextManagement?: unknown } | undefined)?.contextManagement,
    { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 12, cleared_input_tokens: 30_000 }] },
  )
})

test('a response with no applied edits carries no such field', () => {
  const translator = new AnthropicStreamTranslator()
  const chunks = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].flatMap(event => translator.push(event as never))
  const finish = chunks.find(chunk => chunk.type === 'finish')
  const envelope = finish?.type === 'finish' ? finish.replayState : undefined
  assert.equal(
    (envelope?.response as { contextManagement?: unknown } | undefined)?.contextManagement,
    undefined,
    'an unedited response records no edits',
  )
})
