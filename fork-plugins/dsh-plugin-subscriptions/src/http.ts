/**
 * Proxy routing for every outbound subscription request. When a proxy is
 * configured, {@link proxiedFetch} attaches an undici {@link ProxyAgent} as the
 * fetch `dispatcher`, so token exchanges, model-API streams, usage lookups,
 * model discovery, and the `web_search` / `x_search` / `image_generate` / `video_generate`
 * tools all leave through the proxy without touching their call sites.
 *
 * The config lives at `~/.dsh/plugins/subscriptions/proxy.json` (mode 0600,
 * it may carry a password), sibling to the auth store. The `proxyGet` /
 * `proxySet` / `proxyTest` RPC endpoints drive it from the web Settings page;
 * a saved config applies immediately to subsequent requests.
 *
 * The OAuth authorize step opens in the user's browser, which uses the
 * browser/system proxy and is outside this module's reach.
 */
import { Agent, Dispatcher, ProxyAgent, fetch as undiciFetch, getGlobalDispatcher } from 'undici'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { hostClaudeRoute, hostProxyForScheme, isClaudeEgressDestination, describeHostClaudeRoute } from './transport/host-egress.js'

/**
 * undici's own fetch, typed to the DOM fetch signature: its bundled types are
 * stricter (Request requires `duplex`, `RequestInit.body` is non-null) and
 * incompatible with the DOM shapes the provider code passes. The runtime
 * object is the same Web-fetch implementation Node uses.
 */
const dispatchFetch = undiciFetch as unknown as typeof fetch

/** Stored proxy configuration (the proxy.json shape). */
interface ProxyConfig {
  /** Whether outbound subscription requests route through {@link url}. */
  enabled: boolean
  /** Proxy origin: `http://host:port` or `https://host:port`. */
  url: string
  /** Optional proxy user for basic auth. */
  username?: string
  /** Optional proxy password for basic auth; never sent back to the client. */
  password?: string
  /** Hostnames (exact, suffix, or `*.example.com`) that use host routing instead. */
  bypass: string[]
}

/** The proxy config as served to the client: secrets replaced by a flag. */
export interface ProxyConfigView {
  enabled: boolean
  url: string
  username?: string
  /** Whether a password is stored (the password itself never leaves the host). */
  passwordSet: boolean
  bypass: string[]
  /** Last load/apply failure, when the stored config is unusable. */
  error?: string
}

/** One `proxySet` payload. */
export interface ProxyInput {
  enabled: boolean
  url: string
  username?: string
  /** `undefined` keeps the stored password, `null`/`''` clears it. */
  password?: string | null
  bypass?: string[]
}

/** One `proxyTest` result. */
export interface ProxyTestResult {
  /** Whether the destination answered with an HTTP status. */
  ok: boolean
  /** Whether the plugin proxy was used; false means host routing, not necessarily direct. */
  viaProxy: boolean
  /** Status of the answered request, when one was received. */
  status?: number
  /** Round-trip latency in milliseconds. */
  latencyMs?: number
  /** Failure message, when no response was received. */
  error?: string
}

/** A draft proxy for one test probe (never persisted). */
export interface ProxyDraft {
  url: string
  username?: string
  password?: string
}

/** Destination the `proxyTest` endpoint probes when none is given. */
const DEFAULT_PROXY_TEST_URL = 'https://api.x.ai/v1/models'
/** Probe deadline; a hung proxy must not pin the Settings dialog forever. */
const DEFAULT_PROXY_TEST_TIMEOUT_MS = 15_000

/**
 * Destinations the `proxyTest` probe accepts: the API hosts this plugin's own traffic
 * uses. The probe answers whether the operator's proxy carries that traffic, and its
 * target arrives from the web client, so a target outside this set would make the
 * endpoint a request proxy for whatever this host can reach. Matching covers the exact
 * host and its subdomains, and ignores case and a terminal DNS root dot.
 */
