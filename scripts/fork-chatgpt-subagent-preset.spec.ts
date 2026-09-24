import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface AgentStub {
  readonly options?: { readonly provider?: string; readonly model?: string }
}

type SelectPreset = (
  payload: { parent: AgentStub; child: AgentStub },
  next: () => Promise<string | undefined>,
) => Promise<string | undefined>

interface PresetPlugin {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: {
    on(event: 'subagent/child-preset', listener: SelectPreset): () => void
  }, config?: { preset?: string; providers?: string[]; modelPattern?: string }): () => void
}

function isPresetPlugin(value: unknown): value is PresetPlugin {
  return typeof value === 'object' && value !== null
    && 'name' in value && value.name === 'chatgpt-subagent-preset'
    && 'inject' in value && Array.isArray(value.inject)
    && 'apply' in value && typeof value.apply === 'function'
}

const source = fileURLToPath(new URL('../fork-runtime/web/chatgpt-subagent-preset.cjs', import.meta.url))
const loaded: unknown = createRequire(import.meta.url)(source)
if (!isPresetPlugin(loaded)) throw new Error('The fork ChatGPT preset plugin has no Cordis apply export')
const plugin = loaded

function mount(config = { preset: 'chatgpt-dsh', providers: ['codex'], modelPattern: '^gpt-' }) {
  let listener: SelectPreset | undefined
  const dispose = plugin.apply({ on: (event, callback) => {
    expect(event).toBe('subagent/child-preset')
    listener = callback
    return () => { listener = undefined }
  } }, config)
  if (listener === undefined) throw new Error('The fork preset did not register a child-preset selector')
  return { listener, dispose }
}

describe('fork ChatGPT child preset', () => {
  it('chooses the configured preset for a Codex provider or GPT model', async () => {
    expect(plugin.inject).toEqual(['agentPresets'])
    const { listener, dispose } = mount()
    try {
      await expect(listener({ parent: {}, child: { options: { provider: 'codex' } } }, () => Promise.resolve(undefined))).resolves.toBe('chatgpt-dsh')
      await expect(listener({ parent: {}, child: { options: { provider: 'custom', model: 'GPT-6' } } }, () => Promise.resolve(undefined))).resolves.toBe('chatgpt-dsh')
    } finally {
      dispose()
    }
  })

  it('delegates unrelated routes and accepts explicit provider and model rules', async () => {
    const { listener, dispose } = mount({ preset: 'reviewing', providers: ['other'], modelPattern: '^o[0-9]' })
    try {
      await expect(listener({ parent: {}, child: { options: { provider: 'codex', model: 'gpt-6' } } }, () => Promise.resolve(undefined))).resolves.toBeUndefined()
      await expect(listener({ parent: {}, child: { options: { provider: 'other' } } }, () => Promise.resolve(undefined))).resolves.toBe('reviewing')
      await expect(listener({ parent: {}, child: { options: { model: 'o3' } } }, () => Promise.resolve(undefined))).resolves.toBe('reviewing')
    } finally {
      dispose()
    }
  })

  it('rejects incomplete routing configuration at activation', () => {
    const on = () => () => {}
    expect(() => plugin.apply({ on })).toThrow('config.preset')
    expect(() => plugin.apply({ on }, { preset: 'chatgpt-dsh' })).toThrow('config.providers')
    expect(() => plugin.apply({ on }, { preset: 'chatgpt-dsh', providers: [] })).toThrow('config.modelPattern')
    expect(() => plugin.apply({ on }, { preset: 'chatgpt-dsh', providers: [], modelPattern: '[' })).toThrow()
  })
})
