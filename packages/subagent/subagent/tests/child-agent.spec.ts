import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { applyChildComposition, resolveChildAgentOptions } from '../src/child-agent.ts'
import SubagentRuntime from '../src/index.ts'

const contexts: Context[] = []
const scopes: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function compositionFixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  const childScope = createScope(ctx, {})
  scopes.push(childScope)
  const inherited = 'standard'
  const bindings = new Map<Context, string>()
  const presets = {
    composedPreset: vi.fn((scope: Context) => scope === ctx ? inherited : bindings.get(scope)),
    composeFrom: vi.fn((scope: Context) => { bindings.set(scope, inherited); return inherited }),
    mount: vi.fn(async (scope: Context, id: string) => { bindings.set(scope, id); return { id } }),
  }
  const context = vi.fn()
  ctx.provide('agentPresets', presets as never)
  ctx.provide('systemPrompt', { context, getContextOrder: () => 0 } as never)
  const parent = { id: SessionId('parent'), ctx, options: {}, session: Session.create(SessionId('parent')) } as Agent
  const child = { id: SessionId('child'), ctx: childScope.ctx,
    options: { provider: 'codex', model: 'gpt-6' }, session: Session.create(SessionId('child')) } as Agent
  return { ctx, childCtx: childScope.ctx, parent, child, presets, context }
}

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('child Agent preset composition', () => {
  it('inherits the parent preset when no selector proposes another', async () => {
    const f = await compositionFixture()
    await applyChildComposition(f.childCtx, f.parent, f.child, {})
    expect(f.presets.composeFrom).toHaveBeenCalledWith(f.childCtx, f.parent.ctx)
    expect(f.presets.mount).not.toHaveBeenCalled()
    expect(f.context).toHaveBeenCalledOnce()
  })

  it('mounts a proposed preset before child registrations and logs its selection', async () => {
    const f = await compositionFixture()
    f.ctx.on('subagent/child-preset', ({ child }, next) => child.options.provider === 'codex' ? Promise.resolve('chatgpt-dsh') : next())
    await applyChildComposition(f.childCtx, f.parent, f.child, {})
    expect(f.presets.mount).toHaveBeenCalledWith(f.childCtx, 'chatgpt-dsh')
    expect(f.presets.composeFrom).not.toHaveBeenCalled()
    expect(f.child.session.seq).toBe(1)
    expect(f.context).toHaveBeenCalledAfter(f.presets.mount)
  })

  it('keeps the parent scope when a selector repeats its preset', async () => {
    const f = await compositionFixture()
    f.ctx.on('subagent/child-preset', async () => 'standard')
    await applyChildComposition(f.childCtx, f.parent, f.child, {})
    expect(f.presets.composeFrom).toHaveBeenCalledOnce()
    expect(f.presets.mount).not.toHaveBeenCalled()
    expect(f.child.session.seq).toBe(0)
  })

  it('falls back to the parent when a proposed preset cannot mount', async () => {
    const f = await compositionFixture()
    f.ctx.on('subagent/child-preset', async () => 'missing')
    f.presets.mount.mockRejectedValueOnce(new RemoteError('agent-preset/not-found', 'missing preset', {
      agentPreset: 'missing', available: [],
    }))
    const warning = vi.spyOn(f.childCtx.logger, 'warn').mockImplementation(() => {})
    try {
      await applyChildComposition(f.childCtx, f.parent, f.child, {})
      expect(f.presets.composeFrom).toHaveBeenCalledOnce()
      expect(f.child.session.seq).toBe(0)
      expect(warning).toHaveBeenCalledOnce()
    } finally {
      warning.mockRestore()
    }
  })

  it('does not hide an unexpected mount failure', async () => {
    const f = await compositionFixture()
    f.ctx.on('subagent/child-preset', async () => 'chatgpt-dsh')
    f.presets.mount.mockRejectedValueOnce(new Error('late mount failure'))
    await expect(applyChildComposition(f.childCtx, f.parent, f.child, {})).rejects.toThrow('late mount failure')
    expect(f.presets.composeFrom).not.toHaveBeenCalled()
  })

  it('reuses the logged preset on resume without appending another selection', async () => {
    const f = await compositionFixture()
    f.ctx.provide('sessionProjections', { stateOf: () => 'chatgpt-dsh' } as never)
    const selector = vi.fn(async () => 'another')
    f.ctx.on('subagent/child-preset', selector)
    await applyChildComposition(f.childCtx, f.parent, f.child, {}, 'resume')
    expect(selector).not.toHaveBeenCalled()
    expect(f.presets.mount).toHaveBeenCalledWith(f.childCtx, 'chatgpt-dsh')
    expect(f.child.session.seq).toBe(0)
  })
})
