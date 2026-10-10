/**
 * Cursor subscription provider.
 *
 * Login uses `Cursor.auth.login({ store: null })` from `@cursor/sdk` and keeps
 * the minted user API key in this plugin's account map. Each request passes
 * that key explicitly, so the process never reads `CURSOR_API_KEY` or
 * `~/.cursor/sdk/auth.json`. The key does not refresh; an expired key asks
 * the user to log in again.
 *
 * A turn is one local `Agent` run in an empty working directory. Built-in
 * tools stay off. When the harness passed tools, the allowlist is only `mcp`,
 * which is the documented group that includes `local.customTools`. The first
 * custom-tool call cancels the run and is returned as a tool-call chunk; the
 * harness executes it and sends the result back on the next request.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../compat.js'
import type { CursorSession, ProviderId } from '../auth/store.js'
import { resolveImages } from '../translate/resolved.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  discoverAcrossAccounts,
  effortDisplayName,
  idleWatchdog,
  mergeReasoning,
  OAuthEndpointError,
  oauthEndpointError,
  mapFetchFailure,
} from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry, ProviderUsage, UsageWindow } from './common.js'
import { ProviderCatalog, catalogRow, withPoolTiers } from './provider-catalog.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager } from './accounts.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'

/** Default lifetime when login does not report `apiKeyExpiresAtMs`. The SDK default is 90 days. */
export const CURSOR_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** How long before expiry a request attempts refresh. Cursor chat has no refresh grant. */
export const CURSOR_PREEMPT_MS = 60_000

const CURSOR_API_BASE = 'https://api2.cursor.sh'
const CURSOR_WEBSITE = 'https://cursor.com'
/** Public OAuth client id the Cursor IDE uses when refreshing a dashboard session. */
const CURSOR_OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const CURSOR_USAGE_URL = `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
const CURSOR_PLAN_URL = `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetPlanInfo`
const CURSOR_API_KEY_URL = `${CURSOR_API_BASE}/aiserver.v1.DashboardService/CreateUserApiKey`
const CURSOR_ME_URL = `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetMe`
const CURSOR_REFRESH_URL = `${CURSOR_API_BASE}/oauth/token`

let cursorFetch: FetchFn = proxiedFetch

/** @internal Tests replace the login and usage fetch. */
export function setCursorLoginFetch(fetchFn: FetchFn | undefined): void {
  cursorFetch = fetchFn ?? proxiedFetch
}

const CURSOR_SDK_SPECIFIER = '@cursor/sdk'

/** One image attached to a Cursor `agent.send` call. `data` is base64. */
interface CursorSendImage {
  data: string
  mimeType: string
}

interface CursorLoginResult {
  apiKey: string
  email?: string
  apiKeyExpiresAtMs?: number
}

interface CursorSdkModule {
  Cursor: {
    auth: {
      login(options: {
        store: null
        openBrowser: false
        signal: AbortSignal
        apiKeyName: string
        onLoginUrl: (url: string) => void
      }): Promise<CursorLoginResult>
    }
    models: {
      list(options: { apiKey: string }): Promise<CursorListedModel[]>
    }
  }
  Agent: {
    create(options: CursorAgentOptions): Promise<CursorAgent>
  }
  JsonlLocalAgentStore: new (directory: string) => unknown
}

interface CursorAgentOptions {
  apiKey: string
  model: { id: string; params?: { id: string; value: string }[] }
  tools: readonly string[]
  local: {
    cwd: string
    settingSources: []
    store: unknown
    enableAgentRetries: false
    customTools?: Record<string, CursorCustomTool>
  }
}

interface CursorCustomTool {
  description: string
  inputSchema?: Record<string, unknown>
  execute: (
    args: Record<string, unknown>,
    context: { toolCallId?: string },
  ) => string
}

interface CursorRun {
  usage?: unknown
  stream(): AsyncIterable<unknown>
  cancel(): Promise<void>
}

interface CursorAgent {
  send(input: string | { text: string; images: CursorSendImage[] }): Promise<CursorRun>
  close?: () => void
  [Symbol.asyncDispose]?: () => Promise<void>
}

/** A browser login that has not been stored yet. */
export interface CursorLoginHandle {
  authorizeUrl: Promise<string>
  done: Promise<CursorSession>
  cancel(): void
}

/** Transcript handed to one stateless Cursor agent run. */
export interface CursorTurn {
  system?: string
  prompt: string
  images: CursorSendImage[]
}

interface HandoffCall {
  id: string
  name: string
  arguments: string
}

let loadCursorSdk = defaultLoadCursorSdk

async function defaultLoadCursorSdk(): Promise<CursorSdkModule> {
  try {
    const loaded: unknown = await import(CURSOR_SDK_SPECIFIER)
    return loaded as CursorSdkModule
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cursor provider requires the optional package @cursor/sdk (${reason})`)
  }
}

/**
 * Replace the SDK loader. Tests pass a fake; `undefined` restores the real import.
 * @internal
 */
export function setCursorSdkLoader(loader: (() => Promise<unknown>) | undefined): void {
  loadCursorSdk = loader === undefined
    ? defaultLoadCursorSdk
    : async () => await loader() as CursorSdkModule
}

