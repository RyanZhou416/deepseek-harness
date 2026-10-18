import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionQueryEngine, SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionMetadataObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'

/** Concrete query engine for the host test: search is not part of this behavior. */
class RejectingSearchEngine extends SessionQueryEngine {
  searchSessions(): Promise<never> {
    return Promise.reject(new Error('searchSessions is not used by the skill catalog'))
  }

  searchEvents(): Promise<never> {
    return Promise.reject(new Error('searchEvents is not used by the skill catalog'))
  }
}

function metadata(
  sessionId: SessionId,
  options: {
    readonly cwd?: string
    readonly workingDirectory?: string | null
    readonly agentPreset?: string | null
  } = {},
): SessionMetadataObservation {
  const present = options.workingDirectory !== undefined || options.agentPreset !== undefined
  return {
    header: {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
    },
    ...present
      ? {
        projections: {
          asOfSeq: SessionSeq(1),
          values: {
            ...options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory },
            ...options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
          },
        },
      }
      : {},
  }
}

/** A query service whose metadata read is scripted; a full observation must never run. */
function scriptedQuery(read: () => Promise<SessionMetadataObservation>) {
  const observeSession = vi.fn(() =>
    Promise.reject(new Error('skills/list must not observe the complete log')))
  const observeSessionMetadata = vi.fn(read)
  return { sessionQuery: { observeSession, observeSessionMetadata } as never, observeSession, observeSessionMetadata }
}

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  provideWorkingDirectoryFixture(ctx, '/catalog/default')
  return ctx
}

