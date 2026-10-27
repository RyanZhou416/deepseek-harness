/** The Host credential and discovery operations behind the page. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialInfo, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { createCcPoolOperations } from '../src/client/operations.ts'

/** One `credentials.describe` answer, as the Remote carries it. */
type DescribeAnswer = { ok: true; value: Record<string, CredentialInfo> } | { ok: false; error: RemoteError }
/** One `credentials.set` answer, as the Remote carries it. */
type SetAnswer = { ok: true; value: undefined } | { ok: false; error: RemoteError }
/** One `llm.discoverModels` answer, as the Remote carries it. */
type DiscoveryAnswer = { ok: true; value: LlmDiscoveredModel[] } | { ok: false; error: RemoteError }

/** A context whose credential and discovery namespaces answer with the given results. */
function bench() {
  const ctx = new Context()
  const describeCredential = vi.fn<() => Promise<DescribeAnswer>>(async () => ({ ok: true, value: {} }))
  const set = vi.fn<(ref: string, value: string) => Promise<SetAnswer>>(async () => ({ ok: true, value: undefined }))
  const discoverModels = vi.fn<(ns: string, request: object) => Promise<DiscoveryAnswer>>(
    async () => ({ ok: true, value: [] }),
  )
  new TestRemote(ctx, {
    credentials: { describe: describeCredential, set, unset: vi.fn() },
    llm: { discoverModels },
  })
  return { ctx, describeCredential, set, discoverModels, operations: createCcPoolOperations(ctx) }
}

describe('cc-pool credential operations', () => {
  it('reports the configured state, source, and writability of the reference', async () => {
    const { describeCredential, operations } = bench()
    describeCredential.mockResolvedValue({
      ok: true,
      value: { CC_POOL_API_KEY: { configured: true, source: 'file', writable: true } },
    })

    await expect(operations.describeCredential('CC_POOL_API_KEY')).resolves.toEqual({
      configured: true, source: 'file', writable: true,
    })
    expect(describeCredential).toHaveBeenCalledWith(['CC_POOL_API_KEY'])
  })

  it('omits the source while the Host reports none', async () => {
    const { describeCredential, operations } = bench()
    describeCredential.mockResolvedValue({ ok: true, value: { CC_POOL_API_KEY: { configured: false, writable: true } } })

    const view = await operations.describeCredential('CC_POOL_API_KEY')
    expect(view).toEqual({ configured: false, writable: true })
    expect(Object.hasOwn(view, 'source')).toBe(false)
  })

  it('treats an unknown reference as unconfigured but writable', async () => {
    const { operations } = bench()

    await expect(operations.describeCredential('CC_POOL_API_KEY')).resolves.toEqual({ configured: false, writable: true })
  })

  it('surfaces a read failure with the Host diagnostic and no writability', async () => {
    const { describeCredential, operations } = bench()
    describeCredential.mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'no credential provider is mounted', {}),
    })

    await expect(operations.describeCredential('CC_POOL_API_KEY')).resolves.toEqual({
      configured: false, writable: false, error: 'no credential provider is mounted',
    })
  })

  it('stores a literal and reports a refusal verbatim', async () => {
    const { set, operations } = bench()
    await expect(operations.storeCredential('CC_POOL_API_KEY', 'sk-one')).resolves.toBeUndefined()

    set.mockResolvedValue({
      ok: false,
      error: new RemoteError('credential/rejected', 'the store is read-only', { ref: 'CC_POOL_API_KEY' }),
    })
    await expect(operations.storeCredential('CC_POOL_API_KEY', 'sk-two')).resolves.toBe('the store is read-only')
    expect(set).toHaveBeenLastCalledWith('CC_POOL_API_KEY', 'sk-two')
  })
})

describe('cc-pool discovery operations', () => {
  it('asks the pool route for its catalogue and returns the listing', async () => {
    const { discoverModels, operations } = bench()
    discoverModels.mockResolvedValue({ ok: true, value: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }] })

    await expect(operations.discoverModels('llm-cc-pool', { provider: 'cc-pool' })).resolves.toEqual({
      kind: 'found', models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
    })
    expect(discoverModels).toHaveBeenCalledWith('llm-cc-pool', { provider: 'cc-pool' })
  })

  it('reports a refused interrogation with the Host diagnostic', async () => {
    const { discoverModels, operations } = bench()
    discoverModels.mockResolvedValue({
      ok: false,
      error: new RemoteError('llm/model-discovery-rejected', 'no model discovery is registered for "llm-cc-pool"', {
        settingsNs: 'llm-cc-pool',
      }),
    })

    await expect(operations.discoverModels('llm-cc-pool', { provider: 'cc-pool' })).resolves.toEqual({
      kind: 'refused', message: 'no model discovery is registered for "llm-cc-pool"',
    })
  })

  it('answers normally when the read settles before any cancellation', async () => {
    const { discoverModels, operations } = bench()
    discoverModels.mockResolvedValue({ ok: true, value: [{ id: 'claude-sonnet-5-5' }] })
    const controller = new AbortController()

    await expect(operations.discoverModels('llm-cc-pool', { provider: 'cc-pool' }, controller.signal)).resolves.toEqual({
      kind: 'found', models: [{ id: 'claude-sonnet-5-5' }],
    })
    // A later cancellation has no listener left to reach.
    controller.abort()
  })

  it('stops waiting when the page cancels, keeping the reason it cancelled with', async () => {
    const { discoverModels, operations } = bench()
    const answer = deferred<DiscoveryAnswer>()
    discoverModels.mockReturnValue(answer.promise)
    const controller = new AbortController()
    const reason = new Error('the page left')

    const listing = operations.discoverModels('llm-cc-pool', { provider: 'cc-pool' }, controller.signal)
    controller.abort(reason)

    await expect(listing).rejects.toBe(reason)
  })

  it('describes a cancellation that carries no Error reason', async () => {
    const { discoverModels, operations } = bench()
    discoverModels.mockReturnValue(new Promise<DiscoveryAnswer>(() => {}))
    const controller = new AbortController()

    const listing = operations.discoverModels('llm-cc-pool', { provider: 'cc-pool' }, controller.signal)
    controller.abort('connection closed')

    await expect(listing).rejects.toThrow('the pool discovery was cancelled')
  })

  it('never asks the Host when the page already cancelled', async () => {
    const { discoverModels, operations } = bench()
    const controller = new AbortController()
    const reason = new Error('the page cancelled before the call')
    controller.abort(reason)

    await expect(operations.discoverModels('llm-cc-pool', { provider: 'cc-pool' }, controller.signal))
      .rejects.toBe(reason)
    expect(discoverModels).not.toHaveBeenCalled()
  })
})

/** One promise plus its resolver, for scripting an in-flight Host call. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
