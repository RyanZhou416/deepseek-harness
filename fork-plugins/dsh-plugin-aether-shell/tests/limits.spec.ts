/**
 * Foreground lifecycle: deadlines, cancellation, and the process facts they
 * leave behind.
 *
 * The interpreter fixture's `hang` scenario never exits on its own, so every
 * case here is decided by the plugin: a deadline it armed, or a cancellation it
 * forwarded. The timeout under test is small and the surrounding suite budget
 * is large so the harness's own wait can never decide the outcome.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { createHarness, text, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness(options)
  return harness
}

describe('aether-shell deadlines', () => {
  it('kills the interpreter at the per-call deadline and reports the interruption', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_call', { builtin: 'hang', timeoutMs: 250 })
    expect(result.isError).toBe(false)
    const value = valueOf(result)
    expect(value['kind']).toBe('interrupted')
    expect(value['timedOut']).toBe(true)
    expect(value['aborted']).toBe(false)
    // A forced kill reports no exit code on POSIX and `1` on Windows, so the
    // deadline facts are the stable assertion and the exit code is not.
    expect(value['process']).toMatchObject({ timedOut: true, aborted: false, timeoutMs: 250 })
    expect(value['sandbox']).toEqual({ mode: 'danger-full-access', denied: false })
    // Windows reports the forced termination as exit 1 without a signal, so the
    // deadline marker is the stable fact.
    expect(text(result)).toContain('[timed out before the interpreter reported a result]')
  })

  it('caps a per-call deadline at the deployment maximum', async () => {
    const mounted = await setup({ config: { timeoutMs: 200, maxTimeoutMs: 400 } })
    const result = await mounted.call('aether_call', { builtin: 'hang', timeoutMs: 600_000 })
    const value = valueOf(result)
    expect(value['kind']).toBe('interrupted')
    expect(value['timedOut']).toBe(true)
    expect((value['process'] as { timeoutMs: number }).timeoutMs).toBe(400)
  })

  it('refuses a non-positive deadline hint instead of disarming the deadline', async () => {
    const mounted = await setup()
    const result = await mounted.call('aether_call', { builtin: 'pwd', timeoutMs: 0 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('positive finite number')
  })

  it('leaves no in-flight child behind after a deadline', async () => {
    const mounted = await setup()
    await mounted.call('aether_call', { builtin: 'hang', timeoutMs: 200 })
    // A second call only completes promptly if the first managed range was
    // terminated and drained rather than left holding the provider.
    const followUp = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(valueOf(followUp)['kind']).toBe('value')
  })
})

describe('aether-shell cancellation', () => {
  it('reports an upstream cancellation as the structured abort', async () => {
    const mounted = await setup()
    const controller = new AbortController()
    const pending = mounted.call('aether_call', { builtin: 'hang' }, { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 150)
    const result = await pending
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected an aborted call')
    expect(result.error.info).toMatchObject({ name: 'AbortError', code: TOOL_ABORTED })
  })

  it('lets the next call run after a cancellation', async () => {
    const mounted = await setup()
    const controller = new AbortController()
    const pending = mounted.call('aether_call', { builtin: 'hang' }, { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 150)
    await pending
    const followUp = await mounted.call('aether_call', { builtin: 'pwd' })
    expect(valueOf(followUp)['kind']).toBe('value')
  })

  it('refuses a pre-aborted call before dispatch', async () => {
    const mounted = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await mounted.call('aether_call', { builtin: 'pwd' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
  })
})

describe('aether-shell foreground-only surface', () => {
  it('advertises no background mode on any tool', async () => {
    const mounted = await setup()
    for (const schema of mounted.ctx.tools.schemas()) {
      const properties = (schema.parameters as { properties: Record<string, unknown> }).properties
      expect(properties['run_in_background']).toBeUndefined()
      expect(properties['background']).toBeUndefined()
    }
  })
})
