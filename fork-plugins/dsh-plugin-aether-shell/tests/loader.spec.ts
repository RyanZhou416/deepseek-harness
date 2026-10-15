/**
 * REAL Loader composition (packages/AGENTS.md): boot the committed test-only
 * `cordis.yml` through the Cordis Loader with the workspace packages mapped to
 * their source identities, then drive the loaded tools through the real tool
 * registry and the deterministic interpreter fixture.
 *
 * This is the tier a hand-built `ctx.plugin(...)` suite cannot cover: it proves
 * the plugin is loadable by name from a composition file, receives its
 * configuration through the Loader's `!!js` interpolation, activates only once
 * every required service exists, and registers a working model-visible surface.
 *
 * The composition is copied into a private directory before it is loaded. The
 * Loader records an unloaded plugin by writing `disabled: true` back into the
 * config file it read, so booting the committed file directly would let this
 * suite mutate its own fixture.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as sessionProjection from '@deepseek-ai/dsh-session-projection'
import * as sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as subprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as systemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as tools from '@deepseek-ai/dsh-tools'
import * as aetherShell from '../src/index.ts'
import * as passthroughSandbox from './fixtures/loader/passthrough-sandbox.ts'
import { AETHER_FIXTURE, sessionAgent, text, valueOf } from './helpers/harness.ts'

/** The committed composition this suite boots, kept pristine by copying it. */
const COMMITTED_CONFIG = new URL('./fixtures/loader/cordis.yml', import.meta.url)

/** The specifier set the committed composition file may name. */
const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-system-prompt', systemPrompt],
  ['@deepseek-ai/dsh-tools', tools],
  ['@deepseek-ai/dsh-session-projection', sessionProjection],
  ['@deepseek-ai/dsh-sandbox-policy', sandboxPolicy],
  ['@deepseek-ai/dsh-sandbox-local', passthroughSandbox],
  ['@deepseek-ai/dsh-subprocess-local', subprocessLocal],
  ['@ryanzhou416/dsh-plugin-aether-shell', aetherShell],
])

const interpreter = process.env['DSH_AETHER_INTERPRETER']
const fixture = process.env['DSH_AETHER_FIXTURE']

let ctx: Context | undefined
const roots: string[] = []

beforeAll(() => {
  process.env['DSH_AETHER_INTERPRETER'] = process.execPath
  process.env['DSH_AETHER_FIXTURE'] = AETHER_FIXTURE
})

afterAll(() => {
  if (interpreter === undefined) delete process.env['DSH_AETHER_INTERPRETER']
  else process.env['DSH_AETHER_INTERPRETER'] = interpreter
  if (fixture === undefined) delete process.env['DSH_AETHER_FIXTURE']
  else process.env['DSH_AETHER_FIXTURE'] = fixture
})

afterEach(async () => {
  const owned = ctx
  ctx = undefined
  await owned?.fiber.dispose()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

/**
 * Wait until an observable condition holds, bounding the wait.
 *
 * The Loader's `await()` covers its own import and lifecycle tasks; a plugin
 * whose `inject` list is only satisfied once sibling entries activate registers
 * its tools a tick later, so the composition is considered ready when the tool
 * registry actually carries the four tools.
 * @param condition - the observable state to wait for.
 * @param label - what is being awaited, named in the timeout failure.
 */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Boot the committed composition, copied into a private directory, through the Loader. */
async function boot(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-aether-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, await readFile(COMMITTED_CONFIG, 'utf8'))

  const booted = new Context()
  booted.baseUrl = pathToFileURL(root).href + '/'
  await booted.plugin(Loader)
  // Keep every YAML import inside Vitest's source module graph so service
  // identities stay single: the loaded plugin IS this suite's imported module.
  booted.loader.builtins.include = Include
  booted.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!MODULES.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return MODULES.get(specifier)
    },
  } as unknown as NonNullable<typeof booted.loader.internal>
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await booted.loader.await()
  // Nothing may stay unloaded: a config the Loader silently rejected would
  // otherwise read as "no tools registered" instead of "the file is broken".
  const unloaded = [...booted.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(unloaded.map(entry => entry.options.name)).toEqual([])
  await waitFor(() => booted.get('tools')?.schemas().length === 4, 'the loaded aether-shell tools')
  ctx = booted
  return booted
}

describe('aether-shell through a real Loader composition', () => {
  it('activates the function plugin and registers all four tools', async () => {
    const booted = await boot()
    const names = booted.tools.schemas().map(schema => schema.name).sort()
    expect(names).toEqual(['aether_call', 'aether_discover', 'aether_eval', 'aether_pipeline'])
    // The plugin is the source module itself, not a rebuilt or duplicated copy.
    expect(MODULES.get('@ryanzhou416/dsh-plugin-aether-shell')).toBe(aetherShell)
    // A function plugin must not carry a default export, which the Loader would
    // prefer and would silently drop `inject` for.
    expect('default' in aetherShell).toBe(false)
    expect(aetherShell.inject).toEqual(['tools', 'subprocess', 'sandbox', 'sandboxPolicy'])
  })

  it('runs a loaded call, pipeline, discovery, and program through the composed services', async () => {
    const booted = await boot()
    const workspace = booted.sandboxPolicy.resolve().workspaceRoot
    const agent = sessionAgent(workspace)
    const call = (name: string, args: unknown) => booted.tools.execute({
      callId: ToolCallId(`loader-${name}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: agent as never,
    })

    const discovered = await call('aether_discover', { query: 'pwd' })
    expect(valueOf(discovered)['discovery']).toMatchObject({ shape: 'builtin', query: 'pwd' })

    const called = await call('aether_call', { builtin: 'pwd' })
    expect(valueOf(called)['kind']).toBe('value')

    const piped = await call('aether_pipeline', { steps: [{ builtin: 'pwd' }] })
    expect(valueOf(piped)['kind']).toBe('value')

    const evaluated = await call('aether_eval', { code: '1 + 1' })
    expect(valueOf(evaluated)).toMatchObject({ kind: 'value', value: 2, resultType: 'number' })

    const failed = await call('aether_call', { builtin: 'unknown_builtin' })
    expect(failed.isError).toBe(false)
    expect(valueOf(failed)['kind']).toBe('error')
    expect(text(failed)).toContain('E_UNKNOWN_BUILTIN')
  })

  it('removes every tool when the loaded plugin fiber disposes', async () => {
    const booted = await boot()
    expect(booted.tools.schemas()).toHaveLength(4)
    const entry = [...booted.loader.entries()]
      .find(candidate => candidate.options.name === '@ryanzhou416/dsh-plugin-aether-shell')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    // The registry survives the plugin's unload; its contributions do not.
    expect(booted.tools.schemas()).toHaveLength(0)
  })
})
