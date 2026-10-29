/** Real Loader composition: the route exists only when the plugin row is installed. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
// Type-only: the profile composition mounts ctx.settings, whose form write path
// these cases exercise.
import type {} from '@deepseek-ai/dsh-settings'
import { afterEach, expect, it, vi } from 'vitest'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as CcPool from '../src/index.ts'
import { BASE_URL, PROVIDER } from '../src/pool.ts'
import { assemble, capturePoolFetch, user } from './harness.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) {
    const temporary = tmpdir()
    if (!root.startsWith(temporary)) throw new Error(`refusing to remove ${root}: outside ${temporary}`)
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * Boot a test profile through the real Loader. The rows become the profile
 * bundle patch, which is what installing (or not installing) the plugin
 * changes. The Settings and configuration-editor services ride along from the
 * profile composition, so a case can exercise the settings write path.
 * @param rows - callback producing cordis.yml rows from the temporary profile root.
 * @returns the booted context, its root, and the profile patch the editor writes.
 */
async function loadComposition(rows: (home: string) => string[]): Promise<{ ctx: Context; home: string; patchPath: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cc-pool-composition-'))
  root = home
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, `${rows(home).join('\n')}\n`)

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-llm-cc-pool', CcPool],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous model resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, home, configPath)
  return { ctx, home, patchPath }
}

it('has no cc-pool provider in a composition that does not install the plugin', async () => {
  const { ctx } = await loadComposition(() => [
    '- id: llm',
    "  name: 'test-llm-service'",
  ])
  expect(ctx.llm.listProviders()).toEqual([])
})

