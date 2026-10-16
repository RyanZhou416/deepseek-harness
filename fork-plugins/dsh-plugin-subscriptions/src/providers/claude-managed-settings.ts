/**
 * The managed-settings read: one conditional `GET` of the first-party settings endpoint,
 * the fixed envelope and cache-state semantics the pinned client uses, and the projection
 * of accepted remote policy into restrictions a consumer can enforce.
 *
 * The endpoint, its authentication and its header role belong to the Claude protocol
 * configuration; this module receives them as an injected fetch. What it owns is the
 * response contract — envelope validation, the 200/204/304/404 branches, the server's own
 * revalidation checksum, and the rule that a remote restriction is never silently dropped.
 *
 * Remote JSON never reaches Cordis config, environment variables, the tool catalog or a
 * download: this module produces a validated projection, and an operation the projection
 * cannot decide is refused rather than allowed.
 */

import { claudeIdentityKey } from './claude-account-state.js'
import type { ClaudeMaintenanceFailure } from './claude-account-state.js'

/**
 * What one conditional settings read needs from the Claude protocol configuration.
 * @param request - the account, its access token and the cache validator.
 * @returns the endpoint's response; the caller owns redirect and status handling.
 */
export type ClaudePolicyFetchFn = (request: ClaudePolicyFetchRequest) => Promise<Response>

/** One conditional managed-settings request. */
export interface ClaudePolicyFetchRequest {
  /** Canonical account key the credential belongs to. */
  account: string
  /** Access token to authenticate with; the caller refreshes it before a retry. */
  accessToken: string
  /**
   * The server's own checksum from the last accepted snapshot. Present only when a
   * snapshot is cached, and sent as `If-None-Match`, which is what makes a 304 valid.
   */
  ifNoneMatch?: string
  /** Caller cancellation. */
  signal?: AbortSignal
}

/** What one operation a remote restriction could affect is about. */
export interface ClaudePolicyCheckRequest {
  /** Kind of operation being decided, for the common single-scope case. */
  scope?: ClaudePolicyScope
  /**
   * Every capability scope the operation actually exercises.
   *
   * A tool run that can execute a shell command reaches the sandbox and environment
   * restrictions too, and an MCP tool call reaches the MCP ones. A caller that knows only
   * that "some tool" runs must pass {@link claudeScopesFor} with the unknown kind, which
   * reaches every scope: a restriction that cannot be shown to be unaffected stops the
   * operation instead of slipping past a narrow single scope.
   */
  capabilities?: readonly ClaudePolicyScope[]
  /** DSH tool name, for a tool operation. */
  tool?: string
  /** Model id, for a model operation. */
  model?: string
  /** MCP server name, for an MCP operation. */
  server?: string
  /** Whether the operation asks for bypass-permissions mode. */
  bypassPermissions?: boolean
}

/** The operation kinds a remote restriction can reach. */
export type ClaudePolicyScope =
  /** Tool execution. */
  | 'tool'
  /** Model selection and requests. */
  | 'model'
  /** MCP servers and their tools. */
  | 'mcp'
  /** Shell, hook and sandbox execution surfaces. */
  | 'execution'
  /** Network destinations. */
  | 'network'
  /** A restriction whose reach is unknown, so it reaches everything. */
  | 'unknown'

/** The operation kinds a caller can name when it knows what it is about to do. */
export type ClaudeOperationKind =
  /** A model request. */
  | 'model'
  /** A tool whose own effects are known not to include execution, MCP or network. */
  | 'tool'
  /** A tool that can run a shell command. */
  | 'shell'
  /** An MCP server call. */
  | 'mcp'
  /** A network request. */
  | 'network'
  /** A file read or write. */
  | 'file'
  /** An operation whose reach is unknown; it reaches every scope. */
  | 'unknown'

/** Every scope a restriction can reach, used for an operation of unknown reach. */
const ALL_POLICY_SCOPES: readonly ClaudePolicyScope[] =
  ['tool', 'model', 'mcp', 'execution', 'network', 'unknown']

/**
 * The capability scopes one operation of a known kind exercises.
 *
 * A caller that cannot classify its operation passes `'unknown'`, which reaches every
 * scope: an unenforceable restriction must stop the operation rather than be skipped
 * because the caller described the operation too narrowly.
 * @param kind - what the caller is about to do.
 * @returns the scopes the operation reaches.
 */
export function claudeScopesFor(kind: ClaudeOperationKind): readonly ClaudePolicyScope[] {
  switch (kind) {
    case 'model':
      return ['model', 'network']
    case 'tool':
      return ['tool']
    case 'shell':
      return ['tool', 'execution', 'network']
    case 'mcp':
      return ['mcp', 'network']
    case 'network':
      return ['network']
    case 'file':
      return ['tool', 'execution']
    case 'unknown':
      return ALL_POLICY_SCOPES
  }
}

