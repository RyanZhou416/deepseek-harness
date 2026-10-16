/** Cancellation containment during root unload; persistence ordering is tested separately by its owner. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const contexts: Context[] = []
afterEach(async () => {
  const results = await Promise.allSettled(contexts.splice(0).reverse().map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'shutdown fixture cleanup failed')
})

async function setup(): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const adapter = new MockAdapter(['hang', 'hang'])
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

describe('root shutdown during an in-process abort', () => {
  it.each(['during-unload', 'after-release'] as const)('contains cancellation %s', async (ordering) => {
    const { ctx, adapter } = await setup()
    const logged: unknown[][] = []
    vi.spyOn(ctx.logger, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) })
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const agents = ctx.agents
    const controller = new AbortController()
    const run = await startInProcessRun({
      label: 'child task', prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: controller.signal,
      descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'test', label: 'child task' }),
    }, {})
    const uncaught: unknown[] = []
    const observe = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtExceptionMonitor', observe)
    try {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent turn' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      const disposing = ctx.fiber.dispose()
      if (ordering === 'after-release') await vi.waitFor(() => { expect(agents.get(run.id)).toBeUndefined() })
      controller.abort()
      const outcomes = await Promise.allSettled([disposing, run.dispose(), run.result])
      await new Promise(resolve => setImmediate(resolve))
      expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
      expect(uncaught).toEqual([])
      expect(logged.flat().map(String).filter(message => message.includes('projection registration is not active'))).toEqual([])
      expect(agents.get(run.id)).toBeUndefined()
    } finally {
      process.off('uncaughtExceptionMonitor', observe)
      await run.dispose()
    }
  })
})
