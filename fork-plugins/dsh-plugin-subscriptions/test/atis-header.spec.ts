import assert from 'node:assert/strict'
import test from 'node:test'

import { clientAtisFor, fetchClaudeModelOptions } from '../src/providers/claude.js'
import { buildClaudeWireRequest } from '../src/providers/claude-wire.js'
import type { FetchFn } from '../src/providers/common.js'
import type { ClaudeSession } from '../src/auth/store.js'
import type { TranslatableMessage } from '../src/translate/resolved.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

/** Wire session ids, the UUIDs the client declares its session as. */
const ATIS_ATIS_SESSION = '00000000-0000-4000-8000-0000000000a1'
const ATIS_X_SESSION = '00000000-0000-4000-8000-0000000000a2'

const SESSION: ClaudeSession = {
  accessToken: 'synthetic-access-token-0123456789abcdef0123456789abcdef0123456789abcdef',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:inference',
  accountUuid: 'uuid-1',
  deviceId: 'd'.repeat(64),
}

function respondWith(document: unknown): FetchFn {
  return (async () => new Response(JSON.stringify(document), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as FetchFn
}

test('a bootstrap read hands the account the ATIS token it disclosed', async () => {
  const account = 'atis-account-a'
  assert.equal(clientAtisFor(account), undefined, 'nothing is known before a read')

  await fetchClaudeModelOptions(
    SESSION, [], respondWith({ client_data: { atis: 'v1.pin.a.b.c' }, additional_model_options: [] }),
    undefined, account,
  )
  assert.equal(clientAtisFor(account), 'v1.pin.a.b.c')
})

test('a read that discloses no token leaves the account without one', async () => {
  const account = 'atis-account-b'
  await fetchClaudeModelOptions(
    SESSION, [], respondWith({ client_data: null, additional_model_options: [] }),
    undefined, account,
  )
  assert.equal(clientAtisFor(account), undefined)
})

test('the request carries the header once a read has disclosed a token', async () => {
  const account = 'atis-account-c'
  const messages: TranslatableMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ]
  const options = { provider: 'claude', model: 'claude-opus-5', messages, system: 'be terse' }

  const before = await buildClaudeWireRequest(
    options as never, SESSION, messages, 32_000, undefined, undefined, ATIS_ATIS_SESSION, account,
  )
  assert.equal(
    before.headers.some(([name]) => name.toLowerCase() === 'x-cc-atis'),
    false,
    'no token, no header',
  )

  await fetchClaudeModelOptions(
    SESSION, [], respondWith({ client_data: { atis: 'v1.pin.a.b.c' }, additional_model_options: [] }),
    undefined, account,
  )
  const after = await buildClaudeWireRequest(
    options as never, SESSION, messages, 32_000, undefined, undefined, ATIS_ATIS_SESSION, account,
  )
  const header = after.headers.find(([name]) => name.toLowerCase() === 'x-cc-atis')
  assert.deepEqual(header, ['x-cc-atis', 'v1.pin.a.b.c'])
})

test('the header belongs to the request, not to the process', async () => {
  const messages: TranslatableMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ]
  const options = { provider: 'claude', model: 'claude-opus-5', messages, system: 'be terse' }
  const built = await buildClaudeWireRequest(
    options as never, SESSION, messages, 32_000, undefined, undefined, ATIS_X_SESSION, 'atis-account-untouched',
  )
  assert.equal(built.headers.some(([name]) => name.toLowerCase() === 'x-cc-atis'), false)
})
