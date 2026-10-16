/**
 * The bounded request reader: status classification, the retry budget, `Retry-After`,
 * cancellation and the delegation of a version refusal.
 *
 * The transport is a synthetic recorder, so every assertion is about the requests this core
 * would send and the decision it returns — never about a real endpoint.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coreFailure } from '../src/claude-core/failures.js'
import {
  POLICY_LIMITS_BODY_LIMIT,
  policyBackoffMs,
  readBoundedBody,
  readPolicyLimits,
} from '../src/claude-core/policy-limits-client.js'
import type {
  CoreClock,
  CoreHttpRequest,
  CoreHttpResponse,
  CoreSleep,
} from '../src/claude-core/policy-limits-client.js'

const CLOCK: CoreClock = { now: () => 1_000 }

/** A response stand-in with case-insensitive headers. */
function response(status: number, body: string, headers: Record<string, string> = {}): CoreHttpResponse {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    status,
    headers: { get: name => lowered.get(name.toLowerCase()) ?? null },
    body: new Response(body).body,
  }
}

/**
 * A response whose body never ends, with pull and reader-acquisition counters.
 * @param status - the status the transport answers with.
 * @returns the response, the pull count and the reader count.
 */
function endlessResponse(status: number): {
  response: CoreHttpResponse
  pulls: () => number
  readers: () => number
} {
  const chunk = new Uint8Array(4_096).fill(65)
  let pulls = 0
  let readers = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(chunk)
    },
  })
  const acquire = stream.getReader.bind(stream)
  Object.defineProperty(stream, 'getReader', {
    value: () => {
      readers += 1
      return acquire()
    },
  })
  return {
    response: { status, headers: { get: () => null }, body: stream },
    pulls: () => pulls,
    readers: () => readers,
  }
}

/** The transport recorder plus a deterministic sleep. */
function harness(responses: Array<CoreHttpResponse | Error>): {
  requests: CoreHttpRequest[]
  slept: number[]
  transport: (request: CoreHttpRequest) => Promise<CoreHttpResponse>
  sleep: CoreSleep
} {
  const requests: CoreHttpRequest[] = []
  const slept: number[] = []
  let index = 0
  return {
    requests,
    slept,
    transport: async (request) => {
      requests.push(request)
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (next instanceof Error) throw next
      return next
    },
    sleep: async (ms) => { slept.push(ms) },
  }
}

/** The base operation for one test. */
function operation(
  transport: (request: CoreHttpRequest) => Promise<CoreHttpResponse>,
  sleep: CoreSleep,
  overrides: Partial<Parameters<typeof readPolicyLimits>[0]> = {},
): Parameters<typeof readPolicyLimits>[0] {
  return {
    url: 'https://api.anthropic.com/api/claude_code/policy_limits',
    accessToken: 'at-1',
    userAgent: 'claude-cli/2.1.288',
    transport,
    clock: CLOCK,
    sleep,
    random: () => 0.5,
    ...overrides,
  }
}

test('a 200 is parsed, hashed and returned with the role headers', async () => {
  const h = harness([response(200, '{"restrictions":{"enforce_a":{"allowed":true}}}', { signature: 'sig-1' })])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(outcome.kind, 'success')
  if (outcome.kind !== 'success') return
  assert.equal(outcome.response?.restrictions['enforce_a']?.allowed, true)
  assert.match(outcome.validator ?? '', /^sha256:/)
  assert.equal(outcome.signature, 'sig-1')
  assert.equal(outcome.attempts, 1)
  assert.equal(h.requests[0]?.headers['authorization'], 'Bearer at-1')
  assert.equal(h.requests[0]?.headers['cache-control'], 'no-cache')
  assert.equal(h.requests[0]?.headers['if-none-match'], undefined, 'no validator, no conditional header')
})

test('the live validator is sent as a conditional entity tag', async () => {
  const h = harness([response(304, '')])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, { validator: 'sha256:abc' }))
  assert.equal(outcome.kind, 'success')
  if (outcome.kind !== 'success') return
  assert.equal(outcome.response, null, 'a 304 revalidates the session policy')
  assert.equal(h.requests[0]?.headers['if-none-match'], '"sha256:abc"')
})

