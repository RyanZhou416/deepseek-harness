// The Context Dashboard's open-state store (src/client/overviewStore.ts):
// subscribe/notify semantics, idempotent sets, unsubscribe.

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { overviewStore } from '../../src/client/overviewStore'

afterEach(() => {
  overviewStore.set(false)
})

describe('overviewStore', () => {
  test('closed by default; set flips and notifies', () => {
    assert.equal(overviewStore.getSnapshot(), false)
    const seen: boolean[] = []
    const unsubscribe = overviewStore.subscribe(() => { seen.push(overviewStore.getSnapshot()) })
    overviewStore.set(true)
    assert.equal(overviewStore.getSnapshot(), true)
    assert.deepEqual(seen, [true])
    overviewStore.set(false)
    assert.deepEqual(seen, [true, false])
    unsubscribe()
  })

  test('an idempotent set notifies nobody', () => {
    overviewStore.set(true)
    let calls = 0
    const unsubscribe = overviewStore.subscribe(() => { calls++ })
    overviewStore.set(true)
    assert.equal(calls, 0)
    overviewStore.set(false)
    assert.equal(calls, 1)
    unsubscribe()
  })

  test('unsubscribe detaches the listener', () => {
    let calls = 0
    const unsubscribe = overviewStore.subscribe(() => { calls++ })
    unsubscribe()
    overviewStore.set(true)
    assert.equal(calls, 0)
  })

  test('several listeners all hear a flip', () => {
    let a = 0
    let b = 0
    const unA = overviewStore.subscribe(() => { a++ })
    const unB = overviewStore.subscribe(() => { b++ })
    overviewStore.set(true)
    assert.equal(a, 1)
    assert.equal(b, 1)
    unA()
    unB()
  })
})
