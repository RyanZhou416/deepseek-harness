/** Last-message edits regenerate from H + U' while preserving the original H + U + A. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestRemote } from './test-remote.ts'
import type { SessionForkRequest, SessionRequestId } from '../src/types.ts'

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
  const edit = (seq: number, text = 'revised question', requestId = 'revision-1'): SessionForkRequest => ({
    sessionId: source.id, editLastMessage: { seq, text, requestId: requestId as SessionRequestId },
  })
  return { ctx, source, adapter, remote, edit }
}

describe('editing the latest user message', () => {
  it('sends only H + U-prime, preserves the original, and reuses the child on submission retry', async () => {
    const { ctx, source, adapter, remote, edit } = await setup()
    source.followup(message('history question'))
    await source.whenIdle()
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const before = source.session.snapshotEvents()
    const request = edit(userEvents(source.session).at(-1)!.seq)
    const [first, simultaneous] = await Promise.all([remote.fork(request), remote.fork(request)])
    expect(first).toEqual(simultaneous)
    if (!first.ok) throw first.error
    const child = ctx.agents.get(first.value.sessionId)!
    await child.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]!.messages.slice(0, -1)).toEqual(adapter.requests[1]!.messages.slice(0, -1))
    expect(adapter.requests[2]!.messages.filter(entry => entry.role !== 'system').flatMap(entry => entry.content.flatMap(
      block => block.type === 'text' ? [block.text] : [],
    ))).toEqual(['history question', 'history answer', 'revised question'])
    expect(source.session.snapshotEvents()).toEqual(before)
    expect(child.session.header.parentSession).toBe(source.id)
    expect(await remote.fork(request)).toEqual(first)
    await child.whenIdle()
    expect(adapter.requests).toHaveLength(3)
  })

  it('edits the first prompt without bringing its previous answer into the new request', async () => {
    const { ctx, source, adapter, remote, edit } = await setup([textResponse('obsolete answer'), textResponse('new answer')])
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const result = await remote.fork(edit(userEvents(source.session)[0]!.seq))
    if (!result.ok) throw result.error
    await ctx.agents.get(result.value.sessionId)!.whenIdle()
    expect(adapter.requests[1]!.messages.filter(entry => entry.role !== 'system').flatMap(entry => entry.content.flatMap(
      block => block.type === 'text' ? [block.text] : [],
    ))).toEqual(['revised question'])
  })

  it('rejects an older target, a blank revision, and conflicting fork coordinates', async () => {
    const { source, remote, edit, ctx } = await setup()
    source.followup(message('history question'))
    await source.whenIdle()
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const events = userEvents(source.session)
    expect(await remote.fork(edit(events[0]!.seq))).toMatchObject({ ok: false, error: { code: 'session/fork-unavailable' } })
    expect(await remote.fork(edit(events[1]!.seq, '  '))).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(await remote.fork({ ...edit(events[1]!.seq), atSeq: events[0]!.seq })).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(ctx.agents.list()).toHaveLength(1)
  })

  it('rejects a pending queue without consuming it', async () => {
    const { source, remote, edit } = await setup()
    source.followup(message('obsolete question'))
    await source.whenIdle()
    const queued = message('waiting question')
    source.inbox.append('next-turn', queued)
    expect(await remote.fork(edit(userEvents(source.session)[0]!.seq))).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(source.inbox.nextTurn).toEqual([queued])
  })

  it('rejects an active turn without cancelling or forking it', async () => {
    const { source, remote, edit, ctx } = await setup(['hang'])
    source.followup(message('running question'))
    await expect.poll(() => userEvents(source.session).length).toBe(1)
    expect(await remote.fork(edit(userEvents(source.session)[0]!.seq))).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(source.status).toBe('running')
    expect(ctx.agents.list()).toHaveLength(1)
  })
})
