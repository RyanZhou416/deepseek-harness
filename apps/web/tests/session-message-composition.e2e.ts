/** The shipped Web presets, not the Host global layer, own Session-addressed tools. */
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-tools'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('scopes Session-addressed tools to full Web Agent presets', async () => {
  scaffold = await launchWebScaffold()
  expect(scaffold.ctx.tools.schemas()).toEqual([])

  for (const preset of ['standard', 'ptc', 'cordis'] as const) {
    const id = SessionId(`session-message-${preset}`)
    await scaffold.ctx.sessionController.create({
      sessionId: id,
      cwd: scaffold.workspaceCwd,
      agentPreset: preset,
    })
    const agent = scaffold.ctx.agents.get(id)
    if (agent === undefined) throw new Error(`${preset} Agent was not created`)
    expect(scaffold.ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(expect.arrayContaining([
      'session_create',
      'session_find',
      'session_message_status',
      'session_send_message',
    ]))
  }

  const minimalId = SessionId('session-message-minimal')
  await scaffold.ctx.sessionController.create({
    sessionId: minimalId,
    cwd: scaffold.workspaceCwd,
    agentPreset: 'minimal',
  })
  const minimal = scaffold.ctx.agents.get(minimalId)
  if (minimal === undefined) throw new Error('minimal Agent was not created')
  expect(scaffold.ctx.tools.schemas(minimal).map(schema => schema.name)).not.toEqual(expect.arrayContaining([
    'session_create',
    'session_find',
    'session_message_status',
    'session_send_message',
  ]))
})

class CreatedSessionAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Independent task complete.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Independent task complete.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('creates an ordinary Session in the caller workspace and starts its attributed task', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  ctx.effect(() => ctx.llm.registerAdapter(['session-create-test'], new CreatedSessionAdapter()))
  await ctx.agentDefaultModel.saveSelection({ provider: 'session-create-test', model: 'test' })
  const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const callerId = SessionId('session-create-web-caller')
  await ctx.sessionController.create({ sessionId: callerId, workspaceId: workspace.id, agentPreset: 'standard' })
  const caller = ctx.agents.get(callerId)
  if (caller === undefined) throw new Error('Session creator did not start')
  ctx.permissionPresets.set(caller.session, 'read-only')
  const settled = scaffold.whenTurnSettled()

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('session-create-web-task'),
    name: 'session_create',
    arguments: { task: 'Complete a separate, independent task.' },
    agent: caller,
  })

  expect(result.isError).toBe(false)
  const targetId = await settled
  const target = ctx.sessions.get(targetId)
  if (target === undefined) throw new Error('Created Session was not retained')
  expect(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    .toContain(`Independent Session ${targetId} created`)
  expect(target.header.cwd).toBe(scaffold.workspaceCwd)
  expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(targetId)
  expect(target.header.parentSession).toBeUndefined()
  expect(target.header.origin).toBeUndefined()
  expect(ctx.permissionPresets.current(target)).toBe('read-only')
  expect(ctx.sessionProjections.stateOf(target, 'agentPreset')).toBe('standard')
  const entered = target.snapshotEvents().find(event => event.type === 'user/message')
  expect(entered?.type === 'user/message' ? entered.data.source : undefined).toEqual({
    kind: 'agent-message', form: 'relay', senderSessionId: callerId,
  })
  expect(target.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
})
