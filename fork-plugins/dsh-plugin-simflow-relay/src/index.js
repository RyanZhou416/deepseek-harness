/**
 * SimFlow relay: a loopback-only HTTP ingress through which the external
 * SimFlow tool wakes one bound DSH Session.
 *
 * Delivery uses exactly the path of the `session` tool's `send` action
 * (`Agent.send(message, 'next-step', true)`): a running target receives the
 * message at its next model step, an idle or stored target is resumed and
 * woken. The model-visible lead is SimFlow's own
 * (`SimFlow 发来「<槽位>」的消息：`) and the source kind is `simflow`, so it is
 * never stacked with the `Message from another Session (...)` lead of session send.
 *
 * Authentication: requests must come from a loopback socket and carry
 * `x-simflow-token` equal to the first line of the configured token file
 * (compared in constant time). The file is re-read on every request so the
 * token can be rotated without reloading the plugin.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'simflow-relay'

/** Host services: the WebServer for the route, Agent residency and the Session Controller for target activation. */
export const inject = ['webServer', 'agents', 'sessionController']

/** Model-visible lead; the slot name is SimFlow's own sender identity. */
export function simflowLead(slot) {
  return `SimFlow 发来「${slot}」的消息：`
}

export const Config = z.object({
  path: z.string().default('/api/simflow/relay'),
  tokenFile: z.string().required(),
  maxBodyBytes: z.number().step(1).min(1024).max(1048576).default(65536),
})

const MAX_TEXT_CHARS = 20000
const MAX_SLOT_CHARS = 120
const MIN_TOKEN_CHARS = 32
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

class RelayHttpError extends Error {
  /**
   * @param status - HTTP status.
   * @param message - human-readable detail.
   * @param reason - stable machine reason SimFlow switches on.
   */
  constructor(status, message, reason = 'bad-request') {
    super(message)
    this.status = status
    this.reason = reason
  }
}

function assertConfig(config) {
  if (!config.path.startsWith('/') || config.path === '/' || config.path.endsWith('/')
    || config.path.includes('?') || config.path.includes('#')) {
    throw new Error('simflow-relay path must be an absolute non-root pathname without a trailing slash, query, or fragment')
  }
  if (!isAbsolute(config.tokenFile)) {
    throw new Error('simflow-relay tokenFile must be an absolute path')
  }
}

