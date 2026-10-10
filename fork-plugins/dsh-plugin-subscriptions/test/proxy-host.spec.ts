import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { proxiedFetch, proxySetConfig, proxyTestConnection, resetProxyForTests } from '../src/http.js'
import {
  describeHostClaudeRoute,
  hostClaudeRoute,
  hostProxyForScheme,
  isClaudeEgressDestination,
} from '../src/transport/host-egress.js'

/** Every name the launcher publishes its resolved proxy policy under. */
const HOST_PROXY_ENV_NAMES = [
  'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY', 'dsh_claude_proxy_url', 'DSH_CLAUDE_PROXY_URL',
] as const

test('disabled and bypassed plugin proxy preserve the host global dispatcher, including probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subscriptions-proxy-host-'))
  const previousHome = process.env.DSH_HOME
  const previousDispatcher = getGlobalDispatcher()
  const host = new MockAgent()
  host.disableNetConnect()
  process.env.DSH_HOME = dir
  await resetProxyForTests()
  setGlobalDispatcher(host)
  try {
    const target = 'https://subscriptions.example'
    const pool = host.get(target)
    for (const bypass of [false, true]) {
      await proxySetConfig({ enabled: bypass, url: 'http://127.0.0.1:1', bypass: ['subscriptions.example'] })
      pool.intercept({ path: '/', method: 'GET' }).reply(200, 'host-routed')
      assert.equal(await (await proxiedFetch(target)).text(), 'host-routed')
      pool.intercept({ path: '/', method: 'GET' }).reply(204)
      const probe = await proxyTestConnection(target)
      assert.equal(probe.ok, true)
      assert.equal(probe.status, 204)
      assert.equal(probe.viaProxy, false, 'means no plugin override, not direct transport')
      assert.equal(getGlobalDispatcher(), host, 'plugin must not replace the host dispatcher')
    }
    host.assertNoPendingInterceptors()
  } finally {
    await resetProxyForTests()
    setGlobalDispatcher(previousDispatcher)
    await host.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Runs `check` with every published proxy name cleared, restoring the process values after.
 *
 * @param check - The body to run against the cleared environment.
 */
async function withClearedHostEnv(check: () => Promise<void>): Promise<void> {
  const previous = HOST_PROXY_ENV_NAMES.map(name => [name, process.env[name]] as const)
  for (const name of HOST_PROXY_ENV_NAMES) delete process.env[name]
  try {
    await check()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * Runs `check` with a private home, a cleared host proxy environment plus `published`,
 * and the global fetch replaced by a spy recording each call's `dispatcher`.
 *
 * @param enabled - Whether the plugin's own proxy is configured against a closed port.
 * @param published - Host proxy values to publish before the calls.
 * @param check - Receives the recorded dispatchers, one per global-fetch call.
 */
async function withHostProxyEnv(
  enabled: boolean,
  published: Readonly<Record<string, string>>,
  check: (dispatchers: unknown[]) => Promise<void>,
): Promise<void> {
  await withClearedHostEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subscriptions-proxy-host-'))
    const previousHome = process.env.DSH_HOME
    const previousFetch = globalThis.fetch
    await resetProxyForTests()
    process.env.DSH_HOME = dir
    Object.assign(process.env, published)
    const dispatchers: unknown[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher)
      return new Response('host-routed', { status: 200 })
    }) as typeof fetch
    try {
      if (enabled) await proxySetConfig({ enabled: true, url: 'http://127.0.0.1:1', bypass: [] })
      await check(dispatchers)
    } finally {
      globalThis.fetch = previousFetch
      await resetProxyForTests()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(dir, { recursive: true, force: true })
    }
  })
}

/**
 * Runs `check` with the plugin proxy enabled against a closed port and a host-mandated
 * Claude route published.
 *
 * @param check - Receives the recorded dispatchers, one per global-fetch call.
 */
async function withHostRoute(check: (dispatchers: unknown[]) => Promise<void>): Promise<void> {
  await withHostProxyEnv(true, { DSH_CLAUDE_PROXY_URL: 'http://127.0.0.1:9' }, check)
}

