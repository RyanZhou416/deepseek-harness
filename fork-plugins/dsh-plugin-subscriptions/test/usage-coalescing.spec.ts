import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchClaudeUsage } from '../src/providers/claude.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'

function session(accessToken: string): ClaudeSession {
  return {
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    scopes: 'user:inference',
    accountUuid: 'uuid-1',
    deviceId: 'dev-1',
  }
}

const OK_BODY = JSON.stringify({ limits: [{ kind: 'session', percent: 12 }] })

interface Deferred {
  readonly fetch: FetchFn
  calls(): number
  aborted(): boolean
  settle(): void
}

/**
 * A fetch that answers only when `settle` is called, and rejects on abort the way the real
 * one does.
 * @returns the fake plus the observations the tests assert on.
 */
function deferredFetch(): Deferred {
  let release: (() => void) | undefined
  let calls = 0
  let sawAbort = false
  const fetchFn = ((_url: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
    calls += 1
    return new Promise<Response>((resolve, reject) => {
      const fail = (): void => {
        sawAbort = true
        reject(new Error('aborted'))
      }
      if (init?.signal?.aborted === true) {
        fail()
        return
      }
      init?.signal?.addEventListener('abort', fail, { once: true })
      release = () => {
        resolve(new Response(OK_BODY, { status: 200, headers: { 'content-type': 'application/json' } }))
      }
    })
  }) as FetchFn
  return {
    fetch: fetchFn,
    calls: () => calls,
    aborted: () => sawAbort,
    settle: () => { release?.() },
  }
}

test('a second caller waits on the read already running', async () => {
  const scripted = deferredFetch()
  const first = fetchClaudeUsage(session('token-a'), scripted.fetch)
  const second = fetchClaudeUsage(session('token-a'), scripted.fetch)
  scripted.settle()
  const [a, b] = await Promise.all([first, second])

  assert.equal(scripted.calls(), 1, 'one request serves both callers')
  assert.deepEqual(a, b)
})

test('a later caller starts a new read once the first has settled', async () => {
  const scripted = deferredFetch()
  const first = fetchClaudeUsage(session('token-b'), scripted.fetch)
  scripted.settle()
  await first
  const second = fetchClaudeUsage(session('token-b'), scripted.fetch)
  scripted.settle()
  await second
  assert.equal(scripted.calls(), 2, 'the in-flight entry is released')
})

test('one caller giving up does not cancel the shared read', async () => {
  const scripted = deferredFetch()
  const controller = new AbortController()
  const abandoned = fetchClaudeUsage(session('token-c'), scripted.fetch, controller.signal)
  const waiting = fetchClaudeUsage(session('token-c'), scripted.fetch)
  controller.abort()

  await assert.rejects(abandoned)
  assert.equal(scripted.aborted(), false, 'the shared request keeps its own controller')
  scripted.settle()
  await waiting
})

test('a read that outlives its bound is abandoned', async () => {
  const scripted = deferredFetch()
  await assert.rejects(
    fetchClaudeUsage(session('token-d'), scripted.fetch, undefined, undefined, 1),
  )
  assert.equal(scripted.aborted(), true, 'the bound aborts the request it owns')
})
