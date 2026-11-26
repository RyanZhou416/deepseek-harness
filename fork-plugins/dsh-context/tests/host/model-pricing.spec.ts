// DeepSeek Harness fork modification: classify actual request costs before Session aggregation.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { header, assistantMessage } from './helpers/events'
import { fullDef } from './helpers/projection'
import type { TimelineState } from '../../src/host/foldState'
import type { TimelineEvent } from '../../src/host/fold'
import type { ContextTimeline } from '../../src/shared/types'

function fold(events: TimelineEvent[]): { state: TimelineState; view: ContextTimeline } {
  const definition = fullDef()
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state) }
}

test('a request above the threshold books its whole usage into the long bucket', () => {
  const { state, view } = fold([
    header(1, { provider: 'codex', model: 'gpt-6-sol' }),
    assistantMessage(2, { usage: { inputTokens: 150_000, outputTokens: 1_000 } }),
    assistantMessage(3, { usage: { inputTokens: 150_000, outputTokens: 1_000 } }),
    assistantMessage(4, { usage: { inputTokens: 1_000, cacheReadTokens: 300_000, outputTokens: 1_000 } }),
  ])
  assert.equal(state.cost?.codex['gpt-6-sol'].peak?.uncached, 300_000)
  assert.equal(state.cost?.codex['gpt-6-sol'].long?.cacheRead, 300_000)
  const definition = fullDef()
  definition.stateSchema.parse(state)
  definition.wire.viewSchema.parse(view)
  assert.notEqual(view.cost?.codex['gpt-6-sol'].long, state.cost?.codex['gpt-6-sol'].long, 'the wire clones the bucket')
})

test('Grok long context and flat Claude pricing retain different cost periods', () => {
  const { state } = fold([
    header(1, { provider: 'cursor', model: 'grok-4.7' }),
    assistantMessage(2, { usage: { inputTokens: 200_000, outputTokens: 0 } }),
    assistantMessage(3, { usage: { inputTokens: 200_001, outputTokens: 0 } }),
    header(4, { provider: 'claude', model: 'claude-opus-5-5', reason: 'change' }),
    assistantMessage(5, { usage: { inputTokens: 900_000, outputTokens: 0 } }),
  ])
  assert.equal(state.cost?.cursor['grok-4.7'].peak?.uncached, 200_000)
  assert.equal(state.cost?.cursor['grok-4.7'].long?.uncached, 200_001)
  assert.equal(state.cost?.claude['claude-opus-5-5'].peak?.uncached, 900_000)
  assert.equal(state.cost?.claude['claude-opus-5-5'].long, undefined)
})

test('a checkpointed cost keeps the long bucket through restore', () => {
  const { state } = fold([
    header(1, { provider: 'codex', model: 'gpt-6-sol' }),
    assistantMessage(2, { usage: { inputTokens: 1_000, cacheReadTokens: 300_000, outputTokens: 1_000 } }),
  ])
  const definition = fullDef()
  const parsed = definition.stateSchema.parse(JSON.parse(JSON.stringify(state))) as TimelineState
  assert.equal(parsed.cost?.codex['gpt-6-sol'].long?.cacheRead, 300_000)
})