/**
 * Build a stored session. `refreshToken` repeats the API key because every
 * provider session in this plugin must carry a non-empty refresh token; Cursor
 * does not issue one.
 */
export function cursorSession(
  apiKey: string,
  expiresAt: number,
  email?: string,
  dashboard?: { accessToken: string; refreshToken: string },
): CursorSession {
  return {
    accessToken: apiKey,
    refreshToken: apiKey,
    expiresAt,
    ...email === undefined ? {} : { email },
    ...dashboard === undefined ? {} : {
      dashboardAccessToken: dashboard.accessToken,
      dashboardRefreshToken: dashboard.refreshToken,
    },
  }
}

/**
 * Keep a key that has not expired. An expired key cannot be renewed.
 */
export function refreshCursor(session: CursorSession): Promise<CursorSession> {
  if (session.expiresAt > Date.now()) return Promise.resolve(session)
  return Promise.reject(new LlmError(
    'Cursor API key expired; log in again from Settings → Subscriptions',
    'INVALID_CREDENTIAL',
  ))
}

/** True when the stored key can no longer be used and the account should be dropped. */
export function isCursorPermanentRefreshError(error: unknown): boolean {
  return error instanceof LlmError && error.code === 'INVALID_CREDENTIAL'
}

/**
 * Start a browser login. The Settings page opens `authorizeUrl`. The same
 * browser handshake the SDK uses is polled until it releases dashboard
 * session tokens; those are kept, and one of them mints the chat API key.
 * Nothing is written to `~/.cursor/sdk/auth.json` or the Cursor IDE database.
 */
export function beginCursorLogin(): CursorLoginHandle {
  const ac = new AbortController()
  let cancelled = false
  let urlSettled = false
  let resolveUrl: (url: string) => void = () => undefined
  let rejectUrl: (error: Error) => void = () => undefined
  const authorizeUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve
    rejectUrl = reject
  })
  const settleUrl = (value: string | Error): void => {
    if (urlSettled) return
    urlSettled = true
    if (typeof value === 'string') resolveUrl(value)
    else rejectUrl(value)
  }
  const handshake = cursorLoginHandshake()
  settleUrl(handshake.loginUrl)
  const done = (async (): Promise<CursorSession> => {
    try {
      const tokens = await pollCursorLogin(handshake, ac.signal)
      const expiresAt = Date.now() + CURSOR_DEFAULT_TTL_MS
      const minted = await mintCursorApiKey(tokens.accessToken, expiresAt)
      return cursorSession(minted.apiKey, expiresAt, minted.email, tokens)
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      const reported = cancelled || ac.signal.aborted ? new Error('login cancelled') : wrapped
      settleUrl(reported)
      throw reported
    }
  })()
  return {
    authorizeUrl,
    done,
    cancel() {
      if (cancelled) return
      cancelled = true
      settleUrl(new Error('login cancelled'))
      ac.abort()
    },
  }
}

/**
 * Refresh the dashboard access token when a usage query needs it.
 * The chat API key is left unchanged. A failed refresh does not log the
 * account out.
 */
export async function refreshCursorDashboard(
  session: CursorSession,
  fetchFn: FetchFn = cursorFetch,
  signal?: AbortSignal,
): Promise<CursorSession> {
  if (session.dashboardRefreshToken === undefined) return session
  const response = await fetchFn(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: session.dashboardRefreshToken,
    }),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'cursor usage refresh')
  const refreshed = readOAuthTokens(await response.json())
  if (refreshed === undefined) throw new Error('Cursor usage refresh returned no access token')
  return {
    ...session,
    dashboardAccessToken: refreshed.accessToken,
    dashboardRefreshToken: refreshed.refreshToken ?? session.dashboardRefreshToken,
  }
}

/**
 * Usage snapshot for one account. Callers invoke this from the settings
 * page, the manual refresh button, and pool member selection. There is no
 * timer. Accounts without dashboard tokens must log in again.
 */
