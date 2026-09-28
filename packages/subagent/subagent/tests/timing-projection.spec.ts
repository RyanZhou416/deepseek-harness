import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition, type TimingState } from '../src/projection.ts'
import { SUBAGENT_DESCRIPTOR_VERSION } from '../src/descriptor.ts'

function event(
  type: SessionEvent['type'],
  seq: number,
  time: number,
  reason: TurnEndReason = { kind: 'completed' },
): SessionEvent {
  return {
    type,
    seq,
    time,
    data: type === 'turn/end' ? { turn: 1, reason } : {},
  } as SessionEvent
}

function fold(events: SessionEvent[]) {
  let state: TimingState = subagentTimingProjectionDefinition.init()
  for (const item of events) state = subagentTimingProjectionDefinition.apply(state, item)
  return subagentTimingProjectionDefinition.wire.view(state)
}

describe('subagent timing projection', () => {
  it('serves timing transitions through the validated registry view', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(subagentTimingProjectionDefinition)
      const session = ctx.sessions.create()
      session.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'synthetic' })
      session.append('turn/start', { turn: 1 })
      expect(ctx.sessionProjections.snapshot(session).values.subagentTiming?.active).toBeDefined()
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(ctx.sessionProjections.snapshot(session).values.subagentTiming).toMatchObject({ lastTurnCompleted: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores child identity and clears it when a later descriptor is unusable', () => {
    const unit = subagentIdentityProjectionDefinition
    let state: Parameters<typeof unit.apply>[0] = unit.init()
    expect(unit.apply(state, event('turn/start', 0, 0))).toBe(state)
    const cases = [
      { data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'synthetic' }, value: { mode: 'one-shot' } },
      { data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'synthetic', label: 'named' },
        value: { mode: 'one-shot', label: 'named' } },
      { data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'synthetic', label: 'child' },
        value: { mode: 'continuable', label: 'child' } },
      { data: { version: SUBAGENT_DESCRIPTOR_VERSION + 1 }, value: null },
      { data: { version: SUBAGENT_DESCRIPTOR_VERSION }, value: null },
    ]
    for (const [seq, input] of cases.entries()) {
      const descriptor = { ...event('subagent/descriptor', seq, seq), data: input.data } as SessionEvent
      state = unit.apply(state, descriptor)
      expect(unit.wire.viewSchema.parse(unit.wire.view(state)))
        .toEqual(input.value === null ? null : { ...input.value, seq })
    }
  })

  it('keeps timing state stable for active events at the same recorded time', () => {
    const unit = subagentTimingProjectionDefinition
    const descriptor = unit.apply(unit.init(), event('subagent/descriptor', 0, 100))
    const active = unit.apply(descriptor, event('turn/start', 1, 200))
    expect(unit.apply(active, event('assistant/attempt', 2, 200))).toBe(active)
    expect(unit.apply(active, event('assistant/attempt', 3, 250))).toEqual({
      ...active, active: { since: 200, through: 250 },
    })
  })

  it('registers with the optional session projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const serviceFiber = await ctx.plugin(SubagentRuntime)

    const before = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(before.subagentTiming).toEqual({ settledMs: 0 })
    // The identity unit registers alongside timing; an empty log serves its
    // serializable null sentinel.
    expect(before.subagent).toBeNull()
    await serviceFiber.dispose()
    const after = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(after.subagentTiming).toBeUndefined()
    expect(after.subagent).toBeUndefined()
  })

  it('resets inherited seed timing at the child descriptor and sums later completed turns', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 300),
      event('turn/start', 3, 1_000),
      event('subagent/descriptor', 4, 1_100),
      event('turn/end', 5, 4_100),
      event('turn/start', 6, 10_000),
      event('turn/end', 7, 12_000),
    ])).toEqual({ settledMs: 5_100, lastTurnCompleted: true })
  })

  it('exposes an open turn start and never subtracts time for reversed boundaries', () => {
    expect(fold([
      event('turn/start', 0, 1_000),
      event('subagent/descriptor', 1, 1_100),
      event('turn/end', 2, 900),
      event('turn/start', 3, 2_000),
      event('assistant/attempt', 4, 2_500),
    ])).toEqual({ settledMs: 0, active: { since: 2_000, through: 2_500 } })
  })

  it('publishes only the latest closed turn completion and clears it when another turn opens', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 200),
      event('turn/start', 3, 300),
      event('turn/end', 4, 400, { kind: 'interrupted' }),
    ])).toEqual({ settledMs: 200, lastTurnCompleted: false })

    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 200),
      event('turn/start', 3, 300),
    ])).toEqual({ settledMs: 100, active: { since: 300, through: 300 } })
  })

  it('ignores completed pre-descriptor turns and unrelated events', () => {
    const initial = subagentTimingProjectionDefinition.init()
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('assistant/attempt', 0, 1),
    )).toBe(initial)
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('turn/end', 1, 2),
    )).toBe(initial)
    const descriptor = subagentTimingProjectionDefinition.apply(
      initial,
      event('subagent/descriptor', 2, 3),
    )
    expect(subagentTimingProjectionDefinition.apply(
      descriptor,
      event('turn/end', 3, 4),
    )).toBe(descriptor)
    expect(fold([
      event('turn/start', 0, 100),
      event('turn/end', 1, 200),
      event('subagent/descriptor', 2, 300),
    ])).toEqual({ settledMs: 0 })
  })
})
