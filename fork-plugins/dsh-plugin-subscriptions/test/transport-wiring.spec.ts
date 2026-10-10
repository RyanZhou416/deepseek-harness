import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { BunBridge, BridgeError, type BridgeDuplex } from '../src/transport/bridge.js'
import { FrameDecoder, type Frame } from '../src/transport/frames.js'
import { bridgeEnabled, claudeApiFetch, stopBridge } from '../src/transport/claude-fetch.js'
import { BUN_PATH_ENV, BunRuntimeError, resolveBunRuntime } from '../src/transport/bun-runtime.js'

/** Records what the client framed, so a test can assert the stream index. */
function recordingDuplex(): { duplex: BridgeDuplex; frames: () => readonly Frame[] } {
  const sent: Uint8Array[] = []
  const decoder = new FrameDecoder()
  return {
    duplex: {
      write: (bytes) => {
        sent.push(bytes)
      },
      onData: () => {},
      onExit: () => {},
      kill: () => {},
    },
    frames: () => {
      const out: Frame[] = []
      for (const chunk of sent) out.push(...decoder.push(chunk))
      return out
    },
  }
}

test('the request control frame carries the index its body frames use', async () => {
  // The end-to-end run caught this: the requester picked the index locally while
  // the child only learned indices when it sent, so every request body arrived as
  // a frame for an unknown stream and was dropped.
  const harness = recordingDuplex()
  const bridge = new BunBridge(harness.duplex)
  void bridge.request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: 'hello',
  }).catch(() => {})
  const frames = harness.frames()
  const control = frames.find((frame) => frame.tag === 1 && frame.message['type'] === 'request')
  assert.ok(control !== undefined && control.tag === 1)
  if (control.tag !== 1) return
  assert.equal(control.message['index'], 0, 'the control frame names the stream index')
  const body = frames.find((frame) => frame.tag === 2)
  assert.ok(body !== undefined && body.tag === 2)
  if (body.tag !== 2) return
  assert.equal(body.streamIndex, control.message['index'], 'the body frame uses that same index')
})

test('the bridge is on by default and off only when explicitly disabled', () => {
  assert.equal(bridgeEnabled({}), true)
  assert.equal(bridgeEnabled({ DSH_SUBSCRIPTIONS_BRIDGE: 'on' }), true)
  for (const value of ['off', 'false', '0']) {
    assert.equal(bridgeEnabled({ DSH_SUBSCRIPTIONS_BRIDGE: value }), false, value)
  }
})

test('a non-Claude host never reaches the bridge', async () => {
  // Routing is by host, so token refresh and the other providers keep the client
  // they had; the assertion is that no bridge is started for them.
  const original = globalThis.fetch
  let called: string | undefined
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    called = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    await claudeApiFetch('https://console.anthropic.com/v1/oauth/token', { method: 'POST' })
    assert.equal(called, 'https://console.anthropic.com/v1/oauth/token')
  } finally {
    globalThis.fetch = original
  }
})

test('a missing runtime fails loudly and names the switch', async () => {
  const originalFetch = globalThis.fetch
  const originalBun = process.env[BUN_PATH_ENV]
  const originalBridge = process.env['DSH_SUBSCRIPTIONS_BRIDGE']
  // Keep the pre-existing client out of the way: this test is about the error.
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
  process.env[BUN_PATH_ENV] = 'C:/definitely/missing/bun.exe'
  delete process.env['DSH_SUBSCRIPTIONS_BRIDGE']
  try {
    await assert.rejects(
      claudeApiFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'BridgeUnavailableError' &&
        error.message.includes('DSH_SUBSCRIPTIONS_BRIDGE'),
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalBun === undefined) delete process.env[BUN_PATH_ENV]
    else process.env[BUN_PATH_ENV] = originalBun
    if (originalBridge === undefined) delete process.env['DSH_SUBSCRIPTIONS_BRIDGE']
    else process.env['DSH_SUBSCRIPTIONS_BRIDGE'] = originalBridge
    await stopBridge()
  }
})

test('the runtime override is honoured and a missing override is refused', () => {
  const override = process.execPath
  assert.equal(resolveBunRuntime({ [BUN_PATH_ENV]: override }), override)
  assert.throws(
    () => resolveBunRuntime({ [BUN_PATH_ENV]: 'C:/missing/bun.exe' }),
    (error: unknown) => error instanceof BunRuntimeError,
  )
})

test('the declared platform runtime resolves on this host when installed', () => {
  try {
    const resolved = resolveBunRuntime({})
    assert.equal(existsSync(resolved), true)
  } catch (error) {
    // An uninstalled platform package is the documented, fail-closed state on a
    // host that never installed it; the message must name the package and the
    // override rather than failing silently.
    assert.ok(error instanceof BunRuntimeError)
    assert.match(error.message, /@oven\/bun-|DSH_SUBSCRIPTIONS_BUN_PATH/)
  }
})
