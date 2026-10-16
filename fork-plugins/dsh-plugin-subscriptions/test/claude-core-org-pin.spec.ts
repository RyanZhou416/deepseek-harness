/**
 * The organization pin: parsing a stated pin and validating the account against it.
 *
 * The transport is synthetic, so the assertions are about whether a request is sent at all
 * and what decision each answer produces.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOrgPin, validateOrgPin } from '../src/claude-core/org-pin.js'
import type { CoreHttpRequest, CoreHttpResponse, CoreTransport } from '../src/claude-core/policy-limits-client.js'

/** A response stand-in. */
function response(status: number, body: string): CoreHttpResponse {
  return { status, headers: { get: () => null }, body: new Response(body).body }
}

/** A transport that records what it was asked to send. */
function recorder(answer: CoreHttpResponse | Error): { requests: CoreHttpRequest[]; transport: CoreTransport } {
  const requests: CoreHttpRequest[] = []
  return {
    requests,
    transport: async (request) => {
      requests.push(request)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

/** The validation request for one pin. */
function validation(
  pin: unknown,
  answer: CoreHttpResponse | Error,
): { requests: CoreHttpRequest[]; outcome: ReturnType<typeof validateOrgPin> } {
  const recorded = recorder(answer)
  return {
    requests: recorded.requests,
    outcome: validateOrgPin({
      url: 'https://api.anthropic.com/api/oauth/validate',
      accessToken: 'at-1',
      userAgent: 'claude-cli/2.1.288',
      pin,
      transport: recorded.transport,
    }),
  }
}

test('a string pin and a non-empty array pin parse into ordered sets', () => {
  const single = parseOrgPin('org-1')
  assert.equal(single.kind, 'pin')
  if (single.kind !== 'pin') return
  assert.deepEqual([...single.organizations], ['org-1'])
  const set = parseOrgPin(['org-1', 'org-2', 'org-1'])
  assert.equal(set.kind, 'pin')
  if (set.kind !== 'pin') return
  assert.deepEqual([...set.organizations], ['org-1', 'org-2'], 'duplicates collapse, order is kept')
})

test('absent and unusable pins are different states', () => {
  assert.equal(parseOrgPin(undefined).kind, 'none')
  assert.equal(parseOrgPin(null).kind, 'none')
  // An empty array and a whitespace-only string are INVALID, never none: a malformed pin
  // must not read as "no pin".
  for (const value of [[], '', '   ', 42, {}, [''], ['org-1', 2]]) {
    const parsed = parseOrgPin(value)
    assert.equal(parsed.kind, 'invalid', `expected ${JSON.stringify(value)} to be invalid`)
  }
})

test('no pin sends nothing and permits the operation', async () => {
  for (const pin of [undefined, null]) {
    const { requests, outcome } = validation(pin, response(200, '{"organization_uuid":"org-1"}'))
    assert.equal((await outcome).kind, 'no-pin')
    assert.equal(requests.length, 0, 'a missing pin never probes the endpoint')
  }
})

test('an unusable pin denies without sending a request', async () => {
  const { requests, outcome } = validation([], response(200, '{"organization_uuid":"org-1"}'))
  const resolved = await outcome
  assert.equal(resolved.kind, 'denied')
  if (resolved.kind !== 'denied') return
  assert.equal(resolved.failure.code, 'invalid_input')
  assert.equal(requests.length, 0)
})

test('a pinned organization is allowed and the request is the pinned one', async () => {
  const { requests, outcome } = validation('org-1', response(200, '{"organization_uuid":"org-1"}'))
  const resolved = await outcome
  assert.equal(resolved.kind, 'allowed')
  if (resolved.kind !== 'allowed') return
  assert.equal(resolved.organization, 'org-1')
  const request = requests[0]
  assert.equal(request?.method, 'POST')
  assert.equal(request?.body, null, 'the validation is bodyless')
  assert.equal(request?.timeoutMs, 10_000)
  assert.equal(request?.headers['authorization'], 'Bearer at-1')
  assert.equal(request?.headers['content-type'], 'application/json')
  assert.equal(request?.headers['user-agent'], 'claude-cli/2.1.288')
})

test('a string array pin allows any member', async () => {
  const { outcome } = validation(['org-1', 'org-2'], response(200, '{"organization_uuid":"org-2"}'))
  assert.equal((await outcome).kind, 'allowed')
})

test('an organization outside the pin is a mismatch', async () => {
  const { outcome } = validation('org-1', response(200, '{"organization_uuid":"org-9"}'))
  const resolved = await outcome
  assert.equal(resolved.kind, 'denied')
  if (resolved.kind !== 'denied') return
  assert.equal(resolved.failure.code, 'org_pin_mismatch')
})

test('a result without an organization is a verification failure', async () => {
  for (const body of ['{}', '{"organization_uuid":""}', 'not json']) {
    const { outcome } = validation('org-1', response(200, body))
    const resolved = await outcome
    assert.equal(resolved.kind, 'denied')
    if (resolved.kind !== 'denied') return
    assert.equal(resolved.failure.code, 'org_verify_failed')
  }
})

test('a non-2xx or a transport failure is a verification failure, never an allow', async () => {
  const http = await validation('org-1', response(500, '{}')).outcome
  assert.equal(http.kind, 'denied')
  if (http.kind === 'denied') assert.equal(http.failure.code, 'org_verify_failed')
  const transport = await validation('org-1', new Error('offline')).outcome
  assert.equal(transport.kind, 'denied')
  if (transport.kind === 'denied') assert.equal(transport.failure.reason, 'transport')
})

test('cancellation denies rather than allowing', async () => {
  const recorded = recorder(response(200, '{"organization_uuid":"org-1"}'))
  const controller = new AbortController()
  controller.abort()
  const outcome = await validateOrgPin({
    url: 'https://api.anthropic.com/api/oauth/validate',
    accessToken: 'at-1',
    userAgent: 'claude-cli/2.1.288',
    pin: 'org-1',
    transport: recorded.transport,
    signal: controller.signal,
  })
  assert.equal(outcome.kind, 'denied')
  if (outcome.kind !== 'denied') return
  assert.equal(outcome.failure.code, 'cancelled')
})

test('a validation body over the product cap denies without carrying its bytes', async () => {
  const chunk = new Uint8Array(4_096).fill(65)
  let pulls = 0
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(chunk)
    },
  })
  const recorded = recorder({ status: 200, headers: { get: () => null }, body: endless })
  const resolved = await validateOrgPin({
    url: 'https://api.anthropic.com/api/oauth/validate',
    accessToken: 'at-1',
    userAgent: 'claude-cli/2.1.288',
    pin: 'org-1',
    transport: recorded.transport,
  })
  assert.equal(resolved.kind, 'denied')
  if (resolved.kind !== 'denied') return
  assert.equal(resolved.failure.code, 'org_verify_failed')
  assert.equal(resolved.failure.reason, 'body_over_limit')
  assert.deepEqual(Object.keys(resolved.failure).sort(), ['code', 'message', 'reason'], 'no response text reaches the failure')
  assert.equal(recorded.requests.length, 1, 'the oversized answer is not requested again')
  assert.ok(pulls <= 4, `only the chunks inside the cap were pulled (pulled: ${String(pulls)})`)
})
