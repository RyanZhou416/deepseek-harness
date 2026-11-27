/**
 * Wire hint views: a unit whose client value grows without bound declares
 * `wire.hintView`, and the Host push faces (`hintValue`, `hintValues`) narrow
 * only what a push carries. The complete faces (snapshot, cached cells,
 * checkpoints, change feeds) keep serving the whole value, and an explicit
 * `session.projections` read therefore stays complete.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/hinted': { entries: number[] }
    'test/complete': { text: string }
  }
}

/** Newest two entries, like a bounded catalog. */
function newestTwo(value: { entries: number[] }): { entries: number[] } {
  return value.entries.length <= 2 ? value : { entries: value.entries.slice(-2) }
}

const hintedUnit = () => ({
  key: 'test/hinted',
  stateSchema: z.object({ entries: z.array(z.number()) }),
  init: () => ({ entries: [] }),
  apply: (state: { entries: number[] }, event) => (event.type === 'turn/start'
    ? { entries: [...state.entries, event.data.turn] }
    : state),
  wire: {
    viewSchema: z.object({ entries: z.array(z.number()) }),
    view: state => state,
    hintView: newestTwo,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/hinted', { entries: number[] }>

const completeUnit = () => ({
  key: 'test/complete',
  stateSchema: z.object({ text: z.string() }),
  init: () => ({ text: '' }),
  apply: (state: { text: string }, event) => (event.type === 'turn/start'
    ? { text: `turn-${String(event.data.turn)}` }
    : state),
  wire: {
    viewSchema: z.object({ text: z.string() }),
    view: state => state,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/complete', { text: string }>

async function mount(): Promise<{ ctx: Context; registry: SessionProjectionRegistry }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, registry: ctx.sessionProjections }
}

describe('session projection wire hints', () => {
  it('narrows one push value while the snapshot keeps the complete value', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(hintedUnit())
      const session = ctx.sessions.create(brandString<SessionId>('hinted'), { meta: { cwd: '/workspace' } })
      for (const turn of [1, 2, 3]) session.append('turn/start', { turn })

      const complete = registry.snapshot(session).values['test/hinted']
      expect(complete).toEqual({ entries: [1, 2, 3] })
      expect(registry.hintValue('test/hinted', complete)).toEqual({ entries: [2, 3] })
      // A value the unit narrows anyway is served unchanged.
      expect(registry.hintValue('test/hinted', { entries: [7] })).toEqual({ entries: [7] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('narrows every value of one pushed block and keeps unbounded keys intact', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(hintedUnit())
      await registry.register(completeUnit())
      const block = { 'test/hinted': { entries: [1, 2, 3] }, 'test/complete': { text: 'kept' } }
      const narrowed = registry.hintValues(block)
      expect(narrowed).not.toBe(block)
      expect(narrowed).toEqual({ 'test/hinted': { entries: [2, 3] }, 'test/complete': { text: 'kept' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns the pushed block unchanged when no selected unit declares a hint', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(completeUnit())
      const block = { 'test/complete': { text: 'kept' } }
      expect(registry.hintValues(block)).toBe(block)
      expect(registry.hintValue('test/complete', { text: 'kept' })).toEqual({ text: 'kept' })
      // An unregistered key cannot resolve a unit and passes through.
      expect(registry.hintValue('test/hinted', { entries: [1, 2, 3] })).toEqual({ entries: [1, 2, 3] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes values through after the unit unregisters', async () => {
    const { ctx, registry } = await mount()
    try {
      const handle = await registry.register(hintedUnit())
      await handle.dispose()
      expect(registry.hintValue('test/hinted', { entries: [1, 2, 3] })).toEqual({ entries: [1, 2, 3] })
      expect(registry.hintValues({ 'test/hinted': { entries: [1, 2, 3] } })).toEqual({ 'test/hinted': { entries: [1, 2, 3] } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to share one key between registrations that disagree on a hint view', async () => {
    const { ctx, registry } = await mount()
    try {
      await registry.register(hintedUnit())
      const { hintView: _dropped, ...unhinted } = hintedUnit().wire
      await expect(Promise.resolve(registry.register({ ...hintedUnit(), wire: unhinted }))).rejects.toThrow(/test\/hinted.*already registered with a different wire hint declaration/)
      await expect(Promise.resolve(registry.register(completeUnit()))).resolves.toBeDefined()
      await expect(Promise.resolve(registry.register({
        ...completeUnit(),
        wire: { ...completeUnit().wire, hintView: (value: { text: string }) => ({ text: value.text.slice(0, 2) }) },
      }))).rejects.toThrow(/test\/complete.*already registered with a different wire hint declaration/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
