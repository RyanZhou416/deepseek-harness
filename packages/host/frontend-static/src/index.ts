/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: a webserver resource serving the built frontend directory
 * with explicit index entry points. A readable index renders at the dist root
 * and configured index path; missing paths return 404, traversal outside the
 * dist root is 403, unknown extensions ship as octet-stream, and non-GET/HEAD
 * is 405. An HTTP index request first passes Connection's browser
 * authentication and renders for the browser Peer; an in-process read renders
 * for the Peer its caller admitted. Both renders go through the webserver's
 * index render (structured injection rows, then raw taps). Non-index assets
 * stay public. The dist location is workspace knowledge of the composing
 * application, so `distIndex` is typically supplied through a `!!js`
 * expression, never hardcoded by a deployment.
 *
 * Caching follows each file's identity. The rendered index carries the
 * process's browser token and is never stored; content-hashed files under
 * `assets/` never change for their URL and are immutable for a year; every
 * other file revalidates with an ETag made from its size and modification
 * time, so a rebuilt file cannot be served stale and an unchanged one costs
 * no body. A content-hashed script, stylesheet, JSON, or SVG file is sent
 * Brotli-encoded to a request that accepts `br`; each file's encoding is
 * computed once on the libuv pool and then held for the plugin's lifetime.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlibConstants } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { acceptsBrotli } from '@deepseek-ai/dsh-host-webserver'

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
  // Launchers require an image Content-Type for the install icons.
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

/** Media types whose content-hashed files are worth a cached Brotli encoding. */
const BROTLI_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.css', '.json', '.map', '.svg'])

/** Brotli quality for cached asset encodings: paid once per file, then reused by every transfer. */
const BROTLI_QUALITY = 9

const brotliCompressAsync = promisify(brotliCompress)

/**
 * Brotli encodings of content-hashed files, keyed by path and entity tag so a
 * rebuilt file is encoded again. The key set is bounded by the dist contents.
 */
class AssetEncodings {
  private readonly encodings = new Map<string, Promise<Buffer>>()

  /**
   * Encoded bytes of one file version, computed on the first call.
   * @param target - absolute file path.
   * @param etag - entity tag of the version being served.
   * @returns the Brotli encoding; a failed encoding is forgotten so the next request retries.
   */
  brotli(target: string, etag: string): Promise<Buffer> {
    const key = `${target}\0${etag}`
    let encoding = this.encodings.get(key)
    if (encoding === undefined) {
      encoding = readFile(target).then(bytes => brotliCompressAsync(bytes, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      }))
      encoding.catch(() => { this.encodings.delete(key) })
      this.encodings.set(key, encoding)
    }
    return encoding
  }
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
function matchesEntityTag(header: string | null, etag: string): boolean {
  if (header === null) return false
  return header.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === etag || value === `W/${etag}`
  })
}

/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Answer one GET or HEAD dist request; the webserver answers any other method
 * with 405 before a resource runs. A malformed percent-escape or a filesystem
 * failure other than a missing or non-file target rejects.
 * @param request - the request; only its method and URL path are read.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - answers an index request before its bytes are read:
 * the response to send instead of the index, or undefined to serve it.
 * @param renderIndex - turns the raw index.html body into the served document
 * for the dist root and configured index path.
 * @returns the dist response; a HEAD response carries the GET status and
 * headers without a body. The rendered index carries `cache-control: no-store`;
 * content-hashed files under `assets/` are immutable; every other file carries
 * `cache-control: no-cache` and an ETag from its size and modification time, and
 * a request whose `If-None-Match` selects that ETag receives an empty 304. A
 * Brotli representation carries its own ETag and `Vary: Accept-Encoding`.
 */
async function serveStatic(
  request: Request, distRoot: string, distIndex: string,
  authorizeIndex: () => Response | undefined,
  renderIndex: (html: string) => string,
  encodings: AssetEncodings,
): Promise<Response> {
  const pathname = decodeURIComponent(new URL(request.url).pathname)
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
  let body: string | Uint8Array
  let headers: Record<string, string>
  try {
    if (target === distRoot || target === distIndex) {
      const refusal = authorizeIndex()
      if (refusal !== undefined) return refusal
      body = renderIndex(await readFile(distIndex, 'utf8'))
      headers = { 'content-type': HTML_MIME, 'cache-control': INDEX_CACHE_CONTROL }
    } else {
      // The validator comes from file identity, so a conditional request is
      // answered without reading the bytes.
      const hashed = isContentHashedAsset(pathname)
      const fileTag = entityTag(await stat(target))
      const encodable = hashed && BROTLI_EXTENSIONS.has(extname(target))
      const brotli = encodable && acceptsBrotli(request.headers)
      // Each representation has its own strong validator.
      const etag = brotli ? `${fileTag.slice(0, -1)}-br"` : fileTag
      const cache: Record<string, string> = {
        'cache-control': hashed ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
        etag,
        ...encodable ? { vary: 'Accept-Encoding' } : {},
      }
      if (matchesEntityTag(request.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers: cache })
      }
      body = brotli ? await encodings.brotli(target, fileTag) : await readFile(target)
      headers = {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        ...cache,
        ...brotli ? { 'content-encoding': 'br' } : {},
      }
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the caller, which the webserver answers with 400 over HTTP.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    return new Response(null, { status: 404 })
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
}

/**
 * Claim the webserver fallback seat with a resource serving the dist.
 * @param ctx - plugin context carrying the webServer and connection services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Connection's browser authentication writes the token exchange's 303 or
  // the 401 through a writeHead/end response; capture it as a Fetch response.
  // The answer stays a 401 unless Connection writes another one.
  const authorizeIndex = (request: Request): Response | undefined => {
    let status = 401
    let headers = new Headers()
    let body: string | undefined
    const admitted = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) { body = text },
    })
    return admitted ? undefined : new Response(body, { status, headers })
  }
  const encodings = new AssetEncodings()
  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request, peer) => serveStatic(
      request,
      distRoot,
      distIndex,
      // A read with a Peer was admitted by its caller; an HTTP request carries
      // none and passes Connection's browser authentication instead.
      () => peer === undefined ? authorizeIndex(request) : undefined,
      // The browser authentication admits the owner's shared browser Peer. The
      // base goes in after all index transforms, so it precedes every resource
      // reference they insert.
      html => ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer)
        .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`),
      encodings,
    ),
  }), 'frontend-static: fallback seat')
}
