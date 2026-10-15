import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

let proxied: string[]
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string
let disposeProxy: (() => Promise<void>) | undefined

// The fixture proxy answers without forwarding; origin.test never needs a real DNS answer.
const proxyTarget = 'http://origin.test/page'

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address() as AddressInfo)
    })
  })
}

function respond(_request: IncomingMessage, response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

beforeEach(async () => {
  proxied = []
  proxy = createServer((request, response) => {
    proxied.push(request.url ?? '')
    respond(request, response, 'via-proxy')
  })
  origin = createServer((request, response) => { respond(request, response, 'direct') })
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/page`
})

afterEach(async () => {
  try {
    await disposeProxy?.()
  } finally {
    disposeProxy = undefined
    await Promise.all([proxy, origin].map(server => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })))
  }
})

async function installProxy(): Promise<() => Promise<void>> {
  const env = { get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
  return await installProxyFromEnvironment(env, () => undefined)
}

describe('fetching through the process transport', () => {
  it('uses the installed proxy without resolving the destination locally', async () => {
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: proxyTarget })

    expect(result.body.content).toBe('via-proxy')
    expect(proxied).toEqual([proxyTarget])
  })

  it('keeps loopback direct when a proxy is installed', async () => {
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(proxied).toEqual([])
  })

  it('fetches loopback without proxy configuration or DNS substitution', async () => {
    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(proxied).toEqual([])
  })

  it.each(['10.0.0.5', '169.254.169.254', '198.18.0.1', '28.0.0.83', '[fdfe:dcba:9876::3b]'])(
    'hands %s to the configured proxy without an address-class restriction',
    async (host) => {
      disposeProxy = await installProxy()
      const url = `http://${host}:8080/page`

      const result = await new HttpFetchProvider(limits).fetch({ url })

      expect(result.body.content).toBe('via-proxy')
      expect(proxied).toEqual([url])
    },
  )

  it('still refuses a cross-origin redirect on the proxied path', async () => {
    proxy.removeAllListeners('request')
    proxy.on('request', (request, response) => {
      proxied.push(request.url ?? '')
      response.writeHead(302, { location: 'http://elsewhere.example/next' })
      response.end()
    })
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: proxyTarget }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    expect(proxied).toEqual([proxyTarget])
  })

  it('still refuses a URL the transport policy rejects before any hop', async () => {
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'ftp://example.com/x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(proxied).toEqual([])
  })
})
