#!/usr/bin/env node
/** Exercise raw plugin routes on both declared host authentication generations. */
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { apply as installConnection } from '@deepseek-ai/dsh-client-connection'
import { authenticatedWebRoutes, readJsonRequest, RequestBodyError } from '../lib/web-routes.js'

const COOKIE = 'agent-teams-route-verification=1'
const STATE_PATH = '/plugins/dsh-agent-teams/state'
const PLAN_PATH = '/plugins/dsh-agent-teams/plan'
const paths = [STATE_PATH, PLAN_PATH]

const ctx = new Context()
const routes = new Map()
// 0.2.3-alpha.2 applies a route's `auth` policy before calling its handler;
// through 0.2.2 the raw route carries no policy and the plugin's gate owns
// admission. One switch selects the emulated generation.
let hostAuthorizes = true
let calls = 0
let base

function routeFor(pathname) {
  const exact = routes.get(pathname)
  if (exact !== undefined) return exact
  let best
  for (const route of routes.values()) {
    if (route.kind !== 'prefix') continue
    if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
    if (best === undefined || route.path.length > best.path.length) best = route
  }
  return best
}

/**
 * Emulate the installed WebServer's dispatch: match the route, apply its
 * `auth` policy through the host's own authorization waterfall, then call the
 * handler. The waterfall runs the real Connection listener, so credential
 * verification and the Host/Origin fence are the target implementations.
 */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const route = routeFor(url.pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  if (hostAuthorizes) {
    const policy = route.auth ?? 'required'
    const admission = ctx.bail('webserver/authorize', {
      headers: req.headers, method: req.method, url, transport: 'http',
    }, policy) ?? (policy === 'anonymous' ? { kind: 'allow' } : { kind: 'deny', status: 503 })
    if (admission.kind === 'deny') {
      res.writeHead(admission.status, { 'cache-control': 'no-store' })
      res.end(admission.status === 401 ? 'unauthorized' : admission.status === 503 ? 'authentication unavailable' : 'forbidden')
      return
    }
  }
  void Promise.resolve(route.handler(req, res)).catch((error) => {
    process.stderr.write(`route handler failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    if (res.headersSent) res.destroy()
    else {
      res.writeHead(500)
      res.end()
    }
  })
})

const webServer = {
  register(route) {
    assert(!routes.has(route.path), `duplicate route: ${route.path}`)
    routes.set(route.path, route)
    return () => {
      if (routes.get(route.path) === route) routes.delete(route.path)
    }
  },
}

/**
 * The plugin's raw routes as the installed Host mounts them. `connection` is
 * resolved from the plugin's own fiber, exactly as the plugin does, so the
 * Cordis inject boundary is the production one.
 */
function routePlugin(connection) {
  return {
    name: 'agent-teams-auth-test',
    apply(owner) {
      const protectedRoutes = authenticatedWebRoutes(webServer, () => connection(owner))
      for (const path of paths) {
        owner.effect(() => protectedRoutes.register({
          kind: 'exact',
          path,
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
}

/** Read one emitted header from either a Fetch Headers or a node header object. */
function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined
  const value = headers?.[name]
  return Array.isArray(value) ? value.join('; ') : value
}

/** Issue a request whose hostile Host header Fetch would rewrite. */
async function rawRequest(path, headers, method = 'GET', body) {
  return await new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers }, (incoming) => {
      const chunks = []
      incoming.on('data', (chunk) => chunks.push(chunk))
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const connections = []
try {
  ctx.provide('webServer', webServer)
  // Mount Connection the way a profile does — inside a plugin fiber — so the
  // test reproduces the inject boundary a raw-route caller actually has. A
  // root-context `apply(ctx)` would expose `connection.authentication` as a
  // root provision and hide the defect this script guards.
  const connectionFiber = ctx.plugin({
    name: 'connection-under-test',
    apply: (scope) => installConnection(scope, {}),
  })
  connections.push(connectionFiber)
  await connectionFiber.inertia
  let peer
  const authenticationFiber = ctx.plugin({
    name: 'test-authentication',
    inject: ['connection', 'connection.authentication'],
    apply(scope) {
      peer = scope.connection.createPeer({ principal: { kind: 'owner' } })
      scope['connection.authentication'].register({
        authenticate(request) {
          return headerValue(request.headers, 'cookie')?.includes(COOKIE) === true ? peer : undefined
        },
      })
    },
  })
  connections.push(authenticationFiber)
  await authenticationFiber.inertia
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`

  // 0.2.3-alpha.2: the host authorizes the registered route itself.
  const modernFiber = ctx.plugin(routePlugin((owner) => owner.get('connection')))
  await modernFiber.inertia
  for (const path of paths) {
    const response = await fetch(base + path, { method: path === PLAN_PATH ? 'POST' : 'GET' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(await response.text(), 'unauthorized')
  }
  assert.equal(calls, 0, 'unauthenticated requests must not read or mutate team state')

  for (const path of paths) {
    const response = await fetch(base + path, {
      method: path === PLAN_PATH ? 'POST' : 'GET', headers: { cookie: COOKIE, origin: base },
    })
    assert.equal(response.status, 200, 'an admitted request must reach the handler')
    assert.deepEqual(await response.json(), { ok: true })
  }
  assert.equal(calls, 2)
  // The wrapper must hand admission to the host: the field is what the
  // 0.2.3-alpha.2 WebServer evaluates before the handler.
  for (const path of paths) assert.equal(routes.get(path).auth, 'required', '0.2.3 route must delegate admission to the host')
  const unauthenticatedUpload = await fetch(base + PLAN_PATH, { method: 'POST', body: 'x'.repeat(65) })
  assert.equal(unauthenticatedUpload.status, 401, 'host admission runs before the handler parses request bodies')
  await unauthenticatedUpload.arrayBuffer()
  const oversized = await fetch(base + PLAN_PATH, {
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
    const { status } = await rawRequest(PLAN_PATH, headers, 'POST')
    assert.equal(status, 403, `reject ${Object.keys(headers).filter(key => key !== 'cookie').join(', ')}`)
  }
  assert.equal(calls, 2, 'rejected origins must not enter the mutation handler')

  // Reverse verification of the 2026-11 regression: `admit()` resolves
  // `this.authentication` through the *caller's* inject table, so a raw-route
  // plugin that does not inject the sub-service gets a Cordis TypeError rather
  // than an admission. The route above must therefore not call it.
  let admitError
  const rawCallerFiber = ctx.plugin({
    name: 'raw-route-caller',
    apply(scope) {
      try {
        scope.get('connection').admit({ headers: { host: '127.0.0.1' }, method: 'GET', url: '/' })
      } catch (error) {
        admitError = error
      }
    },
  })
  await rawCallerFiber.inertia
  await rawCallerFiber.dispose()
  assert.match(String(admitError), /connection\.authentication/,
    'admit() must stay unusable from a non-injecting raw-route context')

  await modernFiber.dispose()
  assert(paths.every(path => !routes.has(path)), 'unload removes every owned route')
  const reloaded = ctx.plugin(routePlugin((owner) => owner.get('connection')))
  await reloaded.inertia
  assert(paths.every(path => routes.has(path)), 'reload restores exactly one registration')
  await reloaded.dispose()

  // Hosts through 0.2.2: no route policy in the server, the gate decides.
  hostAuthorizes = false
  const legacyGate = {
    requestRejection(req) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return 403
      if (req.headers.origin !== undefined && req.headers.origin !== base) return 403
      if (req.headers.host !== new URL(base).host) return 403
      return headerValue(req.headers, 'cookie')?.includes(COOKIE) === true ? undefined : 401
    },
  }
  let legacyGateRef = legacyGate
  const legacyFiber = ctx.plugin(routePlugin(() => legacyGateRef))
  await legacyFiber.inertia
  for (const path of paths) assert.equal(routes.get(path).auth, 'required', 'the wrapper declares the policy for hosts that read it')
  for (const path of paths) {
    const response = await fetch(base + path, { method: path === PLAN_PATH ? 'POST' : 'GET' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
  }
  assert.equal(calls, 2, 'the legacy gate rejects before the handler runs')
  for (const headers of [
    { cookie: COOKIE, origin: 'https://untrusted.invalid' },
    { cookie: COOKIE, 'sec-fetch-site': 'cross-site' },
    { cookie: COOKIE, host: 'untrusted.invalid' },
  ]) {
    const { status, body } = await rawRequest(PLAN_PATH, headers, 'POST')
    assert.equal(status, 403)
    assert.deepEqual(JSON.parse(body), { error: 'forbidden' })
  }
  assert.equal(calls, 2, 'the legacy gate rejects untrusted origins before the handler runs')
  const legacyAuthenticated = await fetch(base + STATE_PATH, { headers: { cookie: COOKIE, origin: base } })
  assert.equal(legacyAuthenticated.status, 200)
  assert.equal(calls, 3)
  const legacyOversized = await fetch(base + PLAN_PATH, {
    method: 'POST', headers: { cookie: COOKIE, origin: base }, body: 'x'.repeat(65),
  })
  assert.equal(legacyOversized.status, 413, 'authorized oversized requests fail before mutating team state')
  await legacyOversized.arrayBuffer()
  assert.equal(calls, 3)
  legacyGateRef = { requestRejection: () => 503 }
  const verificationFailed = await fetch(base + STATE_PATH, { headers: { cookie: COOKIE } })
  assert.equal(verificationFailed.status, 503)
  assert.deepEqual(await verificationFailed.json(), { error: 'authentication unavailable' })
  assert.equal(calls, 3, 'a failed credential verification fails closed')
  legacyGateRef = undefined
  const unavailable = await fetch(base + STATE_PATH, { headers: { cookie: COOKIE } })
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'authentication unavailable' })
  assert.equal(calls, 3, 'missing Connection must fail closed')
  await legacyFiber.dispose()
  assert(paths.every(path => !routes.has(path)), 'unload removes every legacy-gated route')

  console.log('PASS Web routes: host-delegated admission, legacy gate contract, bounded bodies, disposal and reload')
} finally {
  for (const fiber of connections) await fiber.dispose()
  await ctx.fiber.dispose()
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
}