/** The scopes a check request reaches, conservatively when it names none. */
function requestedScopes(request: ClaudePolicyCheckRequest): readonly ClaudePolicyScope[] {
  const named = [
    ...request.capabilities ?? [],
    ...request.scope === undefined ? [] : [request.scope],
  ]
  return named.length === 0 ? ALL_POLICY_SCOPES : named
}

/** Whether a restriction or blocker of one scope reaches the requested operation. */
function policyScopeReaches(entryScope: ClaudePolicyScope, requested: readonly ClaudePolicyScope[]): boolean {
  return entryScope === 'unknown' || requested.includes('unknown') || requested.includes(entryScope)
}

/** One validated restriction a consumer can enforce. */
export interface ClaudePolicyRestriction {
  /** Remote settings key the restriction came from. */
  readonly key: string
  /** Operation scope the restriction reaches. */
  readonly scope: ClaudePolicyScope
  /** Consumer-specific restriction kind. */
  readonly kind: string
  /** Consumer-specific restriction value. */
  readonly value: unknown
}

/** A reason an accepted remote policy cannot be applied to an operation. */
export interface ClaudePolicyBlocker {
  /** Remote settings key, or `(envelope)` for a document-level problem. */
  readonly key: string
  /** Operation scope the blocker reaches. */
  readonly scope: ClaudePolicyScope
  /** Stable machine code the status view and the refusal carry. */
  readonly code:
    | 'POLICY_UNSUPPORTED'
    | 'POLICY_INVALID_VALUE'
    | 'POLICY_CONSENT_REQUIRED'
  /** Short explanation naming what could not be applied. */
  readonly detail: string
}

/** The outcome of deciding one operation. */
export type ClaudePolicyDecision =
  | { readonly decision: 'allow'; readonly reason?: string }
  | { readonly decision: 'deny'; readonly code: string; readonly blocker: ClaudePolicyBlocker }

/** What one consumer's parse produced. */
export interface ClaudePolicyParseResult {
  /** Restrictions the consumer can enforce exactly. */
  readonly restrictions: readonly ClaudePolicyRestriction[]
  /** Parts of the value the consumer cannot apply exactly, which block their scope. */
  readonly unsupported: readonly ClaudePolicyBlocker[]
}

/**
 * One registered enforcement for a remote settings key.
 *
 * A consumer exists only where the fixed protocol schema's meaning is known: it parses the
 * remote value into restrictions it can enforce exactly, and it decides each affected
 * operation. A key with no consumer is never treated as applied.
 */
export interface ClaudePolicyConsumer {
  /** Remote settings key the consumer owns, for example `permissions`. */
  readonly key: string
  /** The scope this consumer decides. */
  readonly scope: ClaudePolicyScope
  /**
   * Parse the remote value.
   * @param value - the JSON value the accepted envelope carried for this key.
   * @returns the restrictions and the parts that cannot be applied, or `undefined` when
   *   the value is outside this consumer's contract entirely.
   */
  parse(value: unknown): ClaudePolicyParseResult | undefined
  /**
   * Decide one operation.
   * @param request - the operation being decided.
   * @param restrictions - this consumer's restrictions that reach the request.
   * @returns the decision; a consumer never returns an allow it cannot justify.
   */
  decide(
    request: ClaudePolicyCheckRequest,
    restrictions: readonly ClaudePolicyRestriction[],
  ): ClaudePolicyDecision
}

/**
 * A remote settings key's fixed treatment when no consumer owns it.
 *
 * `blocked` is the fail-closed default: a key that could restrict an operation and has no
 * enforcement stops that operation rather than being ignored. The other two are recorded
 * outcomes for keys whose verified meaning needs no enforcement in this plugin at all.
 */
type ClaudePolicyKeyTreatment =
  /** No consumer: operations in this scope are refused while the key is present. */
  | 'blocked'
  /** The restriction is already satisfied by construction (the surface does not exist here). */
  | 'satisfied'
  /** The key is a default preference, not a restriction; it is reported, not enforced. */
  | 'preference'

/** One key's fixed scope and unhandled treatment. */
interface ClaudePolicyKeySchema {
  scope: ClaudePolicyScope
  treatment: ClaudePolicyKeyTreatment
  detail: string
}

/**
 * Scope and fail-closed treatment of the remote settings keys whose meaning the adopted
 * evidence fixes. A key outside this table is unknown, so it takes the fail-closed default
 * with scope `unknown` — the reach of an unknown restriction includes every operation.
 */