export async function fetchCursorUsage(
  session: CursorSession,
  fetchFn: FetchFn = cursorFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  if (session.dashboardAccessToken === undefined) {
    throw new LlmError(
      'Cursor usage needs a new login; log in again from Settings → Subscriptions',
      'AUTH',
    )
  }
  const response = await fetchFn(CURSOR_USAGE_URL, {
    method: 'POST',
    headers: cursorDashboardHeaders(session.dashboardAccessToken),
    body: '{}',
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'cursor usage')
  const payload: unknown = await response.json()
  const plan = await cursorPlanName(session.dashboardAccessToken, fetchFn, signal)
  const windows = cursorUsageWindows(payload)
  return {
    supported: true,
    windows,
    ...plan === undefined ? {} : { plan },
  }
}

/**
 * Return a session whose dashboard access token is still usable, refreshing
 * once when it is missing an expiry or inside the preempt window.
 */
/**
 * One on-demand usage read. Refreshes the dashboard token only when this
 * call finds it near expiry or rejected, then persists that update.
 */
export async function loadCursorAccountUsage(
  session: CursorSession,
  fetchFn: FetchFn,
  signal: AbortSignal | undefined,
  persist: (session: CursorSession) => Promise<void>,
): Promise<ProviderUsage> {
  let current = await cursorUsageSession(session, fetchFn, signal)
  if (current !== session) await persist(current)
  try {
    return await fetchCursorUsage(current, fetchFn, signal)
  } catch (error) {
    if (!(error instanceof OAuthEndpointError) || error.status !== 401
      || current.dashboardRefreshToken === undefined) throw error
    current = await refreshCursorDashboard(current, fetchFn, signal)
    await persist(current)
    return fetchCursorUsage(current, fetchFn, signal)
  }
}

export async function cursorUsageSession(
  session: CursorSession,
  fetchFn: FetchFn = cursorFetch,
  signal?: AbortSignal,
): Promise<CursorSession> {
  if (session.dashboardAccessToken === undefined || session.dashboardRefreshToken === undefined) return session
  const expiresAt = jwtExpiryMs(session.dashboardAccessToken)
  if (expiresAt === undefined || expiresAt - Date.now() > CURSOR_PREEMPT_MS) return session
  return refreshCursorDashboard(session, fetchFn, signal)
}

/** Render one harness request as a single Cursor prompt. Developer messages fail. */
export function renderCursorTurn(messages: readonly RequestMessage[], system: string | undefined): CursorTurn {
  const systemParts: string[] = []
  if (system !== undefined && system.trim().length > 0) systemParts.push(system.trim())
  const lines: string[] = []
  const images: CursorSendImage[] = []
  for (const message of messages) {
    if (message.role === 'developer') {
      throw new LlmError(
        'dsh-plugin-subscriptions: developer messages are not supported by this provider',
        'UNSUPPORTED_CONTENT',
      )
    }
    if (message.role === 'system') {
      const text = blocksText(message.content, images)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (message.role === 'tool') {
      const body = blocksText(message.content, images)
      const error = message.isError === true ? ' error' : ''
      lines.push(`[tool]\ntool_result ${message.toolCallId}${error}: ${body}`)
      continue
    }
    lines.push(`[${message.role}]\n${blocksText(message.content, images)}`)
  }
  const joined = systemParts.join('\n\n')
  const prompt = lines.join('\n\n').trim()
  return {
    ...joined.length > 0 ? { system: joined } : {},
    prompt: prompt.length > 0 ? prompt : '(empty)',
    images,
  }
}

function blocksText(blocks: readonly unknown[], images: CursorSendImage[]): string {
  return blocks.map(block => blockText(block, images)).filter(part => part.length > 0).join('\n')
}

function blockText(block: unknown, images: CursorSendImage[]): string {
  if (typeof block !== 'object' || block === null) return ''
  const record = block as Record<string, unknown>
  switch (record.type) {
    case 'text':
      return typeof record.text === 'string' ? record.text : ''
    case 'image':
      if (typeof record.dataBase64 === 'string' && typeof record.mediaType === 'string') {
        images.push({ data: record.dataBase64, mimeType: record.mediaType })
      }
      return '[image]'
    case 'file':
      return '[file]'
    case 'tool-call': {
      const name = typeof record.name === 'string' ? record.name : 'tool'
      const id = typeof record.id === 'string' ? record.id : ''
      const args = typeof record.arguments === 'string' ? record.arguments : ''
      return `tool ${name} (${id}): ${args}`
    }
    case 'tool-result': {
      const id = typeof record.toolCallId === 'string' ? record.toolCallId : ''
      const nested = Array.isArray(record.content) ? blocksText(record.content, images) : ''
      const error = record.isError === true ? ' error' : ''
      return `tool_result ${id}${error}: ${nested}`
    }
    default:
      return ''
  }
}

function classifyCursorError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  const auth = name === 'AuthenticationError' || /\b401\b|unauthenticated|invalid api key/i.test(message)
  return new LlmError(`cursor API ${message}`, auth ? 'AUTH' : 'SERVER', { cause: error })
}

function cursorUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const usage = value as Record<string, unknown>
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...typeof usage.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {},
    ...typeof usage.cacheWriteTokens === 'number' ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
    ...typeof usage.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {},
    ...typeof usage.reasoningTokens === 'number' ? { reasoningTokens: usage.reasoningTokens } : {},
  }
}

function encodeArgs(args: unknown): string {
  try {
    const encoded = JSON.stringify(args ?? {})
    return typeof encoded === 'string' ? encoded : '{}'
  } catch {
    return '{}'
  }
}

async function disposeAgent(agent: CursorAgent): Promise<void> {
  const dispose = agent[Symbol.asyncDispose]
  if (typeof dispose === 'function') {
    await dispose.call(agent)
    return
  }
  agent.close?.()
}

/** Constructor dependencies for {@link CursorAdapter}. */
export interface CursorAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<CursorSession>
  pool?: () => PoolAdapter | undefined
  discovery: boolean
  onWarn?: (message: string) => void
  resolveAttachments?: () => AttachmentStore | undefined
  catalogStore?: CatalogPersistence
  rateLimit?: RateLimitWait
  defaultEffortOf?: (model: string) => string | undefined
  /** Local context-window override from Settings. Capped by the catalog maximum. */
  contextWindowOf?: (model: string) => number | undefined
  /** True when this session's Speed control is set to fast. */
  speedFor?: (sessionId: string | undefined, model: string) => boolean | Promise<boolean>
}

