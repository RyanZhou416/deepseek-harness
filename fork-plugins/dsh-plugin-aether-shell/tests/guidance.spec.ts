/** Model-facing context budgets and usage rules for the assembled optional tool set. */
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { StructuredDataMode } from '../src/config.ts'
import { createHarness } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

const mounted: Harness[] = []
afterEach(async () => { for (const harness of mounted.splice(0)) await harness.dispose() })

/** Assemble every optional tool without executing an interpreter or creating a persistent handle. */
async function schemas(mode: StructuredDataMode) {
  const harness = await createHarness({ config: { structuredDataMode: mode } })
  mounted.push(harness)
  await harness.ctx.plugin(AgentRegistry)
  await harness.ctx.plugin(LocalJobRegistry)
  return harness.ctx.tools.schemas().filter(tool => tool.name.startsWith('aether_'))
}

/** Count every model-facing description, including nested parameter descriptions. */
function descriptionBytes(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0
  return Object.entries(value).reduce((sum, [key, item]) => sum + (
    key === 'description' && typeof item === 'string' ? Buffer.byteLength(item, 'utf8') : descriptionBytes(item)
  ), 0)
}

/** Assert the provider-neutral serialized and prose budgets independently. */
function expectContextBudget(tools: unknown): void {
  expect(Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBeLessThanOrEqual(13_000)
  expect(descriptionBytes(tools)).toBeLessThanOrEqual(9_500)
}

const PARAMETERS = {
  aether_call: ['builtin', 'args', 'cwd', 'timeoutMs', 'executionTimeoutMs'],
  aether_discover: ['query', 'offset', 'limit', 'cwd', 'timeoutMs'],
  aether_eval: ['code', 'cwd', 'timeoutMs', 'executionTimeoutMs'],
  aether_pipeline: ['steps', 'input', 'cwd', 'timeoutMs', 'executionTimeoutMs'],
  aether_job_start: ['code', 'label', 'cwd', 'timeoutMs'],
  aether_result_page: ['id', 'offset', 'limit', 'maxBytes', 'format', 'drop'],
  aether_session_open: ['cwd', 'name', 'timeoutMs'],
  aether_session_eval: ['session_id', 'code', 'timeoutMs'],
  aether_session_read: ['session_id'],
  aether_session_list: ['usage', 'timeoutMs'],
  aether_session_close: ['session_id', 'timeoutMs'],
}

for (const mode of ['legacy', 'typed-v1'] as const) {
  describe(`compact ${mode} AetherShell declarations`, () => {
    it('keeps all eleven tools and arguments within the model context budget', async () => {
      const tools = await schemas(mode)
      expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(PARAMETERS).sort())
      for (const tool of tools) {
        expect(Object.keys(tool.parameters.properties ?? {})).toEqual(PARAMETERS[tool.name as keyof typeof PARAMETERS])
      }
      // Compact JSON is the provider-neutral wire measurement, not a tokenizer estimate.
      expectContextBudget(tools)
    })

    it('rejects declarations that exceed the context budget', async () => {
      const tools = await schemas(mode)
      const bloated = tools.map(tool => tool.name === 'aether_call' ? { ...tool, description: 'x'.repeat(14_000) } : tool)
      expect(() => expectContextBudget(bloated)).toThrow()
    })

    it('keeps tool choice, same-job collection, paging and process lifetime guidance', async () => {
      const tools = await schemas(mode)
      const description = (name: string) => tools.find(tool => tool.name === name)?.description ?? ''
      for (const name of ['aether_call', 'aether_pipeline', 'aether_eval']) {
        expect(description(name)).toContain('original jobId without stopping or rerunning')
        expect(description(name)).toContain('job_output')
        expect(description(name)).toContain('job_kill')
        expect(description(name)).toContain('aether_result_page')
        expect(description(name)).toContain('Explicit cancellation stops and awaits cleanup')
      }
      for (const name of ['aether_call', 'aether_pipeline', 'aether_eval', 'aether_job_start', 'aether_session_open', 'aether_session_eval']) {
        expect(description(name)).toContain('DSH restricts writes/deletes, not reads, network or process control')
        expect(description(name)).toContain('no alternate-tool/shell or native-token retry')
        expect(description(name)).toContain('the user must change policy')
      }
      expect(description('aether_call')).toContain('aether_discover')
      expect(description('aether_eval')).toContain('not PowerShell')
      expect(description('aether_job_start')).toContain('No persistent state or JSON decoding')
      expect(description('aether_session_eval')).toContain('Timeout/cancel kills the whole session')
      expect(description('aether_session_eval')).toContain('does not roll back earlier effects')
      expect(description('aether_session_open')).toContain('No checkpoint/replay')
      expect(description('aether_result_page')).toContain('without rerunning code/effects')
      expect(description('aether_result_page')).toContain('concatenate data strings then JSON-parse once')
    })
  })
}