const CLAUDE_POLICY_KEY_SCHEMA: Readonly<Record<string, ClaudePolicyKeySchema>> = Object.freeze({
  permissions: { scope: 'tool', treatment: 'blocked', detail: 'tool permission rules' },
  disableBypassPermissionsMode: {
    scope: 'tool',
    treatment: 'blocked',
    detail: 'bypass-permissions mode restriction',
  },
  sandbox: { scope: 'execution', treatment: 'blocked', detail: 'sandbox restriction' },
  isolation: { scope: 'execution', treatment: 'blocked', detail: 'isolation restriction' },
  managedMcpServers: { scope: 'mcp', treatment: 'blocked', detail: 'managed MCP servers' },
  allowedMcpServers: { scope: 'mcp', treatment: 'blocked', detail: 'MCP server allow list' },
  deniedMcpServers: { scope: 'mcp', treatment: 'blocked', detail: 'MCP server deny list' },
  allowManagedMcpServersOnly: {
    scope: 'mcp',
    treatment: 'blocked',
    detail: 'managed-only MCP servers',
  },
  enableAllProjectMcpServers: { scope: 'mcp', treatment: 'blocked', detail: 'project MCP servers' },
  env: { scope: 'execution', treatment: 'blocked', detail: 'remote environment injection' },
  hooks: { scope: 'execution', treatment: 'blocked', detail: 'remote hooks' },
  apiKeyHelper: { scope: 'execution', treatment: 'blocked', detail: 'remote credential helper' },
  // `model` states a preferred default; it denies nothing, so it is not enforced as an
  // allow list and never blocks an operation.
  model: { scope: 'model', treatment: 'preference', detail: 'preferred default model' },
  // Remote control is a Claude client surface this plugin does not implement, so the
  // restriction holds by construction.
  disableRemoteControl: {
    scope: 'unknown',
    treatment: 'satisfied',
    detail: 'remote control serving is absent from this plugin',
  },
})

/** The scope and treatment one accepted key's value receives. */
export interface ClaudePolicyKeyState {
  key: string
  scope: ClaudePolicyScope
  /** What happened to the value: enforced, reported, or blocking. */
  disposition: 'enforced' | 'not-applicable' | 'preference' | 'blocked'
  /** The key's fixed detail text, or the reason it blocked. */
  detail: string
}

/** An accepted remote policy snapshot, isolated by account, organization, origin and protocol fingerprint. */
export interface ClaudePolicySnapshot {
  /** Identity the snapshot was accepted for. */
  identity: {
    account: string
    origin: string
    protocolFingerprint: string
    organization?: string
  }
  /** The server's own checksum, sent back as `If-None-Match` on the next conditional read. */
  checksum: string
  /** The envelope's own revision identifier. */
  revision: string
  /** When the snapshot was accepted, in epoch milliseconds. */
  acceptedAt: number
  /**
   * The validated settings document the envelope carried, kept so the projection can be
   * re-derived against the consumers in force — after a restart in particular. It is a
   * cache of the server's own answer: it is never merged into Cordis config, the
   * environment, the tool catalog or a download.
   */
  settings: Record<string, unknown>
  /** What happened to each key the envelope carried. */
  keys: readonly ClaudePolicyKeyState[]
  /** Restrictions an operation check can enforce. */
  restrictions: readonly ClaudePolicyRestriction[]
  /** Parts of the accepted policy that could not be applied. */
  blockers: readonly ClaudePolicyBlocker[]
}

/** What one settings read produced. */
export type ClaudePolicyReadOutcome =
  /** A 200 envelope was accepted. */
  | { readonly outcome: 'accepted'; readonly snapshot: ClaudePolicySnapshot }
  /** The endpoint's fixed empty-success statuses, accepted as an empty remote snapshot. */
  | { readonly outcome: 'empty'; readonly snapshot: ClaudePolicySnapshot }
  /** A 304 that revalidated the cached snapshot for the same identity. */
  | { readonly outcome: 'unchanged'; readonly snapshot: ClaudePolicySnapshot }
  /** The provider refused this account; no retry and no switch to another account. */
  | { readonly outcome: 'refused'; readonly failure: ClaudeMaintenanceFailure }
  /** The credential was rejected; the caller may refresh and retry exactly once. */
  | { readonly outcome: 'unauthorized'; readonly failure: ClaudeMaintenanceFailure }
  /** A transport or server failure; a cached snapshot stays valid. */
  | { readonly outcome: 'transient'; readonly failure: ClaudeMaintenanceFailure }
  /** A malformed envelope or an invalid 304; a cached snapshot stays valid and the blocker, when present, denies its scope. */
  | { readonly outcome: 'invalid'; readonly failure: ClaudeMaintenanceFailure; readonly blocker?: ClaudePolicyBlocker }
  /** The caller cancelled. */
  | { readonly outcome: 'cancelled' }