/** Cursor wire adapter. One instance serves the `cursor` provider route. */
/** One in-flight Cursor turn, so a context retry can see what it already sent. */
interface CursorSendAttempt {
  contextValue?: string
}

export class CursorAdapter extends LlmAdapter {
  private readonly catalogs: ProviderCatalog
  /** Context parameter values the registry rejected, keyed `account|model|value`. */
  private readonly rejectedCursorContext = new Set<string>()

  constructor(private readonly options: CursorAdapterOptions) {
    super()
    this.catalogs = new ProviderCatalog(options, 'cursor', {
      staticRows: provider => this.staticModels(provider),
      fetchCatalog: (account, signal) => this.fetchCatalog(account, signal),
      row: (provider, model) => this.listed(provider, model),
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cursor' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(
      DEFAULT_RETRY,
      this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `cursor: provider "${provider}" retryPolicy`,
    )
  }

  /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
  clearAccountCatalog(account?: string): void {
    this.catalogs.invalidate(account)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return withPoolTiers(await this.listOwnModels(provider), this.options.pool?.(), provider)
  }

  /** The provider's own catalog: union of every account, or one account when named. */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    return this.catalogs.list(provider, account, signal)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
    return this.resolveOwnModel(provider, model)
  }

  async resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning)
    const limits = cursorContextLimits(discovered, configured?.contextWindow)
    const override = this.options.contextWindowOf?.(model)
    const contextWindow = limits === undefined
      ? configured?.contextWindow
      : override === undefined ? limits.default : Math.min(override, limits.max)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? ['text'],
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens },
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  /** Advertised default and maximum context, when the catalog lists a context size. */
  async contextLimits(model: string, account?: string): Promise<{ default: number; max: number } | undefined> {
    const discovered = await this.discovered(model, account)
    const configured = this.options.models.find(entry => entry.id === model)
    return cursorContextLimits(discovered, configured?.contextWindow)
  }

  /** Whether the discovered catalog advertises Cursor's `fast` parameter. */
  async supportsFastTier(model: string, account?: string): Promise<boolean> {
    return (await this.discovered(model, account))?.fastTier === true
  }

  /** Ids of every discovered model with a `fast` parameter. */
  async fastCapableModels(): Promise<string[]> {
    if (!this.options.discovery) return []
    const accounts = (await this.options.tokens.list()).map(entry => entry.key)
    if (accounts.length === 0) return []
    const seen = new Set<string>()
    const ids: string[] = []
    for (const account of accounts) {
      try {
        const catalog = await this.catalogs.cache(account)
        const models = await catalog.resolve(() => this.fetchCatalog(account))
        for (const model of models ?? []) {
          if (model.fastTier !== true || seen.has(model.id)) continue
          seen.add(model.id)
          ids.push(model.id)
        }
      } catch {
        // One account's catalog must not hide the others.
      }
    }
    return ids
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamAccount(options)
  }

  streamAccount(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    return this.streamWithRetry(options, account)
  }

  private async *streamWithRetry(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    let yielded = false
    let contextRetried = false
    for (;;) {
      const attempt: CursorSendAttempt = {}
      try {
        for await (const chunk of this.streamCore(options, account, attempt)) {
          yielded = true
          yield chunk
        }
        return
      } catch (error) {
        if (!yielded && !contextRetried && this.rejectCursorContext(error, account, options.model, attempt.contextValue)) {
          contextRetried = true
          continue
        }
        if (yielded || !(error instanceof LlmError) || error.code !== 'AUTH' || options.signal?.aborted === true) {
          throw error
        }
        await this.options.tokens.session(account, true)
        yield* this.streamCore(options, account, {})
        return
      }
    }
  }

  /** Remember a context value the registry refused, so the retry can step down. */
  private rejectCursorContext(
    error: unknown,
    account: string | undefined,
    model: string,
    contextValue: string | undefined,
  ): boolean {
    const message = error instanceof Error ? error.message : ''
    if (contextValue === undefined || !/Invalid parameters for registry model/i.test(message)) return false
    const key = cursorContextRejectionKey(account, model, contextValue)
    if (this.rejectedCursorContext.has(key)) return false
    this.rejectedCursorContext.add(key)
    return true
  }

  private async *streamCore(
    options: GenerateOptions,
    account: string | undefined,
    attempt: CursorSendAttempt,
  ): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    let agent: CursorAgent | undefined
    let runRef: CursorRun | undefined
    const handoff: HandoffCall[] = []
    let stoppedForTools = false
    const onAbort = (): void => { void runRef?.cancel() }
    try {
      const callerAborted = (): boolean => options.signal?.aborted === true
      if (callerAborted()) {
        throw new LlmError('cursor API request aborted by caller', 'ABORTED')
      }
      const session = await this.options.tokens.session(account)
      const resolved = await resolveImages(
        options.messages,
        this.options.resolveAttachments?.(),
        watchdog.signal,
      )
      const turn = renderCursorTurn(resolved as readonly RequestMessage[], options.system)
      const discovered = await this.discovered(options.model)
      const fast = await this.options.speedFor?.(options.sessionId, options.model)
      const limits = cursorContextLimits(discovered, undefined)
      const override = this.options.contextWindowOf?.(options.model)
      const requested = limits === undefined
        ? undefined
        : override === undefined ? limits.default : Math.min(override, limits.max)
      const context = discovered === undefined
        ? undefined
        : cursorContextAttempt(
          discovered,
          requested,
          cursorRejectedContextValues(this.rejectedCursorContext, account, options.model),
        )
      if (context !== undefined) attempt.contextValue = context
      const params = discovered === undefined
        ? undefined
        : cursorRequestParams(discovered, options.reasoningEffort, fast, context)
      const prompt = turn.system === undefined ? turn.prompt : `${turn.system}\n\n${turn.prompt}`
      const sdk = await loadCursorSdk()
      const dirs = cursorDirs()
      await mkdir(dirs.cwd, { recursive: true })
      await mkdir(dirs.store, { recursive: true })
      let cancelPending = false
      const customTools = cursorCustomTools(options.tools, handoff, () => {
        stoppedForTools = true
        if (runRef === undefined) cancelPending = true
        else void runRef.cancel()
      })
      agent = await sdk.Agent.create({
        apiKey: session.accessToken,
        model: params === undefined ? { id: options.model } : { id: options.model, params },
        // `[]` removes every built-in tool, including the `mcp` group that
        // custom tools belong to. `['mcp']` keeps only those harness tools.
        // `systemPrompt` is not passed: this SDK build rejects it as
        // `--system-prompt`. The harness prompt is prefixed onto the user text.
        tools: customTools === undefined ? [] : ['mcp'],
        local: {
          cwd: dirs.cwd,
          settingSources: [],
          store: new sdk.JsonlLocalAgentStore(dirs.store),
          enableAgentRetries: false,
          ...customTools === undefined ? {} : { customTools },
        },
      })
      options.signal?.addEventListener('abort', onAbort)
      watchdog.signal.addEventListener('abort', onAbort)
      const run = await agent.send(turn.images.length > 0
        ? { text: prompt, images: turn.images }
        : prompt)
      runRef = run
      if (cancelPending) await run.cancel()
      const cursor = { index: 0 }
      const prose: CursorProse = { block: undefined }
      let sawBlock = false
      let pendingUsage: TokenUsage | undefined
      try {
        for await (const event of run.stream()) {
          watchdog.pulse()
          if (handoff.length > 0) break
          const failure = cursorStatusError(event)
          if (failure !== undefined) throw failure
          const usage = usageFromEvent(event)
          if (usage !== undefined) pendingUsage = usage
          const chunks = eventChunks(event, cursor, prose)
          if (chunks.length > 0) sawBlock = true
          yield* chunks
          if (handoff.length > 0) break
        }
      } catch (error) {
        if (!stoppedForTools || callerAborted()) throw error
      }
      const closed = closeCursorProse(prose)
      if (closed.length > 0) {
        sawBlock = true
        yield* closed
      }
      if (watchdog.timedOut()) throw new LlmError('cursor API stream idle timeout', 'TIMEOUT')
      if (callerAborted() && !stoppedForTools) {
        throw new LlmError('cursor API request aborted by caller', 'ABORTED')
      }
      if (handoff.length > 0) {
        for (const call of handoff) {
          const index = cursor.index++
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index,
            id: ToolCallId(call.id),
            name: call.name,
            argumentsDelta: call.arguments,
          }
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments },
          }
        }
        sawBlock = true
      }
      if (!sawBlock) throw new LlmError('cursor API returned an empty response', EMPTY_RESPONSE_CODE)
      const usage = cursorUsage(run.usage) ?? pendingUsage
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: handoff.length > 0 ? 'tool-calls' : 'stop' } }
    } catch (error) {
      throw mapFetchFailure('cursor API', classifyCursorError(error), watchdog, options.signal)
    } finally {
      watchdog.stop()
      options.signal?.removeEventListener('abort', onAbort)
      watchdog.signal.removeEventListener('abort', onAbort)
      if (agent !== undefined) await disposeAgent(agent).catch(() => undefined)
    }
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? ['text'],
    }))
  }

  /** One discovered entry as a picker row; Cursor catalog models are text-only. */
  private listed(provider: string, model: DiscoveredModel): LlmModelInfo {
    return catalogRow(provider, model, ['text'], {
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    })
  }

  private async fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const session = await this.options.tokens.session(account)
    const sdk = await loadCursorSdk()
    const listed = await withCallerSignal(
      sdk.Cursor.models.list({ apiKey: session.accessToken }),
      signal,
    )
    const models: DiscoveredModel[] = []
    for (const model of listed) {
      const discovered = cursorDiscoveredModel(model)
      if (discovered !== undefined) models.push(discovered)
    }
    return models
  }

  private async discovered(model: string, account?: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const accounts = account === undefined
      ? (await this.options.tokens.list()).map(entry => entry.key)
      : [account]
    return discoverAcrossAccounts(accounts, async account => {
      const catalog = await this.catalogs.cache(account)
      const models = await catalog.resolve(() => this.fetchCatalog(account))
      return models?.find(entry => entry.id === model)
    })
  }
}