function respond(response, status, body) {
  const text = JSON.stringify(body)
  // Explicit length: SimFlow's minimal HTTP client reads one plain body, never chunked framing.
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

async function readBoundedBody(request, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) throw new RelayHttpError(413, 'request body too large', 'too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function expectedToken(tokenFile) {
  let text
  try {
    text = await readFile(tokenFile, 'utf8')
  } catch {
    throw new RelayHttpError(503, 'relay token file is unavailable', 'token-unavailable')
  }
  const token = (text.split(/\r?\n/u)[0] ?? '').trim()
  if (token.length < MIN_TOKEN_CHARS) throw new RelayHttpError(503, 'relay token is too short', 'token-unavailable')
  return token
}

function sameToken(presented, expected) {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function requiredText(record, field, max) {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') throw new RelayHttpError(400, `${field} must be a non-empty string`)
  if (value.length > max) throw new RelayHttpError(400, `${field} exceeds ${max} characters`)
  return value
}

function optionalText(record, field, max) {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > max) throw new RelayHttpError(400, `${field} must be a string of at most ${max} characters`)
  return value
}

/** Parse and validate one relay request body. */
export function parseRelayRequest(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new RelayHttpError(400, 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayHttpError(400, 'request body must be a JSON object')
  }
  const sessionId = requiredText(parsed, 'sessionId', 200)
  if (!/^[A-Za-z0-9._:-]+$/u.test(sessionId)) throw new RelayHttpError(400, 'sessionId has invalid characters')
  return {
    sessionId,
    slot: requiredText(parsed, 'slot', MAX_SLOT_CHARS),
    text: requiredText(parsed, 'text', MAX_TEXT_CHARS),
    mailId: optionalText(parsed, 'mailId', 64),
    mailKind: optionalText(parsed, 'kind', 32),
  }
}

/** Build the SimFlow-attributed message; never carries the session-send lead. */
export function createSimflowMessage(request) {
  return createUserMessage({
    content: [
      { type: 'text', text: simflowLead(request.slot) },
      { type: 'text', text: request.text },
    ],
    source: {
      kind: 'simflow',
      slot: request.slot,
      ...(request.mailId === undefined ? {} : { mailId: request.mailId }),
      ...(request.mailKind === undefined ? {} : { mailKind: request.mailKind }),
      // Same context form as session send: a message addressed to this agent.
      form: 'relay',
    },
  })
}

/**
 * Whether the Workspace registry reports the Session as archived. An archived
 * Session still resolves and accepts `send`, but the controller's
 * archived-session gate rejects every model step, so the message would sit
 * unread while the sender saw success. The relay refuses it by name instead.
 */
export function isArchived(ctx, sessionId) {
  const ids = ctx.get?.('workspaceRegistry')?.archivedSessionIds ?? ctx.workspaceRegistry?.archivedSessionIds ?? []
  return ids.includes(sessionId)
}

/** Map a Session Controller failure to a named HTTP refusal. */
function resolveFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const text = String(error?.message ?? error)
  if (code === 'session/not-found') return new RelayHttpError(404, `target session not found: ${text}`, 'not-found')
  if (code.includes('subagent')) return new RelayHttpError(409, `target session is owned by a subagent runtime: ${text}`, 'subagent-owned')
  return new RelayHttpError(503, `target session unavailable: ${text}`, 'unavailable')
}

/** Resolve a live Agent, otherwise resume the persisted Session (same as session send). */
async function resolveTarget(ctx, sessionId) {
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return { agent: live, before: live.status === 'running' ? 'working' : 'idle' }
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolveFailure(resolved.error)
  return { agent: resolved.agent, before: 'stored' }
}

/** Recently delivered (sessionId, mailId) pairs, so a SimFlow retry never wakes a Session twice. */
const DEDUPE_LIMIT = 2048
const delivered = new Map()

function rememberDelivery(key, messageId) {
  delivered.set(key, messageId)
  if (delivered.size > DEDUPE_LIMIT) delivered.delete(delivered.keys().next().value)
}

export function createRelayHandler(ctx, config) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new RelayHttpError(405, 'method not allowed', 'method')
      }
      const remote = request.socket?.remoteAddress ?? ''
      if (!LOOPBACK.has(remote)) throw new RelayHttpError(403, 'loopback only', 'forbidden')
      const presented = request.headers['x-simflow-token']
      if (typeof presented !== 'string' || presented === '') throw new RelayHttpError(401, 'missing x-simflow-token', 'unauthorized')
      const expected = await expectedToken(config.tokenFile)
      if (!sameToken(presented, expected)) throw new RelayHttpError(401, 'invalid x-simflow-token', 'unauthorized')
      const relay = parseRelayRequest(await readBoundedBody(request, config.maxBodyBytes))
      // Checked before resolving: resuming an archived Session would only park the message behind the gate.
      if (isArchived(ctx, relay.sessionId)) throw new RelayHttpError(410, 'target session is archived', 'archived')
      const dedupeKey = relay.mailId === undefined ? undefined : `${relay.sessionId}\0${relay.mailId}`
      if (dedupeKey !== undefined && delivered.has(dedupeKey)) {
        respond(response, 200, { ok: true, duplicate: true, messageId: delivered.get(dedupeKey), targetSessionId: relay.sessionId })
        return
      }
      const { agent: target, before } = await resolveTarget(ctx, relay.sessionId)
      if (ctx.agents.get(relay.sessionId) !== target) throw new RelayHttpError(409, 'target session stopped before delivery', 'stopped')
      if (isArchived(ctx, relay.sessionId)) throw new RelayHttpError(410, 'target session is archived', 'archived')
      const message = createSimflowMessage(relay)
      target.send(message, 'next-step', true)
      if (dedupeKey !== undefined) rememberDelivery(dedupeKey, message.id)
      respond(response, 202, { ok: true, messageId: message.id, targetSessionId: relay.sessionId, targetStatus: before })
    } catch (error) {
      if (error instanceof RelayHttpError) {
        respond(response, error.status, { ok: false, reason: error.reason, error: error.message })
        return
      }
      ctx.logger.warn(`simflow-relay: delivery failed: ${String(error?.message ?? error)}`)
      respond(response, 503, { ok: false, error: 'relay delivery unavailable' })
    }
  }
}