/** The outer bound on a settings response body this module will read. */
export const CLAUDE_POLICY_BODY_LIMIT = 1_048_576

/**
 * Classify one non-success settings response.
 *
 * Implemented by the reliability module's single HTTP classifier, so a client-version
 * refusal or a permission refusal discovered here carries the same decision — including
 * the hard-stop disposition — that the Messages path produces. This module never keeps a
 * second mapping of provider codes.
 * @param response - the response to classify, with its body still unread.
 * @param context - the read the response answered.
 * @returns the structured decision, or `undefined` when the classifier does not own it.
 */
export type ClaudePolicyHttpClassifier = (
  response: Response,
  context: { account: string; origin: string; protocolFingerprint: string },
) => Promise<ClaudeMaintenanceFailure | undefined>

/** Everything one settings read needs. */
export interface ClaudePolicyReadInput {
  /** The identity the snapshot is isolated by. */
  identity: ClaudePolicySnapshot['identity']
  /** Canonical account key. */
  account: string
  /** Access token to authenticate the read. */
  accessToken: string
  /** Previously accepted snapshot for this identity, when there is one. */
  cached?: ClaudePolicySnapshot
  /** Current epoch milliseconds. */
  now: number
  /** Registered consumers, by key. */
  consumers: ReadonlyMap<string, ClaudePolicyConsumer>
  /** The injected conditional fetch. */
  fetchSettings: ClaudePolicyFetchFn
  /** The unified failure classifier; absent maps every non-success status generically. */
  classifyHttpFailure?: ClaudePolicyHttpClassifier
  /** Caller cancellation. */
  signal?: AbortSignal
}

/**
 * Format one server checksum as an `If-None-Match` entity tag.
 *
 * The pinned client sends the cached checksum quoted; a value that already carries quotes
 * is sent as it arrived rather than double-quoted.
 * @param checksum - the server's checksum.
 * @returns the entity tag to send.
 */
export function claudeIfNoneMatch(checksum: string): string {
  return checksum.startsWith('"') && checksum.endsWith('"') ? checksum : `"${checksum}"`
}

/**
 * Whether a JSON value is a non-null, non-array object.
 * @param value - the value to check.
 * @returns true when the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A response body text read under a hard byte bound, or the reason it could not be read. */
async function readBoundedText(response: Response, limit: number): Promise<{ text: string; truncated: boolean } | undefined> {
  const body = response.body
  if (body === null) {
    try {
      const text = await response.text()
      return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
    } catch {
      // A body that cannot be read at all is a malformed envelope, which the caller classifies.
      return undefined
    }
  }
  const reader = body.getReader()
  try {
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      bytes += value.byteLength
      if (bytes > limit) {
        text += decoder.decode(value.subarray(0, Math.max(value.byteLength - (bytes - limit), 0)), { stream: true })
        await reader.cancel().catch(() => undefined)
        return { text, truncated: true }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { text, truncated: false }
  } catch {
    await reader.cancel().catch(() => undefined)
    return undefined
  } finally {
    releaseReader(reader)
  }
}

/**
 * Release one response-body reader on every path.
 *
 * A reader left locked keeps the response body pinned and prevents the transport from
 * reusing the connection. A release that races a cancel is contained: the read's own
 * outcome is what the caller classifies, never this bookkeeping.
 * @param reader - the reader to release.
 */
function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // A release racing a cancel is the one case the stream may refuse; nothing is pending.
  }
}

/**
 * Read the managed settings once.
 *
 * The statuses follow the pinned client: 200 validates the `{uuid, checksum, settings}`
 * envelope, 204/404 are the endpoint's own empty-success semantics, a 304 is valid only
 * against a cached checksum for the same identity, and a transport failure keeps the
 * accepted snapshot. A redirected response is never read as the pinned endpoint. Every
 * other status goes to the injected unified classifier, so a version or permission refusal
 * keeps its own decision — a hard stop included — instead of becoming a generic retry.
 * @param input - the identity, credential, cache, classifier and injected fetch for this read.
 * @returns what the read produced, with the snapshot that the caller should keep.
 */