function cursorDirs(): { cwd: string; store: string } {
  const root = join(tmpdir(), 'dsh-cursor')
  return { cwd: join(root, 'workspace'), store: join(root, 'agents') }
}

function cursorCustomTools(
  tools: readonly ToolSchema[] | undefined,
  handoff: HandoffCall[],
  stop: () => void,
): Record<string, CursorCustomTool> | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  const custom: Record<string, CursorCustomTool> = {}
  for (const tool of tools) {
    custom[tool.name] = {
      description: tool.description,
      inputSchema: tool.parameters,
      execute(args, context) {
        const id = typeof context.toolCallId === 'string' && context.toolCallId.length > 0
          ? context.toolCallId
          : randomUUID()
        handoff.push({ id, name: tool.name, arguments: encodeArgs(args) })
        stop()
        return 'Stopped so the host can run this tool.'
      },
    }
  }
  return custom
}

/** One assistant or thinking block kept open across token-sized stream events. */
interface CursorProseBlock {
  index: number
  kind: 'text' | 'reasoning'
  text: string
}

interface CursorProse {
  block: CursorProseBlock | undefined
}

/**
 * Map one Cursor stream event into harness chunks. Consecutive text events
 * stay in one block: the runtime sends a token at a time, and closing a
 * block per token makes the host render each token on its own line.
 * @internal
 */