const PROBE_DESTINATIONS: readonly string[] = [
  'api.x.ai', // Grok chat, models, images, videos
  'auth.x.ai', // Grok OIDC discovery
  'cli-chat-proxy.grok.com', // Grok CLI catalog and billing
  'api.anthropic.com', // Claude Messages, usage, profile, files, bootstrap
  'platform.claude.com', // Claude OAuth token and manual callback
  'claude.com', // Claude OAuth authorize
  'chatgpt.com', // Codex responses, models, usage, search
  'auth.openai.com', // Codex OAuth
  'api.github.com', // Copilot token exchange and user lookup
  'github.com', // Copilot device flow
  'api.githubcopilot.com', // Copilot chat, models, responses
  'cloudcode-pa.googleapis.com', // Antigravity production API
  'daily-cloudcode-pa.googleapis.com', // Antigravity default API
  'oauth2.googleapis.com', // Antigravity token endpoint
  'www.googleapis.com', // Antigravity userinfo
  'accounts.google.com', // Antigravity authorize page
  'api2.cursor.sh', // Cursor chat
  'cursor.com', // Cursor session and usage
  'registry.npmjs.org', // Codex client-version lookup
  'update.code.visualstudio.com', // Copilot VS Code version lookup
]

/**
 * Whether the proxy probe may reach a destination.
 * @param hostname - The probe target's hostname.
 * @returns true when the hostname is one of {@link PROBE_DESTINATIONS}.
 */
function isProbeDestination(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/u, '')
  return PROBE_DESTINATIONS.some(entry => host === entry || host.endsWith(`.${entry}`))
}

/**
 * Minimum per-address connect attempt budget for Node's Happy Eyeballs
 * (`net.autoSelectFamilyAttemptTimeout`). Node's default is 250ms, which is
 * shorter than one TCP handshake to Cloudflare-fronted hosts (registry.npmjs.org,
 * chatgpt.com) on a high-latency link: every address then fails with
 * ETIMEDOUT and the whole fetch dies even though curl succeeds.
 */
export const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 1500


/** Disabled configuration: the module state before the first load. */
const DISABLED: ProxyConfig = { enabled: false, url: '', bypass: [] }

/** Current config; updated by every load/apply/save. */
let current: ProxyConfig = DISABLED
/** The live dispatcher, or undefined when proxies are off/errored. */
let agent: Dispatcher | undefined
/** Last load/apply failure, surfaced by the config view. */
let configError: string | undefined
/** One lazy load of the on-disk config (module-import cheap; file read once). */
let ready: Promise<ProxyConfig> | undefined

/** Absolute path of the proxy config file. */
function proxyFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'proxy.json')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Flatten a fetch failure into a readable message: undici wraps the true
 * cause (`connect ECONNREFUSED ...`) behind a bare "fetch failed", so walk
 * the cause chain and append each distinct layer (up to four, cycle-safe).
 * A hostname resolving to several addresses (e.g. `localhost` → ::1 and
 * 127.0.0.1) fails as an `AggregateError` with an empty message, so its
 * per-address `errors` entries are folded in too.
 */
function describeFetchError(error: unknown): string {
  const parts: string[] = []
  let node: unknown = error
  for (let depth = 0; depth < 4 && node !== undefined && node !== null; depth += 1) {
    const layer = node as { errors?: unknown[]; code?: unknown; cause?: unknown; message?: unknown }
    if (Array.isArray(layer.errors)) {
      for (const child of layer.errors) {
        const childText = child instanceof Error && child.message !== '' ? child.message : String(child)
        if (childText !== '' && !parts.includes(childText)) parts.push(childText)
      }
    }
    let text = layer instanceof Error ? layer.message : String(node)
    const code = layer.code
    if (typeof code === 'string' && code !== '') {
      if (text === '') text = code
      else if (!text.includes(code)) text = `${text} (${code})`
    }
    if (text !== '' && !parts.includes(text)) parts.push(text)
    const next = layer.cause
    if (next === undefined || next === null || next === node) break
    node = next
  }
  return parts.join(' → ')
}

function withError(error: unknown): void {
  configError = errorMessage(error)
}

/**
 * Parse and validate a proxy URL. Only HTTP(S) proxies are supported because
 * the undici dispatcher speaks CONNECT over HTTP; socks5 is not supported.
 * @param raw - the URL the user configured.
 * @returns the parsed URL (credentials attached by the caller).
 */
function parseProxyUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`proxy URL "${raw}" is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`proxy URL must use the http:// or https:// scheme (got "${raw}")`)
  }
  if (url.hostname === '') throw new Error('proxy URL must include a host')
  return url
}

/**
 * Whether a request hostname bypasses the proxy.
 * @param hostname - the request's hostname.
 * @param entries - configured bypass entries: exact host, plain suffix
 *   (`example.com` also matches `api.example.com`), or `*.example.com`.
 */