export async function readClaudeManagedSettings(input: ClaudePolicyReadInput): Promise<ClaudePolicyReadOutcome> {
  // A validator is sent only for a snapshot of THIS identity whose server checksum is
  // non-empty. The empty-success sentinel has no validator, and a snapshot accepted under
  // another organization, origin or protocol configuration is not this identity's cache.
  const cached = input.cached !== undefined && claudeIdentityKey(input.cached.identity) === claudeIdentityKey(input.identity)
    ? input.cached
    : undefined
  const validator = cached !== undefined && cached.checksum.length > 0
    ? claudeIfNoneMatch(cached.checksum)
    : undefined
  const request: ClaudePolicyFetchRequest = {
    account: input.account,
    accessToken: input.accessToken,
    ...validator === undefined ? {} : { ifNoneMatch: validator },
    ...input.signal === undefined ? {} : { signal: input.signal },
  }
  // Read through a call, so every check sees the signal as it is at that moment: the abort
  // can land between two branches, and a narrowed comparison would miss it.
  const cancelled = (): boolean => input.signal?.aborted === true
  let response: Response
  try {
    response = await input.fetchSettings(request)
  } catch (error: unknown) {
    if (cancelled()) return { outcome: 'cancelled' }
    return { outcome: 'transient', failure: claudePolicyFailure('network_error', input, error) }
  }
  if (cancelled()) {
    await discardPolicyBody(response)
    return { outcome: 'cancelled' }
  }
  if (response.redirected) {
    await discardPolicyBody(response)
    return {
      outcome: 'invalid',
      failure: claudePolicyFailure('redirected', input, undefined, response.status),
      blocker: claudeDocumentBlocker('the settings endpoint redirected away from its pinned target'),
    }
  }
  if (response.status === 304) {
    // Only a validator actually sent can be revalidated: an empty sentinel has no checksum,
    // and a snapshot of another identity never contributed one.
    if (cached === undefined || validator === undefined) {
      await discardPolicyBody(response)
      return {
        outcome: 'invalid',
        failure: claudePolicyFailure('unexpected_304', input, undefined, 304),
        blocker: claudeDocumentBlocker('the endpoint reported 304 without a request checksum'),
      }
    }
    await discardPolicyBody(response)
    return { outcome: 'unchanged', snapshot: { ...cached, acceptedAt: input.now } }
  }
  if (response.status === 204 || response.status === 404) {
    await discardPolicyBody(response)
    return {
      outcome: 'empty',
      snapshot: {
        identity: input.identity,
        checksum: '',
        revision: '',
        acceptedAt: input.now,
        settings: {},
        keys: [],
        restrictions: [],
        blockers: [],
      },
    }
  }
  if (response.status === 200) {
    const bounded = await readBoundedText(response, CLAUDE_POLICY_BODY_LIMIT)
    // An abort that surfaced as an unreadable body is a cancellation, not a malformed
    // response: the caller's own decision outranks the read's bookkeeping.
    if (cancelled()) return { outcome: 'cancelled' }
    if (bounded === undefined) {
      return {
        outcome: 'invalid',
        failure: claudePolicyFailure('unreadable_body', input, undefined, 200),
        blocker: claudeDocumentBlocker('the settings response body could not be read'),
      }
    }
    if (bounded.truncated) {
      return {
        outcome: 'invalid',
        failure: claudePolicyFailure('body_over_limit', input, undefined, 200),
        blocker: claudeDocumentBlocker(`the settings body exceeded ${String(CLAUDE_POLICY_BODY_LIMIT)} bytes`),
      }
    }
    const envelope = parseClaudePolicyEnvelope(bounded.text)
    if (envelope === undefined) {
      return {
        outcome: 'invalid',
        failure: claudePolicyFailure('parse_error', input, undefined, 200),
        blocker: claudeDocumentBlocker('the settings response did not carry the uuid/checksum/settings envelope'),
      }
    }
    const projection = projectClaudePolicy(envelope.settings, input.consumers)
    return {
      outcome: 'accepted',
      snapshot: {
        identity: input.identity,
        checksum: envelope.checksum,
        revision: envelope.uuid,
        acceptedAt: input.now,
        settings: envelope.settings,
        keys: projection.keys,
        restrictions: projection.restrictions,
        blockers: projection.blockers,
      },
    }
  }
  const classified = await input.classifyHttpFailure?.(response, {
    account: input.account,
    origin: input.identity.origin,
    protocolFingerprint: input.identity.protocolFingerprint,
  })
  await discardPolicyBody(response)
  if (classified !== undefined && classified.retryDisposition === 'forbid') {
    return { outcome: 'refused', failure: classified }
  }
  const failure = classified ?? claudePolicyFailure(`http_${String(response.status)}`, input, undefined, response.status)
  if (response.status === 401) return { outcome: 'unauthorized', failure }
  if (response.status === 403) return { outcome: 'refused', failure }
  return { outcome: 'transient', failure }
}

/** Release a response body this module will not read. */
async function discardPolicyBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch (cancelError: unknown) {
    // A failed or locked body does not change the status the response already reported.
    void cancelError
  }
}

