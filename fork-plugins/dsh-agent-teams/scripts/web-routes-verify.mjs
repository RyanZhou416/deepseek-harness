#!/usr/bin/env node
/** Exercise raw plugin routes through the installed host's admission service. */
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { apply as installConnection } from '@deepseek-ai/dsh-client-connection'
import { authenticatedWebRoutes, readJsonRequest, RequestBodyError } from '../lib/web-routes.js'

const ctx = new Context()
const routes = new Map()
const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url, 'http://x').pathname)
  if (!route) { res.writeHead(404); res.end(); return }
  Promise.resolve(route.handler(req, res)).catch(() => {
    res.writeHead(500); res.end()
  })
})
const webServer = {
  register(route) {
    assert(!routes.has(route.path), `duplicate route: ${route.path}`)
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}
// Only persistence is replaced: actual Host/Origin validation, credential
// verification, and HTTP requests all use the target implementation.
let credentialRecord
ctx.provide('credentials', {
  async modifyRecord(_key, update) {
    credentialRecord = await update(credentialRecord) ?? credentialRecord
    return credentialRecord
  },
})
ctx.provide('webServer', webServer)
let gate
let calls = 0
const paths = ['/plugins/dsh-agent-teams/state', '/plugins/dsh-agent-teams/plan']
const routePlugin = {
  name: 'agent-teams-auth-test',
  apply(owner) {
    const protectedRoutes = authenticatedWebRoutes(webServer, () => gate)
    for (const path of paths) {
      owner.effect(() => protectedRoutes.register({
        kind: 'exact', path,
        async handler(req, res) {
          if (req.method === 'POST') {
            try {
              await readJsonRequest(req, 64)
            } catch (error) {
              res.writeHead(error instanceof RequestBodyError ? error.status : 500)
              res.end()
              return
            }
          }
          calls += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        },
      }))
    }
  },
}

/** Read one emitted header from either a Fetch Headers or a node header object. */
function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined
  const value = headers?.[name]
  return Array.isArray(value) ? value.join('; ') : value
}

try {
  await installConnection(ctx, {})
  gate = ctx.connection
  // Host 0.2.3-alpha.2 moved launch-token exchange and cookie signing into
  // `@deepseek-ai/dsh-host-authentication-token`, which registers itself as an
  // authentication provider. This script owns the plugin's raw-route gate, not
  // credential issuance, so a verifier for the test cookie stands in for it.
  const COOKIE = 'agent-teams-route-verification=1'
  const peer = gate.createPeer({ principal: { kind: 'owner' } })
  ctx.connection.authentication.register({
    authenticate(request) {
      return headerValue(request.headers, 'cookie')?.includes(COOKIE) === true ? peer : undefined
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const fiber = ctx.plugin(routePlugin)
  await fiber.inertia
  for (const path of paths) {
    const response = await fetch(base + path, { method: path.endsWith('/plan') ? 'POST' : 'GET' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
  }
  assert.equal(calls, 0, 'unauthenticated requests must not read or mutate team state')

  for (const path of paths) {
    const response = await fetch(base + path, {
      method: path.endsWith('/plan') ? 'POST' : 'GET', headers: { cookie: COOKIE, origin: base },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  }
  assert.equal(calls, 2)
  const unauthenticatedUpload = await fetch(base + paths[1], { method: 'POST', body: 'x'.repeat(65) })
  assert.equal(unauthenticatedUpload.status, 401, 'authentication runs before parsing request bodies')
  await unauthenticatedUpload.arrayBuffer()
  const oversized = await fetch(base + paths[1], {
    method: 'POST', headers: { cookie: COOKIE, origin: base }, body: 'x'.repeat(65),
  })
  assert.equal(oversized.status, 413, 'authorized oversized requests fail before mutating team state')
  await oversized.arrayBuffer()
  assert.equal(calls, 2)
  for (const headers of [
    { cookie: COOKIE, origin: 'https://untrusted.invalid' },
    { cookie: COOKIE, 'sec-fetch-site': 'cross-site' },
    { cookie: COOKIE, host: 'untrusted.invalid' },
  ]) {
    // node:http preserves an explicitly hostile Host; Fetch may replace it.
    const status = await new Promise((resolve, reject) => {
      const req = request(base + paths[1], { method: 'POST', headers }, response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403, `reject ${Object.keys(headers).filter(key => key !== 'cookie').join(', ')}`)
  }
  assert.equal(calls, 2, 'rejected origins must not enter the mutation handler')

  gate = undefined
  const unavailable = await fetch(base + paths[0], { headers: { cookie: COOKIE } })
  assert.equal(unavailable.status, 503)
  await unavailable.arrayBuffer()
  assert.equal(calls, 2, 'missing Connection must fail closed')

  await fiber.dispose()
  assert(paths.every(path => !routes.has(path)), 'unload removes every owned route')
  gate = ctx.connection
  const reloaded = ctx.plugin(routePlugin)
  await reloaded.inertia
  assert(paths.every(path => routes.has(path)), 'reload restores exactly one registration')
  await reloaded.dispose()
  console.log('PASS Web routes: host admission, bounded bodies, trusted origins, fail-closed startup, disposal and reload')
} finally {
  await ctx.fiber.dispose()
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}
