import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('jobs-local through a real Loader composition', () => {
  it('applies provider-owned admission and terminal retention config from a Cordis row', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jobs-local-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-jobs-local'",
      '  config:',
      '    maxConcurrentJobsPerOwner: 1',
      '    terminalJobRetentionMs: 60000',
      '    maxRetainedTerminalJobsPerOwner: 1',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-jobs-local') return LocalJobRegistry
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.jobs).toBeInstanceOf(LocalJobRegistry)
    context.jobs.attachController('loader-test')
    let settle!: (outcome: { status: 'killed' }) => void
    const firstId = context.jobs.start({
      kind: 'bash',
      label: 'hold loader slot',
      run: () => ({
        cancel: () => { settle({ status: 'killed' }) },
        done: new Promise((resolve) => { settle = resolve }),
      }),
    })
    expect(() => context!.jobs.start({
      kind: 'bash',
      label: 'blocked loader job',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })).toThrow('(limit: 1)')

    settle({ status: 'killed' })
    await Promise.resolve()
    context.jobs.read(firstId)
    const secondId = context.jobs.start({
      kind: 'bash',
      label: 'replacement loader job',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })
    await Promise.resolve()
    expect(() => context!.jobs.get(firstId)).toThrow(`unknown job ${firstId}`)
    expect(context.jobs.get(secondId).status).toBe('completed')
  })
})
