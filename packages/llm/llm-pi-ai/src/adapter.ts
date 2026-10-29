/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import { createHash } from 'node:crypto'
import {
  attributionHeaders,
  contentHasImage,
  errorChain,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { requestImageTarget, toPiContext } from './context.ts'
import { conversationUpdates, createModels, getSupportedThinkingLevels } from './models.ts'
import { ProviderErrorCapture } from './pool-error.ts'
import { encodeSessionNameHeader, sanitizeSessionName } from './session-name.ts'
import { toStreamChunks } from './stream.ts'

/**
 * Initially active declaration added to an Anthropic request whose projected
 * tools are all deferred, because Anthropic rejects a tool list without one.
 */
const ANTHROPIC_TOOL_UPDATE_PLACEHOLDER: ToolSchema = {
  name: 'DeferredToolPlaceholder',
  description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
  parameters: { type: 'object', properties: {} },
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** The session identity header a conversation-aware Claude endpoint reads. */
const CLAUDE_SESSION_HEADER = 'X-Claude-Code-Session-Id'

/** The session display name header the pool decodes for display; never forwarded to a provider. */
const SESSION_NAME_HEADER = 'x-cc-session-name'

/** The request's ledger identity, derived once per logical request and repeated by its retries. */
const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

/** Longest session identity such an endpoint accepts. */
const MAX_SESSION_HEADER_LENGTH = 256

/**
 * Sessions whose attempt counters for diagnostics are retained. The bound caps
 * the adapter state a long-lived host accumulates; eviction only restarts
 * attempt numbering.
 */
const MAX_TRACKED_SESSIONS = 64

/**
 * One message's contribution to a logical request's identity.
 *
 * A durable message carries its own stable identity, so the request position
 * does not depend on content. A one-shot request input carries none, and
 * digesting its content is what keeps two different inputs from sharing a
 * position.
 * @param message - one message of the assembled request.
 * @returns the message's stable identity within the request.
 */
function messageIdentity(message: RequestMessage): string {
  const identity = message.id === undefined
    ? createHash('sha256').update(JSON.stringify(message.content)).digest('hex')
    : message.id
  return `${message.role}:${identity}`
}

/**
 * Derive the ledger identity of one logical request.
 *
 * The identity is the request's conversation position: its session, purpose,
 * route, model, and the messages it is about to send. Re-running the same step
 * reconstructs that position exactly, so a later attempt of it shares the base
 * identity. The value is UUID v4 shaped, the form a conversation-aware endpoint
 * accepts as a client request id.
 * @param provider - the route serving the request.
 * @param model - the resolved model on that route.
 * @param options - the assembled request.
 * @returns a stable UUID-shaped base identity for this logical request.
 */
function logicalRequestId(provider: string, model: string, options: GenerateOptions): string {
  const digest = createHash('sha256').update(JSON.stringify([
    options.sessionId === undefined ? '' : String(options.sessionId),
    options.purpose ?? '',
    provider,
    model,
    options.messages.map(messageIdentity),
  ])).digest()
  return uuidV4(digest)
}

/**
 * Derive one attempt's wire ledger identity from its logical request.
 *
 * A deliberate retry opens a new attempt at the same conversation position, and
 * a shared-account pool records the attempt id it receives as a terminal ledger
 * entry. Resending the logical id would therefore be read as a replay and
 * refused once the first entry closed; the per-attempt nonce keeps each attempt
 * distinct while leaving repeated dispatches of one attempt stable.
 * @param logicalId - the logical request's base identity.
 * @param attemptNonce - the loop's nonce for this attempt, when it is a retry.
 * @returns the identity this attempt sends to the endpoint.
 */
function attemptRequestId(logicalId: string, attemptNonce: string | undefined): string {
  if (attemptNonce === undefined) return logicalId
  const digest = createHash('sha256').update(`${logicalId}\n${attemptNonce}`).digest()
  return uuidV4(digest)
}

/**
 * Render digest bytes as the RFC 9562 §5.4 UUID v4 shape a conversation-aware
 * endpoint parses.
 * @param digest - at least 16 digest bytes.
 * @returns the UUID-shaped identity.
 */
function uuidV4(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Whether a session id is printable ASCII 1..{@link MAX_SESSION_HEADER_LENGTH}
 * characters, the only form the member endpoint of a shared-account pool
 * accepts for the session header. It is a durable key and an echoed response
 * header there, so control characters and unbounded values are refused rather
 * than truncated.
 * @param value - the request's session id.
 * @returns true when the endpoint would accept the value.
 */
function isSessionHeaderValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SESSION_HEADER_LENGTH) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/**
 * The Claude Code identity headers one opted-in route stamps on a request.
 *
 * The session header carries the request's own session id unchanged, so every
 * turn and tool continuation of one conversation presents the same identity and
 * the endpoint can keep one conversation key and prompt identity. The request id
 * is the attempt's ledger identity: each deliberate retry sends a new value, so
 * an endpoint that records the id as a terminal ledger entry does not read the
 * next attempt as a replay of the closed one; repeated dispatches of one attempt
 * keep the same value. The name header is the pool's display label: the name is
 * sanitized to the pool's accepted display set, encoded for the header field,
 * and omitted when no usable name remains.
 * @param provider - route the request targets, for diagnostics.
 * @param sessionId - the request's session id, when the caller supplied one.
 * @param clientRequestId - this attempt's ledger identity.
 * @param sessionName - the owning session's display name, when it has one.
 * @returns the headers to merge into the provider request.
 * @throws LlmError when the session id is not a value the endpoint accepts.
 */
function sessionIdentityHeaders(
  provider: string,
  sessionId: string | undefined,
  clientRequestId: string,
  sessionName: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { [CLIENT_REQUEST_ID_HEADER]: clientRequestId }
  const sanitized = sessionName === undefined ? undefined : sanitizeSessionName(sessionName)
  const name = sanitized === undefined ? undefined : encodeSessionNameHeader(sanitized)
  if (name !== undefined) headers[SESSION_NAME_HEADER] = name
  if (sessionId === undefined) return headers
  if (!isSessionHeaderValue(sessionId)) {
    throw new LlmError(
      `pi-ai provider "${provider}" cannot send its session id as ${CLAUDE_SESSION_HEADER}:`
      + ` expected printable ASCII, 1 to ${MAX_SESSION_HEADER_LENGTH} characters`,
      'INVALID_REQUEST',
    )
  }
  headers[CLAUDE_SESSION_HEADER] = sessionId
  return headers
}

/**
 * Identity every diagnostic record of one request attempt carries. None of it
 * is conversation content.
 */
export interface PiAiRequestIdentity {
  /** Route the request targets. */
  readonly provider: string
  /** Model id on that route. */
  readonly model: string
  /** Effective endpoint URL the route sends to. */
  readonly endpoint: string
  /** The request's session id, when the caller supplied one. */
  readonly sessionId?: string
  /** This attempt's wire ledger identity; a deliberate retry of the same request sends a new value. */
  readonly clientRequestId: string
  /** Whether the response is streamed; this adapter only requests streams. */
  readonly stream: true
  /** 1-based attempt number within its logical request. */
  readonly attempt: number
}

/** One attempt's settled response, with non-content failure facts. */
export interface PiAiResponseDiagnostic extends PiAiRequestIdentity {
  /** HTTP status of the provider response, when one arrived. */
  readonly status?: number
  /** Pool-issued request id echoed by the response, when the pool issued one. */
  readonly poolRequestId?: string
  /** Stable harness failure code, when the attempt failed. */
  readonly code?: string
  /** Provider or transport failure message, when the attempt failed. */
  readonly message?: string
  /** Rendered cause chain of a thrown failure, when it carried one. */
  readonly cause?: string
}

/**
 * One diagnostic record of a provider request attempt: the request about to be
 * sent, or the response that settled it.
 */
export type PiAiRequestDiagnostic =
  | ({ readonly kind: 'request' } & PiAiRequestIdentity)
  | ({ readonly kind: 'response' } & PiAiResponseDiagnostic)

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call, and by `listModels`, which offers no
   * models while it throws `MISSING_CREDENTIAL`. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Provider routes whose requests carry the Claude Code session identity
   * (`X-Claude-Code-Session-Id` from the request's session id plus the logical
   * request's ledger `x-client-request-id`). Empty or omitted leaves every route
   * untouched.
   */
  sessionHeaders?: ReadonlySet<string>
  /**
   * Observe every provider request attempt and its settled response: the
   * route, model, endpoint, session, ledger id, attempt number, HTTP status,
   * pool request id, and failure facts. The callback never receives messages,
   * request bodies, credentials, or token counts. Omitting it leaves the
   * adapter silent.
   */
  onRequestDiagnostic?: (event: PiAiRequestDiagnostic) => void
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/** Anthropic beta that permits a one-hour prompt-cache lifetime on the markers. */
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/** The one-hour `cache_control` value the four-marker policy writes on each slot. */
function cc4CacheControl(): Record<string, string> {
  return { type: 'ephemeral', ttl: '1h' }
}

/**
 * Assistant content types that end a message with no place for a breakpoint.
 *
 * A marker on either would cache no assistant content, and the policy does not
 * search earlier blocks: the trailing block is the message's whole prefix
 * boundary.
 */
const UNCACHEABLE_ASSISTANT_TAIL: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking'])

/**
 * Whether provider payload data can carry request fields.
 * @param value - any value pi-ai hands an `onPayload` hook.
 * @returns whether the value is a plain JSON object.
 */
function isRequestPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copy one request object without its `cache_control` field.
 * @param value - a system block, tool declaration, or message content block.
 * @returns the same fields without the marker.
 */
function withoutCacheControl(value: Record<string, unknown>): Record<string, unknown> {
  const { cache_control: _cacheControl, ...rest } = value
  return rest
}

/**
 * Read one array field of a request object.
 * @param value - any field pi-ai placed on the request.
 * @returns the array elements as unknown values, or undefined when the field is not an array.
 */
function arrayOf(value: unknown): unknown[] | undefined {
  // `Array.isArray` narrows `unknown` to `any[]`; the assertion restores the
  // element type this module actually handles without weakening the check.
  return Array.isArray(value) ? value as unknown[] : undefined
}

/**
 * Copy one block without its `cache_control` field.
 * @param value - a block pi-ai built for the request.
 * @returns the block without the marker.
 */
function stripBlock(value: unknown): unknown {
  /* v8 ignore next -- pi-ai builds every block as an object; the guard keeps a future value from a dereference */
  if (!isRequestPayload(value)) return value
  return withoutCacheControl(value)
}

/**
 * Copy one message without the markers its content blocks carried.
 * @param value - one message pi-ai built for the request.
 * @returns the message with unmarked content blocks, or the value when its content is not a block array.
 */
function stripMessage(value: unknown): unknown {
  /* v8 ignore next -- pi-ai builds every message as an object */
  if (!isRequestPayload(value)) return value
  const content = arrayOf(value['content'])
  if (content === undefined) return value
  return { ...value, content: content.map(stripBlock) }
}

/**
 * Copy one request object with the four-marker `cache_control` value added.
 * @param value - a system block, tool declaration, or message content block.
 * @returns the block carrying the explicit one-hour marker.
 */
function withCc4Marker(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, cache_control: cc4CacheControl() }
}

/**
 * The index of the last message with one role.
 * @param messages - the request's messages in wire order.
 * @param role - the message role to find.
 * @returns the last matching index, or -1 when no message has that role.
 */
function lastRoleIndex(messages: readonly unknown[], role: string): number {
  return messages.findLastIndex(message => isRequestPayload(message) && message['role'] === role)
}

/**
 * Mark the last block of one user message.
 *
 * A text-only user message is serialized as a bare string when no block needs a
 * marker; placing the marker expands it to the one-block array the transport
 * already uses for marked messages.
 * @param message - the final user message pi-ai built.
 * @returns the message with its last content block marked.
 */
function markLastUserBlock(message: Record<string, unknown>): Record<string, unknown> {
  const content = message['content']
  if (typeof content === 'string') {
    return { ...message, content: [{ type: 'text', text: content, cache_control: cc4CacheControl() }] }
  }
  const blocks = arrayOf(content)
  /* v8 ignore next 2 -- pi-ai emits user content as a string or a non-empty block array */
  if (blocks === undefined || blocks.length === 0) return message
  const last = blocks[blocks.length - 1]
  /* v8 ignore next -- pi-ai builds every content block as an object */
  if (!isRequestPayload(last)) return message
  return { ...message, content: [...blocks.slice(0, -1), withCc4Marker(last)] }
}

/**
 * Mark the last block of one assistant message, unless it cannot carry a marker.
 *
 * A trailing `thinking` or `redacted_thinking` block is the one case the policy
 * skips rather than searching backward: a marker before it would not cache the
 * reasoning that follows.
 * @param message - the final assistant message pi-ai built.
 * @returns the marked message, or undefined when its trailing block is skipped.
 */
function markLastAssistantBlock(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const blocks = arrayOf(message['content'])
  /* v8 ignore next 2 -- pi-ai emits assistant content as a non-empty block array */
  if (blocks === undefined || blocks.length === 0) return undefined
  const last = blocks[blocks.length - 1]
  /* v8 ignore next -- pi-ai builds every content block as an object */
  if (!isRequestPayload(last)) return undefined
  if (UNCACHEABLE_ASSISTANT_TAIL.has(String(last['type']))) return undefined
  return { ...message, content: [...blocks.slice(0, -1), withCc4Marker(last)] }
}

/**
 * Place the Claude Code four-marker layout on one Anthropic Messages request.
 *
 * The policy owns placement: every `cache_control` the transport or a caller
 * placed is removed from `system`, `tools`, and `messages` first, then exactly
 * the slots present are marked with `{type: "ephemeral", ttl: "1h"}`. A request
 * with no tool declaration or no assistant turn carries the smaller set rather
 * than gaining a block it did not have.
 * @param payload - the Anthropic Messages request fields pi-ai built.
 * @returns the fields with the policy's markers in place.
 */
function withCc4Markers(payload: Record<string, unknown>): Record<string, unknown> {
  const systemBlocks = arrayOf(payload['system'])
  const toolBlocks = arrayOf(payload['tools'])
  const messageBlocks = arrayOf(payload['messages'])
  const stripped: Record<string, unknown> = {
    ...payload,
    ...systemBlocks === undefined ? {} : { system: systemBlocks.map(stripBlock) },
    ...toolBlocks === undefined ? {} : { tools: toolBlocks.map(stripBlock) },
    ...messageBlocks === undefined ? {} : { messages: messageBlocks.map(stripMessage) },
  }
  const system = arrayOf(stripped['system'])
  if (system !== undefined && system.length > 0) {
    const first = system[0]
    /* v8 ignore next -- pi-ai builds every system block as an object */
    if (isRequestPayload(first)) stripped['system'] = [withCc4Marker(first), ...system.slice(1)]
  }
  const tools = arrayOf(stripped['tools'])
  if (tools !== undefined && tools.length > 0) {
    const last = tools[tools.length - 1]
    /* v8 ignore next -- pi-ai builds every tool declaration as an object */
    if (isRequestPayload(last)) stripped['tools'] = [...tools.slice(0, -1), withCc4Marker(last)]
  }
  const messages = arrayOf(stripped['messages'])
  if (messages !== undefined) {
    const marked: unknown[] = [...messages]
    const userIndex = lastRoleIndex(messages, 'user')
    if (userIndex >= 0) {
      const message = messages[userIndex]
      /* v8 ignore next -- lastRoleIndex only matches message objects */
      if (isRequestPayload(message)) marked[userIndex] = markLastUserBlock(message)
    }
    const assistantIndex = lastRoleIndex(messages, 'assistant')
    if (assistantIndex >= 0) {
      const message = messages[assistantIndex]
      /* v8 ignore next -- lastRoleIndex only matches message objects */
      if (isRequestPayload(message)) {
        const assistant = markLastAssistantBlock(message)
        if (assistant !== undefined) marked[assistantIndex] = assistant
      }
    }
    stripped['messages'] = marked
  }
  return stripped
}

/**
 * Add the extended prompt-cache TTL beta to one Anthropic Messages request.
 *
 * Appending to `betas` keeps every automatic beta pi-ai derived for the route,
 * and the Anthropic SDK turns the list into the `anthropic-beta` header. Only
 * the route option declares this beta — a `long` retention tier writes
 * `ttl: "1h"` on its markers and stays without it.
 * @param payload - the Anthropic Messages request fields.
 * @returns the fields with the beta appended, or the same object when it already declares it.
 */
function withExtendedCacheBeta(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = payload['betas']
  const betas = Array.isArray(existing)
    ? existing.filter((beta): beta is string => typeof beta === 'string')
    : []
  if (betas.includes(EXTENDED_CACHE_TTL_BETA)) return payload
  return { ...payload, betas: [...betas, EXTENDED_CACHE_TTL_BETA] }
}

/**
 * Apply one route's Anthropic payload policy.
 *
 * One hook owns both transformations, so a route never installs two
 * `onPayload` assignments: the beta alone preserves pi-ai's own markers, while
 * the four-marker policy replaces them.
 * @param payload - the Anthropic Messages request fields pi-ai built.
 * @param profile - the resolved route whose payload policy applies.
 * @returns replacement fields, or undefined to leave them as built.
 */
function withAnthropicPayloadPolicy(
  payload: unknown,
  profile: ResolvedPiAiProviderProfile,
): Record<string, unknown> | undefined {
  /* v8 ignore next -- pi-ai hands the hook the request fields it built, always an object */
  if (!isRequestPayload(payload)) return undefined
  let next = profile.cacheMarkerPolicy === 'cc4' ? withCc4Markers(payload) : payload
  if (profile.extendedCacheBeta === true) next = withExtendedCacheBeta(next)
  return next === payload ? undefined : next
}


/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the default level configured for this model or its route, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/**
 * Whether pi-ai's implementation for this protocol accepts a custom fetch.
 * Google's SDKs reject one outright, and a protocol that never reads it would
 * only add a wrapper without capturing anything.
 * @param api - the resolved model's wire protocol.
 * @returns true when a request-level fetch replacement is honored.
 */
function supportsFetchCapture(api: Api): boolean {
  return api === 'anthropic-messages' || api === 'openai-completions' || api === 'openai-responses'
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/** Header names this adapter owns on a sessionHeaders route; a profile may not set them. */
const ADAPTER_SESSION_HEADERS: ReadonlySet<string> = Object.freeze(new Set([
  CLAUDE_SESSION_HEADER,
  SESSION_NAME_HEADER,
  CLIENT_REQUEST_ID_HEADER,
].map(name => name.toLowerCase())))

/**
 * Remove adapter-owned session headers from deployment headers.
 *
 * Header names are case-insensitive, so a profile spelling
 * `x-claude-code-session-id` beside the adapter's `X-Claude-Code-Session-Id`
 * would leave two entries for one field; an HTTP client then sends one of them
 * or joins both, and the pool may bind the wrong session or read a stale ledger
 * id. The adapter's value therefore replaces the profile's under every casing.
 * @param headers - deployment headers after attribution collision removal.
 * @returns the headers without any adapter-owned session header.
 */
function withoutSessionHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !ADAPTER_SESSION_HEADERS.has(name.toLowerCase())),
  )
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined
  /** The logical request each session last attempted, for numbering attempts. */
  private readonly attempts = new Map<string, { readonly logicalId: string; readonly attempt: number }>()

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * Number one attempt within its logical request.
   *
   * A stream call that repeats the session's previous logical identity is
   * another attempt at that conversation position; anything else starts a new
   * logical request. The attempt's wire id may differ from the logical identity
   * (a deliberate retry adds its nonce), so counting stays keyed on the
   * position. The map is bounded, because it only serves diagnostics: eviction
   * restarts numbering, which is the only observable effect.
   * @param sessionId - the request's session id, when it has one.
   * @param logicalId - the request's base conversation-position identity.
   * @returns the 1-based attempt number.
   */
  private attemptOf(sessionId: string | undefined, logicalId: string): number {
    const key = sessionId ?? ''
    const previous = this.attempts.get(key)
    const attempt = previous?.logicalId === logicalId ? previous.attempt + 1 : 1
    // Re-insert so the longest-idle session is the first eviction candidate.
    this.attempts.delete(key)
    this.attempts.set(key, { logicalId, attempt })
    if (this.attempts.size > MAX_TRACKED_SESSIONS) {
      for (const oldest of this.attempts.keys()) {
        this.attempts.delete(oldest)
        break
      }
    }
    return attempt
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    const snapshot = this.current()
    this.modelOf(snapshot, provider, model)
    const profile = this.profileOf(snapshot, provider)
    return requestImageTarget(image, { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes })
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      try { await this.config.resolveApiKey(provider, profile) }
      catch (error) {
        // A route whose named key does not resolve cannot serve a request, so it offers no models until the key is stored.
        if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
        throw error
      }
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    // The model's own default wins: it picks among the levels this model
    // offers, while the route-level level is the fallback for models that name
    // none. The seam materializes the described effort into requests that name
    // none.
    const defaultLevel = describableReasoningLevel(
      resolvedModel,
      profile.defaultReasoning.get(model) ?? profile.reasoning,
    )
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
      ...conversationUpdates(resolvedModel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const diagnose = this.config.onRequestDiagnostic
    // pi-ai flattens the SDK error to its message and discards response
    // headers, so the request's single response is recorded here for the pool
    // classifier to read `Retry-After` from and for the response diagnostic.
    const providerError = new ProviderErrorCapture()
    /** The attempt's identity, absent while the request identity is still unresolved. */
    let identity: PiAiRequestIdentity | undefined
    /** Report the response that settled this attempt, with its identity fields. */
    const reportResponse = (failure?: LlmFailure, thrownCause?: string): void => {
      if (diagnose === undefined || identity === undefined) return
      const observed = providerError.readResponse()
      const status = failure?.status ?? observed?.status
      // pi-ai flattens a transport failure to its message text; the fetch
      // capture retains the original Error, so the diagnostic can still report
      // the cause chain of a request that never got a response.
      const transportError = providerError.readTransportError()
      const cause = thrownCause
        ?? (transportError === undefined ? undefined : errorChain(transportError))
      diagnose({
        kind: 'response',
        ...identity,
        ...status === undefined ? {} : { status },
        ...observed?.poolRequestId === undefined ? {} : { poolRequestId: observed.poolRequestId },
        ...failure === undefined ? {} : { code: failure.code, message: failure.message },
        ...cause === undefined ? {} : { cause },
      })
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
      // Both taken before any await: a refused session id fails without
      // resolving a credential or opening a request. The attempt number counts
      // attempts of one conversation position, while the wire id adds the
      // loop's nonce so a deliberate retry is a distinct ledger entry.
      const logicalId = logicalRequestId(options.provider, model.id, options)
      const clientRequestId = attemptRequestId(logicalId, options.attemptNonce)
      identity = Object.freeze({
        provider: options.provider,
        model: model.id,
        endpoint: model.baseUrl,
        ...sessionId === undefined ? {} : { sessionId },
        clientRequestId,
        stream: true,
        attempt: this.attemptOf(sessionId, logicalId),
      })
      diagnose?.({ kind: 'request', ...identity })
      // The session identity is adapter-owned: a refused session id fails here,
      // before the request opens, and outranks a static profile header of the
      // same name lower down.
      const sessionHeaders = this.config.sessionHeaders?.has(options.provider) === true
        ? sessionIdentityHeaders(options.provider, sessionId, clientRequestId, options.sessionName)
        : undefined
      const updates = conversationUpdates(model)
      // pi-ai collapses Anthropic tool updates without an initially active declaration.
      const tools = options.tools ?? []
      const needsPlaceholder = model.api === 'anthropic-messages' && updates.toolUpdate === 'in-history'
        && tools.every(tool => tool.deferLoading === true)
        && options.messages.some(message => message.role === 'developer'
          && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
      const request = needsPlaceholder
        ? { ...options, tools: [ANTHROPIC_TOOL_UPDATE_PLACEHOLDER, ...tools] }
        : options
      const reasoning = resolveReasoningLevel(
        model,
        options.reasoningEffort ?? profile.reasoning,
      )
      const apiKey = await this.config.resolveApiKey(options.provider, profile)
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(request, undefined, onReplayDegrade)
        : await toPiContext({ ...request, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          ...model.api === 'anthropic-messages'
            ? { maxRequestImages: model.contextWindow <= 200_000 ? 100 : 600 }
            : {},
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
            ...model.api === 'anthropic-messages'
              ? { maxDimension: (count: number) => count > 20 ? 2000 : 8000 }
              : {},
          },
        }, onReplayDegrade)
      // Profile headers are deployment-owned; attribution names are
      // Harness-owned and therefore win collisions. The session identity is
      // adapter-owned and replaces a profile header of the same name in any
      // casing, so one field never carries two conflicting values.
      const deploymentHeaders = requestHeaders(profile.headers)
      const headers = {
        ...sessionHeaders === undefined ? deploymentHeaders : withoutSessionHeaders(deploymentHeaders),
        ...sessionHeaders,
      }
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...(profile.extendedCacheBeta === true || profile.cacheMarkerPolicy === 'cc4')
          && model.api === 'anthropic-messages'
          ? { onPayload: (payload: unknown) => withAnthropicPayloadPolicy(payload, profile) }
          : {},
        ...supportsFetchCapture(model.api) ? { fetch: providerError.fetch } : {},
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        headers,
      })
      const iterator = toStreamChunks(
        events, model.contextWindow, options.signal, model.id, providerError,
      )[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            exhausted = true
            return
          }
          const chunk = result.value
          if (chunk.type === 'finish') {
            reportResponse(chunk.reason.kind === 'error' ? chunk.reason.failure : undefined)
          }
          yield chunk
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          // A demand the deadline abandoned can stay pending forever, and this
          // generator queues its return behind it; the abort above owns SDK termination.
          /* v8 ignore next -- the detached drain only rejects while unwinding an abandoned stream. */
          void iterator.return(undefined).catch(() => {})
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        const failure: LlmFailure = {
          message: `pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`,
          code: 'TIMEOUT',
        }
        reportResponse(failure, errorChain(error))
        throw new LlmError(failure.message, failure.code, { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      reportResponse(
        error instanceof LlmError ? error.failure : undefined,
        errorChain(error),
      )
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
