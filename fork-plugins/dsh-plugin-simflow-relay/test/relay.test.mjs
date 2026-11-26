// Run: node --import ./test/register.mjs --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as relayModule from '../src/index.js'

const { createRelayHandler, createSimflowMessage, createStatusHandler, parseRelayRequest, sessionStatus, simflowLead } = relayModule

const TOKEN = 'simflow-relay-test-token-0123456789abcdef'

function tokenFile() {
  const dir = mkdtempSync(join(tmpdir(), 'simflow-relay-'))
  const file = join(dir, 'relay-token')
  writeFileSync(file, `${TOKEN}\n`)
  return file
}

function fakeCtx(sent, archived = []) {
  const agent = { status: 'idle', send: (message, mode, wake) => sent.push({ message, mode, wake }) }
  const registry = { archivedSessionIds: archived }
  return {
    get: name => (name === 'workspaceRegistry' ? registry : undefined),
    agents: { get: id => (id === 'session-live' || id === 'session-archived' ? agent : undefined) },
    sessionController: {
      resolveAgent: async id => (id === 'session-stored'
        ? { agent: (() => { sent.stored = agent; return agent })() }
        : { error: Object.assign(new Error('no such session'), { code: 'session/not-found' }) }),
    },
    logger: { warn: () => {} },
  }
}

async function withServer(ctx, fn) {
  const handler = createRelayHandler(ctx, { path: '/api/simflow/relay', tokenFile: tokenFile(), maxBodyBytes: 65536 })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/api/simflow/relay`
  try { await fn(url) } finally { server.close() }
}

function post(url, body, token = TOKEN) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { 'x-simflow-token': token }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('message carries the SimFlow lead and never the session-send lead', () => {
  const m = createSimflowMessage({ sessionId: 's', slot: 'S1·market', text: '信 #M1 正文', mailId: 'M1', mailKind: 'blocked' })
  const texts = m.content.map(block => block.text)
  assert.equal(texts[0], simflowLead('S1·market'))
  assert.equal(texts[0], 'SimFlow 发来「S1·market」的消息：')
  assert.equal(texts[1], '信 #M1 正文')
  assert.ok(!texts.join('\n').includes('Message from another Session'))
  assert.equal(m.source.kind, 'simflow')
  assert.equal(m.source.form, 'relay')
  assert.equal(m.source.slot, 'S1·market')
  assert.equal(m.source.mailId, 'M1')
})

test('valid request wakes a live target with next-step delivery', async () => {
  const sent = []
  await withServer(fakeCtx(sent), async url => {
    const res = await post(url, { sessionId: 'session-live', slot: '总设计', text: 'hello', mailId: 'M9' })
    assert.equal(res.status, 202)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.targetSessionId, 'session-live')
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].mode, 'next-step')
  assert.equal(sent[0].wake, true)
  assert.equal(sent[0].message.content[0].text, 'SimFlow 发来「总设计」的消息：')
})

test('stored target is resumed through the Session Controller', async () => {
  const sent = []
  const ctx = fakeCtx(sent)
  // After resume the controller's agent becomes the live one.
  const resolved = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async id => {
    const out = await resolved(id)
    if ('agent' in out) ctx.agents.get = sid => (sid === id ? out.agent : undefined)
    return out
  }
  await withServer(ctx, async url => {
    const res = await post(url, { sessionId: 'session-stored', slot: 'S1·pop', text: 'x' })
    assert.equal(res.status, 202)
  })
  assert.equal(sent.length, 1)
})

test('unknown target is 404 and nothing is sent', async () => {
  const sent = []
  await withServer(fakeCtx(sent), async url => {
    const res = await post(url, { sessionId: 'session-missing', slot: 's', text: 'x' })
    assert.equal(res.status, 404)
    assert.equal((await res.json()).reason, 'not-found')
  })
  assert.equal(sent.length, 0)
})

test('authentication: missing or wrong token is 401', async () => {
  const sent = []
  await withServer(fakeCtx(sent), async url => {
    assert.equal((await post(url, { sessionId: 'session-live', slot: 's', text: 'x' }, null)).status, 401)
    assert.equal((await post(url, { sessionId: 'session-live', slot: 's', text: 'x' }, 'wrong-token-wrong-token-wrong-token!!')).status, 401)
  })
  assert.equal(sent.length, 0)
})

test('method and body validation', async () => {
  const sent = []
  await withServer(fakeCtx(sent), async url => {
    assert.equal((await fetch(url)).status, 405)
    assert.equal((await post(url, 'not json')).status, 400)
    assert.equal((await post(url, { sessionId: 'session-live', slot: '', text: 'x' })).status, 400)
    assert.equal((await post(url, { sessionId: 'bad id!', slot: 's', text: 'x' })).status, 400)
  })
  assert.equal(sent.length, 0)
})

test('parseRelayRequest rejects oversized text', () => {
  assert.throws(() => parseRelayRequest(JSON.stringify({ sessionId: 'a', slot: 's', text: 'x'.repeat(20001) })))
})

test('archived target is refused with 410 and nothing is queued', async () => {
  const sent = []
  await withServer(fakeCtx(sent, ['session-archived']), async url => {
    const res = await post(url, { sessionId: 'session-archived', slot: 's', text: 'x', mailId: 'M1' })
    assert.equal(res.status, 410)
    assert.equal((await res.json()).reason, 'archived')
  })
  assert.equal(sent.length, 0)
})

test('a retried mail id wakes the target only once', async () => {
  const sent = []
  await withServer(fakeCtx(sent), async url => {
    const first = await post(url, { sessionId: 'session-live', slot: 's', text: 'x', mailId: 'M-dedupe' })
    assert.equal(first.status, 202)
    assert.equal((await first.json()).targetStatus, 'idle')
    const again = await post(url, { sessionId: 'session-live', slot: 's', text: 'x', mailId: 'M-dedupe' })
    assert.equal(again.status, 200)
    assert.equal((await again.json()).duplicate, true)
  })
  assert.equal(sent.length, 1)
})
test('sessionStatus classifies without resuming', () => {
  const ctx = fakeCtx([], ['session-archived'])
  ctx.get = name => (name === 'workspaceRegistry'
    ? { archivedSessionIds: ['session-archived'], list: () => [{ sessionIds: ['session-stored', 'session-archived'] }] }
    : undefined)
  let resumed = false
  ctx.sessionController.resolveAgent = async () => { resumed = true; return { error: new Error('x') } }
  assert.equal(sessionStatus(ctx, 'session-archived'), 'archived')
  assert.equal(sessionStatus(ctx, 'session-live'), 'idle')
  assert.equal(sessionStatus(ctx, 'session-stored'), 'stored')
  assert.equal(sessionStatus(ctx, 'session-nope'), 'not-found')
  assert.equal(resumed, false)
})

test('status endpoint requires the token and returns every id', async () => {
  const ctx = fakeCtx([], ['session-archived'])
  const handler = createStatusHandler(ctx, { path: '/api/simflow/relay', tokenFile: tokenFile(), maxBodyBytes: 65536 })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/api/simflow/relay/status`
  try {
    assert.equal((await post(url, { sessionIds: ['session-live'] }, null)).status, 401)
    const res = await post(url, { sessionIds: ['session-live', 'session-archived', 'session-nope'] })
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).statuses, { 'session-live': 'idle', 'session-archived': 'archived', 'session-nope': 'not-found' })
    assert.equal((await post(url, { sessionIds: 'x' })).status, 400)
  } finally { server.close() }
})