export function eventChunks(event: unknown, cursor: { index: number }, prose: CursorProse): StreamChunk[] {
  if (typeof event !== 'object' || event === null) return []
  const record = event as Record<string, unknown>
  if (record.type === 'thinking' && typeof record.text === 'string' && record.text.length > 0) {
    return appendCursorProse(prose, cursor, 'reasoning', record.text)
  }
  if (record.type !== 'assistant') return closeIfForeign(record.type, prose)
  const message = record.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const chunks: StreamChunk[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    if (item.type !== 'text' || typeof item.text !== 'string' || item.text.length === 0) {
      chunks.push(...closeCursorProse(prose))
      continue
    }
    chunks.push(...appendCursorProse(prose, cursor, 'text', item.text))
  }
  return chunks
}

/** Close the open prose block. Exported for the stream loop's end of turn. */
export function closeCursorProse(prose: CursorProse): StreamChunk[] {
  const block = prose.block
  if (block === undefined) return []
  prose.block = undefined
  if (block.kind === 'reasoning') {
    return [{ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }]
  }
  return [{ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }]
}

function closeIfForeign(type: unknown, prose: CursorProse): StreamChunk[] {
  if (type === 'status' || type === 'usage' || type === 'system' || type === 'request') return []
  return closeCursorProse(prose)
}

function appendCursorProse(
  prose: CursorProse,
  cursor: { index: number },
  kind: CursorProseBlock['kind'],
  text: string,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  const current = prose.block
  if (current !== undefined && current.kind !== kind) chunks.push(...closeCursorProse(prose))
  let block = prose.block
  if (block === undefined) {
    const index = cursor.index++
    block = { index, kind, text: '' }
    prose.block = block
    chunks.push({ type: 'block-start', index, blockType: kind === 'reasoning' ? 'reasoning' : 'text' })
  }
  block.text += text
  chunks.push(kind === 'reasoning'
    ? { type: 'reasoning-delta', index: block.index, text }
    : { type: 'text-delta', index: block.index, text })
  return chunks
}

function usageFromEvent(event: unknown): TokenUsage | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as Record<string, unknown>
  if (record.type !== 'usage') return undefined
  return cursorUsage(record.usage)
}

/** One row from `Cursor.models.list`. Fields match the SDK's `ModelListItem`. */
export interface CursorListedModel {
  id?: string
  displayName?: string
  description?: string
  parameters?: Array<{
    id?: string
    displayName?: string
    values?: Array<{ value?: string; displayName?: string }>
  }>
  variants?: Array<{
    isDefault?: boolean
    params?: Array<{ id?: string; value?: string }>
  }>
}

const EFFORT_PARAMETER_IDS = new Set(['reasoning_effort', 'effort', 'reasoning'])

/** Parse a Cursor context parameter such as `300k` or `1m` into tokens. */
export function cursorContextTokens(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const tokens = match[2].toLowerCase() === 'm' ? amount * 1_000_000 : amount * 1_000
  const rounded = Math.round(tokens)
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : undefined
}

