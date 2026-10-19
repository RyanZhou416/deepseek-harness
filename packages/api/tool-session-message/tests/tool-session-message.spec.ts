import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import * as tool from '../src/index.ts'

let context: Context | undefined
let nextCall = 0
const sends = new WeakMap<Agent, ReturnType<typeof vi.fn<Agent['send']>>>()

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

function makeAgent(ctx: Context, id: string, cwd?: string, origin?: 'subagent'): Agent {
  const session = ctx.sessions.create(SessionId(id), {
    meta: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(origin === undefined ? {} : { origin, parentSession: SessionId('unrelated-parent') }),
    },
  })
  const send = vi.fn<Agent['send']>()
  const agent = {
    id: session.id,
    session,
    ctx,
    status: 'idle',
    send,
  } as unknown as Agent
  sends.set(agent, send)
  return agent
}

function sendOf(agent: Agent): ReturnType<typeof vi.fn<Agent['send']>> {
  const send = sends.get(agent)
  if (send === undefined) throw new Error(`missing send spy for ${agent.id}`)
  return send
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
  const create = vi.fn<SessionController['create']>()
  const rename = vi.fn<SessionController['rename']>()
  const sessionController = Object.assign(Object.create(SessionController.prototype) as SessionController, {
    inspect, resolveAgent, create, rename,
  })
  ctx.provide('sessionController', sessionController)
  const currentSelection = vi.fn().mockReturnValue({ provider: 'test-provider', model: 'test-model' })
  ctx.provide('agentDefaultModel', {
    currentSelection,
    saveSelection: vi.fn(),
  } as never)
  ctx.provide('sessionTitle', {
    get: vi.fn(() => undefined),
  } as never)
  const current = vi.fn<PermissionPresetService['current']>().mockReturnValue('workspace-write')
  const resolve = vi.fn<PermissionPresetService['resolve']>().mockReturnValue({
    sandbox: 'workspace-write', approval: 'ask',
  })
  const set = vi.fn<PermissionPresetService['set']>()
  const permissionService = Object.assign(Object.create(PermissionPresetService.prototype) as PermissionPresetService, {
    current, resolve, set,
  })
  ctx.provide('permissionPresets', permissionService)
  const listCandidates = vi.fn<SessionReferenceResolver['listCandidates']>()
  ctx.provide('sessionReferenceResolver', { listCandidates } as unknown as SessionReferenceResolver)
  const listSessions = vi.fn<SessionQueryEngine['listSessions']>().mockResolvedValue([])
  ctx.provide('sessionQuery', { listSessions } as unknown as SessionQueryEngine)
  const pinnedState: { ids: SessionId[] } = { ids: [] }
  const pinSession = vi.fn(async (id: SessionId) => {
    pinnedState.ids = [id, ...pinnedState.ids.filter(candidate => candidate !== id)]
  })
  const unpinSession = vi.fn(async (id: SessionId) => {
    pinnedState.ids = pinnedState.ids.filter(candidate => candidate !== id)
  })
  const archiveSession = vi.fn(async () => undefined)
  const workspaceRegistry = {
    list: vi.fn(() => []),
    get pinnedSessionIds() { return pinnedState.ids },
    pinSession,
    unpinSession,
    archiveSession,
  }
  ctx.provide('workspaceRegistry', workspaceRegistry as never)
  const fiber = await ctx.plugin(tool)
  return {
    ctx, fiber, inspect, listCandidates, listSessions, resolveAgent, create, rename, currentSelection,
    permissions: { current, resolve, set }, workspace: { archiveSession, pinSession, unpinSession, pinnedState },
  }
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

function createSession(ctx: Context, args: unknown, agent?: Agent, signal = new AbortController().signal) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`session-create-${String(++nextCall)}`),
    name: 'session_create',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

function runSessionTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
  signal = new AbortController().signal,
) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`session-tool-${String(++nextCall)}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('dsh-tool-session-message', () => {
  it('registers an exact-id context-injection tool with prompt-only loop guidance', async () => {
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
    expect(schema.description).toContain('wakes an idle target')
    expect(schema.description).toContain('ordinary next-turn user queue')
    const sessionIdParameter = properties.session_id as { description?: unknown }
    expect(sessionIdParameter.description).toContain('Do not use a subagent or teammate id here.')
    expect(sessionIdParameter.description).toContain('session_create result')
    const create = ctx.tools.schemas().find(candidate => candidate.name === 'session_create')
    expect(create?.description).toContain('user explicitly asks for a separate conversation')
    expect(create?.description).toContain('global model selection')
    expect(Object.keys((create?.parameters as { properties?: Record<string, unknown> }).properties ?? {}))
      .toEqual(['task', 'name', 'model', 'reasoning_effort', 'pinned'])
    const workspace = ctx.tools.schemas().find(candidate => candidate.name === 'session_workspace')
    expect(workspace?.description).toContain('user-authorized')
    expect(workspace?.description).toContain('one archive')
    expect(workspace?.description).toContain('long-term')
    expect(workspace?.description).toContain('rename')
    expect(Object.keys((workspace?.parameters as { properties?: Record<string, unknown> }).properties ?? {}))
      .toEqual(['action', 'session_id', 'title'])
    expect(ctx.tools.schemas().some(candidate => candidate.name === 'session_archive')).toBe(false)
    expect(ctx.tools.schemas().some(candidate => candidate.name === 'session_pin')).toBe(false)
    expect(ctx.tools.schemas().some(candidate => candidate.name === 'session_unpin')).toBe(false)
    const status = ctx.tools.schemas().find(candidate => candidate.name === 'session_message_status')
    expect(status?.description).toContain('do not poll')
    expect(status?.description).toContain('terminal_send')
    const find = ctx.tools.schemas().find(candidate => candidate.name === 'session_find')
    expect(find?.description).toContain('case-insensitive title')
    expect(find?.description).toContain('Delegated child Sessions')
    expect(find?.description).toContain('instead of guessing')
  })

  it('creates an independent Session and wakes its initial attributed task after copying permissions', async () => {
    const { ctx, create, permissions, resolveAgent } = await setup()
    const sender = makeAgent(ctx, 'creator-session', '/workspace')
    const target = makeAgent(ctx, 'new-independent-session', '/workspace')
    await ctx.agents.register(sender)
    await ctx.agents.register(target)
    create.mockResolvedValueOnce({ sessionId: target.id })

    const result = await createSession(ctx, { task: 'Investigate the new work independently.' }, sender)

    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain(`Independent Session ${target.id} created`)
    expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: '/workspace' })
    expect(permissions.current).toHaveBeenCalledWith(sender.session)
    expect(permissions.resolve).toHaveBeenCalledExactlyOnceWith('workspace-write')
    expect(permissions.set).toHaveBeenCalledExactlyOnceWith(target.session, 'workspace-write')
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(sendOf(target)).toHaveBeenCalledOnce()
    expect(permissions.set.mock.invocationCallOrder[0]).toBeLessThan(sendOf(target).mock.invocationCallOrder[0]!)
    expect(sendOf(target).mock.calls[0]![1]).toBe('next-step')
    expect(sendOf(target).mock.calls[0]![2]).toBe(true)
    const message = sendOf(target).mock.calls[0]![0]
    expect(message.source).toEqual({
      kind: 'agent-message', form: 'relay', senderSessionId: sender.id,
    })
    const initialFrame = message.content[0]
    if (initialFrame?.type !== 'text') throw new Error('initial task frame is not text')
    expect(initialFrame.text).toContain('initial task')
    expect(message.content[1]).toEqual({ type: 'text', text: 'Investigate the new work independently.' })
    expect(target.session.header.parentSession).toBeUndefined()
    expect(target.session.header.origin).toBeUndefined()
  })

  it('applies a title and pin, and reports the global model instead of requested overrides', async () => {
    const { ctx, create, rename, currentSelection, workspace } = await setup()
    const sender = makeAgent(ctx, 'creator-with-options', '/workspace')
    const target = makeAgent(ctx, 'created-with-options', '/workspace')
    await ctx.agents.register(sender)
    await ctx.agents.register(target)
    create.mockResolvedValueOnce({ sessionId: target.id })
    rename.mockResolvedValueOnce({ title: 'Chosen title', seq: 7 })
    currentSelection.mockReturnValueOnce({ provider: 'global-provider', model: 'global-model', reasoningEffort: 'high' })

    const result = await createSession(ctx, {
      task: 'Work with the selected options.',
      name: '  Chosen title  ',
      model: 'requested-model',
      reasoning_effort: 'low',
      pinned: true,
    }, sender)

    expect(result.isError).toBe(false)
    expect(rename).toHaveBeenCalledWith({ sessionId: target.id, title: 'Chosen title' })
    expect(workspace.pinSession).toHaveBeenCalledWith(target.id)
    const text = resultText(result)
    expect(text).toContain('global-provider/global-model')
    expect(text).toContain('high')
    expect(text).toContain('Chosen title')
    expect(text).toContain('pinned true')
    expect(text).not.toContain('requested-model')
    expect(text).not.toContain('low')
  })

  it('archives, pins, unpins, and renames an exact Session and reports actual state', async () => {
    const { ctx, workspace, rename } = await setup()
    const caller = makeAgent(ctx, 'workspace-tool-caller', '/workspace')
    await ctx.agents.register(caller)

    const archived = await runSessionTool(ctx, 'session_workspace', { action: 'archive', session_id: 'archived-session' }, caller)
    expect(archived.isError).toBe(false)
    expect(workspace.archiveSession).toHaveBeenCalledExactlyOnceWith(SessionId('archived-session'))
    expect(resultText(archived)).toContain('archived: true')

    const pinned = await runSessionTool(ctx, 'session_workspace', { action: 'pin', session_id: 'pinned-session' }, caller)
    expect(pinned.isError).toBe(false)
    expect(workspace.pinSession).toHaveBeenCalledWith(SessionId('pinned-session'))
    expect(resultText(pinned)).toContain('pinned: true')

    const unpinned = await runSessionTool(ctx, 'session_workspace', { action: 'unpin', session_id: 'pinned-session' }, caller)
    expect(unpinned.isError).toBe(false)
    expect(workspace.unpinSession).toHaveBeenCalledWith(SessionId('pinned-session'))
    expect(resultText(unpinned)).toContain('pinned: false')

    rename.mockResolvedValueOnce({ title: 'Renamed title', seq: SessionSeq(9) })
    const renamed = await runSessionTool(ctx, 'session_workspace', {
      action: 'rename', session_id: 'renamed-session', title: '  Renamed title  ',
    }, caller)
    expect(renamed.isError).toBe(false)
    expect(rename).toHaveBeenCalledWith({ sessionId: SessionId('renamed-session'), title: 'Renamed title' })
    expect(resultText(renamed)).toContain('renamed to "Renamed title"')
  })

  it('rejects a blank created name', async () => {
    const { ctx, create } = await setup()
    const sender = makeAgent(ctx, 'option-validation-creator', '/workspace')
    const target = makeAgent(ctx, 'option-validation-target', '/workspace')
    await ctx.agents.register(sender)
    await ctx.agents.register(target)
    create.mockResolvedValue({ sessionId: target.id })

    expect((await createSession(ctx, { task: 'task', name: '   ' }, sender)).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects delegated creators, missing workspaces, blank tasks, custom permissions, and cancellation before creation', async () => {
    const { ctx, create, permissions } = await setup()
    const delegated = makeAgent(ctx, 'delegated-creator', '/workspace', 'subagent')
    const noCwd = makeAgent(ctx, 'missing-cwd')
    const root = makeAgent(ctx, 'valid-creator', '/workspace')
    await ctx.agents.register(delegated)
    await ctx.agents.register(noCwd)
    await ctx.agents.register(root)

    expect((await createSession(ctx, { task: 'task' }, delegated)).isError).toBe(true)
    expect((await createSession(ctx, { task: 'task' }, noCwd)).isError).toBe(true)
    expect((await createSession(ctx, { task: ' ' }, root)).isError).toBe(true)
    permissions.current.mockReturnValueOnce('custom')
    expect(resultText(await createSession(ctx, { task: 'task' }, root))).toContain('select a configured permission preset')
    permissions.current.mockReturnValueOnce('auto')
    expect(resultText(await createSession(ctx, { task: 'task' }, root))).toContain('current-session-only Auto permissions')
    const aborted = new AbortController()
    aborted.abort()
    expect((await createSession(ctx, { task: 'task' }, root, aborted.signal)).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('reports the created id but never starts work when the caller stops before admission', async () => {
    const { ctx, create } = await setup()
    const sender = makeAgent(ctx, 'creator-stopping', '/workspace')
    const target = makeAgent(ctx, 'created-but-unstarted', '/workspace')
    const unregister = await ctx.agents.register(sender)
    await ctx.agents.register(target)
    create.mockImplementationOnce(async () => {
      await unregister()
      return { sessionId: target.id }
    })

    const result = await createSession(ctx, { task: 'Do not start after caller disposal.' }, sender)

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(`created Session "${target.id}" but did not accept its initial task`)
    expect(sendOf(target)).not.toHaveBeenCalled()
  })

  it('does not deliver if the caller changes permissions during creation', async () => {
    const { ctx, create, permissions } = await setup()
    const sender = makeAgent(ctx, 'creator-changing-permissions', '/workspace')
    const target = makeAgent(ctx, 'unstarted-after-permission-change', '/workspace')
    await ctx.agents.register(sender)
    await ctx.agents.register(target)
    permissions.current.mockReturnValueOnce('workspace-write').mockReturnValueOnce('custom')
    create.mockResolvedValueOnce({ sessionId: target.id })

    const result = await createSession(ctx, { task: 'Do not run with changed access.' }, sender)

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(`created Session "${target.id}" but did not accept its initial task`)
    expect(permissions.set).not.toHaveBeenCalled()
    expect(sendOf(target)).not.toHaveBeenCalled()
  })

  it('finds independent Session ids by untrusted title without activating delegated children', async () => {
    const { ctx, listCandidates, listSessions, resolveAgent } = await setup()
    const caller = makeAgent(ctx, 'finder-caller', '/workspace')
    await ctx.agents.register(caller)
    listCandidates.mockResolvedValueOnce([
      {
        sessionId: SessionId('matched-session'),
        label: 'Quarterly migration',
        displayTitle: 'Quarterly migration display',
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
    expect(resultText(result)).toContain('Quarterly migration display')
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
    expect(sendOf(target)).toHaveBeenCalledOnce()
    expect(sendOf(target).mock.calls[0]![1]).toBe('next-step')
    expect(sendOf(target).mock.calls[0]![2]).toBe(true)
    const delivered = sendOf(target).mock.calls[0]![0]
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

  it('uses the production next-step wake lane without opening a next-turn queue', async () => {
    const ctx = new Context()
    context = ctx
    await mountAgentLoopTestDependencies(ctx)
    const resolveAgent = vi.fn<SessionController['resolveAgent']>()
    const inspect = vi.fn<SessionController['inspect']>()
    ctx.provide('sessionController', { inspect, resolveAgent } as unknown as SessionController)
    ctx.provide('sessionReferenceResolver', {
      listCandidates: vi.fn<SessionReferenceResolver['listCandidates']>(),
    } as unknown as SessionReferenceResolver)
    ctx.provide('sessionQuery', {
      listSessions: vi.fn<SessionQueryEngine['listSessions']>().mockResolvedValue([]),
    } as unknown as SessionQueryEngine)
    ctx.provide('permissionPresets', {} as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
      saveSelection: () => Promise.resolve(),
    } as never)
    await ctx.plugin(tool)
    const harness = await mountAgentLoopTestHarness(ctx)
    const sender = await harness.create(SessionId('real-sender'))
    const target = await harness.create(SessionId('real-target'))
    const turnStarted = new Promise<void>((resolve) => {
      const dispose = ctx.on('session/event', (session, event) => {
        if (session !== target.session || event.type !== 'turn/start') return
        dispose()
        resolve()
      })
    })

    const result = await execute(ctx, {
      session_id: target.id,
      message: 'Injected peer context.',
    }, sender)

    expect(result.isError).toBe(false)
    await turnStarted
    await target.whenIdle()
    expect(target.status).toBe('idle')
    expect(target.inbox.nextTurn).toEqual([])
    expect(target.inbox.nextStep).toEqual([])
    expect(target.session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced')).toMatchObject({
      type: 'agent/inbox/spliced',
      data: { target: 'next-step' },
    })
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('allows self-addressing without a policy exception', async () => {
    const { ctx } = await setup()
    const sender = makeAgent(ctx, 'self-session', '/workspace')
    await ctx.agents.register(sender)

    const result = await execute(ctx, {
      session_id: sender.id,
      message: 'Remember this as attributed context.',
    }, sender)

    expect(result.isError).toBe(false)
    expect(sendOf(sender)).toHaveBeenCalledOnce()
  })

  it('cold-resumes an ordinary Session before durable context injection', async () => {
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
      message: 'Retain this context until the Session next runs.',
    }, sender)

    expect(result.isError).toBe(false)
    expect(resolveAgent).toHaveBeenCalledExactlyOnceWith(target.id)
    expect(sendOf(target)).toHaveBeenCalledOnce()
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
    expect(sendOf(target)).not.toHaveBeenCalled()
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
    expect(sendOf(target)).not.toHaveBeenCalled()
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

  it('reports pending-context terminal blocking without waking the target', async () => {
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
        data: { target: 'next-step', start: 0, inserted: [tracked] },
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
    expect(resultText(result)).toContain('pending-context; target running; blocking terminal (terminal_send)')
    expect(sendOf(target)).not.toHaveBeenCalled()
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
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_create')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_send_message')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_message_status')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_find')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_create')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_send_message')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'session_message_status')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-session-message')
    expect(tool.inject).toEqual([
      'tools', 'agents', 'sessionController', 'sessionReferenceResolver', 'sessionQuery', 'permissionPresets',
      'agentDefaultModel',
    ])
    expect(typeof tool.apply).toBe('function')
  })
})