test('F8: a 304 without a validator is terminal and forbidden to retry', async () => {
  const h = harness([response(304, '')])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.reason, 'unexpected_304')
  assert.equal(outcome.failure.skipRetry, true)
  assert.equal(outcome.attempts, 1)
  assert.equal(h.requests.length, 1)
})

test('a transport failure retries within the pinned budget and then reports the caller as owner', async () => {
  const h = harness([new Error('offline')])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.recoveryOwner, 'caller', 'this reader never reschedules itself')
  assert.equal(outcome.attempts, 6, 'the first attempt plus the five pinned retries')
  assert.equal(h.slept.length, 5)
})

test('F11: a 500 is retried while a 4xx refusal stops immediately', async () => {
  const retried = harness([response(500, '{}'), response(200, '{"restrictions":{}}')])
  const recovered = await readPolicyLimits(operation(retried.transport, retried.sleep))
  assert.equal(recovered.kind, 'success')
  assert.equal(retried.requests.length, 2)

  const refused = harness([response(400, '{}'), response(200, '{"restrictions":{}}')])
  const stopped = await readPolicyLimits(operation(refused.transport, refused.sleep))
  assert.equal(stopped.kind, 'failure')
  if (stopped.kind !== 'failure') return
  assert.equal(stopped.failure.skipRetry, true)
  assert.equal(refused.requests.length, 1, 'a 4xx other than 408/409/429 is not retried')
})

test('a Retry-After the response states is honoured over the computed backoff', async () => {
  const h = harness([response(503, '{}', { 'retry-after': '3' }), response(200, '{"restrictions":{}}')])
  await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(h.slept[0], 3_000)
})

test('the backoff doubles to its ceiling, stays above the base and honours the jitter share', () => {
  assert.equal(policyBackoffMs(0, undefined, () => 0.5), 500)
  assert.equal(policyBackoffMs(8, undefined, () => 0.5), 32_000)
  assert.ok(policyBackoffMs(0, undefined, () => 0) >= 500)
  assert.ok(policyBackoffMs(0, undefined, () => 1) <= 625)
  assert.equal(policyBackoffMs(0, 9_000, () => 1), 9_000)
})

test('F10: a 401 is answered by one bounded reauthorization, and the retry keeps the budget', async () => {
  const h = harness([response(401, '{}'), response(200, '{"restrictions":{}}')])
  let reauthorizations = 0
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    reauthorize: async () => {
      reauthorizations += 1
      return 'at-2'
    },
  }))
  assert.equal(outcome.kind, 'success')
  assert.equal(reauthorizations, 1)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1]?.headers['authorization'], 'Bearer at-2', 'the replay uses the replacement token')
  assert.equal(outcome.kind === 'success' ? outcome.attempts : 0, 2, 'the wire count is real: the 401 and its own budgeted replay')
})

test('a 401 with no reauthorization is a terminal authentication failure', async () => {
  const h = harness([response(401, '{}')])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.code, 'auth_failed')
  assert.equal(outcome.failure.skipRetry, true)
})

test('a version refusal comes from the injected classifier and stays terminal', async () => {
  const h = harness([response(400, '{"error":{"error_code":"claude_code_version_too_old"}}'), response(200, '{"restrictions":{}}')])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    classifyFailure: async () => coreFailure('request_failed', {
      status: 400,
      skipRetry: true,
      reason: 'CLIENT_VERSION_UNSUPPORTED',
    }),
  }))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(outcome.failure.skipRetry, true)
  assert.equal(h.requests.length, 1, 'a refusal is not retried here; the owner decides the terminal path')
})

test('a parse failure is retried by default and terminal when the injected flag says so', async () => {
  const retried = harness([response(200, '{}'), response(200, '{"restrictions":{}}')])
  const recovered = await readPolicyLimits(operation(retried.transport, retried.sleep))
  assert.equal(recovered.kind, 'success')
  assert.equal(retried.requests.length, 2)

  const terminal = harness([response(200, '{}'), response(200, '{"restrictions":{}}')])
  const stopped = await readPolicyLimits(operation(terminal.transport, terminal.sleep, {
    parseFailureIsTerminal: true,
  }))
  assert.equal(stopped.kind, 'failure')
  if (stopped.kind !== 'failure') return
  assert.equal(stopped.failure.code, 'parse_failed')
  assert.equal(stopped.failure.skipRetry, true)
  assert.equal(terminal.requests.length, 1)
})