it('installs the fixed route, catalogue, and durable diagnostics through a real profile', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const { ctx, home } = await loadComposition(home => [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-cc-pool',
    "  name: '@deepseek-ai/dsh-llm-cc-pool'",
    '  config:',
    '    requestLog:',
    `      path: ${JSON.stringify(join(home, 'requests.jsonl'))}`,
  ])

  expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'CC 订阅池' }])
  expect(await ctx.llm.listModels(PROVIDER)).toHaveLength(4)
  expect(ctx.llm.listConfigurableProviders()).toEqual([])

  const capture = capturePoolFetch()
  vi.stubGlobal('fetch', capture.fetch)
  const result = await assemble(ctx, {
    model: 'claude-opus-5-5',
    messages: [user('composed mac-pool request')],
    sessionId: 'session-cc-pool-composition' as never,
  })
  expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  expect(capture.calls[0]?.headers.get('x-api-key')).toBe('pool-member-key')
  expect(capture.calls[0]?.body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' } })

  await vi.waitFor(async () => {
    const records = (await readFile(join(home, 'requests.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.map(record => record['kind'])).toEqual(['request', 'response'])
    expect(records[0]).toMatchObject({ provider: PROVIDER, model: 'claude-opus-5-5', attempt: 1 })
  }, { timeout: 5000 })
})

it('reads the pool model list through the installed profile without writing the profile', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const { ctx, patchPath } = await loadComposition(home => [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-cc-pool',
    "  name: '@deepseek-ai/dsh-llm-cc-pool'",
    '  config:',
    '    requestLog:',
    `      path: ${JSON.stringify(join(home, 'requests.jsonl'))}`,
  ])
  const before = await readFile(patchPath, 'utf8')
  const capture = capturePoolFetch(() => new Response(JSON.stringify({
    data: [{ id: 'claude-pool-extra', display_name: 'Claude Pool Extra' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', capture.fetch)

  expect(await ctx.llm.discoverModels('llm-cc-pool', { provider: PROVIDER })).toEqual([
    { id: 'claude-pool-extra', name: 'Claude Pool Extra' },
  ])
  expect(capture.calls).toHaveLength(1)
  expect(capture.calls[0]?.url).toBe(`${BASE_URL}/v1/models`)
  expect(capture.calls[0]?.headers.get('authorization')).toBe('Bearer pool-member-key')
  // A sync is a read: the composed catalogue and the persisted profile stay as
  // they were, so nothing is auto-adopted into the route.
  expect(await ctx.llm.listModels(PROVIDER)).toHaveLength(4)
  expect(await readFile(patchPath, 'utf8')).toBe(before)
})

it('installs a configured catalogue through a real profile and serves it', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const { ctx } = await loadComposition(() => [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-cc-pool',
    "  name: '@deepseek-ai/dsh-llm-cc-pool'",
    '  config:',
    '    requestLog:',
    '      enabled: false',
    '    models:',
    '      - id: claude-test-model',
    '        name: Test Model',
    '        contextWindow: 200000',
    '        maxTokens: 1024',
    '        defaultReasoning: xhigh',
  ])

  expect(await ctx.llm.listModels(PROVIDER)).toEqual([{
    provider: PROVIDER,
    id: 'claude-test-model',
    name: 'Test Model',
    inputModalities: ['text', 'image'],
  }])
  expect(await ctx.llm.resolveModelInfo(PROVIDER, 'claude-test-model')).toMatchObject({
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 1024,
    reasoning: { defaultEffort: 'xhigh' },
  })
  expect(ctx.llm.listConfigurableProviders()).toEqual([])

  const capture = capturePoolFetch()
  vi.stubGlobal('fetch', capture.fetch)
  const result = await assemble(ctx, { model: 'claude-test-model', messages: [user('configured catalogue')] })
  expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  expect(capture.calls[0]?.headers.get('x-api-key')).toBe('pool-member-key')
  expect(capture.calls[0]?.body).toMatchObject({
    model: 'claude-test-model',
    max_tokens: 1024,
    output_config: { effort: 'xhigh' },
  })
})

it('enables the four-marker one-hour layout by default through a real profile', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const { ctx } = await loadComposition(() => [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-cc-pool',
    "  name: '@deepseek-ai/dsh-llm-cc-pool'",
    '  config:',
    '    requestLog:',
    '      enabled: false',
  ])
  const capture = capturePoolFetch()
  vi.stubGlobal('fetch', capture.fetch)
  await assemble(ctx, {
    model: 'claude-sonnet-5-5',
    system: 'You are the composed pool assistant.',
    tools: [{ name: 'echo', description: 'Echo text back.', parameters: { type: 'object', properties: {} } }],
    messages: [user('composed cache lifetime')],
  })

  const call = capture.calls[0]
  if (call === undefined) throw new Error('the pool route sent no request')
  const body = call.body
  expect(body).toMatchObject({
    system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ name: 'echo', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  })
  // The default policy marks the slots this request has: the system block, the
  // last tool declaration, and the last user block, each for one hour. The body
  // carries no scope field and the header no scope beta.
  expect(JSON.stringify(body).match(/"ttl":"1h"/gu)).toHaveLength(3)
  expect(JSON.stringify(body)).not.toContain('"scope"')
  expect(call.headers.get('anthropic-beta')).toBe('extended-cache-ttl-2025-04-11')
  expect(call.headers.get('anthropic-beta')).not.toContain('prompt-caching-scope')
})

it('refuses an invalid catalogue write instead of persisting it', async () => {
  const { ctx, patchPath } = await loadComposition(() => [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-cc-pool',
    "  name: '@deepseek-ai/dsh-llm-cc-pool'",
    '  config:',
    '    requestLog:',
    '      enabled: false',
  ])
  const duplicate = { id: 'duplicate', name: 'Duplicate', contextWindow: 200_000, maxTokens: 1_024, defaultReasoning: 'low' }

  await expect(ctx.settings.mutate('llm-cc-pool', [{
    op: 'set',
    path: ['models'],
    value: [duplicate, { ...duplicate, name: 'Duplicate again' }],
  }])).rejects.toThrow(/"duplicate" more than once/)
  await expect(ctx.settings.mutate('llm-cc-pool', [{
    op: 'set',
    path: ['models'],
    value: [{ ...duplicate, defaultReasoning: 'speed' }],
  }])).rejects.toThrow(/defaultReasoning/)

  expect(await readFile(patchPath, 'utf8')).not.toContain('duplicate')
  expect(await ctx.llm.listModels(PROVIDER)).toHaveLength(4)
})

it('persists a catalogue written through the settings service and serves it live', async () => {
  vi.stubEnv('CC_POOL_API_KEY', 'pool-member-key')
  const { ctx, patchPath } = await loadComposition(() => [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-cc-pool',
    "  name: '@deepseek-ai/dsh-llm-cc-pool'",
    '  config:',
    '    requestLog:',
    '      enabled: false',
  ])
  expect(await ctx.llm.listModels(PROVIDER)).toHaveLength(4)
  expect(await readFile(patchPath, 'utf8')).not.toContain('claude-settings-model')

  await ctx.settings.mutate('llm-cc-pool', [{
    op: 'set',
    path: ['models'],
    value: [{
      id: 'claude-settings-model',
      name: 'Settings Model',
      contextWindow: 200_000,
      maxTokens: 2_048,
      defaultReasoning: 'medium',
    }],
  }])

  // The write lands in the profile patch the Loader re-reads, and the running
  // route serves the new catalogue without remounting.
  const persisted = await readFile(patchPath, 'utf8')
  expect(persisted).toContain('claude-settings-model')
  expect(persisted).toContain('defaultReasoning: medium')
  expect(await ctx.llm.listModels(PROVIDER)).toEqual([{
    provider: PROVIDER,
    id: 'claude-settings-model',
    name: 'Settings Model',
    inputModalities: ['text', 'image'],
  }])
  const capture = capturePoolFetch()
  vi.stubGlobal('fetch', capture.fetch)
  await assemble(ctx, { model: 'claude-settings-model', messages: [user('settings override')] })
  expect(capture.calls[0]?.body).toMatchObject({
    model: 'claude-settings-model',
    max_tokens: 2_048,
    output_config: { effort: 'medium' },
  })
})
