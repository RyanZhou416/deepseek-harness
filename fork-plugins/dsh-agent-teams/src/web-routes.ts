import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Public WebServer route surface used by the plugin. */
export interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    /**
     * Admission policy the host applies before the handler. 0.2.3-alpha.2 reads
     * it and defaults to `required`; hosts through 0.2.2 read only `kind`,
     * `path` and `handler`, so the field is ignored there.
     */
    auth?: 'required'
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Authentication gate for raw Web routes on hosts through 0.2.2.
 *
 * 0.2.3-alpha.2 removed `requestRejection` and authorizes every registered
 * route itself, which is why {@link authenticatedWebRoutes} registers
 * `auth: 'required'` and a gate without this method is treated as that host
 * generation. Its replacement, `admit(request)`, cannot stand in for the gate:
 * Cordis resolves a service method's `this.<sub-service>` read (in `admit`,
 * `this.authentication`) through the *calling* fiber's `inject` table, so
 * invoking it from this plugin's context throws instead of returning an
 * admission.
 */
export interface BrowserRequestGate {
  /** Rejecting status for one raw-route request; `undefined` admits it. */
  requestRejection?(request: IncomingMessage): number | undefined
}

export class RequestBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message)
  }
}

/** Bound memory while draining oversized requests so the route can return 413. */
export async function readJsonRequest(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onError)
      if (error) {
        chunks.length = 0
        // IncomingMessage may still receive data; discard it without buffering.
        req.once('error', () => {})
        req.resume()
        reject(error)
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    }
    const onData = (chunk: Buffer | string): void => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > maxBytes) finish(new RequestBodyError('request body is too large', 413))
      else chunks.push(part)
    }
    const onEnd = (): void => finish()
    const onAborted = (): void => finish(new RequestBodyError('request body was aborted', 400))
    const onError = (): void => finish(new RequestBodyError('invalid request body', 400))
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAborted)
    req.once('error', onError)
  })
  let value: unknown
  try {
    value = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    throw new RequestBodyError('invalid JSON', 400)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestBodyError('body must be an object', 400)
  }
  return value as Record<string, unknown>
}

function matchesEntityTagList(header: string | undefined, tag: string): boolean {
  if (header === undefined) return false
  if (header.trim() === '*') return true
  // A comma can be part of the quoted opaque tag. Consume whole list entries
  // and compare their quoted values, accepting either weak or strong spelling.
  const entry = /[ \t]*(?:(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*"))?[ \t]*(?:,|$)/y
  let matched = false
  while (entry.lastIndex < header.length) {
    const parsed = entry.exec(header)
    if (parsed === null) return false
    matched ||= parsed[1] === tag
  }
  return matched
}

/** Revalidate a current JSON representation across both identity and gzip delivery. */
export function writeJsonWithEtag(req: IncomingMessage, res: ServerResponse, body: string): void {
  const tag = `"${createHash('sha256').update(body).digest('base64url')}"`
  const headers = { 'cache-control': 'no-store', etag: `W/${tag}` }
  if ((req.method === 'GET' || req.method === 'HEAD')
    && matchesEntityTagList(req.headers['if-none-match'], tag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * Require an admitted Connection peer before a raw WebServer route runs.
 *
 * Hosts through 0.2.2 do not inherit Connection's authentication fence for raw
 * routes, so their rejecting status is applied here before the handler reads or
 * mutates team state. 0.2.3-alpha.2 authorizes the registered route itself
 * through the same fence and credential providers, so there the host's own
 * `401`/`403`/`503` answer stands and the handler only runs for an admitted
 * peer.
 */
export function authenticatedWebRoutes(
  server: WebRouteHost,
  connection: () => BrowserRequestGate | undefined,
): WebRouteHost {
  return {
    register(route) {
      return server.register({
        ...route,
        // 0.2.3-alpha.2 evaluates this policy before the handler; hosts through
        // 0.2.2 ignore the field and use the gate below instead.
        auth: 'required',
        async handler(req, res) {
          const gate = connection()
          // Missing/disposing Connection is an assembly failure, never an
          // invitation to expose workspace state or accept plan mutations.
          if (gate === undefined) {
            res.writeHead(503, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify({ error: 'authentication unavailable' }))
            return
          }
          // A gate without `requestRejection` is a 0.2.3-alpha.2 Connection,
          // whose WebServer already admitted this request.
          const rejection = gate.requestRejection?.(req)
          if (rejection !== undefined) {
            res.writeHead(rejection, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized'
              : rejection === 503 ? 'authentication unavailable' : 'forbidden' }))
            return
          }
          await route.handler(req, res)
        },
      })
    },
  }
}
