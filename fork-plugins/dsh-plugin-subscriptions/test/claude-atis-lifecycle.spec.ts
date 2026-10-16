/**
 * The durable ATIS capture arbitration and the pins account spans freeze, driven through the real
 * span store.
 *
 * Each case owns its own store directory and closes the store before removing it, so the pins one
 * case freezes are invisible to the next. No network and no credential is involved: the store's own
 * document is the only state these cases read or write.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { claudeAccountRef } from '../src/providers/claude-salt-store.js'
import {
  CLAUDE_SPAN_LIMIT,
  ClaudeSpanBindingStore,
} from '../src/providers/claude-span-store.js'
import type {
  ClaudeCaptureTicket,
  ClaudeSpanIdentity,
} from '../src/providers/claude-span-store.js'
import type { ClaudeAccountRef } from '../src/claude-core/account-ref.js'

/** Two opaque tokens, distinct in every position the comparison could confuse. */
const PIN_A = 'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc'
const PIN_B = 'v1.pin.dddddddd.eeeeeeee.ffffffff'

/** The salt this file's synthetic references are derived from; an installation's own stays in its store. */
const SALT = 'synthetic-atis-lifecycle-salt'

/** The account reference one synthetic account key derives to. */
function refOf(account: string): ClaudeAccountRef {
  return claudeAccountRef(SALT, account)
}

/** The span one case's account holds for one harness session. */
function spanOf(account: string, harnessSessionId: string): ClaudeSpanIdentity {
  return { accountRef: refOf(account), harnessSessionId, spanEpoch: 0 }
}

/**
 * One case's durable store over a directory it owns; the store is closed and the directory removed
 * however the case ends.
 * @param body - the case, given the store it drives.
 */
