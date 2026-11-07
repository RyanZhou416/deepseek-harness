import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PRESSURE_KEYS, pressureViewsOf, registryReaderOf, TIMELINE_KEY, timelineReaderOf } from '../../src/host/projectionHandle'
import type { TimelineState } from '../../src/host/foldState'

const SESSION = { id: 's1' }

const STATE = { detailRev: 3 } as TimelineState

function ctxWith(projections: unknown): Context {
  return { sessionProjections: projections } as unknown as Context
}

describe('timelineReaderOf', () => {
  test('an awaited registration handle reads its own state', async () => {
    const handle = { stateOf: (session: unknown) => (session === SESSION ? STATE : undefined) }
    const read = await timelineReaderOf(ctxWith({ stateOf: () => { throw new Error('the registry face must not be used') } }), Promise.resolve(handle))
    assert.equal(read?.(SESSION), STATE)
    assert.equal(read?.({ id: 'other' }), undefined)
  })

  test('a legacy disposer registration falls back to the registry-level read', async () => {
    const seen: unknown[] = []
    const registry = { stateOf: (session: unknown, key: string) => { seen.push([session, key]); return STATE } }
    const read = await timelineReaderOf(ctxWith(registry), () => {})
    assert.equal(read?.(SESSION), STATE)
    assert.deepEqual(seen, [[SESSION, TIMELINE_KEY]])
    const absent = await timelineReaderOf(ctxWith({}), 42)
    assert.equal(absent, undefined, 'neither face: no reader')
    const oddHandle = await timelineReaderOf(ctxWith({}), Promise.resolve({ stateOf: 'not-a-function' }))
    assert.equal(oddHandle, undefined, 'a handle without a read face falls through')
    const nullRegistration = await timelineReaderOf(ctxWith(null), null)
    assert.equal(nullRegistration, undefined)
  })
})

describe('registryReaderOf', () => {
  test('reads the timeline key and passes an absent state through', () => {
    const read = registryReaderOf(ctxWith({ stateOf: () => undefined }))
    assert.equal(read?.(SESSION), undefined)
    assert.equal(registryReaderOf(ctxWith(5)), undefined, 'a non-record registry offers no face')
    assert.equal(registryReaderOf(ctxWith({ stateOf: 1 })), undefined, 'a non-callable read offers no face')
    const throwing = registryReaderOf(ctxWith({ stateOf: () => { throw new Error('hostile registry') } }))
    assert.throws(() => throwing?.(SESSION), /hostile registry/)
  })
})

describe('pressureViewsOf', () => {
  test('serves the summary-excluded keys through the key-subset read', () => {
    const asked: unknown[] = []
    const registry = {
      snapshot: (session: unknown, keys: unknown) => {
        asked.push([session, keys])
        return {
          asOfSeq: 3,
          values: {
            contextPressure: { projectedTokens: 10 },
            contextBreakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
          },
        }
      },
    }
    const views = pressureViewsOf(ctxWith(registry), SESSION)
    assert.deepEqual(views, {
      pressure: { projectedTokens: 10 },
      breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
    })
    assert.deepEqual(asked, [[SESSION, PRESSURE_KEYS]], 'the read asks for exactly the excluded keys')
  })

  test('an absent or hostile read face serves no values', () => {
    assert.deepEqual(pressureViewsOf(ctxWith({}), SESSION), {})
    assert.deepEqual(pressureViewsOf(ctxWith(7), SESSION), {})
    assert.deepEqual(pressureViewsOf(ctxWith({ snapshot: () => 42 }), SESSION), {})
    assert.deepEqual(pressureViewsOf(ctxWith({ snapshot: () => ({ values: null }) }), SESSION), {})
    const partial = pressureViewsOf(ctxWith({ snapshot: () => ({ values: { contextPressure: { projectedTokens: 1 } } }) }), SESSION)
    assert.deepEqual(partial, { pressure: { projectedTokens: 1 } }, 'a missing key stays absent')
    const breakdownOnly = pressureViewsOf(ctxWith({
      snapshot: () => ({ values: { contextBreakdown: { systemTokens: 1, toolsTokens: 0, messageTokens: 0 } } }),
    }), SESSION)
    assert.deepEqual(breakdownOnly, { breakdown: { systemTokens: 1, toolsTokens: 0, messageTokens: 0 } }, 'either key may be absent')
  })
})