/** The document-level blocker a response that could not be validated produces. */
function claudeDocumentBlocker(detail: string): ClaudePolicyBlocker {
  return { key: '(envelope)', scope: 'unknown', code: 'POLICY_UNSUPPORTED', detail }
}

/**
 * Project one accepted settings document into restrictions, key states and blockers.
 *
 * Every key the document carries is accounted for: a key with a registered consumer is
 * parsed by that consumer, a key whose verified meaning needs no enforcement here is
 * recorded as such, and anything else blocks its scope. No value is silently dropped.
 * @param settings - the accepted envelope's settings object.
 * @param consumers - registered consumers, by key.
 * @returns the projection and the key states describing it.
 */
export function projectClaudePolicy(
  settings: Record<string, unknown>,
  consumers: ReadonlyMap<string, ClaudePolicyConsumer>,
): { restrictions: ClaudePolicyRestriction[]; blockers: ClaudePolicyBlocker[]; keys: ClaudePolicyKeyState[] } {
  const restrictions: ClaudePolicyRestriction[] = []
  const blockers: ClaudePolicyBlocker[] = []
  const keys: ClaudePolicyKeyState[] = []
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) {
      // An explicit null removes a remote rule; there is nothing to enforce or to block.
      keys.push({ key, scope: CLAUDE_POLICY_KEY_SCHEMA[key]?.scope ?? 'unknown', disposition: 'not-applicable', detail: 'remote rule removed' })
      continue
    }
    const consumer = consumers.get(key)
    if (consumer !== undefined) {
      const parsed = consumer.parse(value)
      if (parsed === undefined) {
        const blocker = claudeUnsupportedBlocker(key, consumer.scope, 'the remote value is outside the consumer contract')
        blockers.push(blocker)
        keys.push({ key, scope: consumer.scope, disposition: 'blocked', detail: blocker.detail })
        continue
      }
      restrictions.push(...parsed.restrictions)
      blockers.push(...parsed.unsupported)
      keys.push({
        key,
        scope: consumer.scope,
        disposition: parsed.unsupported.length === 0 ? 'enforced' : 'blocked',
        detail: parsed.unsupported.length === 0 ? 'enforced by a registered consumer' : 'partly unsupported',
      })
      continue
    }
    const schema = CLAUDE_POLICY_KEY_SCHEMA[key]
    if (schema === undefined) {
      const blocker = claudeUnsupportedBlocker(key, 'unknown', 'unknown remote setting with no known consumer')
      blockers.push(blocker)
      keys.push({ key, scope: 'unknown', disposition: 'blocked', detail: blocker.detail })
      continue
    }
    if (schema.treatment === 'blocked') {
      const blocker = claudeUnsupportedBlocker(key, schema.scope, schema.detail)
      blockers.push(blocker)
      keys.push({ key, scope: schema.scope, disposition: 'blocked', detail: blocker.detail })
      continue
    }
    keys.push({
      key,
      scope: schema.scope,
      disposition: schema.treatment === 'satisfied' ? 'not-applicable' : 'preference',
      detail: schema.detail,
    })
  }
  return { restrictions, blockers, keys }
}

/** One `POLICY_UNSUPPORTED` blocker for a key with no exact enforcement. */
function claudeUnsupportedBlocker(key: string, scope: ClaudePolicyScope, detail: string): ClaudePolicyBlocker {
  return { key, scope, code: 'POLICY_UNSUPPORTED', detail: `${key}: ${detail}` }
}

/** The validated envelope of a 200 response. */
export interface ClaudePolicyEnvelope {
  uuid: string
  checksum: string
  settings: Record<string, unknown>
}

/**
 * Validate the fixed response envelope `{uuid, checksum, settings}`.
 *
 * The envelope schema accepts exactly these keys: `uuid` and `checksum` are response-level
 * identifiers and `settings` is the policy object. A response that does not satisfy all
 * three is a parse error, never an empty policy.
 * @param text - the response body text.
 * @returns the envelope, or `undefined` when the body is not a valid envelope.
 */
export function parseClaudePolicyEnvelope(text: string): ClaudePolicyEnvelope | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const uuid = parsed.uuid
  const checksum = parsed.checksum
  const settings = parsed.settings
  if (typeof uuid !== 'string' || uuid.length === 0) return undefined
  if (typeof checksum !== 'string' || checksum.length === 0) return undefined
  if (!isRecord(settings)) return undefined
  return { uuid, checksum, settings }
}

/** Structured failure facts for one settings-read outcome, without a provider body. */
function claudePolicyFailure(
  reason: string,
  input: ClaudePolicyReadInput,
  cause: unknown,
  status?: number,
): ClaudeMaintenanceFailure {
  void cause
  return {
    reason,
    stage: 'managed-settings',
    scope: 'account',
    origin: input.identity.origin,
    protocolFingerprint: input.identity.protocolFingerprint,
    ...status === undefined ? {} : { status },
  }
}

