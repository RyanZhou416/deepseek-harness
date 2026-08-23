import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox, agentEvents, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as MemoryAdmission from '@deepseek-ai/dsh-memory-admission'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function registerAgent(ctx: Context, id: string): Agent {
  const sessionId = SessionId(id)
  const session = ctx.sessions.create(sessionId)
  const scope = ctx.plugin(() => {})
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: sessionId,
    options: {},
    session,
    inbox,
    ctx: scope.ctx,
    get status() { return status },
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

describe('memory admission real Loader composition', () => {
  it('boots cordis.yml and serializes two proposed steps', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-memory-admission-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-memory-admission'",
      '  config:',
      '    maxConcurrentSteps: 1',
      '    heapHighWatermarkRatio: 0.99',
      '    heapLowWatermarkRatio: 0.98',
      '    sampleIntervalMs: 10',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-memory-admission', MemoryAdmission],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const first = registerAgent(context, 'loader-memory-first')
    const second = registerAgent(context, 'loader-memory-second')
    const signal = new AbortController().signal
    const firstDecision = await agentEvents(context, first).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(firstDecision.kind).toBe('enter')
    let secondSettled = false
    const secondDecision = agentEvents(context, second).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    ).then((value) => {
      secondSettled = true
      return value
    })
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    first.session.append('turn/start', { turn: 1 })
    first.session.append('step/start', { turn: 1, step: 1 })
    first.session.append('step/end', { turn: 1, step: 1 })
    expect((await secondDecision).kind).toBe('enter')
  })
})
