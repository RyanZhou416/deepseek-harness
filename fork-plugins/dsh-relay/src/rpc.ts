/**
 * `/api/relay.*` Fetch routes for the settings page.
 *
 * The routes sit below the connection plugin's authenticated `/api` channel, so
 * a request has already passed its Host/Origin fence and browser-cookie check.
 * Payloads are validated here at the wire boundary; responses never contain a
 * password or the client key.
 *
 * @module dsh-relay/rpc
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RelayAccountPatch } from './account.ts'
import { asRelayError } from './errors.ts'
import type { RelayController } from './controller.ts'

/** Endpoint-name prefix shared by every route. */
export const RELAY_RPC_PREFIX = 'relay.'

/** Endpoints the settings page calls. */
export const RELAY_RPC_ENDPOINTS = ['status', 'save', 'connect', 'disconnect', 'password'] as const

/** One endpoint name. */
export type RelayRpcEndpoint = (typeof RELAY_RPC_ENDPOINTS)[number]

/** Route shape the connection plugin registers. */
export interface ConnectionFetchRouteLike {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** Structural face of the connection plugin's host handle. */
export interface HostConnectionHandleLike {
  readonly fetch: {
    register(route: ConnectionFetchRouteLike): () => Promise<void> | void
  }
}

/** One success or failure result carried to the browser. */
type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Browser request envelope. */
interface ClientRequestEnvelope {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEnvelope(body: unknown): ClientRequestEnvelope | undefined {
  if (!isRecord(body)) return undefined
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') return undefined
  return { type: 'client-request', rpcId: body.rpcId, method: body.method, payload: body.payload }
}

function serverResponse(rpcId: string, result: RpcResult): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

function badRequest(rpcId: string, message: string): Response {
  return serverResponse(rpcId, {
    ok: false,
    error: { code: 'gateway/bad-request', message, details: { issues: [] } },
  })
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  return value
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') throw new TypeError(`${field} must be a non-empty string`)
  return value
}

function readSavePayload(payload: unknown): RelayAccountPatch {
  if (!isRecord(payload)) throw new TypeError('payload must be an object')
  const password = optionalString(payload, 'password')
  const clientKey = optionalString(payload, 'clientKey')
  const autoConnect = payload.autoConnect
  if (autoConnect !== undefined && typeof autoConnect !== 'boolean') {
    throw new TypeError('autoConnect must be a boolean')
  }
  return {
    domain: requiredString(payload, 'domain'),
    username: requiredString(payload, 'username'),
    ...password === undefined ? {} : { password },
    ...clientKey === undefined ? {} : { clientKey },
    ...autoConnect === undefined ? {} : { autoConnect },
  }
}

function readPasswordPayload(payload: unknown): { currentPassword: string; newPassword: string } {
  if (!isRecord(payload)) throw new TypeError('payload must be an object')
  return {
    currentPassword: requiredString(payload, 'currentPassword'),
    newPassword: requiredString(payload, 'newPassword'),
  }
}

async function dispatch(
  controller: RelayController,
  endpoint: RelayRpcEndpoint,
  payload: unknown,
): Promise<RpcResult> {
  switch (endpoint) {
    case 'status':
      return { ok: true, value: await controller.status() }
    case 'save':
      return { ok: true, value: await controller.save(readSavePayload(payload)) }
    case 'connect':
      await controller.start()
      return { ok: true, value: await controller.status() }
    case 'disconnect':
      await controller.disconnect()
      return { ok: true, value: await controller.status() }
    case 'password': {
      const input = readPasswordPayload(payload)
      await controller.changePassword(input.currentPassword, input.newPassword)
      return { ok: true, value: { changed: true } }
    }
  }
}

function failure(rpcId: string, error: unknown, logger: Context['logger']): Response {
  if (error instanceof TypeError) {
    return serverResponse(rpcId, {
      ok: false,
      error: { code: 'bad-request', message: error.message, details: { issues: [] } },
    })
  }
  const relay = asRelayError(error)
  if (relay.code === 'internal') logger.warn(error)
  return serverResponse(rpcId, {
    ok: false,
    error: {
      code: relay.code,
      message: relay.detail ?? relay.code,
      details: {},
    },
  })
}

function routeFor(
  endpoint: RelayRpcEndpoint,
  controller: RelayController,
  logger: Context['logger'],
): ConnectionFetchRouteLike {
  const method = `${RELAY_RPC_PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) return badRequest('invalid-request', 'invalid client-request message')
      if (envelope.method !== method) {
        return badRequest(envelope.rpcId, `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`)
      }
      try {
        return serverResponse(envelope.rpcId, await dispatch(controller, endpoint, envelope.payload))
      } catch (error) {
        return failure(envelope.rpcId, error, logger)
      }
    },
  }
}

/**
 * Register every relay route once the connection service exists.
 * @param ctx - plugin context.
 * @param controller - relay connection owner.
 */
export function registerRelayRpc(ctx: Context, controller: RelayController): void {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as HostConnectionHandleLike
    for (const endpoint of RELAY_RPC_ENDPOINTS) {
      scope.effect(
        () => connection.fetch.register(routeFor(endpoint, controller, scope.logger)),
        `dsh-relay: /api/${RELAY_RPC_PREFIX}${endpoint} route`,
      )
    }
  })
}
