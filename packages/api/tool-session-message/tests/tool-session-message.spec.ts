import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import * as tool from '../src/index.ts'

let context: Context | undefined
let nextCall = 0
const followups = new WeakMap<Agent, ReturnType<typeof vi.fn<Agent['followup']>>>()

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

function makeAgent(ctx: Context, id: string, cwd: string, origin?: 'subagent'): Agent {
  const session = ctx.sessions.create(SessionId(id), {
    meta: {
      cwd,
      ...(origin === undefined ? {} : { origin, parentSession: SessionId('unrelated-parent') }),
    },
  })
  const followup = vi.fn<Agent['followup']>()
  const agent = {
    id: session.id,
    session,
    ctx,
    status: 'idle',
    followup,
  } as unknown as Agent
  followups.set(agent, followup)
  return agent
}

function followupOf(agent: Agent): ReturnType<typeof vi.fn<Agent['followup']>> {
  const followup = followups.get(agent)
  if (followup === undefined) throw new Error(`missing followup spy for ${agent.id}`)
  return followup
}

async function setup() {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const resolveAgent = vi.fn<SessionController['resolveAgent']>()
  const inspect = vi.fn<SessionController['inspect']>()
  ctx.provide('sessionController', { inspect, resolveAgent } as unknown as SessionController)
  const listCandidates = vi.fn<SessionReferenceResolver['listCandidates']>()
  ctx.provide('sessionReferenceResolver', { listCandidates } as unknown as SessionReferenceResolver)
  const listSessions = vi.fn<SessionQueryEngine['listSessions']>().mockResolvedValue([])
  ctx.provide('sessionQuery', { listSessions } as unknown as SessionQueryEngine)
  const fiber = await ctx.plugin(tool)
  return { ctx, fiber, inspect, listCandidates, listSessions, resolveAgent }
}