/**
 * Decide one operation against an accepted snapshot.
 *
 * A blocker whose scope reaches the operation refuses it; so does a restriction whose key
 * has no registered consumer at decision time, because a restriction that cannot be
 * enforced exactly must not be dropped. Everything else is delegated to the consumer.
 * @param request - the operation being decided.
 * @param snapshot - the accepted snapshot, when one exists.
 * @param consumers - registered consumers, by key.
 * @returns whether the operation may run.
 */
export function decideClaudePolicy(
  request: ClaudePolicyCheckRequest,
  snapshot: ClaudePolicySnapshot | undefined,
  consumers: ReadonlyMap<string, ClaudePolicyConsumer>,
): ClaudePolicyDecision {
  if (snapshot === undefined) return { decision: 'allow', reason: 'no remote policy accepted yet' }
  const requested = requestedScopes(request)
  const blocker = snapshot.blockers.find(entry => policyScopeReaches(entry.scope, requested))
  if (blocker !== undefined) return { decision: 'deny', code: blocker.code, blocker }
  const reaching = snapshot.restrictions.filter(entry => policyScopeReaches(entry.scope, requested))
  for (const restriction of reaching) {
    const consumer = consumers.get(restriction.key)
    if (consumer === undefined) {
      return {
        decision: 'deny',
        code: 'POLICY_UNSUPPORTED',
        blocker: claudeUnsupportedBlocker(restriction.key, restriction.scope, 'no consumer is registered for this restriction'),
      }
    }
    const decision = consumer.decide(request, [restriction])
    if (decision.decision === 'deny') return decision
  }
  return { decision: 'allow' }
}

/** One parsed permission rule: a wire tool name and whether it carried a specifier. */
interface ClaudePermissionRule {
  tool: string
  specifier?: string
}

/**
 * Parse one `Tool` or `Tool(specifier)` permission rule.
 * @param rule - the rule string from the remote value.
 * @returns the parsed rule, or `undefined` when the string is not a rule at all.
 */
export function parseClaudePermissionRule(rule: string): ClaudePermissionRule | undefined {
  const trimmed = rule.trim()
  const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\(([\s\S]*)\))?$/u.exec(trimmed)
  if (match === null) return undefined
  const specifier = match[2]
  return { tool: match[1], ...specifier === undefined ? {} : { specifier } }
}

/** Options for {@link claudePermissionConsumer}. */
export interface ClaudePermissionConsumerOptions {
  /**
   * Exact wire tool name to DSH tool name map. A rule naming a tool outside this map is
   * unsupported, so the operation it would restrict is refused rather than ignored.
   */
  toolAliases: Readonly<Record<string, string>>
  /**
   * Whether a rule specifier — for example `Bash(npm test:*)` — has an exact,
   * already-verified translation for one wire tool name. Absent means every specifier is
   * unsupported, which blocks the tool scope instead of guessing at a pattern language.
   */
  specifierMatchers?: Readonly<Record<string, (specifier: string, tool: string) => boolean>>
}

/**
 * Build the `permissions` consumer.
 *
 * Only the meanings the fixed schema states are enforced: `deny` rules refuse a tool,
 * `ask` rules require a consent surface this plugin does not own (reported as
 * consent-required, which blocks the tool scope), and `disableBypassPermissionsMode`
 * refuses bypass mode. A rule whose specifier has no verified translation blocks the tool
 * scope with `POLICY_UNSUPPORTED`; it is never interpreted as a pattern language.
 * @param options - the exact tool alias map and any verified specifier matchers.
 * @returns the consumer to register for the `permissions` key.
 */
