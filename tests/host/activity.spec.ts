// The `contextActivity` projection unit (src/host/activity.ts): the daily
// ledger fold — event filtering, usage sanitizing, day accumulation, the
// retention cap, the copying view, and the schema roundtrip.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyActivity, contextActivitySchema, createContextActivityDefinition } from '../../src/host/activity'

/** Local noon of a day offset from 2026-01-01 — deterministic in every timezone. */
function at(daysFromNewYear: number): number {
  return new Date(2026, 0, 1 + daysFromNewYear, 12).getTime()
}

function assistantMessage(time: number, usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: usage === undefined ? {} : { usage },
  } as never
}

describe('contextActivity unit: shape', () => {
  test('the definition carries the contract fields', () => {
    const def = createContextActivityDefinition()
    assert.equal(def.key, 'contextActivity')
    assert.equal(def.stateVersion, 1)
    assert.deepEqual(def.init(), { days: {} })
  })

  test('the wire view passes its schema; the state schema round-trips a folded state', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), assistantMessage(at(0), { inputTokens: 3, outputTokens: 2 }))
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(contextActivitySchema.safeParse(view).success, true)
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: -1 } } }).success, false)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 'x', requests: 1 } } }).success, false)
  })
})

describe('applyActivity: event filtering', () => {
  test('non-assistant events return the state unchanged (same reference)', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    for (const type of ['user/message', 'request/header', 'turn/start', 'bogus/event']) {
      assert.ok(applyActivity(state, { type, seq: 1, time: at(0), data: {} } as never) === state, type)
    }
  })

  test('a settlement with an unreadable time is dropped whole', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    assert.ok(applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 1 })) === state, 'NaN time')
    assert.ok(applyActivity(state, assistantMessage(1e30, { inputTokens: 1 })) === state, 'out-of-range time')
    assert.ok(applyActivity(state, assistantMessage(-2 * 86_400_000, { inputTokens: 1 })) === state, 'pre-epoch time')
    assert.deepEqual(state, { days: {} })
  })
})

describe('applyActivity: the ledger', () => {
  test('a metered settlement books the disjoint buckets summed into its day', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 5,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 21, requests: 1 } })
  })

  test('same-day settlements accumulate; distinct days key apart', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, assistantMessage(at(0), { outputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(state.days, {
      '2026-01-01': { tokens: 16, requests: 2 },
      '2026-01-02': { tokens: 3, requests: 1 },
    })
  })

  test('a settlement without usage counts its request without fabricating tokens', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0)))
    state = applyActivity(state, assistantMessage(at(0), null))
    state = applyActivity(state, assistantMessage(at(0), 'usage'))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 3 } })
  })

  test('usage buckets are sanitized: fractions round, negatives clamp, garbage reads absent', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10.4,
      cacheReadTokens: -7,
      cacheWriteTokens: '6',
      outputTokens: Number.NaN,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 16, requests: 1 } })
  })

  test('a fully unreadable usage object books zero tokens but keeps the request', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 'x', outputTokens: null }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 1 } })
  })

  test('the persisted previous state is never mutated (copy-on-write)', () => {
    const before = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    const after = applyActivity(before, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(before.days, { '2026-01-01': { tokens: 1, requests: 1 } })
    assert.ok(before !== after)
    assert.ok(before.days !== after.days)
  })

  test('the retention cap evicts the oldest day keys (chronological = lexicographic)', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let d = 0; d < 401; d++) {
      state = applyActivity(state, assistantMessage(at(d), { inputTokens: 1 }))
    }
    const keys = Object.keys(state.days)
    assert.equal(keys.length, 400)
    assert.equal(keys.includes('2026-01-01'), false, 'the oldest day dropped')
    assert.equal(keys.includes('2026-01-02'), true, 'the kept suffix starts the next day')
    // Later folds within the cap keep every day.
    state = applyActivity(state, assistantMessage(at(400), { inputTokens: 1 }))
    assert.equal(Object.keys(state.days).length, 400)
    assert.equal(state.days['2027-02-05'].requests, 2)
  })
})

describe('contextActivity unit: the view', () => {
  test('the view copies the ledger (the wire never shares the fold’s record)', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), assistantMessage(at(0), { inputTokens: 1 }))
    const view = def.wire.view(state)
    assert.ok(view.days !== state.days)
    view.days['2026-01-01'].tokens = 999
    assert.equal(state.days['2026-01-01'].tokens, 1)
  })
})