test('the published host route is read in the host\'s own precedence', () => {
  assert.equal(hostClaudeRoute({}), undefined)
  assert.equal(hostClaudeRoute({ DSH_CLAUDE_PROXY_URL: '   ' }), undefined)
  assert.equal(hostClaudeRoute({ DSH_CLAUDE_PROXY_URL: 'http://upper.example:1' }), 'http://upper.example:1')
  assert.equal(
    hostClaudeRoute({ dsh_claude_proxy_url: 'http://lower.example:1', DSH_CLAUDE_PROXY_URL: 'http://upper.example:1' }),
    'http://lower.example:1',
  )
  assert.equal(hostProxyForScheme(undefined), undefined)
  assert.equal(hostProxyForScheme(new URL('https://a.example'), {}), undefined)
  assert.equal(hostProxyForScheme(new URL('https://a.example'), { http_proxy: 'http://p.example:1' }), undefined)
  assert.equal(hostProxyForScheme(new URL('http://a.example'), { http_proxy: 'http://p.example:1' }), 'http://p.example:1')
  assert.equal(
    hostProxyForScheme(new URL('https://a.example'), { https_proxy: 'http://lower.example:1', HTTPS_PROXY: 'http://upper.example:1' }),
    'http://lower.example:1',
  )
  assert.equal(hostProxyForScheme(new URL('ftp://a.example'), { http_proxy: 'http://p.example:1' }), undefined)
  assert.equal(isClaudeEgressDestination('api.anthropic.com'), true)
  assert.equal(isClaudeEgressDestination('platform.claude.com.'), true)
  assert.equal(isClaudeEgressDestination('CLAUDE.COM'), true)
  assert.equal(isClaudeEgressDestination('notanthropic.example'), false)
  assert.equal(describeHostClaudeRoute('http://user:secret@127.0.0.1:7897'), 'DSH_CLAUDE_PROXY_URL (http://127.0.0.1:7897)')
})

test('a host-mandated Claude route outranks the plugin proxy on every Claude destination', async () => {
  await withHostRoute(async (dispatchers) => {
    // Messages and the OAuth token exchange are the two hosts the plugin's Claude
    // traffic uses; both must leave the route to the dispatcher the host installed.
    for (const url of ['https://api.anthropic.com/v1/messages', 'https://platform.claude.com/v1/oauth/token']) {
      assert.equal(await (await proxiedFetch(url)).text(), 'host-routed')
    }
    assert.deepEqual(dispatchers, [undefined, undefined], 'the process dispatcher decides both')
  })
})

test('a host-mandated Claude route leaves the other providers on the plugin proxy', async () => {
  await withHostRoute(async (dispatchers) => {
    // The mandated route covers Claude destinations only, so a request to another
    // provider still goes through the plugin's own ProxyAgent, which is not the
    // process fetch; the closed proxy port makes that attempt reject.
    await assert.rejects(proxiedFetch('https://api.x.ai/v1/models'))
    assert.deepEqual(dispatchers, [], 'a non-Claude destination keeps the plugin transport')
  })
})

test('a published host proxy keeps the plugin from forcing its own direct route', async () => {
  await withHostProxyEnv(
    false,
    { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' },
    async (dispatchers) => {
      assert.equal(await (await proxiedFetch('http://other-provider.example/v1/models')).text(), 'host-routed')
      assert.equal(await (await proxiedFetch('https://other-provider.example/v1/models')).text(), 'host-routed')
      assert.deepEqual(dispatchers, [undefined, undefined], 'the installed dispatcher carries both schemes')
    },
  )
})

test('an untouched environment keeps the plugin\'s own direct route', async () => {
  await withHostProxyEnv(false, {}, async (dispatchers) => {
    assert.equal(await (await proxiedFetch('https://other-provider.example/v1/models')).text(), 'host-routed')
    assert.equal(dispatchers.length, 1, 'the plugin issues the request itself')
    assert.ok(dispatchers[0] instanceof Agent, 'through this module\'s own direct agent')
  })
})

test('an enabled plugin proxy stays authoritative when the host published nothing', async () => {
  await withHostProxyEnv(true, {}, async (dispatchers) => {
    // The plugin's ProxyAgent issues the request on undici's own fetch, so the process
    // fetch is never reached; the closed proxy port makes the attempt reject.
    await assert.rejects(proxiedFetch('https://other-provider.example/v1/models'))
    assert.deepEqual(dispatchers, [], 'the plugin route, not the process dispatcher')
  })
})