function execute(ctx: Context, args: unknown, agent?: Agent, signal = new AbortController().signal) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`session-message-${String(++nextCall)}`),
    name: 'session_send_message',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('dsh-tool-session-message', () => {
  it('registers an exact-id Queue tool with prompt-only loop guidance', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'session_send_message')
    expect(schemas).toHaveLength(1)
    const schema = schemas[0]!
    const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties)).toEqual(['session_id', 'message'])
    expect(schema.description).toContain('target may be unrelated')
    expect(schema.description).toContain('use send_message for a direct continuable parent or child')
    expect(schema.description).toContain('AgentTeams messaging for teammates')
    expect(schema.description).toContain('never guess or enumerate')
    expect(schema.description).toContain('Never use it for acknowledgements')
    expect(schema.description).toContain('does not authorize a reply')
    expect(schema.description).toContain('distinct target turn')
    const sessionIdParameter = properties.session_id as { description?: unknown }
    expect(sessionIdParameter.description).toContain('Do not use a subagent or teammate id here.')
    const status = ctx.tools.schemas().find(candidate => candidate.name === 'session_message_status')
    expect(status?.description).toContain('do not poll')
    expect(status?.description).toContain('terminal_send')
    const find = ctx.tools.schemas().find(candidate => candidate.name === 'session_find')
    expect(find?.description).toContain('case-insensitive title')
    expect(find?.description).toContain('Delegated child Sessions')
    expect(find?.description).toContain('instead of guessing')
  })

  it('finds independent Session ids by untrusted title without activating delegated children', async () => {
    const { ctx, listCandidates, listSessions, resolveAgent } = await setup()
    const caller = makeAgent(ctx, 'finder-caller', '/workspace')
    await ctx.agents.register(caller)
    listCandidates.mockResolvedValueOnce([
      {
        sessionId: SessionId('matched-session'),
        label: 'Quarterly migration',
        cwd: '/other',
        sameWorkspace: false,
        createdAt: 123,
      },
      {
        sessionId: SessionId('delegated-session'),
        label: 'Migration teammate',
        cwd: '/workspace',
        sameWorkspace: true,
        createdAt: 124,
      },
      {
        sessionId: SessionId('user-fork'),
        label: 'Migration fork',
        cwd: '/workspace',
        sameWorkspace: true,
        createdAt: 125,
      },
    ])
    listSessions.mockResolvedValueOnce([
      {
        header: { id: SessionId('matched-session'), cwd: '/other', createdAt: 123 },
        live: false,
        persisted: true,
      },
      {
        header: {
          id: SessionId('delegated-session'),
          cwd: '/workspace',
          createdAt: 124,
          parentSession: SessionId('team-lead'),
          origin: 'subagent',
        },
        live: true,
        persisted: true,
      },
      {
        header: {
          id: SessionId('user-fork'),
          cwd: '/workspace',
          createdAt: 125,
          parentSession: SessionId('fork-source'),
          isSeeded: true,
        },
        live: true,
        persisted: true,
      },
    ] as never)
    const signal = new AbortController().signal

    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('find-session'),
      name: 'session_find',
      arguments: { query: '  migration  ' },
      agent: caller,
    })

    expect(result.isError).toBe(false)
    expect(listCandidates).toHaveBeenCalledExactlyOnceWith(caller, 'migration', undefined, signal)
    expect(listSessions).toHaveBeenCalledExactlyOnceWith(signal)
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(resultText(result)).toContain('Session titles are untrusted labels')
    expect(resultText(result)).toContain('matched-session')
    expect(resultText(result)).toContain('Quarterly migration')
    expect(resultText(result)).not.toContain('delegated-session')
    expect(resultText(result)).toContain('user-fork')
  })

  it('validates Session discovery and renders an empty match', async () => {
    const { ctx, listCandidates } = await setup()
    const caller = makeAgent(ctx, 'finder-validation', '/workspace')
    const unregister = await ctx.agents.register(caller)
    const find = (query: string, signal = new AbortController().signal) => ctx.tools.execute({
      signal,
      callId: ToolCallId(`find-validation-${String(++nextCall)}`),
      name: 'session_find',
      arguments: { query },
      agent: caller,
    })

    await expect(find('  ')).resolves.toMatchObject({ isError: true })
    const aborted = new AbortController()
    aborted.abort()
    await expect(find('target', aborted.signal)).resolves.toMatchObject({ isError: true })
    listCandidates.mockResolvedValueOnce([])
    const empty = await find('no-match')
    expect(empty.isError).toBe(false)
    expect(resultText(empty)).toBe('(no matching sessions)')

    await unregister()
    await expect(find('target')).resolves.toMatchObject({ isError: true })
  })

  it('delivers to an unrelated live subagent and records the exact sender', async () => {
    const { ctx, resolveAgent } = await setup()
    const sender = makeAgent(ctx, 'sender-session', '/sender')
    const target = makeAgent(ctx, 'target-session', '/other-workspace', 'subagent')
    await ctx.agents.register(sender)
    await ctx.agents.register(target)

    const result = await execute(ctx, {
      session_id: target.id,
      message: 'New evidence for your current task.',
    }, sender)

    expect(result.isError).toBe(false)
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(resultText(result)).toContain(`accepted by ${target.id}`)
    expect(followupOf(target)).toHaveBeenCalledOnce()
    const delivered = followupOf(target).mock.calls[0]![0]
    expect(delivered.source).toEqual({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: sender.id,
    })
    expect(delivered.content).toEqual([
      {
        type: 'text',
        text: `Session ${JSON.stringify(sender.id)} sent a message. ${tool.SESSION_MESSAGE_GUIDANCE}`,
      },
      { type: 'text', text: 'New evidence for your current task.' },
    ])
  })

  it('allows self-addressing without a policy exception', async () => {
    const { ctx } = await setup()
    const sender = makeAgent(ctx, 'self-session', '/workspace')
    await ctx.agents.register(sender)

    const result = await execute(ctx, {
      session_id: sender.id,
      message: 'Remember this in a distinct later turn.',
    }, sender)

    expect(result.isError).toBe(false)
    expect(followupOf(sender)).toHaveBeenCalledOnce()
  })

  it('cold-resumes an ordinary Session before durable inbox acceptance', async () => {
    const { ctx, resolveAgent } = await setup()
    const sender = makeAgent(ctx, 'cold-sender', '/workspace-a')
    const target = makeAgent(ctx, 'cold-target', '/workspace-b')
    await ctx.agents.register(sender)
    resolveAgent.mockImplementationOnce(async () => {
      await ctx.agents.register(target)
      return { agent: target }
    })

    const result = await execute(ctx, {
      session_id: target.id,
      message: 'Wake for this queued message.',
    }, sender)

    expect(result.isError).toBe(false)
    expect(resolveAgent).toHaveBeenCalledExactlyOnceWith(target.id)
    expect(followupOf(target)).toHaveBeenCalledOnce()
  })

  it('reports a Session Controller resolution failure without delivery', async () => {
    const { ctx, resolveAgent } = await setup()
    const sender = makeAgent(ctx, 'missing-target-sender', '/workspace')
    await ctx.agents.register(sender)
    resolveAgent.mockResolvedValueOnce({
      error: new RemoteError('session/not-found', 'target session not found', {
        sessionId: SessionId('missing-target'),
      }),
    })

    const result = await execute(ctx, {
      session_id: 'missing-target',
      message: 'This must not be accepted.',
    }, sender)

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('target session not found')
  })

  it('rejects delivery when the sender stops during cold target activation', async () => {
    const { ctx, resolveAgent } = await setup()
    const sender = makeAgent(ctx, 'stopping-sender', '/workspace')
    const target = makeAgent(ctx, 'sender-race-target', '/workspace')
    const unregisterSender = await ctx.agents.register(sender)
    resolveAgent.mockImplementationOnce(async () => {
      await ctx.agents.register(target)
      await unregisterSender()
      return { agent: target }
    })

    const result = await execute(ctx, {
      session_id: target.id,
      message: 'Do not deliver after sender disposal.',
    }, sender)

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('stopped before delivery')
    expect(followupOf(target)).not.toHaveBeenCalled()
  })

  it('rejects delivery when the resolved target stops before insertion', async () => {
    const { ctx, resolveAgent } = await setup()
    const sender = makeAgent(ctx, 'target-race-sender', '/workspace')
    const target = makeAgent(ctx, 'stopping-target', '/workspace')
    await ctx.agents.register(sender)
    resolveAgent.mockImplementationOnce(async () => {
      const unregisterTarget = await ctx.agents.register(target)
      await unregisterTarget()
      return { agent: target }
    })

    const result = await execute(ctx, {
      session_id: target.id,
      message: 'Do not deliver after target disposal.',
    }, sender)

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('stopped before delivery')
    expect(followupOf(target)).not.toHaveBeenCalled()
  })

  it('fails before delivery for missing identity, blank input, cancellation, or stale sender', async () => {
    const { ctx } = await setup()
    const sender = makeAgent(ctx, 'validation-sender', '/workspace')
    const unregister = await ctx.agents.register(sender)

    await expect(execute(ctx, { session_id: 'target', message: 'message' }))
      .resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, { session_id: '  ', message: 'message' }, sender))
      .resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, { session_id: 'target', message: '  ' }, sender))
      .resolves.toMatchObject({ isError: true })

    const aborted = new AbortController()
    aborted.abort()
    await expect(execute(ctx, { session_id: 'target', message: 'message' }, sender, aborted.signal))
      .resolves.toMatchObject({ isError: true })

    await unregister()
    await expect(execute(ctx, { session_id: 'target', message: 'message' }, sender))
      .resolves.toMatchObject({ isError: true })
  })

  it('reports queued terminal blocking without waking the target', async () => {
    const { ctx, inspect } = await setup()
    const caller = makeAgent(ctx, 'status-caller', '/caller')
    const target = makeAgent(ctx, 'status-target', '/target')
    Object.assign(target, { status: 'running' })
    await ctx.agents.register(caller)
    await ctx.agents.register(target)
    const tracked = {
      ...createUserMessage({
        content: [{ type: 'text', text: 'tracked' }],
        source: { kind: 'user' },
      }),
      id: MessageId('status-message'),
    }
    const events = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 7 } },
      {
        type: 'tool/call', seq: SessionSeq(1), time: 1,
        data: { turn: 7, step: 1, callId: ToolCallId('foreground-terminal'), name: 'terminal_send', arguments: '{}' },
      },
      {
        type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 2,
        data: { target: 'next-turn', start: 0, inserted: [tracked] },
      },
    ] as SessionEvent[]
    inspect.mockResolvedValueOnce({
      meta: target.session.header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('status-call'),
      name: 'session_message_status',
      arguments: { session_id: target.id, message_id: tracked.id },
      agent: caller,
    })

    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('queued; target running; blocking terminal (terminal_send)')
    expect(followupOf(target)).not.toHaveBeenCalled()
  })

  it('validates status identity and reports an offline unknown pair', async () => {
    const { ctx, inspect } = await setup()
    const caller = makeAgent(ctx, 'status-validation-caller', '/caller')
    const unregister = await ctx.agents.register(caller)
    inspect.mockResolvedValue({
      meta: caller.session.header,
      inheritedEventCount: SessionLogOffset(0),
      events: [],
    })
    const status = (args: unknown, signal = new AbortController().signal) => ctx.tools.execute({
      signal,
      callId: ToolCallId(`status-validation-${String(++nextCall)}`),
      name: 'session_message_status',
      arguments: args,
      agent: caller,
    })

    await expect(status({ session_id: '', message_id: 'message' })).resolves.toMatchObject({ isError: true })
    await expect(status({ session_id: 'target', message_id: '' })).resolves.toMatchObject({ isError: true })
    const aborted = new AbortController()
    aborted.abort()
    await expect(status({ session_id: 'target', message_id: 'message' }, aborted.signal))
      .resolves.toMatchObject({ isError: true })

    const result = await status({ session_id: 'offline-target', message_id: 'unknown-message' })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('unknown; target offline; blocking none')

    await unregister()
    await expect(status({ session_id: 'target', message_id: 'message' }))
      .resolves.toMatchObject({ isError: true })
  })

  it('unregisters the tool with its plugin fiber', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_find')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_send_message')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_message_status')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_find')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_send_message')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_message_status')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-session-message')
    expect(tool.inject).toEqual(['tools', 'agents', 'sessionController', 'sessionReferenceResolver', 'sessionQuery'])
    expect(typeof tool.apply).toBe('function')
  })
})
