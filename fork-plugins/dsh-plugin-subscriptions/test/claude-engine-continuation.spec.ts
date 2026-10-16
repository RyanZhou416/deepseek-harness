/**
 * The continuation selector: the retained history is the only authority for chaining.
 *
 * The cases cover the boundaries the client itself implements, because a selector that skips one
 * gate would chain a request to a turn from another account, another identity generation or
 * another wire session. The backward walk and the refusal to backtrack are asserted separately: a
 * row whose id is unusable ends the walk, while a row that simply carries no id must not stop an
 * earlier turn from answering, and a row whose envelope does not line up with the blocks it
 * carries is discarded whole so the walk reaches an older eligible turn.
 *
 * The references here are literals rather than derivations: this layer compares digests, and
 * deriving one would pull the salt store's filesystem and home-directory dependencies into a pure
 * selector's test. The salt store's own spec covers derivation and its shape check.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isClaudeRequestId, readClaudeContinuation, selectClaudeContinuation } from '../src/claude-engine/continuation.js'
import type { ContinuationGate, ContinuationMessage } from '../src/claude-engine/continuation.js'
import type { ClaudeAccountRef } from '../src/claude-core/account-ref.js'

/** A reference this installation would derive for one account. */
const ACCOUNT: ClaudeAccountRef = { kind: 'salt-sha256', version: 1, ref: 'a'.repeat(64) }

/** A second account, for the isolation cases. */
const OTHER_ACCOUNT: ClaudeAccountRef = { kind: 'salt-sha256', version: 1, ref: 'b'.repeat(64) }

/** The gate one request is served under. */
const GATE: ContinuationGate = {
  accountRef: ACCOUNT,
  spanEpoch: 3,
  harnessSessionId: 'session-1',
  wireSessionId: 'wire-1',
}

/** One block per content entry the row carries, so the envelope's list lines up. */
const BLOCKS = [{}]

/** Facts a case states instead of the gate's own. */
interface RowOverrides {
  readonly accountRef?: ClaudeAccountRef
  readonly spanEpoch?: number
  readonly harnessSessionId?: string
  readonly wireSessionId?: string
  readonly model?: string
  readonly provider?: string
  readonly kind?: string
  readonly role?: string
  readonly content?: readonly unknown[]
  readonly blocks?: readonly unknown[]
  readonly responseVersion?: number
  readonly omitRole?: boolean
}

/**
 * The content and envelope of one Claude assistant row.
 *
 * The envelope keeps `blocks` beside `response`, which is the layout the adapter's replay state
 * has: `response` is the recorded response and `blocks` is the assembled block list the row must
 * line up with.
 * @param requestId - the recorded `request-id`, or undefined when the response carried none.
 * @param overrides - facts to state instead of the gate's own.
 * @returns the members every row carries, with or without a role.
 */
function rowBody(
  requestId: string | undefined,
  overrides: RowOverrides,
): { readonly content: readonly unknown[]; readonly source: NonNullable<ContinuationMessage['source']> } {
  return {
    content: overrides.content ?? [{ type: 'text', text: 'recorded' }],
    source: {
      kind: overrides.kind ?? 'model',
      provider: overrides.provider ?? 'claude',
      ...overrides.model === undefined ? {} : { model: overrides.model },
      replayState: {
        response: {
          kind: 'claude',
          version: overrides.responseVersion ?? 1,
          continuation: {
            v: 1,
            accountRef: overrides.accountRef ?? ACCOUNT,
            spanEpoch: overrides.spanEpoch ?? GATE.spanEpoch,
            harnessSessionId: overrides.harnessSessionId ?? GATE.harnessSessionId,
            wireSessionId: overrides.wireSessionId ?? GATE.wireSessionId,
            ...requestId === undefined ? {} : { requestId },
          },
        },
        blocks: overrides.blocks ?? BLOCKS,
      },
    },
  }
}

/**
 * One Claude assistant row carrying the continuation facts this build writes.
 * @param requestId - the recorded `request-id`, or undefined when the response carried none.
 * @param overrides - facts to state instead of the gate's own.
 * @returns the message the selector reads, without a role when the case asks for none.
 */
function claudeRow(requestId: string | undefined, overrides: RowOverrides = {}): ContinuationMessage {
  const body = rowBody(requestId, overrides)
  return overrides.omitRole === true ? body : { role: overrides.role ?? 'assistant', ...body }
}

/** The same row with no role member at all, which is not an assistant turn. */
function rowWithoutRole(requestId: string): ContinuationMessage {
  return rowBody(requestId, {})
}

test('the nearest eligible turn answers, whoever produced it', () => {
  const messages = [
    { role: 'user' },
    claudeRow('req_older'),
    { role: 'user' },
    claudeRow('req_newer'),
  ]
  assert.deepEqual(selectClaudeContinuation(messages, GATE), { kind: 'selected', requestId: 'req_newer', index: 3 })
})

