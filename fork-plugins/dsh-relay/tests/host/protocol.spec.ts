import { describe, expect, it } from 'vitest'
import { RelayError, RELAY_ERROR_CODES } from '../../src/errors.ts'
import { RelayProtocolClient, relayApiBaseUrl } from '../../src/protocol.ts'
import { startHttpServer } from './helpers/test-server.ts'

const KEY = 'dshk_' + 'A'.repeat(43)

const TUNNEL = {
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

const SUCCESS = {
  ok: true,
  username: 'ryan',
  created: false,
  url: 'https://ryan.relay.example.com/',
  tunnel: TUNNEL,
}

async function call(
  handler: Parameters<typeof startHttpServer>[0],
  options: { timeoutMs?: number } = {},
): Promise<{ result?: unknown; error?: RelayError; request?: { url?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown } }> {
  const server = await startHttpServer(handler)
  const request: { url?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown } = {}
  try {
    const client = new RelayProtocolClient({
      baseUrl: `http://127.0.0.1:${String(server.port)}/__dsh/api/v1`,
      clientKey: KEY,
      timeoutMs: options.timeoutMs ?? 2_000,
    })
    try {
      const result = await client.connect({
        username: 'ryan',
        password: 'at least ten characters',
        authority: '127.0.0.1:3080',
        cookie: 'dsh-auth-x=v1.body.sig',
      })
      return { result, request }
    } catch (error) {
      if (error instanceof RelayError) return { error, request }
      throw error
    }
  } finally {
    void request
    await server.close()
  }
}

const capture = (request: { url?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown }) =>
  (incoming: import('node:http').IncomingMessage, _response: import('node:http').ServerResponse, body: string): void => {
    request.url = incoming.url ?? ''
    request.headers = incoming.headers
    request.body = JSON.parse(body) as unknown
  }

describe('relay protocol client', () => {
  it('posts the documented connect body and parses the tunnel', async () => {
    const request: { url?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown } = {}
    const server = await startHttpServer((incoming, response, body) => {
      capture(request)(incoming, response, body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(SUCCESS))
    })
    try {
      const client = new RelayProtocolClient({
        baseUrl: `http://127.0.0.1:${String(server.port)}/__dsh/api/v1`,
        clientKey: KEY,
        timeoutMs: 2_000,
      })
      const result = await client.connect({
        username: 'ryan',
        password: 'at least ten characters',
        authority: '127.0.0.1:3080',
        cookie: 'dsh-auth-x=v1.body.sig',
      })
      expect(result.username).toBe('ryan')
      expect(result.created).toBe(false)
      expect(result.url).toBe('https://ryan.relay.example.com/')
      expect(result.tunnel).toEqual(TUNNEL)
      expect(request.url).toBe('/__dsh/api/v1/connect')
      expect(request.headers?.authorization).toBe(`Bearer ${KEY}`)
      expect(request.headers?.['content-type']).toBe('application/json')
      expect(request.body).toEqual({
        username: 'ryan',
        password: 'at least ten characters',
        dsh: { authority: '127.0.0.1:3080', cookie: 'dsh-auth-x=v1.body.sig' },
      })
    } finally {
      await server.close()
    }
  })

  it('maps every protocol error code to a typed failure', async () => {
    const codes = [
      'client-key-invalid', 'client-key-mismatch', 'credentials-invalid', 'username-invalid',
      'password-too-short', 'password-unchanged', 'dsh-invalid', 'port-pool-exhausted',
      'bad-request', 'internal',
    ] as const
    for (const code of codes) {
      const outcome = await call((_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, code, message: 'refused' }))
      })
      expect(outcome.error?.code).toBe(code)
      expect(RELAY_ERROR_CODES).toContain(code)
    }
  })

  it('carries the relay-reported minimum password length and ignores a malformed one', async () => {
    const reported = await call((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, code: 'password-too-short', message: 'too short', minPassword: 10 }))
    })
    expect(reported.error?.code).toBe('password-too-short')
    expect(reported.error?.minPassword).toBe(10)
    for (const minPassword of [0, -1, 1.5, '10', null]) {
      const malformed = await call((_request, response) => {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, code: 'password-too-short', message: 'x', minPassword }))
      })
      expect(malformed.error?.code).toBe('password-too-short')
      expect(malformed.error?.minPassword).toBeUndefined()
    }
  })
  it('rejects an unknown error code and a non-JSON response', async () => {
    const unknown = await call((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, code: 'who-knows', message: 'x' }))
    })
    expect(unknown.error?.code).toBe('network-invalid-response')
    const text = await call((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('not json')
    })
    expect(text.error?.code).toBe('network-invalid-response')
  })

  it('times out and reports an unreachable server', async () => {
    const timeout = await call((_request, response) => {
      setTimeout(() => { response.end(JSON.stringify(SUCCESS)) }, 300)
    }, { timeoutMs: 30 })
    expect(timeout.error?.code).toBe('network-timeout')

    const server = await startHttpServer((_request, response) => { response.end('{}') })
    const port = server.port
    await server.close()
    const client = new RelayProtocolClient({
      baseUrl: `http://127.0.0.1:${String(port)}/__dsh/api/v1`,
      clientKey: KEY,
      timeoutMs: 1_000,
    })
    await expect(client.connect({
      username: 'ryan', password: 'x', authority: '127.0.0.1:3080', cookie: 'a=b',
    })).rejects.toMatchObject({ code: 'network-unreachable' })
  })

  it('refuses a malformed tunnel and a non-https user address', async () => {
    const malformed = await call((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...SUCCESS, tunnel: { ...TUNNEL, remotePort: 0 } }))
    })
    expect(malformed.error?.code).toBe('network-invalid-response')

    const insecure = await call((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...SUCCESS, url: 'http://ryan.relay.example.com/' }))
    })
    expect(insecure.error?.code).toBe('network-invalid-response')
  })

  it('refuses a request body above the relay limit before sending it', async () => {
    const server = await startHttpServer((_request, response) => { response.end('{}') })
    try {
      const client = new RelayProtocolClient({
        baseUrl: `http://127.0.0.1:${String(server.port)}/__dsh/api/v1`,
        clientKey: KEY,
        timeoutMs: 2_000,
      })
      await expect(client.connect({
        username: 'ryan', password: 'x'.repeat(20_000), authority: '127.0.0.1:3080', cookie: 'a=b',
      })).rejects.toMatchObject({ code: 'bad-request' })
    } finally {
      await server.close()
    }
  })

  it('changes the password over the same channel', async () => {
    const requests: unknown[] = []
    const server = await startHttpServer((incoming, response, body) => {
      requests.push({ url: incoming.url, body: JSON.parse(body) as unknown })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
    try {
      const client = new RelayProtocolClient({
        baseUrl: `http://127.0.0.1:${String(server.port)}/__dsh/api/v1`,
        clientKey: KEY,
        timeoutMs: 2_000,
      })
      await client.changePassword({ username: 'ryan', password: 'old', newPassword: 'new password' })
      expect(requests).toEqual([{
        url: '/__dsh/api/v1/password',
        body: { username: 'ryan', password: 'old', newPassword: 'new password' },
      }])
    } finally {
      await server.close()
    }
  })

  it('builds the https API base from the domain', () => {
    expect(relayApiBaseUrl('relay.example.com')).toBe('https://relay.example.com/__dsh/api/v1')
  })
})
