import assert from 'node:assert/strict'
import test from 'node:test'

import { toAnthropicMessages } from '../src/translate/anthropic.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** An opening instruction (belongs in `system`), a turn, then mid-conversation context. */
function conversation(): TranslatableMessage[] {
  return [
    { role: 'system', content: [{ type: 'text', text: 'opening instruction' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'mid-conversation context' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ]
}

test('a capable model receives mid-conversation context as a system message', () => {
  const wire = toAnthropicMessages(conversation(), 'claude-opus-5', true)

  // The opening instruction is the operator's, and the system slot owns it.
  assert.equal(wire.some(message => message.role === 'system' && message.content === 'opening instruction'), false)

  const system = wire.filter(message => message.role === 'system')
  assert.equal(system.length, 1)
  // The client sends the text as a plain string and clears it after the next user turn,
  // rather than folding it into another message.
  assert.equal(system[0]?.content, 'mid-conversation context')
  assert.equal(system[0]?.clear_at, 'next_user_message')
  assert.deepEqual(wire.map(message => message.role), ['user', 'assistant', 'system', 'user'])
})

test('a model without the capability keeps the reminder-block fallback', () => {
  const wire = toAnthropicMessages(conversation(), 'claude-opus-5', false)

  assert.equal(wire.filter(message => message.role === 'system').length, 0)
  const reminder = wire.find(message => message.role === 'user' && Array.isArray(message.content)
    && message.content.some(block => block.type === 'text' && block.text.includes('mid-conversation context')))
  assert.ok(reminder, 'the text still reaches the request')
  const text = (reminder.content as readonly { type: string; text?: string }[])
    .map(block => block.text ?? '')
    .join('')
  assert.match(text, /<system-reminder>mid-conversation context<\/system-reminder>/)
})

test('a mid-conversation system message never merges with its neighbours', () => {
  const wire = toAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'system', content: [{ type: 'text', text: 'note' }] },
    { role: 'system', content: [{ type: 'text', text: 'another note' }] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
  ], 'claude-opus-5', true)

  assert.deepEqual(wire.map(message => message.role), ['user', 'system', 'system', 'user'])
})