test('a row without an id does not stop an earlier turn from answering', () => {
  const messages = [claudeRow('req_older'), claudeRow(undefined)]
  assert.deepEqual(selectClaudeContinuation(messages, GATE), { kind: 'selected', requestId: 'req_older', index: 0 })
})

test('a newer row with an empty id is not a selection, so an earlier turn answers', () => {
  // The client's gate is truthiness: an empty recorded id is the same fact as an absent one, and
  // treating it as a present-but-invalid id would stop the walk for no reason.
  const messages = [claudeRow('req_older'), claudeRow('')]
  assert.deepEqual(selectClaudeContinuation(messages, GATE), { kind: 'selected', requestId: 'req_older', index: 0 })
  // A truthy id of the wrong shape still ends the walk instead.
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_older'), claudeRow('x')], GATE),
    { kind: 'omitted', reason: 'invalid-request-id' })
})

test('an eligible row with an unusable id is omitted, never skipped for an older one', () => {
  const messages = [claudeRow('req_older'), claudeRow('not-a-request-id')]
  assert.deepEqual(selectClaudeContinuation(messages, GATE), { kind: 'omitted', reason: 'invalid-request-id' })
})

test('an aligning older turn answers when a newer row is misaligned or from another role', () => {
  const older = claudeRow('req_older')
  // The newer envelope records two blocks while the row carries one: the durable pipeline
  // discards that response whole, so the walk must reach the older eligible turn.
  assert.deepEqual(selectClaudeContinuation([older, claudeRow('req_newer', { blocks: [{}, {}] })], GATE),
    { kind: 'selected', requestId: 'req_older', index: 0 })
  assert.deepEqual(selectClaudeContinuation([older, claudeRow('req_newer', { role: 'user' })], GATE),
    { kind: 'selected', requestId: 'req_older', index: 0 })
})

test('a row that is not an aligned assistant Claude message is not eligible', () => {
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_other', { role: 'user' })], GATE), { kind: 'none' })
  assert.deepEqual(selectClaudeContinuation([rowWithoutRole('req_other')], GATE), { kind: 'none' })
  // A response whose block list does not line up with the row is discarded whole.
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_other', { blocks: [{}, {}] })], GATE), { kind: 'none' })
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_other', { content: [] })], GATE), { kind: 'none' })
  // An empty history sends no chain.
  assert.deepEqual(selectClaudeContinuation([], GATE), { kind: 'none' })
})

test('another provider, response version or source kind is skipped, not chained', () => {
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_other', { provider: 'codex' })], GATE), { kind: 'none' })
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_other', { responseVersion: 2 })], GATE), { kind: 'none' })
  assert.deepEqual(selectClaudeContinuation([claudeRow('req_other', { kind: 'user' })], GATE), { kind: 'none' })
})

test('the model a turn was served for does not filter the chain', () => {
  const messages = [
    claudeRow('req_older', { model: 'claude-opus-4-5' }),
    claudeRow('req_newer', { model: 'claude-sonnet-4-5' }),
  ]
  assert.deepEqual(selectClaudeContinuation(messages, GATE), { kind: 'selected', requestId: 'req_newer', index: 1 })
})

test('a row from another account, generation, session or wire session is not eligible', () => {
  const cases: ContinuationMessage[][] = [
    [claudeRow('req_other', { accountRef: OTHER_ACCOUNT })],
    [claudeRow('req_other', { spanEpoch: GATE.spanEpoch + 1 })],
    [claudeRow('req_other', { harnessSessionId: 'session-2' })],
    [claudeRow('req_other', { wireSessionId: 'wire-2' })],
    // A same-shaped digest that is not this account's is not this account either.
    [claudeRow('req_other', { accountRef: { kind: 'salt-sha256', version: 1, ref: '0'.repeat(64) } })],
  ]
  for (const messages of cases) {
    assert.deepEqual(selectClaudeContinuation(messages, GATE), { kind: 'none' })
  }
})

test('the request id grammar is the one the client emits', () => {
  assert.equal(isClaudeRequestId('req_abc-123_XYZ'), true)
  assert.equal(isClaudeRequestId(`req_${'a'.repeat(36)}`), true)
  assert.equal(isClaudeRequestId('req_'), false)
  assert.equal(isClaudeRequestId(`req_${'a'.repeat(37)}`), false)
  assert.equal(isClaudeRequestId('req_a b'), false)
  assert.equal(isClaudeRequestId(7), false)
})

test('reading a continuation ignores an envelope this build did not write', () => {
  assert.equal(readClaudeContinuation(undefined), undefined)
  assert.equal(readClaudeContinuation({}), undefined)
  assert.equal(readClaudeContinuation({ response: { kind: 'claude', version: 1 } }), undefined)
  assert.equal(readClaudeContinuation({ response: { kind: 'claude', version: 2, continuation: {} } }), undefined)
  const read = readClaudeContinuation(claudeRow('req_ok').source?.replayState)
  assert.equal(read?.requestId, 'req_ok')
  assert.equal(read?.wireSessionId, GATE.wireSessionId)
})
