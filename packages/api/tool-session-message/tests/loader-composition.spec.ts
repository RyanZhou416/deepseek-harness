import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSessionMessage from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-session-message through a real Loader composition', () => {
  it('loads from cordis.yml and delivers attributed model-visible content', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-session-message-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      '- name: fixture-session-controller',
      '- name: fixture-session-reference',
      '- name: fixture-session-query',
      "- name: '@deepseek-ai/dsh-tool-session-message'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        switch (specifier) {
          case '@deepseek-ai/dsh-session': return { default: SessionStore }
          case '@deepseek-ai/dsh-agent': return { default: AgentRegistry }
          case '@deepseek-ai/dsh-system-prompt': return { default: SystemPrompt }
          case '@deepseek-ai/dsh-tools': return { default: ToolRuntime }
          case '@deepseek-ai/dsh-tool-session-message': return ToolSessionMessage
          case 'fixture-session-controller':
            return {
              name: 'fixture-session-controller',
              apply(ctx: Context) {
                ctx.provide('sessionController', {
                  resolveAgent: () => Promise.reject(new Error('fixture should use the live target')),
                } as unknown as SessionController)
              },
            }
          case 'fixture-session-reference':
            return {
              name: 'fixture-session-reference',
              apply(ctx: Context) {
                ctx.provide('sessionReferenceResolver', {
                  listCandidates: () => Promise.resolve([]),
                } as unknown as SessionReferenceResolver)
              },
            }
          case 'fixture-session-query':
            return {
              name: 'fixture-session-query',
              apply(ctx: Context) {
                ctx.provide('sessionQuery', {
                  listSessions: () => Promise.resolve([]),
                } as unknown as SessionQueryEngine)
              },
            }
          default: throw new Error(`unexpected Loader import: ${specifier}`)
        }
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.tools.schemas().map(schema => schema.name).toSorted()).toEqual([
      'session_find',
      'session_message_status',
      'session_send_message',
    ])

    const senderSession = context.sessions.create(SessionId('loader-sender'), { meta: { cwd: '/sender' } })
    const targetSession = context.sessions.create(SessionId('loader-target'), { meta: { cwd: '/target' } })
    const sender = { id: senderSession.id, session: senderSession, status: 'idle', ctx: context } as Agent
    const inject = vi.fn<Agent['inject']>()
    const target = {
      id: targetSession.id,
      session: targetSession,
      status: 'idle',
      ctx: context,
      inject,
    } as unknown as Agent
    await context.agents.register(sender)
    await context.agents.register(target)

    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-session-message'),
      name: 'session_send_message',
      arguments: { session_id: target.id, message: 'Loader-composed delivery.' },
      agent: sender,
    })

    expect(result.isError).toBe(false)
    expect(inject).toHaveBeenCalledOnce()
    const message = inject.mock.calls[0]![0]
    expect(message.source).toEqual({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: sender.id,
    })
    expect(message.content).toContainEqual({ type: 'text', text: 'Loader-composed delivery.' })
  })
})