test('an aborted caller gets a cancelled outcome without a request', async () => {
  const h = harness([response(200, '{"restrictions":{}}')])
  const controller = new AbortController()
  controller.abort()
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, { signal: controller.signal }))
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(h.requests.length, 0)
})

test('the fail-open answer is opt-in and only for a missing route', async () => {
  const h = harness([response(404, '')])
  const closed = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(closed.kind, 'failure')

  const open = await readPolicyLimits(operation(h.transport, h.sleep, { failOpenOnMissingRoute: true }))
  assert.equal(open.kind, 'fail_open_empty')
  if (open.kind !== 'fail_open_empty') return
  assert.equal(open.reason, 'route_missing_fail_open')
})

test('the body read pulls only up to its bound, cancels the stream and releases the reader', async () => {
  let pulled = 0
  let cancelled = false
  let released = false
  const chunk = new Uint8Array(4_096).fill(65)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      controller.enqueue(chunk)
    },
    cancel() {
      cancelled = true
    },
  })
  const original = stream.getReader.bind(stream)
  const reader = original()
  const patched = new Proxy(reader, {
    get(target, property, receiver) {
      if (property === 'releaseLock') {
        return () => {
          released = true
          return (target.releaseLock as () => void)()
        }
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  Object.defineProperty(stream, 'getReader', { value: () => patched })
  const outcome = await readBoundedBody({ status: 200, headers: { get: () => null }, body: stream }, 8_192)
  assert.equal(outcome.truncated, true, 'the endless stream is truncated at the bound, not drained')
  assert.ok(pulled <= 4, `only the chunks inside the bound were pulled (pulled: ${String(pulled)})`)
  assert.equal(cancelled, true, 'the stream is cancelled once the bound is reached')
  assert.equal(released, true, 'and the reader is released')
})

test('the body bound is exact: at the limit it is complete, one byte over is truncated', async () => {
  const atLimit = await readBoundedBody({
    status: 200,
    headers: { get: () => null },
    body: new Response('x'.repeat(64)).body,
  }, 64)
  assert.deepEqual(atLimit, { text: 'x'.repeat(64), truncated: false })
  const overLimit = await readBoundedBody({
    status: 200,
    headers: { get: () => null },
    body: new Response('x'.repeat(65)).body,
  }, 64)
  assert.equal(overLimit.truncated, true)
  assert.equal(overLimit.text.length, 64)
})

test('an async-iterable body is closed as soon as the bound is reached', async () => {
  let closed = false
  const chunks = 1_000
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: async () => index < chunks
          ? { done: false as const, value: new Uint8Array(1_024).fill(66) }
          : { done: true as const, value: undefined },
        return: async () => {
          closed = true
          index = chunks
          return { done: true as const, value: undefined }
        },
      }
    },
  }
  const outcome = await readBoundedBody({ status: 200, headers: { get: () => null }, body }, 4_096)
  assert.equal(outcome.truncated, true)
  assert.equal(closed, true, 'the iterator is closed, not drained')
})

test('a cancelled caller wins over a 304 that arrives after the body read', async () => {
  const controller = new AbortController()
  const h = harness([{
    status: 304,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('ignored'))
        controller.abort()
        streamController.close()
      },
    }),
  }])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    validator: 'sha256:abc',
    signal: controller.signal,
  }))
  assert.equal(outcome.kind, 'cancelled', 'cancellation outranks a revalidation that already arrived')
})

