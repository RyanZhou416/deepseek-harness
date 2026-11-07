import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayAccountStore } from '../../src/account.ts'
import { resolveRelayConfig } from '../../src/config.ts'
import type { RelayConfig } from '../../src/config.ts'
import { RelayController } from '../../src/controller.ts'
import { DAY_MS, BROWSER_SESSION_KEY } from '../../src/cookie.ts'
import { FrpcSupervisor } from '../../src/frpc-process.ts'
import type { FrpcSupervisorOptions } from '../../src/frpc-process.ts'
import type { RelayHostContext } from '../../src/host.ts'
import type { RelayTunnel } from '../../src/protocol.ts'
import { buildTarGz, buildZip } from './helpers/archives.ts'
import { MemoryCredentials } from './helpers/memory-credentials.ts'
import { delay } from './helpers/test-server.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-frpc.mjs', import.meta.url))
const KEY = 'dshk_' + 'B'.repeat(43)
const PASSWORD = 'at least ten characters'
const BASE_URL = 'https://ryan.relay.example.com/'
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const TUNNEL: RelayTunnel = {
  frpVersion: '0.71.0',
  serverAddr: '203.0.113.10',
  serverPort: 80,
  websocketPath: '/~!frp',
  tlsServerName: '203.0.113.10',
  caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  sharedToken: 'shared-token',
  user: 'ryan',
  frpToken: 'user-token',
  remotePort: 13080,
}

interface Captured {
  url: string
  body: Record<string, unknown> | undefined
}

interface Harness {
  controller: RelayController
  store: RelayAccountStore
  requests: Captured[]
  supervisorOptions: FrpcSupervisorOptions[]
}

interface HarnessOptions {
  /** `null` mounts no web server; omission mounts 3080. */
  port?: number | null
  /** `null` mounts no Loader; omission mounts a connection entry at 30 days. */
  loaderDays?: number | null
  frpcPath?: string
  config?: RelayConfig
  fetch?: typeof fetch
  /** Overrides the validated refresh interval so tests need not wait a minute. */
  refreshMs?: number
}

let scratch: string | undefined
let harness: Harness | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-relay-controller-'))
})

