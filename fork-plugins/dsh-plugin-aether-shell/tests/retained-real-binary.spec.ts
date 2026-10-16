/** Complete retained values and structured failures through the real native executable and tool registry. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { isJsonObject } from '../src/outcome.ts'
import { createHarness, text } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const executable = process.env['DSH_AETHER_TYPED_TEST_EXECUTABLE']
const mounted: Harness[] = []
afterEach(async () => { for (const harness of mounted.splice(0)) await harness.dispose() })

/** Register an exact live owner rather than a session-shaped stand-in. */
async function owner(harness: Harness): Promise<Agent> {
  await harness.ctx.plugin(AgentRegistry)
  const id = SessionId('retained-native-owner')
  const scope = harness.ctx.plugin(() => {})
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: harness.workspace, isSeeded: false,
  })
  const agent = { id, session, options: {}, status: 'idle', ctx: scope.ctx } as Agent
  await harness.ctx.agents.register(agent)
  return agent
}

/** Mount the source plugin against the explicitly selected candidate executable. */
async function setup(): Promise<Harness> {
  if (executable === undefined) throw new Error('Select the native candidate explicitly')
  const harness = await createHarness({
    executable, executableArgs: [],
    config: { structuredDataMode: 'typed-v1', maxResultBytes: 2_048, maxOutputBytes: 4_096 },
  })
  mounted.push(harness)
  return harness
}

describe.skipIf(executable === undefined)('retained results through the real native binary', () => {
  it('recovers a complete spill and pages every row without repeating the file effect or spawning again', async () => {
    const harness = await setup()
    const agent = await owner(harness)
    const marker = join(harness.workspace, 'once.txt')
    const payload = '中文😀 literal ${name} and a bounded retained-result payload'
    const code = `file_write_verified(r#"${marker}"#, "once"); range(5000) | map(fn(x) => {index:x,text:r#"${payload}"#})`
    const produced = await harness.call('aether_eval', { code }, { agent })
    expect(produced.isError).toBe(false)
    if (!isJsonObject(produced.value) || produced.value.kind !== 'retained'
      || !isJsonObject(produced.value.result) || typeof produced.value.result.id !== 'string') {
      throw new Error(`Expected a retained value, got ${text(produced)}`)
    }
    const id = produced.value.result.id
    expect(produced.value.result.complete).toBe(true)
    expect(produced.meta).toEqual({ resultId: id })
    const executions = harness.confineCalls.length
    const rows: JsonValue[] = []
    let offset = 0
    for (;;) {
      const read = await harness.call('aether_result_page', { id, offset }, { agent })
      if (!isJsonObject(read.value) || read.value.kind !== 'page' || !Array.isArray(read.value.data)) {
        throw new Error(`Expected an items page, got ${text(read)}`)
      }
      expect(Buffer.byteLength(text(read), 'utf8')).toBeLessThanOrEqual(2_048)
      rows.push(...read.value.data)
      if (read.value.complete === true) break
      if (typeof read.value.nextOffset !== 'number' || read.value.nextOffset <= offset) throw new Error('Page made no progress')
      offset = read.value.nextOffset
    }
    expect(rows).toEqual(Array.from({ length: 5_000 }, (_, index) => ({ index, text: payload })))
    expect(harness.confineCalls.length).toBe(executions)
    expect(await readFile(marker, 'utf8')).toBe('once')
    expect((await harness.call('aether_result_page', { id, drop: true }, { agent })).value).toMatchObject({ kind: 'dropped', id })
  })

  it('renders the real native failure object with its phase and safe-retry facts', async () => {
    const harness = await setup()
    const result = await harness.call('aether_call', { builtin: 'env_set', args: ['', 'value'] })
    if (!isJsonObject(result.value) || result.value.kind !== 'error' || !isJsonObject(result.value.error)) {
      throw new Error(`Expected native argument failure, got ${text(result)}`)
    }
    expect(result.value.error.details).toMatchObject({ code: 'E_BAD_ARG', safe_to_retry: false, side_effects: 'unknown', phase: 'execution' })
    expect(JSON.parse(text(result))).toMatchObject({ error: { code: 'E_BAD_ARG', safe_to_retry: false } })
  })
})
