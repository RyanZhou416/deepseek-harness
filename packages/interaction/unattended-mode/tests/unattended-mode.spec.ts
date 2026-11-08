import { describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '../../../../vendor/cosmokit/src/volatile.ts'
import UnattendedModeService, { type Config } from '@deepseek-ai/dsh-unattended-mode'

async function setup(enabled?: boolean): Promise<{ ctx: Context; fiber: Fiber; service: UnattendedModeService }> {
  const ctx = new Context()
  const fiber = enabled === undefined
    ? await ctx.plugin(UnattendedModeService)
    : await ctx.plugin(UnattendedModeService, { enabled })
  return { ctx, fiber, service: ctx.unattendedMode }
}

/** Commit a live configuration value the way the Loader does before notifying. */
function commit(fiber: Fiber, enabled: boolean): void {
  const config = fiber.effectiveConfig as Config
  updateVolatile(config.enabled, createVolatile(enabled))
  fiber.ctx.emit('loader/volatile-update', [['enabled']])
}

describe('unattended mode service', () => {
  it('defaults to off', async () => {
    const { ctx, service } = await setup()

    expect(service.enabled()).toBe(false)
    await ctx.fiber.dispose()
  })

  it('reads a live configuration update without a subscriber', async () => {
    const { ctx, fiber, service } = await setup()

    commit(fiber, true)

    expect(service.enabled()).toBe(true)
    await ctx.fiber.dispose()
  })

  it('notifies subscribers once per changed value and skips unchanged updates', async () => {
    const { ctx, fiber, service } = await setup()
    const listener = vi.fn<(enabled: boolean) => void>()
    service.subscribe(listener)

    commit(fiber, false)
    commit(fiber, true)
    commit(fiber, true)
    commit(fiber, false)

    expect(listener.mock.calls).toEqual([[true], [false]])
    await ctx.fiber.dispose()
  })

  it('removes only the listener whose disposer runs', async () => {
    const { ctx, fiber, service } = await setup()
    const removed = vi.fn<(enabled: boolean) => void>()
    const kept = vi.fn<(enabled: boolean) => void>()
    const dispose = service.subscribe(removed)
    service.subscribe(kept)

    dispose()
    dispose()
    commit(fiber, true)

    expect(removed).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledTimes(1)
    expect(kept).toHaveBeenLastCalledWith(true)
    await ctx.fiber.dispose()
  })

  it('stops notifying after the service fiber is disposed', async () => {
    const { ctx, fiber, service } = await setup()
    const listener = vi.fn<(enabled: boolean) => void>()
    service.subscribe(listener)
    const config = fiber.effectiveConfig as Config

    updateVolatile(config.enabled, createVolatile(true))
    await fiber.dispose()
    ctx.emit('loader/volatile-update', [['enabled']])

    expect(listener).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('exposes a live boolean field to settings forms', async () => {
    const field = UnattendedModeService.Config.dict?.enabled

    expect(field?.meta.volatile).toBe(true)
    expect(field?.meta.default).toBe(false)
  })
})