afterEach(async () => {
  await harness?.controller.dispose()
  harness = undefined
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

function hostContext(options: HarnessOptions): RelayHostContext {
  return {
    get(name: string): unknown {
      if (name === 'webServer') {
        const port = options.port === undefined ? 3080 : options.port
        return port === null ? undefined : { port, protocol: 'http:' as const }
      }
      if (name === 'loader') {
        const days = options.loaderDays === undefined ? 30 : options.loaderDays
        if (days === null) return undefined
        return {
          * entries() {
            yield { options: { name: '@deepseek-ai/dsh-client-connection', config: { cookieMaxAgeDays: days } } }
          },
        }
      }
      return undefined
    },
  }
}

function defaultFetch(requests: Captured[], options: HarnessOptions): typeof fetch {
  return async (input, init) => {
    if (options.fetch !== undefined) return options.fetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({ url, body })
    if (url.endsWith('/connect')) {
      return Response.json({ ok: true, username: 'ryan', created: false, url: BASE_URL, tunnel: TUNNEL })
    }
    if (url.endsWith('/password')) return Response.json({ ok: true })
    return new Response('unexpected', { status: 500 })
  }
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = scratch as string
  const context = new Context()
  const credentials = new MemoryCredentials(context)
  await credentials.modifyRecord(BROWSER_SESSION_KEY, async () => ({
    kind: 'grant',
    payload: { version: 1, secret: SECRET },
  }))
  const store = new RelayAccountStore(credentials)
  await store.save({ domain: 'relay.example.com', username: 'ryan', password: PASSWORD, clientKey: KEY })
  const requests: Captured[] = []
  const supervisorOptions: FrpcSupervisorOptions[] = []
  const controller = new RelayController({
    ctx: hostContext(options),
    config: {
      ...resolveRelayConfig({
        requestTimeoutMs: 2_000,
        connectStartupTimeoutMs: 2_000,
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 40,
        ...options.frpcPath === undefined ? {} : { frpcPath: options.frpcPath },
        ...options.config,
      }),
      ...options.refreshMs === undefined ? {} : { cookieRefreshIntervalMs: options.refreshMs },
    },
    store,
    credentials,
    home: () => root,
    fetchImpl: defaultFetch(requests, options),
    supervisorFactory: (supervisorConfig) => {
      supervisorOptions.push(supervisorConfig)
      return new FrpcSupervisor({
        ...supervisorConfig,
        launch: { command: process.execPath, args: [FIXTURE, 'success'], cwd: root },
      })
    },
  })
  harness = { controller, store, requests, supervisorOptions }
  return harness
}

async function writeFakeFrpc(): Promise<string> {
  const path = join(scratch as string, 'fake-frpc')
  await writeFile(path, 'placeholder')
  return path
}

async function waitForPhase(controller: RelayController, phase: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while ((await controller.status()).phase !== phase) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for phase ${phase}: ${JSON.stringify(await controller.status())}`)
    await delay(10)
  }
}

function decodeCookieBody(header: string): { authority: string; issuedAt: number; expiresAt: number } {
  const body = header.split('=')[1]?.split('.')[1] as string
  const padded = body.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (body.length % 4)) % 4)
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
    authority: string; issuedAt: number; expiresAt: number
  }
}

describe('relay controller', () => {
  it('starts unconfigured and reports saved flags without secrets', async () => {
    const { controller, store } = await createHarness()
    expect((await controller.status()).phase).toBe('disconnected')
    const status = await controller.status()
    expect(status.account.hasPassword).toBe(true)
    const text = JSON.stringify(status)
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain(KEY)

    const fresh = new Context()
    const credentials = new MemoryCredentials(fresh)
    const emptyStore = new RelayAccountStore(credentials)
    const emptyController = new RelayController({
      ctx: hostContext({}),
      config: resolveRelayConfig({}),
      store: emptyStore,
      credentials,
      home: () => scratch as string,
    })
    expect((await emptyController.status()).phase).toBe('unconfigured')
    await emptyController.dispose()
    void store
  })

  it('mints a fresh cookie, registers, and starts the tunnel', async () => {
    const { controller, requests } = await createHarness({ frpcPath: await writeFakeFrpc() })
    await controller.start()
    await waitForPhase(controller, 'connected')
    const status = await controller.status()
    expect(status.url).toBe(BASE_URL)
    expect(status.remotePort).toBe(13080)
    expect(status.frpcVersion).toBe('0.71.0')
    expect(status.lastConnectedAt).toMatch(/^\d{4}-/u)

    const connect = requests.find(request => request.url.endsWith('/connect'))
    expect(connect?.body).toMatchObject({ username: 'ryan', password: PASSWORD })
    const dsh = connect?.body?.dsh as { authority: string; cookie: string }
    expect(dsh.authority).toBe('127.0.0.1:3080')
    const decoded = decodeCookieBody(dsh.cookie)
    expect(decoded.authority).toBe('127.0.0.1:3080')
    expect(decoded.expiresAt - decoded.issuedAt).toBe(29 * DAY_MS)
    expect(dsh.cookie.startsWith('dsh-auth-')).toBe(true)

    const config = await readFile(join(scratch as string, 'dsh-relay', 'run', 'frpc.toml'), 'utf8')
    expect(config).toContain('remotePort = 13080')
    expect(config).toContain('localPort = 3080')
  })

  it('reports a protocol failure and starts no process', async () => {
    const { controller, supervisorOptions } = await createHarness({
      frpcPath: await writeFakeFrpc(),
      fetch: async () => Response.json({ ok: false, code: 'client-key-invalid', message: 'refused' }, { status: 401 }),
    })
    await controller.start()
    const status = await controller.status()
    expect(status.phase).toBe('failed')
    expect(status.errorCode).toBe('client-key-invalid')
    expect(supervisorOptions).toHaveLength(0)
  })

  it('reports a missing web server', async () => {
    const { controller } = await createHarness({ port: null, frpcPath: await writeFakeFrpc() })
    await controller.start()
    const status = await controller.status()
    expect(status.errorCode).toBe('web-server-unavailable')
  })

  it('uses the connection default when no Loader entry overrides the cookie lifetime', async () => {
    const { controller, requests } = await createHarness({ loaderDays: null, frpcPath: await writeFakeFrpc() })
    await controller.start()
    const dsh = requests[0]?.body?.dsh as { cookie: string }
    const decoded = decodeCookieBody(dsh.cookie)
    expect(decoded.expiresAt - decoded.issuedAt).toBe(29 * DAY_MS)
  })

  it('stops the supervisor on disconnect and on dispose', async () => {
    const { controller } = await createHarness({ frpcPath: await writeFakeFrpc() })
    await controller.start()
    await waitForPhase(controller, 'connected')
    await controller.disconnect()
    expect((await controller.status()).phase).toBe('disconnected')
    await controller.start()
    await waitForPhase(controller, 'connected')
    await controller.dispose()
    expect((await controller.status()).phase).toBe('disconnected')
  })

  it('downloads frpc when no local path is configured', async () => {
    const platformKey = `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
    const binary = Buffer.from('fake frpc downloaded binary')
    const archive = process.platform === 'win32'
      ? buildZip([{ name: 'frp_0.71.0_windows_amd64/frpc.exe', data: binary, deflate: true }])
      : buildTarGz('frp_0.71.0_linux_amd64/frpc', binary)
    const hash = createHash('sha256').update(archive).digest('hex')
    const { controller } = await createHarness({
      config: { frpcHashes: { [`0.71.0/${platformKey}`]: hash } },
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith('/connect')) {
          return Response.json({ ok: true, username: 'ryan', created: false, url: BASE_URL, tunnel: TUNNEL })
        }
        return new Response(new Uint8Array(archive), { status: 200, headers: { 'content-length': String(archive.length) } })
      },
    })
    await controller.start()
    await waitForPhase(controller, 'connected', 6_000)
    const executable = join(scratch as string, 'dsh-relay', 'bin', process.platform === 'win32' ? 'frpc.exe' : 'frpc')
    expect((await stat(executable)).isFile()).toBe(true)
    expect((await readFile(executable)).equals(binary)).toBe(true)
  })

  it('stores the new password after a successful change', async () => {
    const { controller, store, requests } = await createHarness({ frpcPath: await writeFakeFrpc() })
    await controller.changePassword('old-password', 'brand-new-password')
    expect((await store.read())?.password).toBe('brand-new-password')
    expect(requests.at(-1)?.body).toEqual({
      username: 'ryan',
      password: 'old-password',
      newPassword: 'brand-new-password',
    })
  })

  it('drops a running tunnel when saved settings change', async () => {
    const { controller } = await createHarness({ frpcPath: await writeFakeFrpc() })
    await controller.start()
    await waitForPhase(controller, 'connected')
    await controller.save({ domain: 'relay.example.com', username: 'other', password: 'another password', clientKey: KEY })
    expect((await controller.status()).phase).toBe('disconnected')
  })

  it('keeps a running tunnel when only auto-connect changes', async () => {
    const { controller } = await createHarness({ frpcPath: await writeFakeFrpc() })
    await controller.start()
    await waitForPhase(controller, 'connected')
    await controller.save({ domain: 'relay.example.com', username: 'ryan', autoConnect: true })
    expect((await controller.status()).phase).toBe('connected')
  })
})