/** Map one `Cursor.models.list` row onto the harness catalog. */
export function cursorDiscoveredModel(model: CursorListedModel): DiscoveredModel | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined
  const parameters: NonNullable<DiscoveredModel['cursorParameters']> = []
  for (const parameter of model.parameters ?? []) {
    if (typeof parameter.id !== 'string' || parameter.id.length === 0) continue
    const values: NonNullable<DiscoveredModel['cursorParameters']>[number]['values'] = []
    for (const value of parameter.values ?? []) {
      if (typeof value.value !== 'string' || value.value.length === 0) continue
      const name = typeof value.displayName === 'string' ? value.displayName.trim() : ''
      values.push({ value: value.value, ...name.length > 0 ? { name } : {} })
    }
    if (values.length > 0) parameters.push({ id: parameter.id, values })
  }
  const variant = (model.variants ?? []).find(entry => entry.isDefault === true) ?? model.variants?.[0]
  const defaults: NonNullable<DiscoveredModel['cursorDefaults']> = []
  for (const param of variant?.params ?? []) {
    if (typeof param.id !== 'string' || param.id.length === 0
      || typeof param.value !== 'string' || param.value.length === 0) continue
    defaults.push({ id: param.id, value: param.value })
  }
  const effort = parameters.find(parameter => EFFORT_PARAMETER_IDS.has(parameter.id))
  const defaultEffortValue = effort === undefined
    ? undefined
    : defaults.find(entry => entry.id === effort.id)?.value ?? effort.values[0]?.value
  const reasoning = effort === undefined ? undefined : {
    efforts: effort.values.map(value => ({
      id: ReasoningEffortId(value.value),
      name: value.name ?? effortDisplayName(value.value),
    })),
    ...defaultEffortValue === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffortValue) },
  }
  const contextParameter = parameters.find(parameter => parameter.id === 'context')
  const contextTokens = (contextParameter?.values ?? [])
    .map(value => cursorContextTokens(value.value))
    .filter((value): value is number => value !== undefined)
  const defaultContext = defaults.find(entry => entry.id === 'context')?.value
  const contextWindow = defaultContext === undefined
    ? contextTokens[0]
    : cursorContextTokens(defaultContext) ?? contextTokens[0]
  const maxContextWindow = contextTokens.length === 0 ? undefined : Math.max(...contextTokens)
  const fastTier = parameters.find(parameter => parameter.id === 'fast')
    ?.values.some(value => value.value === 'true') === true
  return {
    id: model.id,
    name: typeof model.displayName === 'string' && model.displayName.length > 0 ? model.displayName : model.id,
    ...typeof model.description === 'string' && model.description.length > 0 ? { description: model.description } : {},
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxContextWindow === undefined ? {} : { maxContextWindow },
    ...reasoning === undefined ? {} : { reasoning },
    ...fastTier ? { fastTier: true } : {},
    ...parameters.length === 0 ? {} : { cursorParameters: parameters },
    ...defaults.length === 0 ? {} : { cursorDefaults: defaults },
  }
}

/**
 * `model.params` for one run. Starts from the default variant, then applies
 * the selected effort and the Speed toggle. An effort the catalog does not
 * list is left at the variant default.
 */
interface CursorContextOption {
  value: string
  tokens: number
}

function cursorContextOptions(model: DiscoveredModel): CursorContextOption[] {
  const parameter = model.cursorParameters?.find(entry => entry.id === 'context')
  if (parameter === undefined) return []
  return parameter.values.flatMap(value => {
    const tokens = cursorContextTokens(value.value)
    return tokens === undefined ? [] : [{ value: value.value, tokens }]
  }).sort((left, right) => left.tokens - right.tokens)
}

/** Smallest advertised `context` value that covers `requested` tokens. */
export function cursorContextChoice(model: DiscoveredModel, requested: number | undefined): string | undefined {
  if (requested === undefined) return undefined
  const options = cursorContextOptions(model)
  if (options.length === 0) return undefined
  return (options.find(option => option.tokens >= requested) ?? options[options.length - 1]).value
}

/**
 * Context value to send. A value the registry already rejected is skipped.
 * When every covering value was rejected, the largest remaining smaller value
 * is used; when none remain, context is omitted.
 */
export function cursorContextAttempt(
  model: DiscoveredModel,
  requested: number | undefined,
  rejected: ReadonlySet<string>,
): string | undefined {
  if (requested === undefined) return undefined
  const options = cursorContextOptions(model).filter(option => !rejected.has(option.value))
  if (options.length === 0) return undefined
  return (options.find(option => option.tokens >= requested) ?? options[options.length - 1]).value
}

function cursorContextRejectionKey(account: string | undefined, model: string, value: string): string {
  return `${account ?? '*'}|${model}|${value}`
}

/** Context values already refused for one account and model. */
function cursorRejectedContextValues(
  rejected: ReadonlySet<string>,
  account: string | undefined,
  model: string,
): Set<string> {
  const prefix = `${account ?? '*'}|${model}|`
  const values = new Set<string>()
  for (const key of rejected) {
    if (key.startsWith(prefix)) values.add(key.slice(prefix.length))
  }
  return values
}

export function cursorRequestParams(
  model: DiscoveredModel,
  effort: string | undefined,
  fast: boolean | undefined,
  context?: string,
): { id: string; value: string }[] | undefined {
  const parameters = model.cursorParameters
  if (parameters === undefined || parameters.length === 0) return undefined
  const params = new Map<string, string>()
  for (const entry of model.cursorDefaults ?? []) params.set(entry.id, entry.value)
  for (const parameter of parameters) {
    const first = parameter.values[0]
    if (!params.has(parameter.id) && first !== undefined) params.set(parameter.id, first.value)
  }
  const effortParameter = parameters.find(parameter => EFFORT_PARAMETER_IDS.has(parameter.id))
  if (effort !== undefined && effortParameter !== undefined
    && effortParameter.values.some(value => value.value === effort)) {
    params.set(effortParameter.id, effort)
  }
  if (fast !== undefined && parameters.some(parameter => parameter.id === 'fast')) {
    params.set('fast', fast ? 'true' : 'false')
  }
  if (context !== undefined && parameters.some(parameter => parameter.id === 'context')) {
    params.set('context', context)
  }
  return [...params].map(([id, value]) => ({ id, value }))
}

