/** Typed-data interoperability with an explicitly selected source-built interpreter. */
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'
import { isJsonObject } from '../src/outcome.ts'

/** An opt-in native runtime; the protocol fixture cannot substitute for this suite. */
const executable = process.env['DSH_AETHER_TYPED_TEST_EXECUTABLE']
const mounted: Harness[] = []
afterEach(async () => {
  for (const harness of mounted.splice(0)) await harness.dispose()
})

async function setup(): Promise<Harness> {
  if (executable === undefined) throw new Error('Set DSH_AETHER_TYPED_TEST_EXECUTABLE to the tested ae executable')
  const harness = await createHarness({ executable, executableArgs: [], config: { structuredDataMode: 'typed-v1' } })
  mounted.push(harness)
  return harness
}

describe.skipIf(executable === undefined)('source-built typed-data interpreter', () => {
  it('executes the concise source example shown to the model', async () => {
    const harness = await setup()
    const definition = harness.ctx.tools.schemas().find(tool => tool.name === 'aether_eval')
    const properties = definition?.parameters['properties']
    if (!isJsonObject(properties) || !isJsonObject(properties.code) || typeof properties.code.description !== 'string') {
      throw new Error('Missing model-facing source example')
    }
    const match = /e\.g\. (.+)\.$/u.exec(properties.code.description)
    if (match?.[1] === undefined) throw new Error('Missing executable source example')
    expect(valueOf(await harness.call('aether_eval', { code: match[1] }))['value']).toEqual([0, 2, 4])
  })
  it('preserves nested literal text, arbitrary keys and nulls through the real tool', async () => {
    const harness = await setup()
    const input = JSON.parse('{"a-b":"literal ${1+2}","中文":null,"":"empty key","__proto__":{"safe":true},"nested":["quote \\\" slash \\\\ newline \\n",false,0]}')
    const outcome = valueOf(await harness.call('aether_call', { builtin: 'first', args: [[input]] }))
    expect(outcome['value']).toEqual(input)
    expect(outcome['metadata']).toMatchObject({ structured_data: 'typed-v1', action: 'call' })
  })

  it('delivers an explicit null seed as the native null value', async () => {
    const harness = await setup()
    const outcome = valueOf(await harness.call('aether_pipeline', { input: null, steps: [{ builtin: 'type_of' }] }))
    expect(outcome['value']).toBe('Null')
    expect(outcome['metadata']).toMatchObject({ structured_data: 'typed-v1', action: 'pipeline' })
  })

  it('projects non-identifier keys as data after a native operation', async () => {
    const harness = await setup()
    const outcome = valueOf(await harness.call('aether_pipeline', {
      input: [{ 'a-b': 'first ${1+2}' }, { 'a-b': 'second' }],
      steps: [{ builtin: 'reverse', select: 'a-b' }],
    }))
    expect(outcome['value']).toEqual(['second', 'first ${1+2}'])
  })

  it('keeps predicate expressions executable without changing input strings', async () => {
    const harness = await setup()
    const outcome = valueOf(await harness.call('aether_pipeline', {
      input: [{ size: 1, text: '${not_a_variable}' }, { size: 5, text: '${1+2}' }],
      steps: [{ builtin: 'where', predicate: 'size > 2', select: 'text' }],
    }))
    expect(outcome['value']).toEqual(['${1+2}'])
  })

  it('distinguishes byte and Unicode scalar lengths without changing len', async () => {
    const harness = await setup()
    for (const [builtin, expected] of [['len', 10], ['byte_len', 10], ['char_len', 3]] as const) {
      const outcome = valueOf(await harness.call('aether_call', { builtin, args: ['你好😀'] }))
      expect(outcome['value']).toBe(expected)
    }
  })

  it('still refuses an unsafe numeric integer on the typed channel', async () => {
    const harness = await setup()
    const outcome = await harness.call('aether_call', { builtin: 'echo', args: [Number.MAX_SAFE_INTEGER + 1] })
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('E_INPUT_NUMBER') })]))
  })
})
