/**
 * The durable span store: the wire identity, the ATIS pin and the capture arbitration.
 *
 * These cases exist because the in-memory maps they replace cannot survive a restart, and the wire
 * identity is model-visible: the billing `cc_prompt_id` is derived from it, so a restart that
 * minted a new one would change bytes the model sees. The cases therefore assert two things about
 * every ready identity — that it is on disk before the caller may build a request from it, and
 * that a later prepare, freeze or reopening returns the same one — and they assert the refusals as
 * the fixed failure, because the alternative, a temporary random identity, sends a request the
 * store could not vouch for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_SPAN_LIMIT,
  ClaudeSpanBindingStore,
  LOCAL_CONTINUATION_STATE_UNAVAILABLE,
} from '../src/providers/claude-span-store.js'
import type { ClaudeSpanIdentity, ClaudeSpanPrepareResult, ClaudeSpanPrepared } from '../src/providers/claude-span-store.js'
import { claudeAccountRef } from '../src/providers/claude-salt-store.js'
import type { ClaudeAccountRef } from '../src/providers/claude-salt-store.js'

/** The account these cases name. */
const ACCOUNT: ClaudeAccountRef = claudeAccountRef('salt-a', 'acct@example.invalid')

/** Another account, for the cross-account cases. */
const OTHER: ClaudeAccountRef = claudeAccountRef('salt-a', 'other@example.invalid')

/** The timing a test composition resolves from the plugin's own config. */
const LOCK_TIMEOUT_MS = 2_000

/** How long one operation may wait before its caller is refused. */
const DEADLINE_MS = 2_000

/** One private root the caller removes when the case settles. */
function privateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'claude-span-spec-'))
}

/** A store with its state at one path, at the configured timing unless a case names its own. */
function storeAt(path: string, overrides: { readonly lockTimeoutMs?: number; readonly deadlineMs?: number } = {}): ClaudeSpanBindingStore {
  return new ClaudeSpanBindingStore({
    path,
    lockTimeoutMs: overrides.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    deadlineMs: overrides.deadlineMs ?? DEADLINE_MS,
  })
}

/** The identity of one span. */
function identity(harnessSessionId: string, spanEpoch = 1, accountRef: ClaudeAccountRef = ACCOUNT): ClaudeSpanIdentity {
  return { accountRef, harnessSessionId, spanEpoch }
}

/**
 * The prepared span of a result this case expects to be ready.
 * @param result - what `prepare` returned.
 * @returns the committed span.
 */
function prepared(result: ClaudeSpanPrepareResult): ClaudeSpanPrepared {
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') throw new Error('the span was not prepared')
  return result.span
}

