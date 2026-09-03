// DeepSeek Harness fork modification: copy-on-write, dirty-trim, and restored-view bounds coverage. See ../../FORK_MAINTENANCE.md.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineView, createTimelineState } from '../../src/host/fold'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../src/shared/types'
import { planMode, toolCall } from './helpers/events'
import { assertPlainJson, timelineDef } from './helpers/projection'

const LEAN_BOUNDS = {
  maxRequestSteps: 300,
  maxKeptTurns: 60,
  maxEvents: 100,
  maxNodes: 400,
  maxArchiveNodes: 100,
}

function request(seq: number, turn: number, step: number): RequestRecord {
  return {
    seq,
    time: seq,
    turn,
    step,
    system: 0,
    tools: 0,
    user: 0,
    inject: 0,
    assistant: 0,
    tool: 0,
    total: 0,
  }
}

describe('timeline allocation bounds', () => {
  test('an internal tool-call update clones only its owned map', () => {
    const def = timelineDef(LEAN_BOUNDS)
    const state = def.init()
    const next = def.apply(state, toolCall(1, { callId: 'c1', name: 'bash' }))

    assert.notEqual(next, state)
    assert.notEqual(next.callNames, state.callNames)
    assert.equal(next.surface, state.surface)
    assert.equal(next.sums, state.sums)
    assert.equal(next.requests, state.requests)
    assert.equal(next.events, state.events)
    assert.equal(next.archived, state.archived)
  })

  test('host-only state changes reuse the wire view while visible changes replace it', () => {
    const def = timelineDef(LEAN_BOUNDS)
    const initial = def.init()
    const firstView = def.wire.view(initial)

    const pendingCall = def.apply(initial, toolCall(1, { callId: 'c1', name: 'bash' }))
    assert.equal(def.wire.view(pendingCall), firstView)

    const visible = def.apply(pendingCall, planMode(2, { active: true }))
    assert.notEqual(def.wire.view(visible), firstView)
  })

  test('a normalized state trims only the collection changed by the next event', () => {
    const def = timelineDef({ ...LEAN_BOUNDS, maxEvents: 1, maxArchiveNodes: 1 })
    const restored = createTimelineState()
    restored.archived = Array.from({ length: 3 }, (_, index): SurfaceNode => ({
      seq: index + 1,
      cat: 'user',
      tokens: 1,
      gone: 100 + index,
    }))

    const normalized = def.apply(restored, planMode(10, { active: true }))
    assert.equal(normalized.archived.length, 1)
    const next = def.apply(normalized, toolCall(11, { callId: 'c1', name: 'bash' }))
    assert.equal(next.archived, normalized.archived)
    assert.equal(next.requests, normalized.requests)
    assert.equal(next.events, normalized.events)
  })

  test('the first restored-state view enforces lean bounds without mutating the checkpoint', () => {
    const def = timelineDef(LEAN_BOUNDS)
    const state = createTimelineState()
    for (let turn = 1; turn <= 65; turn++) {
      for (let step = 1; step <= 5; step++) {
        state.requests.push(request(state.requests.length + 1, turn, step))
      }
    }
    state.events = Array.from({ length: 120 }, (_, index): ContextEventRecord => ({
      seq: index + 1,
      time: index,
      kind: 'mode',
      name: 'plan.on',
    }))
    state.archiveFloor = 900
    state.archived = Array.from({ length: 120 }, (_, index): SurfaceNode => ({
      seq: index + 1,
      cat: 'user',
      tokens: 1,
      gone: 1001 + index,
    }))
    const before = assertPlainJson(state)

    const view = def.wire.view(state)

    assert.equal(view.requests.length, 300)
    assert.equal(view.requests[0].turn, 6, 'whole-turn trimming keeps the newest 60 complete turns')
    assert.equal(view.events.length, 100)
    assert.equal(view.events[0].seq, 21)
    assert.equal(view.archive.length, 100)
    assert.equal(view.archive[0].seq, 21)
    assert.equal(view.archiveFloor, 1020)
    assert.deepEqual(assertPlainJson(state), before, 'serving a bounded view must not rewrite restored state')

    const normalized = def.apply(state, toolCall(326, { callId: 'c1', name: 'bash' }))
    const normalizedView = def.wire.view(normalized)
    assert.notEqual(normalizedView, view, 'persisting restored-state normalization must not inherit an unchecked view identity')
    assert.equal(normalizedView.requests.length, 300)
    assert.equal(normalizedView.events.length, 100)
    assert.equal(normalizedView.archive.length, 100)
    assert.equal(normalizedView.archiveFloor, 1020)
  })

  test('a normalized state skips the retention scan before building its view', () => {
    const def = timelineDef(LEAN_BOUNDS)
    const state = createTimelineState()
    let iteratorReads = 0
    state.requests = new Proxy(state.requests, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) iteratorReads++
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const normalized = def.apply(state, toolCall(1, { callId: 'c1', name: 'bash' }))
    assert.ok(iteratorReads > 0, 'the first relevant event validates restored retention')

    iteratorReads = 0
    buildTimelineView(normalized, LEAN_BOUNDS)
    assert.equal(iteratorReads, 0, 'an already-normalized state does not recount request turns')
  })
})
