/**
 * Tool-call pairing repair for the provider wires that reject an unpaired
 * call: the Responses input items and the chat completions messages of one
 * request are balanced — every call answered, every result owned — without
 * mutating the history they were assembled from. No network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileChatToolCalls,
  reconcileResponsesToolCalls,
  UNKNOWN_TOOL_OUTCOME_TEXT,
} from '../src/translate/tool-pairing.js'

/** One Responses function call item. */
function call(id: string): Record<string, unknown> {
  return { type: 'function_call', call_id: id, name: 'bash', arguments: '{}' }
}

/** One Responses function-call output item. */
function output(id: string, text = 'done'): Record<string, unknown> {
  return { type: 'function_call_output', call_id: id, output: text }
}

test('reconcileResponsesToolCalls answers a missing output and drops an orphan output', () => {
  const input = [call('call-missing'), output('call-orphan', 'stale'), call('call-ok'), output('call-ok')]
  const balanced = reconcileResponsesToolCalls(input)
  assert.deepEqual(balanced.map(item => item.call_id), [
    'call-missing',
    'call-missing',
    'call-ok',
    'call-ok',
  ])
  assert.equal(balanced[1]?.type, 'function_call_output')
  assert.equal(balanced[1]?.output, UNKNOWN_TOOL_OUTCOME_TEXT)
  assert.equal(balanced.some(item => item.call_id === 'call-orphan'), false)
  // Local repair only: the history it was assembled from stays untouched.
  assert.equal(input.length, 4)
})

test('reconcileResponsesToolCalls returns a balanced input unchanged', () => {
  const balanced = [call('call-1'), output('call-1')]
  assert.equal(reconcileResponsesToolCalls(balanced), balanced)
})

test('reconcileResponsesToolCalls repairs a duplicated call exactly once', () => {
  const repaired = reconcileResponsesToolCalls([call('call-dup'), call('call-dup')])
  assert.deepEqual(repaired.map(item => item.type), [
    'function_call',
    'function_call_output',
    'function_call',
  ])
})

test('reconcileChatToolCalls answers a missing result inside its call run', () => {
  const messages = [
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function' }, { id: 'call-2', type: 'function' }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'file-a' },
    { role: 'user', content: 'next' },
  ]
  const balanced = reconcileChatToolCalls(messages)
  assert.deepEqual(balanced.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user'])
  assert.equal(balanced[2]?.tool_call_id, 'call-1')
  assert.equal(balanced[3]?.tool_call_id, 'call-2')
  assert.equal(balanced[3]?.content, UNKNOWN_TOOL_OUTCOME_TEXT)
  // Local repair only: the history it was assembled from stays untouched.
  assert.equal(messages.length, 4)
})

test('reconcileChatToolCalls drops an orphan result and keeps a balanced history unchanged', () => {
  const orphaned = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function' }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'file-a' },
    { role: 'tool', tool_call_id: 'call-absent', content: 'stale' },
  ]
  assert.deepEqual(reconcileChatToolCalls(orphaned).map(message => message.tool_call_id), [undefined, 'call-1'])

  const balanced = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function' }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'file-a' },
  ]
  assert.equal(reconcileChatToolCalls(balanced), balanced)
})

test('reconcileChatToolCalls pairs every round of a multi-round chain', () => {
  const messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function' }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'file-a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-2', type: 'function' }] },
  ]
  const balanced = reconcileChatToolCalls(messages)
  assert.deepEqual(balanced.map(message => message.tool_call_id), [undefined, 'call-1', undefined, 'call-2'])
})
