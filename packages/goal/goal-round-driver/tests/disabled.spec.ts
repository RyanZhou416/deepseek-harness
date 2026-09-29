/** Disabled Goal admission through the real Agent loop, with no Goal service. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as disabled from '../src/disabled.ts'
import { renderGoalRoundPrompt } from '../src/prompt.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  callTool = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.callTool && this.requests.length === 1) {
      const id = ToolCallId('ordinary-tool')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'noop', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'noop', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const guard = await ctx.plugin(disabled)
  const agent = await ctx.agentLoop.create(SessionId('goal-disabled'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent, guard }
}

function goalMessage(text = 'old automatic objective') {
  return createUserMessage({ content: [{ type: 'text', text }],
    source: { kind: 'goal', goalId: GoalId('old-goal'), revision: 1, round: 1 } })
}

describe('disabled Goal admission', () => {
  it('drops queued Goal work without a model request or deleting stored Goal metadata', async () => {
    const { ctx, agent, adapter } = await setup()
    const event = agent.session.append('goal/change', {
      kind: 'goal/change', version: 1, operation: 'create',
      goal: { id: GoalId('old-goal'), revision: 1, objective: 'saved objective', phase: 'active', maxGoalRounds: 4 },
      roundsStarted: 0, createdAt: 0, updatedAt: 0,
    })
    agent.followup(goalMessage())
    await agent.whenIdle()
    expect(ctx.get('goals')).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    expect([...agent.session.ownEvents()].find(row => row.type === 'goal/change')).toEqual(event)
  })

  it('preserves human input while removing Goal input and downstream Goal notices', async () => {
    const { ctx, agent, adapter } = await setup()
    ctx.on('agent/pre-step', async (_input, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : {
        ...decision, startsRequestSeries: true, messages: [...decision.messages, goalMessage('downstream goal context')],
      }
    })
    agent.inject(goalMessage())
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'human task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('human task')
    expect(request).not.toContain('old automatic objective')
    expect(request).not.toContain('downstream goal context')
  })

  it('suppresses queued Goal closing notices', async () => {
    const { agent, adapter } = await setup()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'old Goal closing instruction' }],
      source: { kind: 'tool-goal', form: 'notice', summary: boundContextSummary('old Goal completion') } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
  })

  it('allows the empty-input step owed by an ordinary tool result', async () => {
    const { ctx, agent, adapter } = await setup()
    adapter.callTool = true
    ctx.tools.register(defineTool({ name: 'noop', description: 'No operation', parameters: {},
      execute: () => Promise.resolve(true),
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'true' }] },
    }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary tool task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  })

  it('preserves downstream rejection and ordinary requests, and removes its listener on unload', async () => {
    const { ctx, agent, adapter, guard } = await setup()
    const reject = ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'rejected' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    reject()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const errors: string[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
    const goal = { id: GoalId('old-goal'), revision: 1, objective: 'old automatic objective', phase: 'active' as const, maxGoalRounds: 4 }
    agent.session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal,
      roundsStarted: 0, createdAt: 0, updatedAt: 0 })
    await guard.dispose()
    agent.followup(createUserMessage({
      content: renderGoalRoundPrompt({ ...goal, roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed' }, 1),
      source: { kind: 'goal', goalId: goal.id, revision: 1, round: 1 },
    }))
    await agent.whenIdle()
    expect(errors).toEqual([])
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('old automatic objective')
  })
})
