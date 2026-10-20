/** Assemble the built optional bundle with matching Host exports; no interpreter is started. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '../../../packages/jobs/jobs-local/lib/index.js'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import LocalSubprocessRuntime from '../../../packages/subprocess/subprocess-local/lib/index.js'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as AetherShell from '../lib/lifecycle.mjs'

class UnusedConfinement extends SandboxProvider {
  async confine() { throw new Error('The declaration smoke must not start any interpreter') }
}

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
  await ctx.plugin(UnusedConfinement)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(AetherShell)
  const tools = ctx.tools.schemas().filter(tool => tool.name.startsWith('aether_'))
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'aether_call', 'aether_discover', 'aether_eval', 'aether_job_start', 'aether_pipeline', 'aether_result_page', 'aether_session',
  ])
  const session = tools.find(tool => tool.name === 'aether_session')
  assert.deepEqual(session.parameters.required, ['action'])
  assert.deepEqual(session.parameters.properties.action.enum, ['open', 'eval', 'read', 'list', 'close'])
  console.log(`Built AetherShell: ${tools.length} tools; one action-based session interface`)
} finally {
  await ctx.fiber.dispose()
}
