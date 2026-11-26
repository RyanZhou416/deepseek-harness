// DeepSeek Harness fork modification: agent heads carry detail views.
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { HEAD_VIEW_KEYS, headViewsOf, headViewsOfValues } from '../../src/host/headViews'
import { fakeCtx } from './helpers/ctx'

describe('head views', () => {
  test('the declared keys are the three summary-excluded detail projections', () => {
    assert.deepEqual(HEAD_VIEW_KEYS, ['contextPressure', 'contextBreakdown', 'tokenUsage'])
  })

  test('a value map yields the present views only', () => {
    assert.deepEqual(headViewsOfValues(null), {})
    assert.deepEqual(headViewsOfValues({ contextPressure: { pressureTokens: 1 } }), { pressure: { pressureTokens: 1 } })
    assert.deepEqual(
      headViewsOfValues({ contextPressure: null, contextBreakdown: { systemTokens: 2 }, tokenUsage: { outputTokens: 3 } }),
      { pressure: null, breakdown: { systemTokens: 2 }, usage: { outputTokens: 3 } },
    )
  })

  test('a live session reads the views from the projection snapshot without a log read', () => {
    const snapshot = vi.fn(() => ({
      asOfSeq: 4,
      values: { contextPressure: { pressureTokens: 7 }, contextBreakdown: { systemTokens: 8 }, tokenUsage: { outputTokens: 9 } },
    }))
    const fake = fakeCtx({}, { sessionProjections: { snapshot } })
    assert.deepEqual(headViewsOf(fake.ctx, { id: 's1' }), {
      pressure: { pressureTokens: 7 },
      breakdown: { systemTokens: 8 },
      usage: { outputTokens: 9 },
    })
    assert.deepEqual(snapshot.mock.calls[0], [{ id: 's1' }, HEAD_VIEW_KEYS])
    fake.dispose()
  })

  test('a missing snapshot face, a throwing snapshot, and a malformed block all degrade to no views', () => {
    const withoutSnapshot = fakeCtx({}, { sessionProjections: { stateOf: () => undefined } })
    assert.deepEqual(headViewsOf(withoutSnapshot.ctx, { id: 's1' }), {})
    withoutSnapshot.dispose()

    const throwing = fakeCtx({}, { sessionProjections: { snapshot: () => { throw new Error('down') } } })
    assert.deepEqual(headViewsOf(throwing.ctx, { id: 's1' }), {})
    throwing.dispose()

    const malformed = fakeCtx({}, { sessionProjections: { snapshot: () => 7 } })
    assert.deepEqual(headViewsOf(malformed.ctx, { id: 's1' }), {})
    malformed.dispose()

    const empty = fakeCtx({}, { sessionProjections: { snapshot: () => ({ asOfSeq: 1 }) } })
    assert.deepEqual(headViewsOf(empty.ctx, { id: 's1' }), {})
    empty.dispose()
  })
})
