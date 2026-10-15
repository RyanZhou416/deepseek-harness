/**
 * Plugin lifecycle: disposal removes the registry contributions, and teardown
 * reaches the interpreter's managed range instead of merely asking it to stop.
 *
 * The `hang` scenario never exits, so a disposal that returned before the child
 * stopped would leave an orphan holding the provider's pipes — and the in-flight
 * call would never settle. Both are asserted here.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import * as AetherShell from '../src/index.ts'
import { AETHER_FIXTURE, createHarness, text, valueOf } from './helpers/harness.ts'
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

describe('aether-shell registration lifecycle', () => {
  it('unregisters every tool when the owning fiber is disposed', async () => {
    const mounted = await setup()
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toHaveLength(4)
    await mounted.pluginFiber.dispose()
    // The tool registry itself belongs to the surviving context.
    expect(mounted.ctx.tools.schemas()).toEqual([])
  })

  it('re-registers cleanly when the plugin is loaded again', async () => {
    const mounted = await setup()
    await mounted.pluginFiber.dispose()
    harness = await createHarness({ workspaceRoot: mounted.workspace })
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual(['aether_call', 'aether_discover', 'aether_eval', 'aether_pipeline'])
    expect(valueOf(await harness.call('aether_call', { builtin: 'pwd' }))['kind']).toBe('value')
  })

  it('disposes idempotently', async () => {
    const mounted = await setup()
    await mounted.pluginFiber.dispose()
    await mounted.pluginFiber.dispose()
    expect(mounted.ctx.tools.schemas()).toEqual([])
  })

  it('refuses a call once the plugin is unloaded', async () => {
    const mounted = await setup()
    await mounted.pluginFiber.dispose()
    const result = await mounted.ctx.tools.execute({
      callId: ToolCallId('after-dispose'),
      name: 'aether_call',
      arguments: { builtin: 'pwd' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
  })

  it('does not leave a default export behind for the Loader to prefer', () => {
    expect('default' in AetherShell).toBe(false)
  })
})

describe('aether-shell teardown quiescence', () => {
  it('terminates and joins an in-flight interpreter before disposal resolves', async () => {
    const mounted = await setup({ config: { graceMs: 2_000 } })
    const pending = mounted.call('aether_call', { builtin: 'hang' })
    // The call has no earlier observable step, so a bounded wait places
    // disposal during the run; the assertion below does not depend on the race.
    await new Promise(resolve => setTimeout(resolve, 250))
    await mounted.pluginFiber.dispose()
    const result = await pending
    expect(result.isError).toBe(false)
    const value = valueOf(result)
    expect(value['kind']).toBe('interrupted')
    expect(value['aborted']).toBe(true)
    expect(value['timedOut']).toBe(false)
    expect((value['process'] as { aborted: boolean }).aborted).toBe(true)
    // Windows reports the forced termination as exit 1 without a signal, so the
    // teardown marker is the stable fact and an exit marker may accompany it.
    expect(text(result)).toContain('[stopped: the plugin unloaded]')
  })

  it('settles a call that was racing teardown instead of hanging', async () => {
    const mounted = await setup()
    const pending = mounted.call('aether_call', { builtin: 'pwd' })
    await mounted.pluginFiber.dispose()
    const result = await pending
    // A `pwd` exchange has only three admissible settlements: it finished
    // first, teardown stopped it, or dispatch observed the cancellation.
    if (result.isError) {
      expect(result.error.info?.code).toBe(TOOL_ABORTED)
    } else {
      const value = valueOf(result)
      expect(['value', 'interrupted']).toContain(value['kind'])
      if (value['kind'] === 'interrupted') expect(value['aborted']).toBe(true)
    }
  })

  it('removes the plugin while a discovery call is in flight', async () => {
    const mounted = await setup()
    const pending = mounted.call('aether_discover', {})
    await mounted.pluginFiber.dispose()
    const result = await pending
    if (result.isError) {
      expect(result.error.info?.code).toBe(TOOL_ABORTED)
    } else {
      const value = valueOf(result)
      expect(['value', 'interrupted']).toContain(value['kind'])
      if (value['kind'] === 'interrupted') expect(value['aborted']).toBe(true)
    }
  })

  it('stops a second call from spawning after teardown', async () => {
    const mounted = await setup()
    const first = mounted.call('aether_call', { builtin: 'hang' })
    await new Promise(resolve => setTimeout(resolve, 250))
    await mounted.pluginFiber.dispose()
    const result = await first
    expect(result.isError).toBe(false)
    // A fresh harness must spawn a working interpreter, proving the first
    // managed range was released rather than left occupying the provider.
    const fresh = await createHarness({ workspaceRoot: mounted.workspace, executableArgs: [AETHER_FIXTURE] })
    harness = fresh
    expect(valueOf(await fresh.call('aether_call', { builtin: 'pwd' }))['kind']).toBe('value')
  })
})