export function claudePermissionConsumer(options: ClaudePermissionConsumerOptions): ClaudePolicyConsumer {
  return {
    key: 'permissions',
    scope: 'tool',
    parse: (value: unknown): ClaudePolicyParseResult | undefined => {
      if (!isRecord(value)) return undefined
      const restrictions: ClaudePolicyRestriction[] = []
      const unsupported: ClaudePolicyBlocker[] = []
      for (const list of ['deny', 'ask'] as const) {
        const rules = value[list]
        if (rules === undefined) continue
        if (!Array.isArray(rules)) {
          unsupported.push({
            key: 'permissions',
            scope: 'tool',
            code: 'POLICY_INVALID_VALUE',
            detail: `permissions.${list} is not an array of rules`,
          })
          continue
        }
        for (const rule of rules) {
          if (typeof rule !== 'string' || rule.trim().length === 0) {
            unsupported.push({
              key: 'permissions',
              scope: 'tool',
              code: 'POLICY_INVALID_VALUE',
              detail: `permissions.${list} carries a rule that is not a non-empty string`,
            })
            continue
          }
          const parsed = parseClaudePermissionRule(rule)
          const dshTool = parsed === undefined ? undefined : options.toolAliases[parsed.tool]
          if (parsed === undefined || dshTool === undefined) {
            unsupported.push({
              key: 'permissions',
              scope: 'tool',
              code: 'POLICY_UNSUPPORTED',
              detail: `permissions.${list} rule "${rule}" names no tool this build maps exactly`,
            })
            continue
          }
          if (parsed.specifier !== undefined) {
            const matcher = options.specifierMatchers?.[parsed.tool]
            if (matcher === undefined) {
              unsupported.push({
                key: 'permissions',
                scope: 'tool',
                code: 'POLICY_UNSUPPORTED',
                detail: `permissions.${list} rule "${rule}" carries a specifier with no verified translation`,
              })
              continue
            }
            restrictions.push({
              key: 'permissions',
              scope: 'tool',
              kind: list === 'deny' ? 'deny-tool-specifier' : 'ask-tool-specifier',
              value: { tool: dshTool, specifier: parsed.specifier, matches: matcher },
            })
            continue
          }
          restrictions.push({
            key: 'permissions',
            scope: 'tool',
            kind: list === 'deny' ? 'deny-tool' : 'ask-tool',
            value: { tool: dshTool },
          })
        }
      }
      const bypass = value.disableBypassPermissionsMode
      if (bypass !== undefined) {
        if (bypass === 'disable') {
          restrictions.push({ key: 'permissions', scope: 'tool', kind: 'deny-bypass-mode', value: {} })
        } else {
          unsupported.push({
            key: 'permissions',
            scope: 'tool',
            code: 'POLICY_INVALID_VALUE',
            detail: 'permissions.disableBypassPermissionsMode carries an unknown value',
          })
        }
      }
      return { restrictions, unsupported }
    },
    decide: (request: ClaudePolicyCheckRequest, restrictions: readonly ClaudePolicyRestriction[]): ClaudePolicyDecision => {
      for (const restriction of restrictions) {
        const value = restriction.value
        if (!isRecord(value)) continue
        if (restriction.kind === 'deny-bypass-mode' && request.bypassPermissions === true) {
          return {
            decision: 'deny',
            code: 'POLICY_UNSUPPORTED',
            blocker: {
              key: 'permissions',
              scope: 'tool',
              code: 'POLICY_UNSUPPORTED',
              detail: 'remote policy disables bypass-permissions mode for this account',
            },
          }
        }
        const tool = typeof value.tool === 'string' ? value.tool : undefined
        if (tool === undefined || request.tool !== tool) continue
        if (restriction.kind === 'ask-tool' || restriction.kind === 'ask-tool-specifier') {
          return {
            decision: 'deny',
            code: 'POLICY_CONSENT_REQUIRED',
            blocker: {
              key: 'permissions',
              scope: 'tool',
              code: 'POLICY_CONSENT_REQUIRED',
              detail: `remote policy requires a recorded approval before running ${tool}`,
            },
          }
        }
        if (restriction.kind === 'deny-tool-specifier') {
          const matcher = value.matches
          const specifier = typeof value.specifier === 'string' ? value.specifier : undefined
          if (typeof matcher === 'function' && specifier !== undefined
            && (matcher as (specifier: string, tool: string) => boolean)(specifier, tool)) {
            return {
              decision: 'deny',
              code: 'POLICY_UNSUPPORTED',
              blocker: {
                key: 'permissions',
                scope: 'tool',
                code: 'POLICY_UNSUPPORTED',
                detail: `remote policy denies ${tool} for the matching invocation`,
              },
            }
          }
          continue
        }
        return {
          decision: 'deny',
          code: 'POLICY_UNSUPPORTED',
          blocker: {
            key: 'permissions',
            scope: 'tool',
            code: 'POLICY_UNSUPPORTED',
            detail: `remote policy denies the ${tool} tool for this account`,
          },
        }
      }
      return { decision: 'allow' }
    },
  }
}

/**
 * Build the consumer registry the maintenance owner and its operation checks share.
 *
 * The registry is passed by reference to every decision, so the projection and the
 * enforcement always read one set of consumers.
 * @param consumers - the consumers to register, in order; a later duplicate key wins.
 * @returns the registry keyed by remote settings key.
 */
export function claudePolicyConsumers(
  consumers: readonly ClaudePolicyConsumer[],
): Map<string, ClaudePolicyConsumer> {
  const registry = new Map<string, ClaudePolicyConsumer>()
  for (const consumer of consumers) registry.set(consumer.key, consumer)
  return registry
}