async function withStore(body: (store: ClaudeSpanBindingStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-atis-lifecycle-'))
  const store = new ClaudeSpanBindingStore({
    path: join(directory, 'spans.json'),
    deadlineMs: 2_000,
    lockTimeoutMs: 2_000,
  })
  try {
    await body(store)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

/** Claim one capture attempt, failing the case when the store issues no ticket. */
async function claim(store: ClaudeSpanBindingStore, account: string): Promise<ClaudeCaptureTicket> {
  const begun = await store.beginCapture(refOf(account))
  if (begun.kind !== 'ticket') throw new Error(`the capture right was not claimed: ${begun.reason}`)
  return begun.ticket
}

/** Record one read's disclosed value, failing the case when its attempt owns nothing. */
async function commit(store: ClaudeSpanBindingStore, account: string, disclosed: unknown): Promise<void> {
  const ticket = await claim(store, account)
  const committed = await store.commitCapture(ticket, disclosed)
  if (committed.kind !== 'committed') {
    throw new Error(
      `the capture was not committed: ${committed.kind === 'unavailable' ? committed.reason : committed.kind}`,
    )
  }
}

/** Drop one account's durable state, failing the case when the store refused. */
async function discard(store: ClaudeSpanBindingStore, account: string): Promise<void> {
  const discarded = await store.discard(refOf(account))
  if (discarded.kind !== 'discarded') throw new Error(`the account state was not discarded: ${discarded.reason}`)
}

/**
 * The token one request freezes for a span: its identity is prepared first, then the pin takes this
 * account's newest committed candidate.
 * @param store - the case's store.
 * @param account - the synthetic account key the span belongs to.
 * @param harnessSessionId - the harness session the span belongs to.
 * @returns the token the span froze, or undefined when it froze empty.
 */
async function requestPin(
  store: ClaudeSpanBindingStore,
  account: string,
  harnessSessionId: string,
): Promise<string | undefined> {
  const identity = spanOf(account, harnessSessionId)
  const prepared = await store.prepare(identity, 'initial')
  if (prepared.kind !== 'ready') throw new Error(`the span was not prepared: ${prepared.reason}`)
  const frozen = await store.freeze(identity)
  if (frozen.kind !== 'frozen') throw new Error(`the span pin was not frozen: ${frozen.reason}`)
  return frozen.pin.kind === 'token' ? frozen.pin.token : undefined
}

/**
 * The pin already in force for one span, read without freezing or creating anything.
 * @param store - the case's store.
 * @param account - the synthetic account key the span belongs to.
 * @param harnessSessionId - the harness session the span belongs to.
 * @returns the token in force, or undefined when the span froze empty or does not exist.
 */
async function storedPin(
  store: ClaudeSpanBindingStore,
  account: string,
  harnessSessionId: string,
): Promise<string | undefined> {
  const result = await store.pinFor(spanOf(account, harnessSessionId))
  if (result.kind === 'unavailable') throw new Error(`the span pin could not be read: ${result.reason}`)
  if (result.kind === 'absent') return undefined
  return result.pin.kind === 'token' ? result.pin.token : undefined
}

test('a discard revokes a capture that is still in flight', async () => {
  await withStore(async store => {
    const account = 'lifecycle-cleared-account'
    const ticket = await claim(store, account)
    await discard(store, account)
    const refused = await store.commitCapture(ticket, PIN_A)
    assert.equal(refused.kind, 'refused', 'the retired attempt no longer owns the account')
    assert.equal(await requestPin(store, account, 'span-1'), undefined)
  })
})

test('of two overlapping captures only the newest may commit', async () => {
  await withStore(async store => {
    const account = 'lifecycle-latest-account'
    const older = await claim(store, account)
    const newer = await claim(store, account)
    const committed = await store.commitCapture(newer, PIN_B)
    assert.equal(committed.kind, 'committed')
    const late = await store.commitCapture(older, PIN_A)
    assert.equal(late.kind, 'refused', 'an older attempt that finishes late owns nothing')
    assert.equal(await requestPin(store, account, 'span-1'), PIN_B)
  })
})

test('a capture issued before a discard cannot commit after the account comes back', async () => {
  await withStore(async store => {
    const account = 'lifecycle-relogin-account'
    const beforeDiscard = await claim(store, account)
    await discard(store, account)
    const afterDiscard = await claim(store, account)
    const retired = await store.commitCapture(beforeDiscard, PIN_A)
    assert.equal(retired.kind, 'refused')
    assert.equal(await requestPin(store, account, 'span-1'), undefined, 'the retired identity wrote nothing')
    const current = await store.commitCapture(afterDiscard, PIN_B)
    assert.equal(current.kind, 'committed')
    assert.equal(await requestPin(store, account, 'span-2'), PIN_B)
  })
})

test('only a non-empty printable token is used, and a rejected one freezes an empty pin', async () => {
  await withStore(async store => {
    const account = 'lifecycle-shape-account'
    for (const disclosed of ['with space', '', 'line\nbreak', 42, null, undefined, 'caf\u00e9']) {
      await discard(store, account)
      const ticket = await claim(store, account)
      const committed = await store.commitCapture(ticket, disclosed)
      assert.equal(committed.kind, 'committed', `recorded: ${String(disclosed)}`)
      assert.equal(await requestPin(store, account, 'span-1'), undefined, `rejected: ${String(disclosed)}`)
      await commit(store, account, PIN_A)
      assert.equal(
        await requestPin(store, account, 'span-1'),
        undefined,
        'the frozen empty pin does not fall back to a later token',
      )
    }
  })
})

test('a discard drops the account it names, and frozen spans stay frozen until then', async () => {
  await withStore(async store => {
    const first = 'lifecycle-named-first'
    const second = 'lifecycle-named-second'
    await commit(store, first, PIN_A)
    await commit(store, second, PIN_B)
    assert.equal(await requestPin(store, first, 'span-1'), PIN_A)
    assert.equal(await requestPin(store, second, 'span-1'), PIN_B)
    await discard(store, first)
    assert.equal(await requestPin(store, first, 'span-1'), undefined)
    assert.equal(await requestPin(store, second, 'span-1'), PIN_B, 'the account the discard did not name keeps its pin')
    await discard(store, second)
    assert.equal(await requestPin(store, second, 'span-1'), undefined)
  })
})

test('the oldest span is evicted at the span bound while a newer span keeps its pin', async () => {
  await withStore(async store => {
    const account = 'lifecycle-bound-account'
    await commit(store, account, PIN_A)
    for (let index = 0; index < CLAUDE_SPAN_LIMIT; index += 1) {
      assert.equal(await requestPin(store, account, `span-${index}`), PIN_A)
    }
    await commit(store, account, PIN_B)
    assert.equal(
      await requestPin(store, account, `span-${CLAUDE_SPAN_LIMIT}`),
      PIN_B,
      'a new span takes the newest token',
    )
    // The bound dropped span-0, so this is a new initial span rather than the evicted record: like
    // any span before its first request, it freezes to the account's newest committed candidate.
    assert.equal(await requestPin(store, account, 'span-0'), PIN_B, 'the evicted oldest span re-freezes from the candidate')
    assert.equal(await storedPin(store, account, 'span-2'), PIN_A, 'a span still inside the bound keeps its pin')
  })
})