describe('relay cookie refresh', () => {
  it('re-registers a fresh cookie while connected without restarting frpc', async () => {
    const frpcPath = await writeFakeFrpc()
    const { controller, requests, supervisorOptions } = await createHarness({ frpcPath, refreshMs: 40 })
    await controller.start()
    await waitForPhase(controller, 'connected')
    const deadline = Date.now() + 4_000
    while (requests.filter(request => request.url.endsWith('/connect')).length < 3) {
      if (Date.now() > deadline) throw new Error('no refresh happened')
      await delay(10)
    }
    const cookies = requests.filter(request => request.url.endsWith('/connect'))
      .map(request => decodeCookieBody((request.body?.dsh as { cookie: string }).cookie).issuedAt)
    expect(new Set(cookies).size).toBe(cookies.length)
    expect(supervisorOptions).toHaveLength(1)
    const status = await controller.status()
    expect(status.phase).toBe('connected')
    expect(status.lastRegisteredAt).toBeDefined()
  })

  it('keeps the tunnel up when a refresh fails', async () => {
    const frpcPath = await writeFakeFrpc()
    let calls = 0
    const { controller, supervisorOptions } = await createHarness({
      frpcPath,
      refreshMs: 40,
      fetch: async () => {
        calls += 1
        if (calls === 1) return Response.json({ ok: true, username: 'ryan', created: false, url: BASE_URL, tunnel: TUNNEL })
        return Response.json({ ok: false, code: 'internal', message: 'down' }, { status: 500 })
      },
    })
    await controller.start()
    await waitForPhase(controller, 'connected')
    while (calls < 3) await delay(10)
    expect((await controller.status()).phase).toBe('connected')
    expect(supervisorOptions).toHaveLength(1)
  })

  it('reconnects when the relay returns different tunnel parameters', async () => {
    const frpcPath = await writeFakeFrpc()
    let calls = 0
    const { controller, supervisorOptions } = await createHarness({
      frpcPath,
      refreshMs: 40,
      fetch: async () => {
        calls += 1
        const tunnel = calls === 1 ? TUNNEL : { ...TUNNEL, remotePort: 13081 }
        return Response.json({ ok: true, username: 'ryan', created: false, url: BASE_URL, tunnel })
      },
    })
    await controller.start()
    await waitForPhase(controller, 'connected')
    const deadline = Date.now() + 4_000
    while (supervisorOptions.length < 2) {
      if (Date.now() > deadline) throw new Error('no reconnect happened')
      await delay(10)
    }
    await waitForPhase(controller, 'connected')
    expect((await controller.status()).remotePort).toBe(13081)
  })

  it('stops refreshing after disconnect', async () => {
    const frpcPath = await writeFakeFrpc()
    const { controller, requests } = await createHarness({ frpcPath, refreshMs: 40 })
    await controller.start()
    await waitForPhase(controller, 'connected')
    await controller.disconnect()
    const count = requests.length
    await delay(150)
    expect(requests).toHaveLength(count)
  })
})