test('a 404 fails open only for a caller that holds no prior policy', async () => {
  const none = harness([response(404, '')])
  const open = await readPolicyLimits(operation(none.transport, none.sleep, {
    failOpenOnMissingRoute: true,
    priorContext: 'none',
  }))
  assert.equal(open.kind, 'fail_open_empty')
  if (open.kind === 'fail_open_empty') assert.equal(open.reason, 'route_missing_fail_open')
  assert.equal(none.requests.length, 1)

  // A validator is the conditional request only a live document can produce, so its presence
  // is the safe inference of `live` — and a live prior is never replaced by an empty policy.
  for (const prior of [{ validator: 'sha256:abc' }, { priorContext: 'live' as const }, { priorContext: 'stale' as const }]) {
    const h = harness([response(404, '')])
    const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
      failOpenOnMissingRoute: true,
      ...prior,
    }))
    assert.equal(outcome.kind, 'failure', `expected ${JSON.stringify(prior)} to fail rather than fail open`)
    if (outcome.kind !== 'failure') continue
    assert.equal(outcome.failure.status, 404)
    assert.equal(outcome.failure.skipRetry, true)
    assert.equal(outcome.recoveryOwner, 'caller', 'the caller keeps its own adopted document')
    assert.equal(h.requests.length, 1, 'a 404 is not retried')
  }
})

test('an unsolicited 304 is fail-open only under the opt-in flag and only with no prior policy', async () => {
  const flagged = harness([response(304, '')])
  const open = await readPolicyLimits(operation(flagged.transport, flagged.sleep, {
    failOpenOnMissingRoute: true,
    priorContext: 'none',
  }))
  assert.equal(open.kind, 'fail_open_empty')
  if (open.kind === 'fail_open_empty') assert.equal(open.reason, 'unsolicited_304_fail_open')

  const unset = harness([response(304, '')])
  const closed = await readPolicyLimits(operation(unset.transport, unset.sleep, { priorContext: 'none' }))
  assert.equal(closed.kind, 'failure')
  if (closed.kind !== 'failure') return
  assert.equal(closed.failure.reason, 'unexpected_304')
  assert.equal(closed.failure.skipRetry, true)
  assert.equal(unset.requests.length, 1)
})

test('a validator no live policy produced cannot revalidate a 304', async () => {
  for (const priorContext of ['none', 'stale'] as const) {
    const h = harness([response(304, '')])
    const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
      validator: 'sha256:abc',
      priorContext,
    }))
    assert.equal(outcome.kind, 'failure', `a ${priorContext} prior holds no live document to revalidate`)
    if (outcome.kind === 'failure') assert.equal(outcome.failure.reason, 'unexpected_304')
  }
  // The inferred prior keeps the three-argument caller working: a validator without a stated
  // context is live, so its conditional answer is the revalidation it asked for.
  const inferred = harness([response(304, '')])
  const revalidated = await readPolicyLimits(operation(inferred.transport, inferred.sleep, { validator: 'sha256:abc' }))
  assert.equal(revalidated.kind, 'success')
  if (revalidated.kind === 'success') assert.equal(revalidated.response, null)
})

test('five retried failures, one rejected credential and the success that follows are seven wire calls', async () => {
  const h = harness([
    response(500, '{}'),
    response(500, '{}'),
    response(500, '{}'),
    response(500, '{}'),
    response(500, '{}'),
    response(401, '{}'),
    response(200, '{"restrictions":{}}'),
  ])
  let refreshes = 0
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    reauthorize: async () => {
      refreshes += 1
      return 'at-2'
    },
  }))
  assert.equal(outcome.kind, 'success')
  if (outcome.kind !== 'success') return
  assert.equal(outcome.attempts, 7, 'five 500s, the 401 and its own budgeted replay')
  assert.equal(h.requests.length, 7)
  assert.equal(h.slept.length, 5, 'one backoff per retried failure')
  assert.equal(refreshes, 1, 'the replay budget is one, and it is separate from the retry budget')
  assert.equal(h.requests[6]?.headers['authorization'], 'Bearer at-2')
})

