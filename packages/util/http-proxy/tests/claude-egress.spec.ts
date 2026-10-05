/** Protected destinations exercise the real dispatcher; fixture DNS forbids external connections. */
import dns from 'node:dns'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { installProxyFromEnvironment, proxyEnvironmentForChild, proxyRouteFor } from '../src/index.ts'

const target = 'http://api.anthropic.com/probe'
const secureTarget = 'https://api.anthropic.com/probe'

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function isLookupCallback(value: unknown): value is (error: NodeJS.ErrnoException) => void {
  return typeof value === 'function'
}

interface GuardFixture {
  seen: string[]
  lookups: string[]
  origin: string
  proxy: string
  refuse: () => void
}

async function withGuard(run: (fixture: GuardFixture) => Promise<void>): Promise<void> {
  const seen: string[] = []
  const lookups: string[] = []
  let refusing = false
  const proxy = createServer((request, response) => {
    seen.push(`HTTP ${request.url ?? ''}`)
    if (refusing) request.socket.destroy()
    else response.end('PROXIED')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    // Reject the tunnel locally: no fixture ever forwards to Anthropic.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  const origin = createServer((request, response) => {
    if (request.url === '/redirect') response.writeHead(302, { location: target }).end()
    else response.end('LOCAL')
  })
  let dispose: (() => Promise<void>) | undefined
  let dnsMock: { mockRestore: () => void } | undefined
  try {
    const proxyUrl = await listen(proxy)
    const originUrl = await listen(origin)
    // Numeric loopback addresses need no lookup. A regression cannot resolve a real external host.
    dnsMock = vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
      lookups.push(String(args[0]))
      const callback = args.at(-1)
      if (!isLookupCallback(callback)) throw new Error('DNS fixture requires a callback')
      callback(Object.assign(new Error('External DNS forbidden by fixture'), { code: 'ENOTFOUND' }))
    })
    const values: Record<string, string> = { DSH_CLAUDE_PROXY_URL: proxyUrl, NO_PROXY: '*' }
    dispose = await installProxyFromEnvironment({ get: name => values[name] === undefined ? undefined : { value: values[name] } }, () => {})
    await run({ seen, lookups, origin: originUrl, proxy: proxyUrl, refuse: () => { refusing = true } })
  } finally {
    await dispose?.()
    dnsMock?.mockRestore()
    await Promise.all([close(proxy), close(origin)])
  }
}

it('forces protected HTTP traffic through the proxy despite NO_PROXY=* and keeps local services direct', async () => {
  await withGuard(async ({ seen, lookups, origin }) => {
    expect(await (await fetch(target)).text()).toBe('PROXIED')
    expect(await (await fetch(origin)).text()).toBe('LOCAL')
    expect(seen).toEqual([`HTTP ${target}`])
    expect(lookups).toEqual([])
  })
})

it('uses CONNECT for protected HTTPS and does not resolve the destination after the proxy refuses', async () => {
  await withGuard(async ({ seen, lookups }) => {
    await expect(fetch(secureTarget)).rejects.toThrow()
    expect(seen).toEqual(['CONNECT api.anthropic.com:443'])
    expect(lookups).toEqual([])
  })
})

it('proxy transport failure never retries the protected destination directly', async () => {
  await withGuard(async ({ seen, lookups, refuse }) => {
    refuse()
    await expect(fetch(target)).rejects.toThrow()
    expect(seen).toEqual([`HTTP ${target}`])
    expect(lookups).toEqual([])
  })
})

it('a redirect from a local direct request into a protected domain is still proxied', async () => {
  await withGuard(async ({ seen, lookups, origin }) => {
    expect(await (await fetch(`${origin}/redirect`)).text()).toBe('PROXIED')
    expect(seen).toEqual([`HTTP ${target}`])
    expect(lookups).toEqual([])
  })
})

it('route-aware callers and DSH children receive the same protected proxy', async () => {
  await withGuard(async ({ proxy }) => {
    const route = proxyRouteFor(new URL(secureTarget))
    expect(route.proxied).toBe(true)
    if (route.proxied) expect(route.proxy).toBe(proxy)
    const child = proxyEnvironmentForChild()
    expect(child.DSH_CLAUDE_PROXY_URL).toBe(proxy)
    expect(child.dsh_claude_proxy_url).toBe(proxy)
  })
})
