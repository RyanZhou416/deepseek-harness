/** The Session-creation override row loads the model directory on demand. */
import { describe, expect, it, vi } from 'vitest'
import { SessionCreateOverrideCatalogStore } from '../src/client/session-create-override-store.ts'

function context(modelCatalog: ReturnType<typeof vi.fn>) {
  return { remote: { session: { modelCatalog } } } as never
}

describe('SessionCreateOverrideCatalogStore', () => {
  it('publishes the loaded directory and marks partial failures', async () => {
    const modelCatalog = vi.fn(async () => ({
      ok: true,
      value: {
        default: { provider: 'alpha', model: 'fast' },
        routableProviders: ['alpha'],
        groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'fast' }] }],
        failures: [{ id: 'beta', name: 'Beta', message: 'offline' }],
      },
    }))
    const store = new SessionCreateOverrideCatalogStore(context(modelCatalog))
    store.load()
    expect(store.store.getSnapshot().status).toBe('loading')
    await vi.waitFor(() => { expect(store.store.getSnapshot().status).toBe('ready') })
    expect(store.store.getSnapshot()).toMatchObject({
      groups: [{ id: 'alpha' }],
      partial: true,
    })
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('reports a failed load and does not publish after disposal', async () => {
    const pending = Promise.withResolvers<never>()
    const modelCatalog = vi.fn(() => pending.promise)
    const store = new SessionCreateOverrideCatalogStore(context(modelCatalog))
    store.load()
    store.dispose()
    pending.reject(new Error('offline'))
    await vi.waitFor(() => { expect(store.store.getSnapshot().status).toBe('loading') })
    expect(store.store.getSnapshot().status).toBe('loading')
  })

  it('reports a failed load', async () => {
    const store = new SessionCreateOverrideCatalogStore(context(vi.fn(async () => { throw new Error('offline') })))
    store.load()
    await vi.waitFor(() => { expect(store.store.getSnapshot().status).toBe('error') })
    store.dispose()
  })

  it('reports a refused directory request', async () => {
    const store = new SessionCreateOverrideCatalogStore(context(vi.fn(async () => ({
      ok: false,
      error: { code: 'unavailable', message: 'offline' },
    } as never))))
    store.load()
    await vi.waitFor(() => { expect(store.store.getSnapshot().status).toBe('error') })
    store.dispose()
  })
})