test('a version refusal on a 401 is terminal, sees the once-read body and starts no replay', async () => {
  const versionBody = '{"error":{"error_code":"claude_code_version_too_old"}}'
  let reads = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1
      controller.enqueue(new TextEncoder().encode(versionBody))
      controller.close()
    },
  })
  const acquire = stream.getReader.bind(stream)
  let acquisitions = 0
  Object.defineProperty(stream, 'getReader', {
    value: () => {
      acquisitions += 1
      return acquire()
    },
  })
  const h = harness([{ status: 401, headers: { get: () => null }, body: stream }])
  let classifiedBody: string | undefined
  let refreshes = 0
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    classifyFailure: async (input) => {
      classifiedBody = input.body
      return input.body.includes('claude_code_version_too_old')
        ? coreFailure('request_failed', { status: input.status, skipRetry: true, reason: 'CLIENT_VERSION_UNSUPPORTED' })
        : undefined
    },
    reauthorize: async () => {
      refreshes += 1
      return 'at-2'
    },
  }))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(classifiedBody, versionBody, 'the classifier is handed the body the reader already consumed')
  assert.equal(reads, 1, 'the body produced exactly one chunk, so it was not read twice')
  assert.equal(acquisitions, 1, 'the reader was acquired once for this response')
  assert.equal(h.requests.length, 1, 'a version refusal is not retried')
  assert.equal(refreshes, 0, 'and is never answered with a credential replay')
})

test('a 304 whose body is pulled before the caller aborts is cancelled, not revalidated', async () => {
  const controller = new AbortController()
  let pulls = 0
  let abortRaisedByPull = false
  const h = harness([{
    status: 304,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      // No `start`: the abort is raised while the body is being pulled, so the cancellation
      // is not a pre-arranged abort that would have short-circuited the read anyway.
      pull(streamController) {
        pulls += 1
        streamController.enqueue(new TextEncoder().encode('ignored'))
        abortRaisedByPull = true
        controller.abort()
        streamController.close()
      },
    }),
  }])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    validator: 'sha256:abc',
    signal: controller.signal,
  }))
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(h.requests.length, 1)
  assert.equal(pulls, 1, 'the body was pulled once before the abort landed')
  assert.equal(abortRaisedByPull, true)
})

test('a body over the product cap is terminal and is never pulled again', async () => {
  const endless = endlessResponse(200)
  const h = harness([endless.response])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.code, 'unsupported')
  assert.equal(outcome.failure.reason, 'body_over_limit')
  assert.equal(outcome.failure.skipRetry, true, 'an oversized document cannot be made to fit by retrying')
  assert.equal(outcome.failure.status, 200)
  assert.deepEqual(
    Object.keys(outcome.failure).sort(),
    ['code', 'message', 'reason', 'skipRetry', 'status'],
    'the failure carries no excerpt of the body it refused',
  )
  assert.equal(outcome.attempts, 1)
  assert.equal(h.requests.length, 1, 'the same oversized document is not re-pulled')
  assert.equal(h.slept.length, 0)
  assert.equal(endless.readers(), 1)
  assert.ok(
    endless.pulls() <= POLICY_LIMITS_BODY_LIMIT / 4_096 + 2,
    `only the chunks inside the cap plus one read-ahead were pulled (pulled: ${String(endless.pulls())})`,
  )
})

test('a failed response whose body is over the cap is terminal too', async () => {
  const endless = endlessResponse(503)
  const h = harness([endless.response, response(200, '{"restrictions":{}}')])
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.code, 'unsupported')
  assert.equal(outcome.failure.reason, 'body_over_limit')
  assert.equal(outcome.failure.skipRetry, true)
  assert.equal(outcome.failure.status, 503)
  assert.equal(h.requests.length, 1, 'no retry spends the budget on the same oversized body')
  assert.equal(h.slept.length, 0)
})

test('a refusal classified from a truncated body still outranks the cap', async () => {
  const endless = endlessResponse(400)
  const h = harness([endless.response])
  const seen: { status: number; truncated: boolean; text: string }[] = []
  const outcome = await readPolicyLimits(operation(h.transport, h.sleep, {
    classifyFailure: async (input) => {
      seen.push({ status: input.status, truncated: input.truncated, text: input.body })
      return coreFailure('request_failed', { status: input.status, skipRetry: true, reason: 'CLIENT_VERSION_UNSUPPORTED' })
    },
  }))
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind !== 'failure') return
  assert.equal(outcome.failure.reason, 'CLIENT_VERSION_UNSUPPORTED')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.status, 400)
  assert.equal(seen[0]?.truncated, true, 'the classifier is told the body was cut at the cap')
  assert.equal(h.requests.length, 1)
})