function matchesBypass(hostname: string, entries: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  for (const raw of entries) {
    let entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry.includes('://')) {
      try {
        entry = new URL(entry).hostname
      } catch {
        continue
      }
    }
    entry = entry.replace(/:\d+$/, '')
    if (entry === '' || entry === '*') continue
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(1))) return true
    } else if (host === entry || host.endsWith(`.${entry}`)) {
      return true
    }
  }
  return false
}

/** Validate and normalize one config (throws with a user-facing message). */
function normalizeConfig(input: ProxyInput): ProxyConfig {
  const url = input.url.trim()
  if (input.enabled && url === '') {
    throw new Error('a proxy URL is required when the proxy is enabled')
  }
  if (url !== '') parseProxyUrl(url)
  const bypass = Array.from(new Set((input.bypass ?? [])
    .map(entry => entry.trim())
    .filter(entry => entry !== '')))
  return {
    enabled: input.enabled,
    url,
    ...input.username !== undefined && input.username !== '' ? { username: input.username.trim() } : {},
    ...input.password !== undefined && input.password !== '' && input.password !== null ? { password: input.password } : {},
    bypass,
  }
}

/** Build the undici agent for a config (throws on an unusable URL). */
/**
 * The connect options every request through this module carries.
 *
 * They live on the plugin's own agents rather than on the process: raising a
 * Node default changes dialing for the host and for every other provider, and no
 * per-caller restoration stays correct while another holder can be live.
 */
const CONNECT_OPTIONS = { autoSelectFamilyAttemptTimeout: MIN_CONNECT_ATTEMPT_TIMEOUT_MS } as const

/**
 * The dispatcher the process had before this module ran.
 *
 * A host that installs its own dispatcher is routing or gating egress, and it must keep
 * winning: the plugin passes its own only while nothing else has claimed the process.
 */
const INITIAL_DISPATCHER = getGlobalDispatcher()

/** The agent for direct requests: no proxy, but this module's connect budget. */
const DIRECT_AGENT = new Agent({ connect: CONNECT_OPTIONS })

function buildAgent(cfg: ProxyConfig): Dispatcher {
  if (!cfg.enabled || cfg.url === '') return DIRECT_AGENT
  const url = parseProxyUrl(cfg.url)
  if (cfg.username !== undefined) url.username = cfg.username
  if (cfg.password !== undefined) url.password = cfg.password
  return new ProxyAgent({ uri: url.toString(), connect: CONNECT_OPTIONS })
}

/** Swap in a config and its agent; a failed agent falls back to host routing. */
async function applyConfig(cfg: ProxyConfig | undefined): Promise<void> {
  let next: Dispatcher = DIRECT_AGENT
  if (cfg !== undefined) {
    configError = undefined
    try {
      next = buildAgent(cfg)
    } catch (error) {
      withError(error)
      next = DIRECT_AGENT
    }
    current = cfg
  }
  const previous = agent
  agent = next
  // The direct agent is shared and outlives every config swap it serves.
  if (previous !== undefined && previous !== DIRECT_AGENT) void previous.close().catch(() => undefined)
}

