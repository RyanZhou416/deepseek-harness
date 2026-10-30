/**
 * The context-management edits the server reports having applied on a response.
 *
 * This route states no context-editing policy, so a response normally reports none. The
 * translator still records an applied edit verbatim on the response envelope when one is
 * reported, because that is a server fact about the request rather than a request field this
 * route composes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AnthropicStreamTranslator } from '../src/translate/anthropic.js'

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
