import assert from 'node:assert/strict'
import test from 'node:test'

import { CLAUDE_CODE_2_1_288_PROFILE } from '@tormentalabs/claude-code-wire-compat'
import { supportsMidConversationSystem } from '../src/providers/claude.js'
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

test('the pinned catalogue decides the capability for every model and its 1M-marked id', () => {
  // The capability was a duplicated local list until the catalogue became the source. Pin the
  // whole catalogue rather than a few names, and pin the marker: the request-time `[1m]` suffix
  // is not part of the catalogue key, so it never changes the answer either way.
  for (const [model, entry] of Object.entries(CLAUDE_CODE_2_1_288_PROFILE.supportedModels)) {
    const capable = entry.capabilities.includes('mid_conv_system')
    assert.equal(supportsMidConversationSystem(model), capable, `${model} follows its catalogue entry`)
    assert.equal(supportsMidConversationSystem(`${model}[1m]`), capable, `${model} keeps its entry under the marker`)
  }
})

test('Sonnet 5, Sonnet 5.5 and Opus 5.5 accept the mid-conversation form', () => {
  // The duplicated list this replaced admitted no Sonnet and no 5.5 entry.
  for (const model of [
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
  ]) {
    assert.equal(supportsMidConversationSystem(model), true, model)
    assert.equal(supportsMidConversationSystem(`${model}[1m]`), true, `${model} stays capable under the marker`)
  }
  // Mythos 5 is catalogued with an empty capability list, which the catalogue reads as a
  // denial even though the library predicate fallback would admit the id.
  for (const model of [
    'claude-mythos-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-3-5-haiku',
  ]) {
    assert.equal(supportsMidConversationSystem(model), false, model)
    assert.equal(supportsMidConversationSystem(`${model}[1m]`), false, `${model} stays incapable under the marker`)
  }
})

test('a marked capable model gets the mid-conversation form from the same predicate', () => {
  // The caller answers with the marker-stripped predicate, so a marked id cannot send the
  // in-history form without the beta the builder composes for the plain id.
  const wire = toAnthropicMessages(conversation(), 'claude-sonnet-5[1m]', true)
  assert.deepEqual(wire.map(message => message.role), ['user', 'assistant', 'system', 'user'])
  assert.equal(wire[2]?.clear_at, 'next_user_message')
})
