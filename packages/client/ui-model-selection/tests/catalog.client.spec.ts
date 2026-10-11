import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'

const catalog = (model: string): ModelCatalog => ({
  default: { provider: 'fixture', model },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: model, name: model }] }],
  failures: [],
})

function directory(models: () => Promise<unknown>): ModelCatalogDirectory {
  // The providing plugin's context, scripted down to the one method it calls.
  return new ModelCatalogDirectory({ remote: { session: { modelCatalog: models } } } as never)
}

/** A marker no catalog equals, so a race that the retained value should win reports which side settled. */
const PENDING = Symbol('pending')

/**
 * One catalog directory whose authority reads stay outstanding until the test
 * releases them by call index. Deferring the responses is what makes read
 * overlap deterministic: every assertion below is about which read is still in
 * flight, never about elapsed time.
 * @returns the directory under test, its read count, and the release verb.
 */
function deferredDirectory(): {
  subject: ModelCatalogDirectory
  reads: () => number
  release: (index: number, response: unknown) => void
} {
  const outstanding: Array<(response: unknown) => void> = []
  const models = vi.fn(() => new Promise<unknown>((resolve) => { outstanding.push(resolve) }))
  return {
    subject: directory(models),
    reads: () => models.mock.calls.length,
    release: (index, response) => { outstanding[index]!(response) },
  }
}

/** One successful read response. */
function ok(model: string): unknown {
  return { ok: true, value: catalog(model) }
}

/**
 * Let a released response run out its `then`/`catch`/`finally` chain. Four
 * microtask turns cover the three the chain uses, so an assertion after this
 * observes a settled read without depending on the clock.
 * @returns fulfillment once the chain has run.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

describe('ModelCatalogDirectory', () => {
  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('recovered') })
    const subject = directory(models)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('recovered'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading', error: null })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears it on a failed Host reset', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(models)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: catalog('old'), status: 'error', error: 'refresh failed',
      })
    })

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: null, status: 'error', error: 'reset failed',
      })
    })
  })

  it('answers a warm reader from the retained catalog while a same-generation refresh is in flight', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('base'))
    await boot

    deferred.subject.refresh()
    expect(deferred.reads()).toBe(2)

    // A reader that awaited the in-flight replacement would still be pending, so
    // the already-settled marker would win this race instead of the catalog.
    const outcome = await Promise.race([deferred.subject.load(), Promise.resolve(PENDING)])
    expect(outcome).toEqual(catalog('base'))
    expect(deferred.subject.store.getSnapshot()).toMatchObject({ value: catalog('base'), status: 'refreshing' })
    expect(deferred.reads()).toBe(2)

    deferred.release(1, ok('refreshed'))
    await vi.waitFor(() => {
      expect(deferred.subject.store.getSnapshot()).toMatchObject({ value: catalog('refreshed'), status: 'ready' })
    })
    await expect(deferred.subject.load()).resolves.toEqual(catalog('refreshed'))
    expect(deferred.reads()).toBe(2)
  })

  it('coalesces a burst of invalidations into one current and one trailing read, and the latest one wins', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('base'))
    await boot

    const published: Array<string | null> = []
    deferred.subject.store.subscribe(() => {
      published.push(deferred.subject.store.getSnapshot().value?.default.model ?? null)
    })

    deferred.subject.refresh()
    expect(deferred.reads()).toBe(2)
    deferred.subject.refresh()
    deferred.subject.refresh()
    expect(deferred.reads()).toBe(2)

    deferred.release(1, ok('superseded'))
    await vi.waitFor(() => { expect(deferred.reads()).toBe(3) })
    deferred.release(2, ok('latest'))
    await vi.waitFor(() => {
      expect(deferred.subject.store.getSnapshot()).toMatchObject({ value: catalog('latest'), status: 'ready' })
    })
    // The retained catalog was marked refreshing once, and only the trailing
    // read served the newest generation: the superseded response reached no reader.
    expect(published).toEqual(['base', 'latest'])
  })

  it('clears the retained catalog on a Host reset and abandons that generation\'s read', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('old-host'))
    await boot

    deferred.subject.refresh()
    deferred.subject.resetGeneration()
    expect(deferred.reads()).toBe(3)
    expect(deferred.subject.store.getSnapshot()).toEqual({ value: null, status: 'loading', error: null })

    deferred.release(1, ok('old-host-late'))
    await settle()
    // The abandoned read neither published the superseded catalog nor started
    // a trailing read for a generation it no longer owns.
    expect(deferred.reads()).toBe(3)
    expect(deferred.subject.store.getSnapshot().value).toBeNull()

    deferred.release(2, ok('new-host'))
    await vi.waitFor(() => {
      expect(deferred.subject.store.getSnapshot()).toMatchObject({ value: catalog('new-host'), status: 'ready' })
    })
  })

  it('keeps the retained catalog through a failed refresh and reads again when asked', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('base'))
    await boot

    deferred.subject.refresh()
    deferred.release(1, { ok: false, error: new RemoteError('gateway/internal', 'refresh offline', {}) })
    await vi.waitFor(() => {
      expect(deferred.subject.store.getSnapshot()).toEqual({
        value: catalog('base'), status: 'error', error: 'gateway/internal: refresh offline',
      })
    })

    const retry = deferred.subject.load()
    expect(deferred.reads()).toBe(3)
    deferred.release(2, ok('recovered'))
    await expect(retry).resolves.toEqual(catalog('recovered'))
  })

  it('settles only after the replacement in flight, including its queued follow-up', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('base'))
    await boot

    deferred.subject.refresh()
    deferred.subject.refresh()
    let settled = false
    void deferred.subject.settled().then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    deferred.release(1, ok('superseded'))
    await settle()
    expect(settled).toBe(false)

    deferred.release(2, ok('latest'))
    await vi.waitFor(() => { expect(settled).toBe(true) })
  })

  it('settles a waiter when the replacement fails, leaving the failure on the store', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('base'))
    await boot

    deferred.subject.refresh()
    let settled = false
    void deferred.subject.settled().then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    deferred.release(1, { ok: false, error: new RemoteError('gateway/internal', 'refresh offline', {}) })
    await vi.waitFor(() => { expect(settled).toBe(true) })
    expect(deferred.subject.store.getSnapshot()).toEqual({
      value: catalog('base'), status: 'error', error: 'gateway/internal: refresh offline',
    })
  })

  it('starts no read and publishes nothing after disposal, including its queued follow-up', async () => {
    const deferred = deferredDirectory()
    const boot = deferred.subject.load()
    deferred.release(0, ok('base'))
    await boot

    deferred.subject.refresh()
    deferred.subject.refresh()
    expect(deferred.reads()).toBe(2)

    deferred.subject.dispose()
    deferred.release(1, ok('after-dispose'))
    await settle()
    // The abandoned read published nothing, and the follow-up it was holding never started.
    expect(deferred.reads()).toBe(2)
    expect(deferred.subject.store.getSnapshot()).toEqual({
      value: catalog('base'), status: 'refreshing', error: null,
    })
    await deferred.subject.settled()

    // Work arriving after teardown — a forwarded Host event, a reset, or a read —
    // starts nothing either, and the read is refused rather than served.
    deferred.subject.refresh()
    deferred.subject.resetGeneration()
    expect(deferred.reads()).toBe(2)
    await expect(deferred.subject.load()).rejects.toThrow('disposed')
  })

  it('refuses a read of a disposed catalog that retained nothing', async () => {
    const deferred = deferredDirectory()
    deferred.subject.dispose()

    await expect(deferred.subject.load()).rejects.toThrow('disposed')
    expect(deferred.reads()).toBe(0)
  })
})
