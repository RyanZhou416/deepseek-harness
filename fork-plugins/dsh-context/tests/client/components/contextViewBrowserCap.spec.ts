import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { browserCapOf } from '../../../src/client/components/contextView'

describe('browserCapOf — the Context browser column\'s height ceiling', () => {
  test('three times the stacked composition + trend card heights, rounded', () => {
    assert.equal(browserCapOf([180.4, 321.6]), 1506)
  })

  test('no measurable card (the loading frame) leaves the column uncapped', () => {
    assert.equal(browserCapOf([]), null)
    assert.equal(browserCapOf([0, 0]), null)
  })
})
