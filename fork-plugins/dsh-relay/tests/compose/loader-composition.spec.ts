/**
 * Real-composition proof: the vendored Loader mounts the plugin beside the
 * shipped credential, web-server, and connection plugins, and the settings RPC
 * answers a real authenticated HTTP request.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import * as connectionPlugin from '../../../../packages/client/connection/src/index.ts'
import WebServer from '../../../../packages/host/webserver/src/index.ts'
import { BROWSER_SESSION_KEY, browserSessionSecret, mintBrowserCookie } from '../../src/cookie.ts'
import * as relayPlugin from '../../src/index.ts'
import { MemoryCredentials } from '../host/helpers/memory-credentials.ts'

const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function waitForPort(owner: Context): Promise<number> {
  const deadline = Date.now() + 10_000
  while (true) {
    const webServer = owner.get('webServer') as { port: number | undefined } | undefined
    if (webServer?.port !== undefined) return webServer.port
    if (Date.now() > deadline) throw new Error('web server never bound a port')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function post(port: number, method: string, payload: unknown, cookie?: string): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...cookie === undefined ? {} : { cookie },
    },
    body: JSON.stringify({ type: 'client-request', rpcId: '1', method, payload }),
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = undefined
  }
  return { status: response.status, body, text }
}

describe('dsh-relay through the shipped Loader', () => {
  it('mounts beside the host plugins and serves the authenticated settings RPC', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-relay-loader-'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.internal = sourceModuleLoader(async (specifier) => {
      if (specifier === 'dsh-relay') return relayPlugin
      throw new Error(`unexpected Loader import: ${specifier}`)
    })

    let credentials: MemoryCredentials | undefined
    await context.plugin((owner) => { credentials = new MemoryCredentials(owner) })
    await credentials!.modifyRecord(BROWSER_SESSION_KEY, async () => ({
      kind: 'grant',
      payload: { version: 1, secret: SECRET },
    }))

    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin(connectionPlugin, { cookieMaxAgeDays: 30 })
    const port = await waitForPort(context)

    await context.loader.create({ name: 'dsh-relay' })
    await context.loader.await()

    const unauthenticated = await post(port, 'relay.status', {})
    expect(unauthenticated.status).toBe(401)

    const secret = browserSessionSecret(await credentials!.readRecord(BROWSER_SESSION_KEY))
    const cookie = mintBrowserCookie(secret, `127.0.0.1:${String(port)}`, 29)
    const status = await post(port, 'relay.status', {}, cookie.header)
    expect(status.status).toBe(200)
    const statusBody = status.body as { type: string; result: { ok: boolean; value: { phase: string } } }
    expect(statusBody.type).toBe('server-response')
    expect(statusBody.result.ok).toBe(true)
    expect(statusBody.result.value.phase).toBe('unconfigured')

    const password = 'at least ten characters'
    const clientKey = 'dshk_' + 'C'.repeat(43)
    const saved = await post(port, 'relay.save', {
      domain: 'relay.example.com',
      username: 'ryan',
      password,
      clientKey,
      autoConnect: true,
    }, cookie.header)
    expect(saved.status).toBe(200)
    expect(saved.text).not.toContain(password)
    expect(saved.text).not.toContain(clientKey)
    const savedBody = saved.body as {
      result: { ok: boolean; value: { phase: string; account: { hasPassword: boolean; hasClientKey: boolean; autoConnect: boolean } } }
    }
    expect(savedBody.result.ok).toBe(true)
    expect(savedBody.result.value.phase).toBe('disconnected')
    expect(savedBody.result.value.account).toMatchObject({
      hasPassword: true,
      hasClientKey: true,
      autoConnect: true,
    })

    const afterSave = await post(port, 'relay.status', {}, cookie.header)
    expect((afterSave.body as { result: { ok: boolean } }).result.ok).toBe(true)
  }, 30_000)
})