test('a prepared span commits its wire identity before it is returned', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const first = prepared(await storeAt(path).prepare(identity('session-1'), 'initial'))
    // A new span starts unfrozen: the pin is decided once the capture is known.
    assert.deepEqual(first.pin, { kind: 'unfrozen' })
    assert.equal(first.created, true)
    // The identity a request may already declare is durable before it is returned.
    assert.equal(readFileSync(path, 'utf8').includes(first.wireSessionId), true)

    const reopened = prepared(await storeAt(path).prepare(identity('session-1'), 'initial'))
    assert.equal(reopened.wireSessionId, first.wireSessionId)
    assert.equal(reopened.created, false)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('repeated prepare and freeze keep one committed identity across reopenings', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const first = prepared(await storeAt(path).prepare(identity('session-1'), 'initial'))
    const frozen = await storeAt(path).freeze(identity('session-1'))
    assert.deepEqual(frozen, { kind: 'frozen', pin: { kind: 'empty' } })

    for (let round = 0; round < 3; round += 1) {
      const reopened = storeAt(path)
      assert.equal(prepared(await reopened.prepare(identity('session-1'), 'initial')).wireSessionId,
        first.wireSessionId)
      assert.deepEqual(await reopened.freeze(identity('session-1')), { kind: 'frozen', pin: { kind: 'empty' } })
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a new session freezes from the newest candidate while a restored one freezes empty', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    const unfrozen = prepared(await store.prepare(identity('session-1'), 'initial'))
    assert.deepEqual(unfrozen.pin, { kind: 'unfrozen' })

    // The first freeze reads the newest committed capture.
    const ticket = await store.beginCapture(ACCOUNT)
    assert.equal(ticket.kind, 'ticket')
    if (ticket.kind !== 'ticket') return
    assert.deepEqual(await store.commitCapture(ticket.ticket, 'atis-token-value'), { kind: 'committed' })
    assert.deepEqual(await store.freeze(identity('session-1')),
      { kind: 'frozen', pin: { kind: 'token', token: 'atis-token-value' } })
    // A span that already froze keeps its value: a later capture cannot change what it sends.
    const later = await store.beginCapture(ACCOUNT)
    assert.equal(later.kind, 'ticket')
    if (later.kind !== 'ticket') return
    assert.deepEqual(await store.commitCapture(later.ticket, 'later-token'), { kind: 'committed' })
    assert.deepEqual(await store.freeze(identity('session-1')),
      { kind: 'frozen', pin: { kind: 'token', token: 'atis-token-value' } })

    // A restored span with no record of its own freezes empty, and the newer candidate cannot
    // fill it in.
    const restored = prepared(await store.prepare(identity('session-2'), 'resume'))
    assert.deepEqual(restored.pin, { kind: 'empty' })
    assert.deepEqual(await store.freeze(identity('session-2')), { kind: 'frozen', pin: { kind: 'empty' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a restored span with no record commits a fresh identity and an empty pin, and a reopen keeps both', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const restored = prepared(await storeAt(path).prepare(identity('session-1'), 'resume'))
    assert.deepEqual(restored.pin, { kind: 'empty' })
    assert.equal(restored.created, true)
    // The identity is committed, not minted for the return value alone.
    assert.equal(readFileSync(path, 'utf8').includes(restored.wireSessionId), true)

    const again = prepared(await storeAt(path).prepare(identity('session-1'), 'resume'))
    assert.equal(again.wireSessionId, restored.wireSessionId)
    assert.equal(again.created, false)
    assert.deepEqual(again.pin, { kind: 'empty' })
    assert.deepEqual(await storeAt(path).freeze(identity('session-1')), { kind: 'frozen', pin: { kind: 'empty' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an existing unfrozen span is frozen empty by a restore and is never filled from a later candidate', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    const initial = prepared(await store.prepare(identity('session-1'), 'initial'))
    const ticket = await store.beginCapture(ACCOUNT)
    assert.equal(ticket.kind, 'ticket')
    if (ticket.kind !== 'ticket') return
    assert.deepEqual(await store.commitCapture(ticket.ticket, 'late-token'), { kind: 'committed' })

    const restored = prepared(await store.prepare(identity('session-1'), 'resume'))
    assert.deepEqual(restored.pin, { kind: 'empty' })
    assert.equal(restored.created, false)
    assert.equal(restored.wireSessionId, initial.wireSessionId)
    assert.deepEqual(await store.freeze(identity('session-1')), { kind: 'frozen', pin: { kind: 'empty' } })
    assert.deepEqual(await storeAt(path).pinFor(identity('session-1')), { kind: 'pin', pin: { kind: 'empty' } })

    // The candidate still belongs to the account's arbitration; it is simply not this span's.
    const fresh = prepared(await storeAt(path).prepare(identity('session-2'), 'initial'))
    assert.deepEqual(fresh.pin, { kind: 'unfrozen' })
    assert.deepEqual(await storeAt(path).freeze(identity('session-2')),
      { kind: 'frozen', pin: { kind: 'token', token: 'late-token' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a restore adopts the wire identity a verified log fact states', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const restored = prepared(await storeAt(path).prepare(identity('session-1'), 'resume', {
      restored: { wireSessionId: 'wire-from-the-session-log' },
    }))
    assert.equal(restored.wireSessionId, 'wire-from-the-session-log')
    assert.deepEqual(restored.pin, { kind: 'empty' })
    assert.equal(readFileSync(path, 'utf8').includes('wire-from-the-session-log'), true)

    // The adopted identity is the span's from then on.
    const again = prepared(await storeAt(path).prepare(identity('session-1'), 'resume', {
      restored: { wireSessionId: 'a-different-log-value' },
    }))
    assert.equal(again.wireSessionId, 'wire-from-the-session-log')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an unusable restored identity is no fact at all, so the span starts fresh and empty', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const restored = prepared(await storeAt(path).prepare(identity('session-1'), 'resume', {
      restored: { wireSessionId: 'not a usable wire identity' },
    }))
    assert.notEqual(restored.wireSessionId, 'not a usable wire identity')
    assert.deepEqual(restored.pin, { kind: 'empty' })
    const again = prepared(await storeAt(path).prepare(identity('session-1'), 'resume'))
    assert.equal(again.wireSessionId, restored.wireSessionId)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an unfrozen span with no candidate freezes empty, which is not the same as unfrozen', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    assert.equal((await store.prepare(identity('session-1'), 'initial')).kind, 'ready')
    assert.deepEqual(await store.freeze(identity('session-1')), { kind: 'frozen', pin: { kind: 'empty' } })
    assert.deepEqual(await store.pinFor(identity('session-1')), { kind: 'pin', pin: { kind: 'empty' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a stored pin answers a later lookup, and an unknown span is absent', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    assert.deepEqual(await store.pinFor(identity('session-1')), { kind: 'absent' })
    assert.equal((await store.prepare(identity('session-1'), 'initial')).kind, 'ready')
    // Prepared but not yet frozen.
    assert.deepEqual(await store.pinFor(identity('session-1')), { kind: 'pin', pin: { kind: 'unfrozen' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('freezing an identity that was never prepared is refused instead of minting one', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const frozen = await storeAt(path).freeze(identity('never-prepared'))
    assert.equal(frozen.kind, 'unavailable')
    if (frozen.kind !== 'unavailable') return
    assert.equal(frozen.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.deepEqual(await storeAt(path).pinFor(identity('never-prepared')), { kind: 'absent' })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('an older capture commits nothing, and a ticket from before a discard is revoked', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    const older = await store.beginCapture(ACCOUNT)
    const newer = await store.beginCapture(ACCOUNT)
    assert.equal(older.kind, 'ticket')
    assert.equal(newer.kind, 'ticket')
    if (older.kind !== 'ticket' || newer.kind !== 'ticket') return
    assert.deepEqual(await store.commitCapture(newer.ticket, 'newest-candidate'), { kind: 'committed' })
    // The older attempt finished late and owns nothing: the newest candidate stands.
    assert.deepEqual(await store.commitCapture(older.ticket, 'stale-candidate'), { kind: 'refused' })

    assert.deepEqual(await store.discard(ACCOUNT), { kind: 'discarded' })
    assert.deepEqual(await store.commitCapture(newer.ticket, 'revoked-candidate'), { kind: 'refused' })
    // The discard cleared the candidate, so a later span freezes empty rather than from a token.
    assert.equal((await store.prepare(identity('session-1'), 'initial')).kind, 'ready')
    assert.deepEqual(await store.freeze(identity('session-1')), { kind: 'frozen', pin: { kind: 'empty' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('spans are bounded per account, and an evicted span comes back as a new identity with an empty pin', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    const ticket = await store.beginCapture(ACCOUNT)
    assert.equal(ticket.kind, 'ticket')
    if (ticket.kind !== 'ticket') return
    assert.deepEqual(await store.commitCapture(ticket.ticket, 'candidate-token'), { kind: 'committed' })

    const oldest = prepared(await store.prepare(identity('span-0'), 'initial'))
    for (let index = 1; index < CLAUDE_SPAN_LIMIT; index += 1) {
      assert.equal((await store.prepare(identity(`span-${String(index)}`), 'initial')).kind, 'ready')
    }
    assert.equal((await store.prepare(identity(`span-${String(CLAUDE_SPAN_LIMIT)}`), 'initial')).kind, 'ready')
    // The oldest span was evicted by the bound.
    assert.deepEqual(await store.pinFor(identity('span-0')), { kind: 'absent' })

    // Used again, a restored evicted span is the current Session's fact: a new committed identity
    // and an empty pin, never a token the old span might once have frozen from.
    const revived = prepared(await store.prepare(identity('span-0'), 'resume'))
    assert.deepEqual(revived.pin, { kind: 'empty' })
    assert.notEqual(revived.wireSessionId, oldest.wireSessionId)
    assert.equal(revived.created, true)
    assert.deepEqual(await store.freeze(identity('span-0')), { kind: 'frozen', pin: { kind: 'empty' } })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('a document this build cannot trust refuses to prepare instead of minting an identity', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    writeFileSync(path, JSON.stringify({ version: 99, accounts: [] }), { mode: 0o600 })
    const store = storeAt(path)
    const result = await store.prepare(identity('session-1'), 'initial')
    assert.equal(result.kind, 'unavailable')
    if (result.kind !== 'unavailable') return
    assert.equal(result.code, LOCAL_CONTINUATION_STATE_UNAVAILABLE)
    assert.equal((await store.pinFor(identity('session-1'))).kind, 'unavailable')
    assert.equal(readFileSync(path, 'utf8').includes('99'), true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('concurrent read-modify-write keeps both accounts', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    // Two stores over one path, each owning a different account, mutate at the same time: a write
    // that dropped the other's account would lose it.
    const [left, right] = await Promise.all([
      storeAt(path, { lockTimeoutMs: 10_000, deadlineMs: 10_000 }).prepare(identity('session-a', 1, ACCOUNT), 'initial'),
      storeAt(path, { lockTimeoutMs: 10_000, deadlineMs: 10_000 }).prepare(identity('session-b', 1, OTHER), 'initial'),
    ])
    assert.equal(left.kind, 'ready')
    assert.equal(right.kind, 'ready')
    const document = JSON.parse(readFileSync(path, 'utf8')) as { accounts: readonly { accountRef: { ref: string } }[] }
    assert.equal(document.accounts.length, 2, 'both accounts survive concurrent mutation')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test('one account\'s state does not answer for another, or for another generation', async () => {
  const root = privateRoot()
  try {
    const path = join(root, 'spans.json')
    const store = storeAt(path)
    await store.prepare(identity('session-1', 1, ACCOUNT), 'initial')
    assert.deepEqual(await store.pinFor(identity('session-1', 1, OTHER)), { kind: 'absent' })
    assert.deepEqual(await store.pinFor(identity('session-1', 2, ACCOUNT)), { kind: 'absent' })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})
