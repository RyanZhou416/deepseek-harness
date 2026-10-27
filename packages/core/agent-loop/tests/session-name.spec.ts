import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/** A loop whose projection registry serves the title unit the session-title domain owns. */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Wait for the agent's next transition to idle after a waking send. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Drive one turn through the agent so its request reaches the recorded adapter. */
async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

describe('request session name', () => {
  it('stamps the request with the latest title the session log folded', async () => {
    const adapter = new MockAdapter([textResponse('named')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('named-request'), { provider: 'mock', model: 'mock' })
    agent.session.append('session/title', { title: 'Fix the widget', messageSeqs: [], source: { kind: 'user' } })

    await runTurn(ctx, agent, 'name this request')

    expect(adapter.requests[0]?.sessionName).toBe('Fix the widget')
  })

  it('leaves the name unset while the session has no title', async () => {
    const adapter = new MockAdapter([textResponse('unnamed')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('unnamed-request'), { provider: 'mock', model: 'mock' })

    await runTurn(ctx, agent, 'no name yet')

    expect(adapter.requests[0]?.sessionName).toBeUndefined()
    expect(adapter.requests[0]?.sessionId).toBe('unnamed-request')
  })
})
