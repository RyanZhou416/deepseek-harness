/**
 * The ATIS header a built request carries, read through the durable capture arbitration: a
 * bootstrap read claims an account's candidate under the real span store, and the request path
 * freezes the pin its span sends. Every fetch is synthetic, no network and no credential is used.
 *
 * A case owns its own store directory and closes the store before removing it, so one case's frozen
 * pin is invisible to the next.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fetchClaudeCatalogue } from '../src/providers/claude.js'
import type { ClaudeCatalogueCapture } from '../src/providers/claude.js'
import { buildClaudeWireRequest } from '../src/providers/claude-wire.js'
import { claudeAccountRef } from '../src/providers/claude-salt-store.js'
import { ClaudeSpanBindingStore } from '../src/providers/claude-span-store.js'
import type { ClaudeSpanIdentity } from '../src/providers/claude-span-store.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'

/** The harness sessions this file's spans are keyed by. */
const ATIS_FIRST_SESSION = '00000000-0000-4000-8000-0000000000b1'
const ATIS_SECOND_SESSION = '00000000-0000-4000-8000-0000000000b2'
const ATIS_THIRD_SESSION = '00000000-0000-4000-8000-0000000000b3'

const SESSION: ClaudeSession = {
  accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  deviceId: 'd'.repeat(64),
}

const MESSAGES: TranslatableMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
]
const OPTIONS = { provider: 'claude', model: 'claude-opus-5', messages: MESSAGES, system: 'be terse' }

/** The salt this file's synthetic references are derived from; an installation's own stays in its store. */
const SALT = 'synthetic-atis-header-salt'

/** A bootstrap answer carrying one token. */
function disclosing(atis: string): FetchFn {
  return respondWith({ client_data: { atis }, additional_model_options: [] })
}

/** A bootstrap answer carrying no token at all. */
function disclosingNothing(): FetchFn {
  return respondWith({ client_data: null, additional_model_options: [] })
}

function respondWith(document: unknown): FetchFn {
  return async () => new Response(JSON.stringify(document), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * One case's durable store over a directory it owns; the store is closed and the directory removed
 * however the case ends.
 * @param body - the case, given the store it drives.
 */
async function withStore(body: (store: ClaudeSpanBindingStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-atis-header-'))
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

/** The span one case's account holds for one harness session. */
function spanOf(account: string, harnessSessionId: string): ClaudeSpanIdentity {
  return { accountRef: claudeAccountRef(SALT, account), harnessSessionId, spanEpoch: 0 }
}

/** The capture seam a bootstrap read claims its candidate under, over the case's own store. */
function captureOf(store: ClaudeSpanBindingStore): ClaudeCatalogueCapture {
  return {
    beginCapture: async account => await store.beginCapture(claudeAccountRef(SALT, account)),
    commitCapture: async (ticket, disclosed) => await store.commitCapture(ticket, disclosed),
  }
}

/** One bootstrap read for an account, claiming its candidate under the case's store. */
async function readBootstrap(
  store: ClaudeSpanBindingStore,
  account: string,
  fetchFn: FetchFn,
): Promise<void> {
  await fetchClaudeCatalogue(SESSION, [], fetchFn, undefined, account, undefined, captureOf(store))
}

/**
 * The ATIS header one built request carries, from the pin the durable span froze: the identity is
 * prepared first, then the pin takes this account's newest committed candidate.
 * @param store - the case's store.
 * @param account - the synthetic account key the span belongs to.
 * @param harnessSessionId - the harness session the span belongs to.
 * @returns the header value, or undefined when the span froze empty.
 */
async function atisHeader(
  store: ClaudeSpanBindingStore,
  account: string,
  harnessSessionId: string,
): Promise<string | undefined> {
  const identity = spanOf(account, harnessSessionId)
  const prepared = await store.prepare(identity, 'initial')
  if (prepared.kind !== 'ready') throw new Error(`the span was not prepared: ${prepared.reason}`)
  const frozen = await store.freeze(identity)
  if (frozen.kind !== 'frozen') throw new Error(`the span pin was not frozen: ${frozen.reason}`)
  const built = await buildClaudeWireRequest(
    OPTIONS as never, SESSION, MESSAGES, 32_000, undefined, undefined,
    { sessionId: prepared.span.wireSessionId,
      atisPin: frozen.pin.kind === 'token' ? frozen.pin.token : undefined,
      previousRequestId: undefined },
    account,
  )
  return built.headers.find(([name]) => name.toLowerCase() === 'x-cc-atis')?.[1]
}

test('a conversation freezes its pin at the first request and a later read reaches only new spans', async () => {
  await withStore(async store => {
    const account = 'atis-freeze-account'
    // The first request freezes the span before any read has disclosed a token: it sends none,
    // and a token disclosed afterwards belongs only to spans that have not frozen yet.
    assert.equal(await atisHeader(store, account, ATIS_FIRST_SESSION), undefined)
    await readBootstrap(store, account, disclosing('v1.pin.aaaaaaaa.bbbbbbbb.cccccccc'))
    assert.equal(await atisHeader(store, account, ATIS_FIRST_SESSION), undefined, 'the frozen span keeps sending none')
    assert.equal(await atisHeader(store, account, ATIS_SECOND_SESSION), 'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc')
  })
})

test('a later read cannot change the token a frozen span sends', async () => {
  await withStore(async store => {
    const account = 'atis-stable-account'
    await readBootstrap(store, account, disclosing('v1.pin.aaaaaaaa.bbbbbbbb.cccccccc'))
    assert.equal(await atisHeader(store, account, ATIS_FIRST_SESSION), 'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc')
    await readBootstrap(store, account, disclosing('v1.pin.dddddddd.eeeeeeee.ffffffff'))
    assert.equal(
      await atisHeader(store, account, ATIS_FIRST_SESSION),
      'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc',
      'the span keeps the token its first request froze',
    )
    assert.equal(await atisHeader(store, account, ATIS_SECOND_SESSION), 'v1.pin.dddddddd.eeeeeeee.ffffffff')
  })
})

test('a read that discloses no token leaves the span without a header', async () => {
  await withStore(async store => {
    const account = 'atis-silent-account'
    await readBootstrap(store, account, disclosingNothing())
    assert.equal(await atisHeader(store, account, ATIS_FIRST_SESSION), undefined)
  })
})

test('a successful read without a token clears the candidate an unfrozen span would have taken', async () => {
  await withStore(async store => {
    const account = 'atis-cleared-candidate-account'
    await readBootstrap(store, account, disclosing('v1.pin.aaaaaaaa.bbbbbbbb.cccccccc'))
    assert.equal(await atisHeader(store, account, ATIS_FIRST_SESSION), 'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc')
    await readBootstrap(store, account, disclosingNothing())
    assert.equal(
      await atisHeader(store, account, ATIS_FIRST_SESSION),
      'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc',
      'a frozen span keeps its token',
    )
    assert.equal(await atisHeader(store, account, ATIS_SECOND_SESSION), undefined, 'an unfrozen span inherits nothing')
  })
})

test('the header belongs to the account that was handed the token', async () => {
  await withStore(async store => {
    await readBootstrap(store, 'atis-owner-account', disclosing('v1.pin.aaaaaaaa.bbbbbbbb.cccccccc'))
    assert.equal(
      await atisHeader(store, 'atis-owner-account', ATIS_FIRST_SESSION),
      'v1.pin.aaaaaaaa.bbbbbbbb.cccccccc',
    )
    assert.equal(await atisHeader(store, 'atis-other-account', ATIS_THIRD_SESSION), undefined)
  })
})
