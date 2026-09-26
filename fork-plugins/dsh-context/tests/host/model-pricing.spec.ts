// DeepSeek Harness fork modification: classify actual request costs before Session aggregation.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { header, assistantMessage } from './helpers/events'
import { driveTimeline, timelineDef } from './helpers/projection'
import { estimateSessionCost } from '../../src/client/cost'
import { timelineOf } from '../../src/client/services'

test('prices cached prompt context per request and preserves the long bucket through wire and client reads', () => {
  const { state, view } = driveTimeline([
    header(1, { provider: 'codex', model: 'gpt-6-sol' }),
    assistantMessage(2, { usage: { inputTokens: 150_000, outputTokens: 1_000 } }),
    assistantMessage(3, { usage: { inputTokens: 150_000, outputTokens: 1_000 } }),
    assistantMessage(4, { usage: { inputTokens: 1_000, cacheReadTokens: 300_000, outputTokens: 1_000 } }),
  ])
  assert.equal(state.cost?.codex['gpt-6-sol'].peak?.uncached, 300_000)
  assert.equal(state.cost?.codex['gpt-6-sol'].long?.cacheRead, 300_000)
  const definition = timelineDef()
  definition.stateSchema.parse(state)
  definition.wire.viewSchema.parse(view)
  assert.notEqual(view.cost?.codex['gpt-6-sol'].long, state.cost?.codex['gpt-6-sol'].long)
  const restored = timelineOf(JSON.parse(JSON.stringify(view)))
  assert.ok(Math.abs((estimateSessionCost(restored?.cost, null, 'usd') ?? 0) - 0.759) < 1e-12)
  const sanitized = timelineOf({ ...view, current: null })
  assert.equal(sanitized?.cost?.codex['gpt-6-sol'].long?.cacheRead, 300_000)
})

test('Grok long context and flat Claude pricing retain different cost periods', () => {
  const { state } = driveTimeline([
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