/**
 * Read-only status of Sessions, for SimFlow's slot↔Session binding check.
 * Never resumes, wakes, or writes anything.
 * @returns `archived` | `working` | `idle` | `stored` (attached to a Workspace, not live) | `not-found`.
 */
export function sessionStatus(ctx, sessionId) {
  if (isArchived(ctx, sessionId)) return 'archived'
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live.status === 'running' ? 'working' : 'idle'
  const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
  for (const workspace of registry?.list?.() ?? []) {
    if ((workspace.sessionIds ?? []).includes(sessionId)) return 'stored'
  }
  return 'not-found'
}

const MAX_STATUS_IDS = 500

export function createStatusHandler(ctx, config) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new RelayHttpError(405, 'method not allowed', 'method')
      }
      const remote = request.socket?.remoteAddress ?? ''
      if (!LOOPBACK.has(remote)) throw new RelayHttpError(403, 'loopback only', 'forbidden')
      const presented = request.headers['x-simflow-token']
      if (typeof presented !== 'string' || presented === '') throw new RelayHttpError(401, 'missing x-simflow-token', 'unauthorized')
      if (!sameToken(presented, await expectedToken(config.tokenFile))) throw new RelayHttpError(401, 'invalid x-simflow-token', 'unauthorized')
      let parsed
      try { parsed = JSON.parse(await readBoundedBody(request, config.maxBodyBytes)) } catch (error) {
        if (error instanceof RelayHttpError) throw error
        throw new RelayHttpError(400, 'request body is not valid JSON')
      }
      const ids = parsed?.sessionIds
      if (!Array.isArray(ids) || ids.length > MAX_STATUS_IDS || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._:-]+$/u.test(id))) {
        throw new RelayHttpError(400, `sessionIds must be an array of at most ${MAX_STATUS_IDS} session ids`)
      }
      const statuses = Object.fromEntries(ids.map(id => [id, sessionStatus(ctx, id)]))
      respond(response, 200, { ok: true, statuses })
    } catch (error) {
      if (error instanceof RelayHttpError) {
        respond(response, error.status, { ok: false, reason: error.reason, error: error.message })
        return
      }
      ctx.logger.warn(`simflow-relay: status failed: ${String(error?.message ?? error)}`)
      respond(response, 503, { ok: false, reason: 'unavailable', error: 'status unavailable' })
    }
  }
}

/** Register the exact relay route and its read-only `<path>/status` sibling on the injected WebServer. */
export function apply(ctx, config) {
  assertConfig(config)
  // A registered Web route defaults to `auth: 'required'`, which asks the Host's
  // credential providers for a browser session or API credential. SimFlow carries
  // neither: the loopback check and the per-request token below are this route's
  // authentication, so the carrier must admit it anonymously.
  const auth = 'anonymous'
  const route = { kind: 'exact', path: config.path, auth, handler: createRelayHandler(ctx, config) }
  ctx.effect(() => ctx.webServer.register(route), `simflow-relay: ${config.path}`)
  const status = { kind: 'exact', path: `${config.path}/status`, auth, handler: createStatusHandler(ctx, config) }
  ctx.effect(() => ctx.webServer.register(status), `simflow-relay: ${config.path}/status`)
}
