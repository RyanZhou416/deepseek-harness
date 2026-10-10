import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BunBridge, BridgeError, childEnvironment, type BridgeDuplex } from '../src/transport/bridge.js'
import { FrameDecoder, type Frame } from '../src/transport/frames.js'
import { bridgeEnabled, claudeApiFetch, stopBridge } from '../src/transport/claude-fetch.js'
import { BUN_PATH_ENV, BUN_PLATFORM_PACKAGES, BunRuntimeError, resolveBunRuntime } from '../src/transport/bun-runtime.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..')

/** The Bun platform packages the manifest declares. */
function declaredBunPackages(): string[] {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>
  }
  return Object.keys(manifest.optionalDependencies ?? {}).filter(name => name.startsWith('@oven/bun-'))
}

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

test('the platform map names the published package for every supported target', () => {
  assert.deepEqual(BUN_PLATFORM_PACKAGES, {
    'win32-x64': '@oven/bun-windows-x64',
    'win32-arm64': '@oven/bun-windows-aarch64',
    'darwin-arm64': '@oven/bun-darwin-aarch64',
    'darwin-x64': '@oven/bun-darwin-x64',
    'linux-x64': '@oven/bun-linux-x64',
    'linux-arm64': '@oven/bun-linux-aarch64',
  })
  // Bun publishes the arm64 targets as `-aarch64`; a `-arm64` name is not
  // published, and a mapping that used that spelling would resolve nothing.
  for (const [target, name] of Object.entries(BUN_PLATFORM_PACKAGES)) {
    assert.match(name, /^@oven\/bun-[a-z0-9-]+$/, `${target} names a scoped @oven package`)
    assert.equal(name.endsWith('-arm64'), false, `${target} must not use the unpublished -arm64 spelling`)
  }
  // The manifest installs exactly the packages the runtime looks for, so the
  // table and the declared optional dependencies cannot drift apart.
  assert.deepEqual(
    [...new Set(Object.values(BUN_PLATFORM_PACKAGES))].sort(),
    declaredBunPackages().sort(),
  )
})

test('a host-mandated Claude route refuses the bridge before the child is considered', async () => {
  const originalBun = process.env[BUN_PATH_ENV]
  const originalRoute = process.env['DSH_CLAUDE_PROXY_URL']
  const originalBridge = process.env['DSH_SUBSCRIPTIONS_BRIDGE']
  process.env[BUN_PATH_ENV] = 'C:/definitely/missing/bun.exe'
  process.env['DSH_CLAUDE_PROXY_URL'] = 'http://user:secret@127.0.0.1:7897'
  delete process.env['DSH_SUBSCRIPTIONS_BRIDGE']
  try {
    await assert.rejects(
      claudeApiFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'BridgeUnavailableError')
        assert.match(error.message, /DSH_CLAUDE_PROXY_URL/)
        assert.match(error.message, /127\.0\.0\.1:7897/)
        assert.equal(error.message.includes('secret'), false, 'the refusal names the route, not its credential')
        assert.equal(error.message.includes('missing/bun.exe'), false, 'the runtime is never resolved')
        return true
      },
    )
  } finally {
    if (originalBun === undefined) delete process.env[BUN_PATH_ENV]
    else process.env[BUN_PATH_ENV] = originalBun
    if (originalRoute === undefined) delete process.env['DSH_CLAUDE_PROXY_URL']
    else process.env['DSH_CLAUDE_PROXY_URL'] = originalRoute
    if (originalBridge === undefined) delete process.env['DSH_SUBSCRIPTIONS_BRIDGE']
    else process.env['DSH_SUBSCRIPTIONS_BRIDGE'] = originalBridge
    await stopBridge()
  }
})

test('the transport child is never handed a host-mandated route', () => {
  // The child runs its own runtime and reads no DSH variable, so a route it cannot
  // honour must not appear in its environment and be silently ignored.
  const kept = childEnvironment({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    DSH_CLAUDE_PROXY_URL: 'http://127.0.0.1:7897',
  })
  assert.equal(kept['HTTPS_PROXY'], 'http://127.0.0.1:7897')
  assert.equal('DSH_CLAUDE_PROXY_URL' in kept, false)
})

test('with the bridge off, a host-mandated Claude route is left to the process dispatcher', async () => {
  const originalFetch = globalThis.fetch
  const originalRoute = process.env['dsh_claude_proxy_url']
  const originalBridge = process.env['DSH_SUBSCRIPTIONS_BRIDGE']
  process.env['dsh_claude_proxy_url'] = 'http://127.0.0.1:7897'
  process.env['DSH_SUBSCRIPTIONS_BRIDGE'] = 'off'
  const dispatchers: unknown[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher)
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    await claudeApiFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })
    assert.deepEqual(dispatchers, [undefined], 'no dispatcher of ours replaces the host route')
  } finally {
    globalThis.fetch = originalFetch
    if (originalRoute === undefined) delete process.env['dsh_claude_proxy_url']
    else process.env['dsh_claude_proxy_url'] = originalRoute
    if (originalBridge === undefined) delete process.env['DSH_SUBSCRIPTIONS_BRIDGE']
    else process.env['DSH_SUBSCRIPTIONS_BRIDGE'] = originalBridge
    await stopBridge()
  }
})