/** A Context with the three services the plugin injects, plus a removable WebServer. */
async function withWebServer(fn) {
  const context = new Context()
  const agent = { status: 'idle', send: () => {} }
  context.provide('agents', { get: id => (id === 'session-live' ? agent : undefined) })
  context.provide('sessionController', { resolveAgent: async () => ({ error: Object.assign(new Error('no'), { code: 'session/not-found' }) }) })
  context.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(relayModule, { path: '/api/simflow/relay', tokenFile: tokenFile(), maxBodyBytes: 65536 })
  const deadline = Date.now() + 10_000
  while (context.webServer.port === undefined) {
    if (Date.now() > deadline) throw new Error('web server never bound a port')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    await fn(`http://127.0.0.1:${context.webServer.port}`)
  } finally {
    await context.fiber.dispose()
  }
}

test('the carrier admits both routes anonymously', async () => {
  await withWebServer(async origin => {
    // A registered Web route defaults to `auth: 'required'`, which refuses a
    // caller carrying no browser session or API credential. SimFlow carries
    // only its token, so the relay's own loopback and token checks must be the
    // whole gate — and the handler, not the carrier, must answer a bad token.
    const ok = await post(`${origin}/api/simflow/relay`, { sessionId: 'session-live', slot: '总设计', text: 'hi' })
    assert.equal(ok.status, 202)
    assert.equal((await ok.json()).ok, true)
    const refused = await post(`${origin}/api/simflow/relay`, { sessionId: 'session-live', slot: 's', text: 'x' }, 'wrong-token-wrong-token-wrong-token!!')
    assert.equal(refused.status, 401)
    assert.equal((await refused.json()).reason, 'unauthorized')
    const status = await post(`${origin}/api/simflow/relay/status`, { sessionIds: ['session-live'] })
    assert.equal(status.status, 200)
    assert.deepEqual((await status.json()).statuses, { 'session-live': 'idle' })
  })
})