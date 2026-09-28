/** Last-message edits regenerate from H + U' while preserving the original H + U + A. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestRemote } from './test-remote.ts'
import type { SessionEditLastMessageRequest, SessionRequestId } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const userEvents = (session: Session) => session.snapshotEvents().filter(
  (event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'user',
)

async function setup(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('history answer'), textResponse('obsolete answer'), textResponse('new answer')]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const source = await harness.create(SessionId('edit-source'), { provider: 'mock', model: 'mock' })
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp',
  })
  const edit = (seq: number, text = 'revised question', requestId = 'revision-1'): SessionEditLastMessageRequest => ({
    sessionId: source.id, seq, text, requestId: requestId as SessionRequestId,
  })
  return { ctx, source, adapter, remote, edit }
}

describe('editing the latest user message', () => {

  it('rejects revision placement when its input projection is unavailable', async () => {
    const { ctx, source } = await setup()
    const revised = createUserMessage({ content: [{ type: 'text', text: 'revision' }], source: { kind: 'user', replacesUserMessage: SessionSeq(0) } })
    const dispatch = agentEvents(ctx, source)
    const unavailable = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    try {
      expect(() => { dispatch.waterfall('agent/prepare-input', { messages: [revised] }, () => {}) })
        .toThrow('requires the userInput projection')
    } finally { unavailable.mockRestore() }
  })

  it('refuses stale queued revisions and missing draft placement without changing history', async () => {
    const { ctx, source } = await setup([textResponse('answer')])
    const dispatch = agentEvents(ctx, source)
    const revised = (seq: number) => createUserMessage({ content: [{ type: 'text', text: 'revision' }], source: { kind: 'user', replacesUserMessage: SessionSeq(seq) } })
    expect(() => { dispatch.waterfall('agent/prepare-input', { messages: [revised(0)] }, () => {}) })
      .toThrow('no longer the latest current user message')
    source.followup(message('original'))
    await source.whenIdle()
    const original = userEvents(source.session)[0]!
    const before = source.session.snapshotEvents()
    expect(() => { dispatch.waterfall('agent/prepare-input', { messages: [revised(original.seq + 1)] }, () => {}) })
      .toThrow('no longer the latest current user message')
    expect(() => dispatch.waterfall('agent/message-surface', { message: revised(original.seq) }, () => ({ surfaceOp: 'append' })))
      .toThrow('pending user revision is no longer')
    expect(source.session.snapshotEvents()).toEqual(before)
    dispatch.waterfall('agent/prepare-input', { messages: [revised(original.seq)] }, () => {})
    const draft = userEvents(source.session).at(-1)!
    source.session.append('user/message', message('replacement context'), {
      surfaceOp: { op: 'replace', startSeq: draft.seq, endSeq: draft.seq }, sourceEventSeqs: [draft.seq],
    })
    const replaced = source.session.snapshotEvents()
    expect(() => dispatch.waterfall('agent/message-surface', { message: revised(original.seq) }, () => ({ surfaceOp: 'append' })))
      .toThrow('pending user revision is no longer')
    expect(source.session.snapshotEvents()).toEqual(replaced)
  })

  it('sends only H + U-prime inside the same Session and accepts submission retries once', async () => {
    const { ctx, source, adapter, remote, edit } = await setup()
    source.followup(message('history question'))
    await source.whenIdle()
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const before = source.session.snapshotEvents()
    const request = edit(userEvents(source.session).at(-1)!.seq)
    const [first, simultaneous] = await Promise.all([remote.editLastMessage(request), remote.editLastMessage(request)])
    expect(first).toEqual(simultaneous)
    if (!first.ok) throw first.error
    await source.whenIdle()
    expect(adapter.requests, JSON.stringify(source.session.snapshotEvents().at(-1))).toHaveLength(3)
    expect(adapter.requests[2]!.messages.slice(0, -1)).toEqual(adapter.requests[1]!.messages.slice(0, -1))
    expect(adapter.requests[2]!.messages.filter(entry => entry.role !== 'system').flatMap(entry => entry.content.flatMap(
      block => block.type === 'text' ? [block.text] : [],
    ))).toEqual(['history question', 'history answer', 'revised question'])
    expect(source.session.snapshotEvents().slice(0, before.length)).toEqual(before)
    expect(ctx.agents.list()).toHaveLength(1)
    expect(source.session.header.parentSession).toBeUndefined()
    expect(userEvents(source.session).at(-1)?.surfaceOp).toMatchObject({ op: 'replace' })
    expect(await remote.editLastMessage(request)).toEqual(first)
    await source.whenIdle()
    expect(adapter.requests, JSON.stringify(source.session.snapshotEvents().at(-1))).toHaveLength(3)
  })

  it('edits the first prompt without bringing its previous answer into the new request', async () => {
    const { source, adapter, remote, edit } = await setup([textResponse('obsolete answer'), textResponse('new answer')])
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const result = await remote.editLastMessage(edit(userEvents(source.session)[0]!.seq))
    if (!result.ok) throw result.error
    await source.whenIdle()
    expect(adapter.requests[1]!.messages.filter(entry => entry.role !== 'system').flatMap(entry => entry.content.flatMap(
      block => block.type === 'text' ? [block.text] : [],
    ))).toEqual(['revised question'])
  })

  it('replays repeated revisions without restoring obsolete prompts or answers', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([
      textResponse('old answer'), textResponse('first revised answer'), textResponse('second revised answer'),
    ])
    source.followup(message('old prompt'))
    await source.whenIdle()
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq))).ok).toBe(true)
    await source.whenIdle()
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq, 'second revision', 'revision-2'))).ok).toBe(true)
    await source.whenIdle()
    expect(adapter.requests[2]!.messages.filter(entry => entry.role === 'user').flatMap(entry => entry.content))
      .toEqual([{ type: 'text', text: 'second revision' }])
    const restored = Session.create(source.id, source.session.snapshotEvents(), source.session.header)
    expect(restored.deriveMessages()).toEqual(source.session.deriveMessages())
    expect(JSON.stringify(restored.deriveMessages())).not.toContain('old prompt')
    expect(JSON.stringify(restored.deriveMessages())).not.toContain('first revised answer')
    expect(ctx.agents.list()).toHaveLength(1)
  })

  it('rebuilds unchanged runtime context and changed in-history system instructions for a first-prompt edit', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([textResponse('old answer'), textResponse('new answer')])
    adapter.systemPromptUpdate = 'in-history'
    let policy = 'original system rules'
    ctx.systemPrompt.section({ name: 'edit-system-policy', order: 0, text: () => policy })
    ctx.systemPrompt.context({ name: 'edit-runtime-policy', order: 0, text: 'current workspace constraints' })
    source.followup(message('old prompt'))
    await source.whenIdle()
    policy = 'updated system rules'
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq))).ok).toBe(true)
    await source.whenIdle()
    const request = JSON.stringify(adapter.requests[1]!.messages)
    expect(request).toContain('updated system rules')
    expect(request).toContain('current workspace constraints')
    expect(request).not.toContain('original system rules')
    expect(request).not.toContain('old prompt')
    expect(request).not.toContain('old answer')
    expect(adapter.requests[1]!.messages.filter(entry => entry.role === 'user' && entry.source?.kind === 'user'))
      .toHaveLength(1)
  })

  it('passes revised text through the ordinary pre-step processors', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([textResponse('old answer'), textResponse('new answer')])
    source.followup(message('old prompt'))
    await source.whenIdle()
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind !== 'enter' ? decision : {
        ...decision,
        messages: decision.messages.map(input => input.source.kind === 'user' && 'replacesUserMessage' in input.source
          ? createUserMessage({ content: [{ type: 'text', text: 'processed revision' }], source: input.source }) : input),
      }
    })
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq))).ok).toBe(true)
    await source.whenIdle()
    expect(adapter.requests[1]!.messages.filter(entry => entry.role === 'user').flatMap(entry => entry.content))
      .toEqual([{ type: 'text', text: 'processed revision' }])
  })

  it('accepts a duplicate revision while request preparation is pending', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([textResponse('old answer'), textResponse('new answer')])
    source.followup(message('old prompt'))
    await source.whenIdle()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/request', async (_payload, next) => { entered.resolve(undefined); await release.promise; return next() })
    const request = edit(userEvents(source.session).at(-1)!.seq)
    try {
      expect((await remote.editLastMessage(request)).ok).toBe(true)
      await entered.promise
      expect(userEvents(source.session).at(-1)?.data.source).toMatchObject({ pendingRevision: true })
      expect(JSON.stringify(source.session.deriveMessages())).not.toContain('old prompt')
      expect(JSON.stringify(source.session.deriveMessages())).not.toContain('revised question')
      expect(await remote.editLastMessage(request)).toEqual({ ok: true, value: { accepted: true } })
    } finally { release.resolve(undefined) }
    await source.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  })

  it('honors durable revision metadata without a Web Session Controller', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new MockAdapter([textResponse('obsolete'), textResponse('updated')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await harness.create(SessionId('profile-independent-edit'), { provider: 'mock', model: 'mock' })
    agent.followup(message('original'))
    await agent.whenIdle()
    const seq = userEvents(agent.session)[0]!.seq
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'updated prompt' }], source: { kind: 'user', replacesUserMessage: seq } }))
    await agent.whenIdle()
    expect(adapter.requests[1]!.messages.filter(entry => entry.role === 'user').flatMap(entry => entry.content))
      .toEqual([{ type: 'text', text: 'updated prompt' }])
    expect(ctx.agents.list()).toHaveLength(1)
  })

  it('can retry a saved draft after request preparation failed', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([textResponse('original answer'), textResponse('recovered answer')])
    source.followup(message('original question'))
    await source.whenIdle()
    const fail = ctx.on('agent/request', async (_payload, next) => { await next(); throw new Error('temporary preparation failure') })
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq))).ok).toBe(true)
    await source.whenIdle()
    expect(userEvents(source.session).at(-1)?.data.source).toMatchObject({ pendingRevision: true })
    fail()
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq, 'revised question', 'retry-revision'))).ok).toBe(true)
    await source.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.messages.filter(entry => entry.role === 'user').flatMap(entry => entry.content))
      .toEqual([{ type: 'text', text: 'revised question' }])
  })

  it('preserves newer steering admitted while an edit reserves the Session', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([textResponse('old answer'), textResponse('new answer')])
    source.followup(message('old question'))
    await source.whenIdle()
    ctx.on('agent/inbox/inserted', ({ message: input }) => {
      if ('replacesUserMessage' in input.source) source.steer(message('newer steering'))
    })
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq))).ok).toBe(true)
    await source.whenIdle()
    expect(adapter.requests[1]!.messages.filter(entry => entry.role === 'user').flatMap(entry => entry.content))
      .toEqual([{ type: 'text', text: 'revised question' }, { type: 'text', text: 'newer steering' }])
    const newer = userEvents(source.session).find(event => event.data.content.some(block => block.type === 'text' && block.text === 'newer steering'))!
    expect(ctx.sessionProjections.stateOf(source.session, 'userInput')?.latest?.seq).toBe(newer.seq)
    expect((await remote.editLastMessage(edit(userEvents(source.session).at(-1)!.seq, 'stale revision', 'revision-2'))).ok).toBe(false)
  })

  it('rejects an older target and a blank revision without changing the surface', async () => {
    const { source, remote, edit, ctx } = await setup()
    source.followup(message('history question'))
    await source.whenIdle()
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const events = userEvents(source.session)
    expect(await remote.editLastMessage(edit(events[0]!.seq))).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(await remote.editLastMessage(edit(events[1]!.seq, '  '))).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(ctx.agents.list()).toHaveLength(1)
  })

  it('rejects a pending queue without consuming it', async () => {
    const { source, remote, edit } = await setup()
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const queued = message('waiting question')
    source.inbox.append('next-turn', queued)
    expect(await remote.editLastMessage(edit(userEvents(source.session)[0]!.seq))).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(source.inbox.nextTurn).toEqual([queued])
  })

  it('rejects an active turn without cancelling or forking it', async () => {
    const { source, remote, edit, ctx } = await setup(['hang'])
    source.followup(message('running question'))
    await expect.poll(() => userEvents(source.session).length).toBe(1)
    expect(await remote.editLastMessage(edit(userEvents(source.session)[0]!.seq))).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(source.status).toBe('running')
    expect(ctx.agents.list()).toHaveLength(1)
  })
})
