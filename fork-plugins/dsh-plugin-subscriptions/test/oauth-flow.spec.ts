/** OAuth success and error callbacks must belong to the pending login attempt. */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { OAuthFlowManager, type FlowSpec } from '../src/auth/oauth-flow.js'

const PROVIDER = 'synthetic'
const FLOW: FlowSpec = {
  callbackPath: '/callback',
  listen: { host: '127.0.0.1', ports: [0] },
  buildAuthorizeUrl: input => `https://example.invalid/authorize?state=${encodeURIComponent(input.state)}`,
}

/** Own one loopback listener; every non-fixture fetch is refused and counted. */
async function startFlow(t: TestContext) {
  const realFetch = globalThis.fetch
  let providerRequests = 0
  globalThis.fetch = () => {
    providerRequests += 1
    return Promise.reject(new Error('the OAuth callback test forbids provider requests'))
  }
  t.after(() => {
    globalThis.fetch = realFetch
    assert.equal(providerRequests, 0)
  })
  const manager = new OAuthFlowManager()
  const attempt = await manager.start(PROVIDER, FLOW)
  const outcome = attempt.waitCode().then(
    code => ({ kind: 'code' as const, code }),
    (error: Error) => ({ kind: 'error' as const, message: error.message }),
  )
  t.after(async () => {
    attempt.cancel()
    await outcome
  })
  return {
    manager,
    attempt,
    outcome,
    async redirect(params: Record<string, string>, pathname = '/callback') {
      const url = new URL(pathname, attempt.redirectUri)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      const response = await realFetch(url)
      const body = await response.text()
      return { status: response.status, body }
    },
  }
}

for (const field of ['code', 'error', 'error_description']) {
  for (const state of [undefined, 'another-attempt']) {
    test(`a ${field} callback with ${state === undefined ? 'missing' : 'wrong'} state leaves the login pending`, async t => {
      const flow = await startFlow(t)
      const params: Record<string, string> = { [field]: 'unrelated-value' }
      if (state !== undefined) params.state = state
      assert.deepEqual(await flow.redirect(params), { status: 400, body: 'state mismatch' })
      assert.equal(flow.manager.isBusy(PROVIDER), true)
      const accepted = await flow.redirect({ code: 'synthetic-code', state: flow.attempt.state })
      assert.equal(accepted.status, 200)
      assert.deepEqual(await flow.outcome, { kind: 'code', code: 'synthetic-code' })
      assert.equal(flow.manager.isBusy(PROVIDER), false)
    })
  }
}

for (const detail of [undefined, 'the user denied authorization']) {
  test(`a matching provider error rejects the attempt with its ${detail === undefined ? 'code' : 'description'}`, async t => {
    const flow = await startFlow(t)
    const params: Record<string, string> = { error: 'access_denied', state: flow.attempt.state }
    if (detail !== undefined) params.error_description = detail
    const response = await flow.redirect(params)
    assert.equal(response.status, 200)
    assert.deepEqual(await flow.outcome, {
      kind: 'error',
      message: `authorization failed: ${detail ?? 'access_denied'}`,
    })
    assert.equal(flow.manager.isBusy(PROVIDER), false)
  })
}

test('a callback on another path cannot end the pending attempt', async t => {
  const flow = await startFlow(t)
  const rejected = await flow.redirect({ error: 'access_denied', state: flow.attempt.state }, '/unrelated')
  assert.equal(rejected.status, 404)
  assert.equal(flow.manager.isBusy(PROVIDER), true)
  const accepted = await flow.redirect({ code: 'synthetic-code', state: flow.attempt.state })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await flow.outcome, { kind: 'code', code: 'synthetic-code' })
})

test('a matching callback without a code or error leaves the login pending', async t => {
  const flow = await startFlow(t)
  assert.deepEqual(await flow.redirect({ state: flow.attempt.state }), { status: 400, body: 'missing authorization code' })
  assert.equal(flow.manager.isBusy(PROVIDER), true)
  const accepted = await flow.redirect({ code: 'synthetic-code', state: flow.attempt.state })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await flow.outcome, { kind: 'code', code: 'synthetic-code' })
})
