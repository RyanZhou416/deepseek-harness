// DeepSeek Harness fork modification: per-generation wire reuse. See ../../FORK_MAINTENANCE.md.
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineState } from '../../src/host/foldState'
import { timelineDef } from './helpers/projection'
import { assistantMessage, header } from './helpers/events'

function stateOf(definition: ReturnType<typeof timelineDef>): TimelineState {
  let state = definition.init()
  state = definition.apply(state, header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }))
  state = definition.apply(state, assistantMessage(2, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }))
  return state
}

describe('per-generation wire reuse', () => {
  test('host-only churn reuses the previous wire value; a visible input builds a new one', () => {
    const definition = timelineDef()
    const state = stateOf(definition)
    const first = definition.wire.view(state)

    const churned: TimelineState = { ...state, stepStart: { time: 1 }, callNames: { c1: { name: 'bash', start: 2 } } }
    assert.equal(definition.wire.view(churned), first, 'a pending step slot and call ledger never reach the wire')

    const visible: TimelineState = { ...state, systemTokens: state.systemTokens + 1 }
    assert.notEqual(definition.wire.view(visible), first, 'a visible input publishes')
  })

  test('two calls on the same state build distinct values', () => {
    const definition = timelineDef()
    const state = stateOf(definition)
    assert.notEqual(definition.wire.view(state), definition.wire.view(state), 'the view stays pure')
  })

  test('the head generation replays its own value and the inline generation renders the archive', () => {
    const slim = timelineDef({}, true)
    const headState = stateOf(slim)
    const headFirst = slim.wire.view(headState)
    assert.equal(slim.wire.view({ ...headState, stepRequestSeq: 4 }), headFirst, 'the head generation replays across host-only churn')

    const inline = timelineDef()
    const state = stateOf(inline)
    const first = inline.wire.view(state)
    const archived: TimelineState = { ...state, archived: [{ seq: 3, cat: 'user', tokens: 1 }] }
    assert.notEqual(inline.wire.view(archived), first, 'the inline generation renders the archive')
    assert.equal(inline.wire.view(archived).archive.length, 1)
  })
})