/** Balanced synthetic turns, used to build one stored log of `turns` * 2 events. */
function turns(count: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= count; turn += 1) {
    events.push({ type: 'turn/start', seq: SessionSeq(events.length), time: 1, data: { turn } })
    events.push({ type: 'turn/end', seq: SessionSeq(events.length), time: 2, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

afterEach(async () => {
  vi.restoreAllMocks()
})

describe('SessionSkillCatalog', () => {
  it('reads a moved cold Session catalog from durable metadata without observing the log', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('cold-skills')
      const read = scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/cold/original', workingDirectory: '/cold/project',
      })))
      ctx.provide('sessionQuery', read.sessionQuery)
      const resume = vi.spyOn(ctx.agents, 'resume')
      const ensureDirectory = vi.spyOn(ctx.workingDirectory, 'ensure')
      const list = vi.fn(() => Promise.resolve([
        {
          name: 'review',
          description: 'Review the current change.',
          whenToUse: 'Before publishing.',
          path: '/cold/project/.agents/skills/review/SKILL.md',
          invocation: { modelInvocable: true, userInvocable: true },
        },
        {
          name: 'model-only',
          description: 'Not shown to the user.',
          invocation: { modelInvocable: true, userInvocable: false },
        },
      ]))
      ctx.provide('skills', { list } as never)
      const catalog = new SessionSkillCatalog(ctx)

      const signal = new AbortController().signal
      await expect(catalog.list({ sessionId }, signal)).resolves.toEqual({
        skills: [{
          name: 'review',
          description: 'Review the current change.',
          whenToUse: 'Before publishing.',
          path: '/cold/project/.agents/skills/review/SKILL.md',
          modelInvocable: true,
        }],
      })
      expect(read.observeSessionMetadata).toHaveBeenCalledExactlyOnceWith(sessionId, {
        signal,
        projectionKeys: ['workingDirectory', 'agentPreset'],
      })
      expect(read.observeSession).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
      expect(ensureDirectory).not.toHaveBeenCalled()
      expect(ctx.agents.list()).toEqual([])
      expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { cwd: undefined, workingDirectory: '/cold/current', expected: '/cold/current' },
    { cwd: '/cold/original', workingDirectory: null, expected: '/cold/original' },
    { cwd: undefined, workingDirectory: null, expected: '/catalog/default' },
    { cwd: undefined, workingDirectory: undefined, expected: '/catalog/default' },
  ])('resolves cold directory metadata $cwd / $workingDirectory to $expected without filesystem checks', async ({ cwd, workingDirectory, expected }) => {
    const ctx = await context()
    try {
      const sessionId = SessionId('cold-directory-fallback')
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        ...cwd === undefined ? {} : { cwd },
        ...workingDirectory === undefined ? {} : { workingDirectory },
      }))).sessionQuery)
      const list = vi.fn(() => Promise.resolve([]))
      ctx.provide('skills', { list } as never)
      const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
      const resume = vi.spyOn(ctx.agents, 'resume')
      await expect(new SessionSkillCatalog(ctx).list({ sessionId }, new AbortController().signal))
        .resolves.toEqual({ skills: [] })
      expect(list).toHaveBeenCalledWith({ cwd: expected, scope: undefined })
      expect(ensure).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves a header-only cold catalog when no checkpoint projections are available', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('header-only-skills')
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/cold/original',
      }))).sessionQuery)
      const list = vi.fn(() => Promise.resolve([]))
      ctx.provide('skills', { list } as never)

      await expect(new SessionSkillCatalog(ctx).list({ sessionId }, new AbortController().signal))
        .resolves.toEqual({ skills: [] })
      expect(list).toHaveBeenCalledWith({ cwd: '/cold/original', scope: undefined })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses a live Agent to address a preset-owned registry', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('live-skills')
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/live/project' } })
      const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
      await ctx.agents.register(agent)
      const ensureDirectory = vi.spyOn(ctx.workingDirectory, 'ensure').mockResolvedValue('/live/current')
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/live/project',
      }))).sessionQuery)
      const scopedList = vi.fn(() => Promise.resolve([{
        name: 'preset-owned',
        description: 'Composed for this Agent.',
        invocation: { modelInvocable: false, userInvocable: true },
      }]))
      const acquireScope = vi.fn()
      ctx.provide('agentPresets', {
        serviceFor: () => ({ list: scopedList }),
        acquireScope,
      } as never)
      const catalog = new SessionSkillCatalog(ctx)

      await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({
        skills: [{
          name: 'preset-owned',
          description: 'Composed for this Agent.',
          modelInvocable: false,
        }],
      })
      expect(scopedList).toHaveBeenCalledWith({ cwd: '/live/current', scope: agent })
      expect(ensureDirectory).toHaveBeenCalledWith(agent, expect.any(AbortSignal))
      expect(session.header.cwd).toBe('/live/project')
      expect(acquireScope).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the recorded preset standing scope for a cold Session', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('standing-skills')
      const scope = { agentPreset: 'minimal' }
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/cold/project',
        agentPreset: 'minimal',
      }))).sessionQuery)
      const acquireScope = vi.fn(() => Promise.resolve({ key: scope, [Symbol.asyncDispose]: async () => {} }))
      ctx.provide('agentPresets', { acquireScope } as never)
      const list = vi.fn(() => Promise.resolve([]))
      ctx.provide('skills', { list } as never)
      const catalog = new SessionSkillCatalog(ctx)

      await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({ skills: [] })
      expect(acquireScope).toHaveBeenCalledWith('minimal')
      expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope })
      expect(ctx.agents.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the global registry when the recorded preset is unavailable', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('gone-preset')
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/cold/project',
        agentPreset: 'gone',
      }))).sessionQuery)
      ctx.provide('agentPresets', {
        acquireScope: () => Promise.reject(new Error('unknown preset')),
      } as never)
      const list = vi.fn(() => Promise.resolve([]))
      ctx.provide('skills', { list } as never)
      const catalog = new SessionSkillCatalog(ctx)

      await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({ skills: [] })
      expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    {
      error: new SessionQueryError(
        'session "missing-skills" not found',
        'SESSION_QUERY_SESSION_NOT_FOUND',
      ),
      code: 'session/not-found',
    },
    { error: new Error('storage offline'), code: 'gateway/internal' },
  ] as const)('classifies failed Session inspection as $code', async ({ error, code }) => {
    const ctx = await context()
    try {
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.reject(error)).sessionQuery)
      const catalog = new SessionSkillCatalog(ctx)

      await expect(catalog.list(
        { sessionId: SessionId('missing-skills') },
        new AbortController().signal,
      )).rejects.toMatchObject({ code })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an absent skill registry instead of an empty catalog', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('no-skills')
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/project',
      }))).sessionQuery)
      const catalog = new SessionSkillCatalog(ctx)

      const failed = catalog.list({ sessionId }, new AbortController().signal)
      await expect(failed).rejects.toMatchObject({ code: 'gateway/internal' })
      await expect(failed).rejects.toThrow('skill registry is absent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('classifies a provider listing failure', async () => {
    const ctx = await context()
    try {
      const sessionId = SessionId('failed-skills')
      ctx.provide('sessionQuery', scriptedQuery(() => Promise.resolve(metadata(sessionId, {
        cwd: '/project',
      }))).sessionQuery)
      ctx.provide('skills', {
        list: () => Promise.reject(new Error('catalog offline')),
      } as never)
      const catalog = new SessionSkillCatalog(ctx)

      await expect(catalog.list({ sessionId }, new AbortController().signal))
        .rejects.toMatchObject({
          code: 'gateway/internal', message: 'skill listing failed: Error: catalog offline',
        })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists a cold multi-frame stored Session without opening its log', async () => {
    const ctx = await context()
    const root = await mkdtemp(join(tmpdir(), 'dsh-skills-cold-'))
    try {
      const sessionId = SessionId('cold-large-skills')
      const stored: SessionEvent[] = turns(3_000)
      const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
      const writer = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION,
        id: sessionId,
        createdAt: 1,
        isSeeded: false,
        cwd: '/cold/original',
      })
      // Separate append batches produce separate durable frames.
      for (let start = 0; start < stored.length; start += 500) {
        await writer.append(stored.slice(start, start + 500))
      }
      await writer.flush()
      await writer.close()

      await ctx.plugin(RejectingSearchEngine)
      const scope = { agentPreset: 'minimal' }
      const acquireScope = vi.fn(() => Promise.resolve({ key: scope, [Symbol.asyncDispose]: async () => {} }))
      ctx.provide('agentPresets', { acquireScope } as never)
      const cachedSnapshot = vi.fn(() => ({
        asOfSeq: stored.length - 1,
        values: { workingDirectory: '/cold/project', agentPreset: 'minimal' },
      }))
      ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)
      const list = vi.fn(() => Promise.resolve([{
        name: 'cold-review',
        description: 'Found through the retained preset scope.',
        invocation: { modelInvocable: true, userInvocable: true },
      }]))
      ctx.provide('skills', { list } as never)

      const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
      const open = vi.spyOn(ctx.sessionPersistence, 'open')
      const observeSession = vi.spyOn(ctx.sessionQuery, 'observeSession')

      const started = performance.now()
      const listed = await new SessionSkillCatalog(ctx).list({ sessionId }, new AbortController().signal)
      const listMs = performance.now() - started
      expect(listed).toEqual({
        skills: [{
          name: 'cold-review',
          description: 'Found through the retained preset scope.',
          modelInvocable: true,
        }],
      })

      // One metadata read: the stored log is never opened or materialized.
      expect(stat).toHaveBeenCalledOnce()
      expect(open).not.toHaveBeenCalled()
      expect(observeSession).not.toHaveBeenCalled()
      expect(cachedSnapshot).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: sessionId, cwd: '/cold/original' }),
        ['workingDirectory', 'agentPreset'],
      )
      expect(acquireScope).toHaveBeenCalledWith('minimal')
      expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope })
      // Loose tripwire only: the zero-open assertion above is the causal proof.
      // A return to cold complete-log materialization costs seconds on a real
      // multi-megabyte history, far outside this bound.
      expect(listMs).toBeLessThan(1_000)

      // Negative control: the same stored Session does open the log through the
      // complete-observation path this catalog no longer uses.
      await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      expect(open).toHaveBeenCalledOnce()

      await persistenceFiber.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