/** Read the on-disk config. A missing file is the disabled default. */
async function loadConfigFile(path: string): Promise<ProxyConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DISABLED, bypass: [] }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions proxy config at ${path} is not valid JSON; fix or delete the file`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('subscriptions proxy config must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const enabled = record.enabled === true
  const url = typeof record.url === 'string' ? record.url : ''
  const username = typeof record.username === 'string' ? record.username : undefined
  const password = typeof record.password === 'string' ? record.password : undefined
  const bypass = Array.isArray(record.bypass)
    ? record.bypass.filter((entry): entry is string => typeof entry === 'string')
    : []
  return normalizeConfig({
    enabled,
    url,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    bypass,
  })
}

/** Resolve the module state once from disk; failures disable the proxy. */
async function ensureReady(): Promise<ProxyConfig> {
  ready ??= loadConfigFile(proxyFilePath()).then(async (cfg) => {
    await applyConfig(cfg)
    return current
  }, async (error) => {
    withError(error)
    await applyConfig(undefined)
    return current
  })
  return ready
}

/** Persist a config atomically with owner-only permissions, then apply it. */
async function persistConfig(cfg: ProxyConfig, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Close the live agent and drop the cached config. Test-only: lets a suite
 *  unwind the agent's keep-alive sockets before the process exits.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export async function resetProxyForTests(): Promise<void> {
  const previous = agent
  agent = undefined
  current = { ...DISABLED, bypass: [] }
  ready = undefined
  configError = undefined
  if (previous !== undefined) await previous.close().catch(() => undefined)
}

/**
 * Current proxy config as served to the client (secrets omitted).
 * @returns the view; {@link ProxyConfigView.error} carries the last
 *   load/apply failure when the stored config is unusable.
 */
export async function proxyGetConfig(): Promise<ProxyConfigView> {
  await ensureReady()
  return {
    enabled: current.enabled,
    url: current.url,
    ...current.username === undefined ? {} : { username: current.username },
    passwordSet: current.password !== undefined && current.password !== '',
    bypass: [...current.bypass],
    ...configError === undefined ? {} : { error: configError },
  }
}

/**
 * Validate, persist, and apply one proxy config. A `password` of `undefined`
 * keeps the stored value; `null` or `''` clears it.
 * @param input - the client's payload.
 * @returns the resulting view (secrets omitted).
 */
export async function proxySetConfig(input: ProxyInput): Promise<ProxyConfigView> {
  await ensureReady()
  const password = input.password === undefined
    ? current.password
    : input.password === null || input.password === ''
      ? undefined
      : input.password
  const next = normalizeConfig({
    enabled: input.enabled,
    url: input.url,
    ...input.username === undefined ? {} : { username: input.username },
    ...password === undefined ? {} : { password },
    bypass: input.bypass ?? current.bypass,
  })
  await persistConfig(next, proxyFilePath())
  await applyConfig(next)
  return proxyGetConfig()
}

/**
 * The fetch caller all subscription code uses: routes through the configured
 * proxy unless the host bypasses it. Identity-passthrough otherwise: the host
 * may itself route global fetch through an environment-configured proxy.
 *
 * A host-mandated Claude route outranks both: for a Claude destination the
 * plugin attaches no dispatcher at all, leaving the process dispatcher the host
 * installed to apply its own route to this request and every other Claude call —
 * Messages, token refresh, usage and profile alike.
 *
 * A published host route for the request's scheme is the same rule for every other
 * destination: this module's own direct agent would send the request around the
 * proxy the host routes that scheme through, so the installed dispatcher decides.
 *
 * Proxied requests run on undici's own fetch (not the global one) so the
 * ProxyAgent dispatcher always comes from the same undici build the request
 * is issued with — a mismatched dispatcher can be silently ignored by the
 * host's global fetch.
 */
export async function proxiedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  await ensureReady()
  const destination = requestUrl(input)
  if (hostClaudeRoute() !== undefined
    && destination !== undefined
    && isClaudeEgressDestination(destination.hostname)) {
    return fetch(input, init)
  }
  // A host-installed dispatcher is how the process routes or gates egress, so the plugin
  // defers to it rather than replacing it with its own agent.
  const hostOwns = getGlobalDispatcher() !== INITIAL_DISPATCHER
  const hostRoutesScheme = hostProxyForScheme(destination) !== undefined
  let dispatcher: Dispatcher | undefined
  if (current.enabled) {
    const hostname = destination?.hostname ?? ''
    // A bypassed host goes direct, still through this module's own agent when it owns the
    // process; the host's dispatcher already means direct.
    if (agent !== undefined && !matchesBypass(hostname, current.bypass)) dispatcher = agent
  }
  if (dispatcher === undefined && !hostOwns && !hostRoutesScheme) dispatcher = DIRECT_AGENT
  if (dispatcher === undefined) return fetch(input, init)
  const configured = { ...init, dispatcher } as RequestInit
  // A proxied call must go through undici's own fetch to honour the ProxyAgent. A direct
  // call stays on the global fetch, which is what a host or a test may replace to observe
  // or gate egress; the agent still carries this module's connect budget.
  return dispatcher === DIRECT_AGENT ? fetch(input, configured) : dispatchFetch(input, configured)
}

/**
 * The request's parsed URL, for the routing decisions above.
 *
 * @param input - The fetch input.
 * @returns The URL, or undefined for a form this module cannot parse.
 */
function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    return typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
  } catch {
    // A caller that reached fetch with an unparseable target still gets the call attempted.
    return undefined
  }
}

/**
 * Reports whether the configured proxy applies to a host.
 *
 * A transport that issues its own requests outside this module cannot apply the
 * `ProxyAgent`, so it must ask first and refuse rather than send the request
 * around a proxy the operator configured deliberately.
 *
 * @param hostname - Destination host.
 * @returns true when a request to that host would go through the proxy.
 */
export async function proxyAppliesTo(hostname: string): Promise<boolean> {
  await ensureReady()
  if (!current.enabled || agent === undefined) return false
  return !matchesBypass(hostname, current.bypass)
}

/**
 * Probe a destination through a proxy, answering with the HTTP status or a
 * flattened transport error. The probe uses `draft` when given (the dialog's
 * current inputs, without saving) and the stored config otherwise.
 *
 * Only a destination this plugin's providers use is accepted, and a target a
 * host-published route covers is refused rather than fetched around that route.
 * @param target - `http(s)` URL to fetch; defaults to {@link DEFAULT_PROXY_TEST_URL}.
 * @param draft - unsaved proxy inputs to test; absent means the stored config.
 * @returns the result; any HTTP status counts as a successful connection,
 *   only a transport failure is an error.
 */
export async function proxyTestConnection(target = DEFAULT_PROXY_TEST_URL, draft?: ProxyDraft): Promise<ProxyTestResult> {
  let parsed: URL
  try {
    parsed = new URL(target)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, viaProxy: false, error: `test destination must be http or https (got "${parsed.protocol}//")` }
    }
  } catch (error) {
    return { ok: false, viaProxy: false, error: errorMessage(error) }
  }
  await ensureReady()
  let probeAgent: ProxyAgent | undefined
  let viaProxy: boolean
  let closeProbe = false
  if (draft !== undefined) {
    // Test the typed values: a throw here is a config problem, not a route one.
    try {
      probeAgent = buildAgent(normalizeConfig({
        enabled: true,
        url: draft.url,
        ...draft.username === undefined || draft.username === '' ? {} : { username: draft.username },
        ...draft.password === undefined || draft.password === '' ? {} : { password: draft.password },
        bypass: [],
      }))
      viaProxy = probeAgent !== undefined
      closeProbe = true
    } catch (error) {
      return { ok: false, viaProxy: false, error: errorMessage(error) }
    }
  } else {
    viaProxy = current.enabled && agent !== undefined && !matchesBypass(parsed.hostname, current.bypass)
    probeAgent = viaProxy ? agent : undefined
  }
  if (!isProbeDestination(parsed.hostname)) {
    return {
      ok: false,
      viaProxy: false,
      error: `test destination ${parsed.hostname} is not a destination this plugin's providers use`,
    }
  }
  // A host-published route is what every other request in this module defers to. A probe
  // carrying its own dispatcher would leave that route, so it refuses instead of testing a
  // transport the host never authorized.
  if (probeAgent !== undefined) {
    const hostRoute = hostClaudeRoute()
    if (hostRoute !== undefined && isClaudeEgressDestination(parsed.hostname)) {
      return {
        ok: false,
        viaProxy: false,
        error: `the host requires Claude traffic to use ${describeHostClaudeRoute(hostRoute)}, and this probe cannot carry that route`,
      }
    }
    if (hostProxyForScheme(parsed) !== undefined) {
      const variable = parsed.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY'
      return {
        ok: false,
        viaProxy: false,
        error: `the host published ${variable} for ${parsed.protocol} destinations, and this probe cannot carry that route`,
      }
    }
  }
  const started = Date.now()
  try {
    const init = probeAgent !== undefined
      ? { method: 'GET', dispatcher: probeAgent, signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS) }
      : { method: 'GET', signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS) }
    const response = probeAgent !== undefined
      ? await dispatchFetch(parsed.toString(), init as RequestInit)
      : await fetch(parsed.toString(), init)
    // Drain so the connection can be released; the body is irrelevant.
    void response.arrayBuffer().catch(() => undefined)
    return { ok: true, viaProxy, status: response.status, latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, viaProxy, latencyMs: Date.now() - started, error: describeFetchError(error) }
  } finally {
    if (closeProbe && probeAgent !== undefined) {
      await probeAgent.close().catch(() => undefined)
    }
  }
}
