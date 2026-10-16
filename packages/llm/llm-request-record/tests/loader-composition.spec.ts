/**
 * Real-composition proof: the vendored Loader resolves this package and the
 * session store from a test-only `cordis.yml`, applies the required
 * configuration, and the mounted service records into the session store the
 * same composition mounts.
 *
 * The installed importer supplies the modules, so this case proves that the
 * Loader mounts this package name with its required configuration and that the
 * mounted service records. It does not prove bare-specifier resolution: the
 * profile composition and the final artifact own that. The fixture is a
 * template, and the Loader's own root is a temporary directory, so no Loader
 * write can reach the package tree.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import * as recordPlugin from '@deepseek-ai/dsh-llm-request-record'
import type { LlmRequestRecordService } from '@deepseek-ai/dsh-llm-request-record'

/** Import mapped source modules without claiming support for Node's HMR internals. */
function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('llm-request-record through the shipped Loader', () => {
  it('mounts the package entry with its bound and records into a live session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-llm-request-record-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', sessionPlugin],
      ['@deepseek-ai/dsh-llm-request-record', recordPlugin],
    ])
    context.loader.internal = sourceModuleLoader(async (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    })
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const sessions: SessionStore | undefined = context.get('sessions')
    const record: LlmRequestRecordService | undefined = context.get('llmRequestRecord')
    expect(sessions).toBeDefined()
    expect(record).toBeDefined()

    const session = sessions!.create()
    let flushed = 0
    context.on('session/flush', () => { flushed += 1 })

    const outcome = await record!.recordPreparedRequest({ sessionId: session.id }, {
      provider: 'claude',
      model: 'claude-opus-5',
      purpose: 'conversation',
      systemBlocks: ['billing header', 'identity header'],
      wireLibrary: '@tormentalabs/claude-code-wire-compat@0.0.0-fixture',
      profile: 'claude-code-2.1.288',
    })

    expect(outcome.ok).toBe(true)
    expect(flushed).toBe(1)
  }, 30_000)
})
