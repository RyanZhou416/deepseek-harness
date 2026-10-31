/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response first passes Connection's browser authentication, then the
 * webserver's index render (structured injection rows, then raw taps).
 * Non-index assets stay public. The dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 *
 * Caching follows each file's identity. The rendered index carries the
 * process's browser token and is never stored; content-hashed files under
 * `assets/` never change for their URL and are immutable for a year; every
 * other file revalidates with an ETag made from its size and modification
 * time, so a rebuilt file cannot be served stale and an unchanged one costs
 * no body.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { Stats } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

/**
 * The rendered index embeds the process token and injected rows, so it is
 * valid for exactly one response and must never enter a browser cache.
 */
const INDEX_CACHE_CONTROL = 'no-store'

/** Content-hashed build output: the URL changes whenever the bytes do. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** A file without a content hash in its URL: revalidate before every reuse. */
const REVALIDATE_CACHE_CONTROL = 'no-cache'

/**
 * Vite content-hash suffix on a build output name: `name-<8+ URL-safe
 * characters>.<extension>`, with source maps keeping their `.js.map` tail.
 * A hand-named asset such as `fonts/Montserrat-OFL.txt` has no such suffix.
 */
const CONTENT_HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[^/]+$/

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Whether a request path names content-hashed build output.
 * @param pathname - decoded URL pathname of the request.
 * @returns true for a file under `assets/` whose name carries a build hash.
 */
function isContentHashedAsset(pathname: string): boolean {
  return pathname.includes('/assets/') && CONTENT_HASHED_ASSET.test(pathname)
}

/**
 * Derive the validator of a file whose URL carries no content hash. Size and
 * modification time both move on a rebuild, so a conditional request can be
 * answered without reading the bytes.
 * @param stats - filesystem metadata of the served file.
 * @returns a strong entity tag, quoted for the `ETag` header.
 */
function entityTag(stats: Stats): string {
  return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
}

/**
 * Whether an `If-None-Match` header selects the current entity tag.
 * @param header - raw request header; absent when the client sent no validator.
 * @param etag - the current entity tag, quotes included.
 * @returns true when the client already holds the current bytes.
 */
function matchesEntityTag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === etag || value === `W/${etag}`
  })
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param ifNoneMatch - the request's conditional-request validator, if any.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  ifNoneMatch: string | undefined,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  let cacheControl: string
  let etag: string | undefined
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      body = await renderIndex()
      type = HTML_MIME
      cacheControl = INDEX_CACHE_CONTROL
    } else {
      const stats = await stat(target)
      etag = entityTag(stats)
      cacheControl = isContentHashedAsset(pathname) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL
      if (matchesEntityTag(ifNoneMatch, etag)) {
        res.writeHead(304, { 'cache-control': cacheControl, etag })
        res.end()
        return
      }
      body = await readFile(target)
      type = MIME[extname(target)] ?? 'application/octet-stream'
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': type,
    'cache-control': cacheControl,
    ...etag === undefined ? {} : { etag },
  })
  res.end(body)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Insert after all index transforms so the base precedes every resource reference.
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const ifNoneMatch = req.headers['if-none-match']
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndex,
      ifNoneMatch,
      () => ctx.connection.authorizeIndex(req, res),
      renderIndex,
    )
  }), 'frontend-static: fallback seat')
}
