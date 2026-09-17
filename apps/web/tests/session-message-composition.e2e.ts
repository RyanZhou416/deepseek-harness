/** The shipped Web presets, not the Host global layer, own Session-addressed tools. */
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-tools'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('scopes Session-addressed tools to full Web Agent presets', async () => {
  scaffold = await launchWebScaffold()
  expect(scaffold.ctx.tools.schemas()).toEqual([])

  const standardId = SessionId('session-message-standard')
  await scaffold.ctx.sessionController.create({
    sessionId: standardId,
    cwd: scaffold.workspaceCwd,
    agentPreset: 'standard',
  })
  const standard = scaffold.ctx.agents.get(standardId)
  if (standard === undefined) throw new Error('standard Agent was not created')
  const standardTools = scaffold.ctx.tools.schemas(standard).map(schema => schema.name)
  expect(standardTools).toEqual(expect.arrayContaining([
    'session_find',
    'session_message_status',
    'session_send_message',
  ]))

  const minimalId = SessionId('session-message-minimal')
  await scaffold.ctx.sessionController.create({
    sessionId: minimalId,
    cwd: scaffold.workspaceCwd,
    agentPreset: 'minimal',
  })
  const minimal = scaffold.ctx.agents.get(minimalId)
  if (minimal === undefined) throw new Error('minimal Agent was not created')
  expect(scaffold.ctx.tools.schemas(minimal).map(schema => schema.name)).not.toEqual(expect.arrayContaining([
    'session_find',
    'session_message_status',
    'session_send_message',
  ]))
})