function cursorContextLimits(
  discovered: DiscoveredModel | undefined,
  configured: number | undefined,
): { default: number; max: number } | undefined {
  const fallback = discovered?.contextWindow ?? configured
  const max = discovered?.maxContextWindow ?? fallback
  const standard = fallback ?? max
  if (standard === undefined || max === undefined) return undefined
  return { default: standard, max }
}

function cursorStatusError(event: unknown): LlmError | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as Record<string, unknown>
  if (record.type !== 'status' || record.status !== 'ERROR') return undefined
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : 'cursor run failed'
  return new LlmError(`cursor API ${message}`, 'SERVER')
}

function cursorLoginHandshake(): { uuid: string; verifier: string; loginUrl: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const uuid = randomUUID()
  return {
    uuid,
    verifier,
    loginUrl: `${CURSOR_WEBSITE}/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=sdk`,
  }
}

async function pollCursorLogin(
  handshake: { uuid: string; verifier: string },
  signal: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
  let useGet = false
  let sawPending = false
  let failures = 0
  for (let attempt = 0; attempt < 150; attempt++) {
    if (signal.aborted) throw new Error('login cancelled')
    const response = useGet
      ? await cursorFetch(
        `${CURSOR_API_BASE}/auth/poll?uuid=${encodeURIComponent(handshake.uuid)}&verifier=${encodeURIComponent(handshake.verifier)}`,
        { method: 'GET', headers: { accept: 'application/json' }, signal },
      )
      : await cursorFetch(`${CURSOR_API_BASE}/auth/poll`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ uuid: handshake.uuid, verifier: handshake.verifier }),
        signal,
      })
    if (response.status === 404) {
      if (!sawPending) {
        const text = (await response.text()).trim()
        if (!useGet && text !== 'Not found') {
          useGet = true
          continue
        }
        sawPending = true
      }
      failures = 0
      await cursorLoginDelay(Math.min(1_000 * 1.2 ** attempt, 10_000), signal)
      continue
    }
    if (!response.ok) {
      failures += 1
      if (failures >= 3) throw new Error('Cursor login failed')
      await cursorLoginDelay(Math.min(1_000 * 1.2 ** attempt, 10_000), signal)
      continue
    }
    const tokens = readOAuthTokens(await response.json())
    if (tokens?.refreshToken === undefined) throw new Error('Cursor login returned no session tokens')
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  }
  throw new Error('Cursor login timed out')
}

async function mintCursorApiKey(
  accessToken: string,
  expiresAt: number,
): Promise<{ apiKey: string; email?: string }> {
  const headers = cursorDashboardHeaders(accessToken)
  const created = await cursorFetch(CURSOR_API_KEY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'dsh-plugin-subscriptions', expiresAt: String(expiresAt) }),
  })
  if (!created.ok) throw await oauthEndpointError(created, 'cursor api key')
  const createdBody = await created.json() as Record<string, unknown>
  const apiKey = createdBody.apiKey ?? createdBody.api_key
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('Cursor login returned no API key')
  }
  let email: string | undefined
  try {
    const me = await cursorFetch(CURSOR_ME_URL, { method: 'POST', headers, body: '{}' })
    if (me.ok) {
      const body = await me.json() as Record<string, unknown>
      if (typeof body.email === 'string' && body.email.trim().length > 0) email = body.email.trim()
    }
  } catch {
    // The API key is enough to chat; email only names the account.
  }
  return { apiKey, ...email === undefined ? {} : { email } }
}

function cursorDashboardHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'connect-protocol-version': '1',
  }
}

function readOAuthTokens(value: unknown): { accessToken: string; refreshToken?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const accessToken = raw.accessToken ?? raw.access_token
  const refreshToken = raw.refreshToken ?? raw.refresh_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  return {
    accessToken,
    ...typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {},
  }
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof json !== 'object' || json === null) return undefined
    const exp = (json as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

async function cursorPlanName(accessToken: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchFn(CURSOR_PLAN_URL, {
      method: 'POST',
      headers: cursorDashboardHeaders(accessToken),
      body: '{}',
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return undefined
    const info = (body as { planInfo?: { planName?: unknown } }).planInfo
    return typeof info?.planName === 'string' && info.planName.length > 0 ? info.planName : undefined
  } catch {
    return undefined
  }
}

function cursorUsageWindows(payload: unknown): UsageWindow[] {
  if (typeof payload !== 'object' || payload === null) return []
  const raw = payload as Record<string, unknown>
  const plan = raw.planUsage
  if (typeof plan !== 'object' || plan === null) return []
  const usage = plan as Record<string, unknown>
  const resetsAt = cursorResetsAt(raw.billingCycleEnd)
  const windows: UsageWindow[] = []
  for (const [scope, field] of [['API', 'apiPercentUsed'], ['Auto', 'autoPercentUsed']] as const) {
    const value = usage[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    windows.push({
      kind: 'other',
      scope,
      usedPercent: value,
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  if (windows.length === 0 && typeof usage.totalPercentUsed === 'number' && Number.isFinite(usage.totalPercentUsed)) {
    windows.push({
      kind: 'other',
      scope: 'total',
      usedPercent: usage.totalPercentUsed,
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  return windows
}

function cursorResetsAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (/^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function cursorLoginDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('login cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('login cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function withCallerSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
