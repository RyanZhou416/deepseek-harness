import type { ContextManagementConfig } from '@tormentalabs/claude-code-wire-compat'
/**
 * Claude Code 2.1.288 wire construction for the claude provider, presenting the
 * Windows desktop identity.
 *
 * `buildClaudeCodeRequest` from `@tormentalabs/claude-code-wire-compat` owns
 * the pinned wire contract: the billing fingerprint and identity system
 * blocks, beta composition, correlation metadata (`user_id`), and the full
 * header plan. This module maps a resolved harness request onto that builder,
 * supplies the runtime identity and the per-session previous-request-id
 * chain, and keeps the pinned profile as the single source of the CLI
 * identity impersonated on the wire.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  CLAUDE_CODE_2_1_288_PROFILE,
  ClaudeCodeWireError,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  buildClaudeCodeRequest,
  supportsContextManagement,
  supportsMidConversationSystem,
} from '@tormentalabs/claude-code-wire-compat'
import { desktopClientHeaders, desktopMachineProfile } from './claude-desktop.js'
import { clientAtisFor } from './claude.js'
import type {
  BuiltClaudeCodeRequest,
  ClaudeCodeEffort,
} from '@tormentalabs/claude-code-wire-compat'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ClaudeSession } from '../auth/store.js'
import type { TranslatableMessage } from '../translate/resolved.js'
import { toAnthropicMessages, toAnthropicSystem, toAnthropicTools } from '../translate/anthropic.js'
import { oversizeWireError } from './claude-images.js'

/** Pinned CLI identity this route presents on every subscription endpoint. */
export const CLAUDE_USER_AGENT: string = CLAUDE_CODE_2_1_288_PROFILE.userAgent

/**
 * The user agent the client uses on endpoints that are not the transport.
 *
 * The client has two: the transport one carries the entrypoint clause (what
 * {@link CLAUDE_USER_AGENT} is), and the plain one is `claude-code/<version>` with no
 * qualifier. Bootstrap, the OAuth profile read and the Files API use the plain form, so a
 * client process emits both and this plugin has to as well.
 */
export const CLAUDE_PLAIN_USER_AGENT = `claude-code/${CLAUDE_CODE_2_1_288_PROFILE.cliVersion}`

/*
 * Anchored to the Windows desktop release: the desktop application pins Claude Code
 * 2.1.288, spawns this same client with the `claude-desktop` entrypoint, and adds the
 * client headers below. A desktop session and a CLI session therefore differ by the
 * entrypoint and those headers, not by the request's shape.
 */

/** The `thinking` object this module maps onto the wire (display is fixed here). */
export interface ClaudeWireThinking {
  type: 'enabled' | 'adaptive'
  budgetTokens?: number
}

/** A two-level string-keyed table whose total leaf count is bounded. */
export interface BoundedTwoLevelMap<V> {
  /**
   * @param outer - first-level key.
   * @param inner - second-level key.
   * @returns the value stored under both keys, or undefined.
   */
  get(outer: string, inner: string): V | undefined
  /**
   * @param outer - first-level key.
   * @returns whether that entry holds any leaf.
   */
  isEmpty(outer: string): boolean
  /**
   * Store a value under both keys; a leaf that already exists is replaced in
   * place. A new leaf inserted at the limit evicts the table's oldest leaf.
   * @param outer - first-level key.
   * @param inner - second-level key.
   * @param value - value to store.
   */
  set(outer: string, inner: string, value: V): void
  /**
   * @param outer - first-level key whose leaves are all dropped.
   */
  deleteOuter(outer: string): void
  /** Drop every leaf. */
  clear(): void
}

/**
 * Delete the oldest leaf of a two-level table, freeing one slot for growth.
 * @param entries - the table to evict from.
 */
function evictOldestLeaf<V>(entries: Map<string, Map<string, V>>): void {
  for (const [outer, leaves] of entries) {
    const oldest = leaves.keys().next().value
    if (oldest !== undefined) {
      leaves.delete(oldest)
      if (leaves.size === 0) entries.delete(outer)
      return
    }
  }
}

/**
 * Build a bounded two-level table.
 *
 * Leaf order is insertion order across the whole table: at the limit the
 * oldest leaf — the first leaf of the first non-empty first-level entry — is
 * evicted, and a first-level entry disappears with its last leaf. What the two
 * key levels mean and what the limit is belong to the caller.
 * @param limit - maximum number of leaves kept.
 * @returns a table bounded to that many leaves.
 */
export function boundedTwoLevelMap<V>(limit: number): BoundedTwoLevelMap<V> {
  const entries = new Map<string, Map<string, V>>()
  let size = 0
  return {
    get: (outer, inner) => entries.get(outer)?.get(inner),
    isEmpty: outer => (entries.get(outer)?.size ?? 0) === 0,
    set: (outer, inner, value) => {
      let leaves = entries.get(outer)
      if (leaves === undefined) {
        leaves = new Map()
        entries.set(outer, leaves)
      }
      if (!leaves.has(inner)) {
        if (size >= limit) evictOldestLeaf(entries)
        size += 1
      }
      leaves.set(inner, value)
    },
    deleteOuter: (outer) => {
      const leaves = entries.get(outer)
      if (leaves === undefined) return
      size -= leaves.size
      entries.delete(outer)
    },
    clear: () => {
      entries.clear()
      size = 0
    },
  }
}

/**
 * Bounded per-account, per-session conversation-chaining state: the last
 * response `request-id`, chained as `cc_prev_req` by the next request of the
 * same conversation. Keyed by the canonical account key first, so a pool
 * switching accounts mid-session never chains one account's request id into
 * another account's requests. Upstream semantics: a response without a
 * request-id clears the chained id.
 */
interface ClaudeChainState {
  previousRequestId?: string
}

const CHAIN_LIMIT = 256
/** Account key → session id → chain state. */
const chains = boundedTwoLevelMap<ClaudeChainState>(CHAIN_LIMIT)

function chainFor(account: string, sessionId: string): ClaudeChainState {
  const existing = chains.get(account, sessionId)
  if (existing !== undefined) return existing
  const state: ClaudeChainState = {}
  chains.set(account, sessionId, state)
  return state
}

/**
 * Wire session ids per account span.
 *
 * A genuine Claude Code conversation runs under one account, so a pool
 * failover mid-session must not continue the first account's wire session
 * under the second account's identity. The first account span reuses the
 * harness session id verbatim (single-account sessions are byte-identical to
 * before), and every later account span gets a fresh UUID; switching back
 * resumes the original id and chain.
 */
const WIRE_SESSION_LIMIT = 256
/** Harness session id → account → stable wire session id. */
const wireSessions = boundedTwoLevelMap<string>(WIRE_SESSION_LIMIT)

/**
 * The wire session id for one account span of a harness session.
 * @param account - the canonical account key serving this request.
 * @param harnessSessionId - the harness session the conversation belongs to.
 * @returns the stable `x-claude-code-session-id` for this (account, session).
 */
export function claudeWireSessionId(account: string, harnessSessionId: string): string {
  const existing = wireSessions.get(harnessSessionId, account)
  if (existing !== undefined) return existing
  // The first account span keeps the harness id; later spans roll a new one.
  const wireId = wireSessions.isEmpty(harnessSessionId) ? harnessSessionId : randomUUID()
  wireSessions.set(harnessSessionId, account, wireId)
  return wireId
}

/**
 * Record the response `request-id` the billing block of the next request in
 * this account's session chains as `cc_prev_req`. A response without the
 * header clears the chained id, matching the genuine client's continuity
 * commit.
 * @param account - the canonical account key the response belonged to.
 * @param sessionId - the harness session the response belongs to.
 * @param requestId - the `request-id` response header, or null when absent.
 */
export function rememberClaudeRequestId(account: string, sessionId: string, requestId: string | null): void {
  const state = chainFor(account, sessionId)
  if (requestId === null) {
    delete state.previousRequestId
    return
  }
  state.previousRequestId = requestId
}

/**
 * The ordinal of the user prompt turn a request belongs to: one per user message
 * that carries no tool result.
 *
 * A turn's tool-continuation steps repeat the same history prefix and so count the
 * same turn; the next user prompt adds one. The count comes from the request's own
 * history rather than from process state, so rebuilding a request renders the same
 * id it rendered the first time.
 */
function promptTurn(messages: readonly TranslatableMessage[]): number {
  let turn = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.content.some(block => block.type === 'tool-result')) continue
    turn += 1
  }
  return turn
}

/**
 * The `cc_prompt_id` segment of the billing block: the request id for this turn.
 *
 * The genuine client mints a fresh UUIDv4 per user prompt turn and reuses it across
 * that turn's tool continuations. A random id there would be model-visible text that
 * no session event records, so this route derives it from the session identity and
 * the turn instead: the same session and turn always render the same bytes, and two
 * sessions never render the same id.
 *
 * @param sessionId - the wire session identity the request declares.
 * @param turn - the prompt turn ordinal within that session.
 * @returns a UUID-shaped id, the only form in which the block emits the segment; the
 *   digest carries a UUIDv4's version and variant nibbles.
 */
export function claudePromptId(sessionId: string, turn: number): string {
  const bytes = Buffer.from(createHash('sha256').update(`claude-prompt-id:${sessionId}:${turn}`).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Map a wire-builder rejection onto a harness error. `INPUT_TOO_LARGE` goes
 * through the logged image-offload path; every other code names a request
 * this assembly layer must reject, so it surfaces as INVALID_REQUEST with
 * the wire code instead of a generic transport failure.
 * @param error - the thrown builder error.
 * @param messages - resolved images in wire order, for the offload mapping.
 * @returns the mapped LlmError, or undefined for a non-wire error.
 */
export function mapClaudeWireError(error: unknown, messages: readonly TranslatableMessage[]): LlmError | undefined {
  if (!(error instanceof ClaudeCodeWireError)) return undefined
  if (error.code === 'INPUT_TOO_LARGE') return oversizeWireError(messages)
  const details = Object.entries(error.safeDetails).length === 0
    ? ''
    : ` (${JSON.stringify(error.safeDetails)})`
  const message = `claude request assembly failed: ${error.code}${details}`
  switch (error.code) {
    case 'INVALID_THINKING':
      return new LlmError(`${message} — the selected model does not accept this thinking configuration`, 'INVALID_REQUEST', { cause: error })
    case 'INVALID_EFFORT':
      return new LlmError(`${message} — the selected model does not accept this reasoning effort`, 'INVALID_REQUEST', { cause: error })
    case 'UNSUPPORTED_CAPABILITY':
      return new LlmError(`${message} — the pinned wire profile does not support this capability`, 'INVALID_REQUEST', { cause: error })
    case 'CRYPTO_UNAVAILABLE':
      return new LlmError(`${message} — the runtime lacks WebCrypto (globalThis.crypto.subtle)`, 'INVALID_REQUEST', { cause: error })
    case 'INVALID_IDENTITY':
      return new LlmError(`${message} — the account wire identity is malformed; log in again via Settings → Subscriptions`, 'INVALID_REQUEST', { cause: error })
    case 'INVALID_UNICODE':
      return new LlmError(`${message} — request text contains characters the wire rejects`, 'INVALID_REQUEST', { cause: error })
    default:
      return new LlmError(message, 'INVALID_REQUEST', { cause: error })
  }
}

/**
 * The cache ttl a request declares, computed as the client computes it.
 *
 * The client resolves one ttl per request: an hour when the account is a subscription and is
 * not drawing on overage, and otherwise the server's own default, which it expresses by
 * leaving the field out — and the beta header that declares the longer ttl is pushed only
 * when the field is there. A session whose profile lookup never disclosed a subscription is
 * therefore treated as having none, which sends the server's default rather than an hour.
 *
 * One input the client has and this does not: whether the account is currently in overage,
 * which the client reads from the usage it tracks. Nothing on the request-building path knows
 * that today, so an account in overage would still declare the hour here.
 *
 * @param session - the account whose request this is.
 * @returns whether the request declares the longer ttl.
 */
function usesExtendedCacheTtl(session: ClaudeSession): boolean {
  const subscription = session.subscriptionType
  return subscription !== undefined && subscription !== 'free'
}

/**
 * The one harness section a client-shaped request never carries: `harness:source` names the
 * on-disk checkout of the harness, a machine-local path that belongs to no client.
 *
 * The harness identity section is deliberately not listed. What the model is told about its
 * own environment is a deployment decision — the harness exposes `includeHarnessIdentity` and
 * the persona for it — and removing it here would also discard a deployment's replacement.
 */
const MACHINE_LOCAL_SECTIONS: ReadonlySet<string> = new Set(['harness:source'])

/** The harness section whose text a Claude request replaces with the deployment's own line. */
const HARNESS_IDENTITY_SECTION = 'harness:identity'

/**
 * The identity a Claude request carries when the deployment sets no line.
 *
 * It describes the environment rather than naming a product: what the agent is, that its tool
 * list is authoritative, and where its commands run. A client-shaped request carries the
 * client's own identity block as well, so this line is what keeps the model from reading that
 * block as a description of its toolset.
 */
export const DEFAULT_CLAUDE_IDENTITY_LINE = `You are an AI coding agent running inside a local agent harness on the user's machine.
The tools listed in this request are the complete and authoritative set available to you: call them exactly as documented, and ignore tool names, commands, and workflows that belong to other environments. Shell commands run on the user's machine in the workspace the request context describes, and the user reads your replies in a local client.`

/**
 * The platform the anchored identity claims, and the architecture with it.
 *
 * The pinned profile is the Windows desktop, so these are constants rather than this
 * host's values: a client reporting `claude-desktop` for Windows while sending another
 * platform, or an architecture that application is not built for, contradicts itself, and
 * a host-specific value would also identify the operator. The runtime version is pinned
 * for the same reason, so a request never varies with the machine that sent it.
 */
export const CLAUDE_CLIENT_OS = 'Windows'

/** Architecture the Windows desktop application is built for. */
export const CLAUDE_CLIENT_ARCH = 'x64'

/** Runtime version reported in place of this host's, so it cannot drift per machine. */
export const CLAUDE_CLIENT_RUNTIME_VERSION = '24.13.0'

const CLAUDE_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

/** The request effort when it is a wire-legal Claude effort id. */
function claudeEffort(value: string | undefined): ClaudeCodeEffort | undefined {
  if (value === undefined || !CLAUDE_EFFORTS.has(value)) return undefined
  return value as ClaudeCodeEffort
}

/**
 * Build the pinned Claude Code wire request for one generate call.
 *
 * The stored session must already carry `deviceId` and `accountUuid`; the
 * adapter backfills both before calling here.
 *
 * Two harness sampling options map onto this request shape differently. A
 * `temperature` is the caller's own value on every request the pinned builder
 * emits the field for, which is what the client sends: the caller's override, or
 * its compiled-in 1, on the models whose profile gives them the parameter. Stop
 * sequences have no field in this shape — the client's main-session request
 * carries none — so a caller asking for one is refused instead of being sent a
 * request that cannot halt on it.
 * @param options - the harness generate request.
 * @param session - the account session whose token the request uses.
 * @param messages - conversation messages with images resolved.
 * @param maxTokens - the resolved output cap.
 * @param thinking - the wire thinking parameter, when the model takes one.
 * @param effort - the reasoning effort, when the model advertises efforts.
 * @param sessionId - the harness session id used as the Claude Code session identity.
 * @param account - the canonical account key owning this conversation's chain state.
 * @returns the built request: pinned URL, header plan, and serialized body.
 */
export async function buildClaudeWireRequest(
  options: GenerateOptions,
  session: ClaudeSession,
  messages: readonly TranslatableMessage[],
  maxTokens: number,
  thinking: ClaudeWireThinking | undefined,
  effort: string | undefined,
  sessionId: string,
  account: string,
  identityLine?: string,
  contextManagement?: ContextManagementConfig,
): Promise<BuiltClaudeCodeRequest> {
  if (session.deviceId === undefined || session.accountUuid === undefined) {
    throw new Error('dsh-plugin-subscriptions: claude wire identity is missing; backfill it before building')
  }
  // An empty list asks for nothing and is not a caller statement about this
  // option, so it passes through as absence.
  if (options.stop !== undefined && options.stop.length > 0) {
    throw new LlmError(
      'claude request assembly failed: the pinned request shape has no stop-sequence field, so GenerateOptions.stop cannot take effect on this route',
      'INVALID_REQUEST',
    )
  }
  // No reporting block is injected. The carve defines the reporting text once and
  // every consumer of it reads the block out of an array that already contains it;
  // no site pushes it into a request, and the block is not part of the standard
  // prompt text, so a genuine request does not carry it. Injecting it would add a
  // block no genuine client sends — distinguishable in the opposite direction from
  // the one this work exists to close. The library seam stays available for a
  // caller that has a capture proving otherwise.
  // The loop splits the rendered prompt at the boundary its sections declared; when it did,
  // the two halves go out as the client's static and dynamic sides. Otherwise the prompt is
  // passed whole, exactly as before.
  // The loop hands the prompt over as its assembled sections. Sections whose contributor
  // declared them stable go first, separated from the session-specific remainder by the
  // marker the wire builder splits on: it joins each side into one block, leaves the identity
  // block unmarked, and gives the shared side the global cache scope. Text after the marker
  // keeps its assembly order, and the leading system-role messages stay last because they are
  // session content. Without the section list the prompt is passed whole.
  // Two of the harness's own sections describe a different product: the identity line names
  // the harness, and the source section names a machine-local checkout path. A request shaped
  // as the client carries the client's own identity block, so sending either leaves the model
  // with two identities and a path that belongs to no client.
  const identity = identityLine ?? DEFAULT_CLAUDE_IDENTITY_LINE
  const sections = (options.systemSections ?? [])
    .filter(section => !MACHINE_LOCAL_SECTIONS.has(section.name))
    // The harness identity section becomes this route's own line. A configured line is a
    // deployment's text rather than a compiled-in one, so it is never claimed as shareable.
    .map(section => section.name === HARNESS_IDENTITY_SECTION
      ? { name: section.name, text: identity, stable: section.stable && identityLine === undefined }
      : section)
    .filter(section => section.text.length > 0)
  // A deployment that turns the harness identity off still gets this route's own line: the
  // model needs to know its tool list is authoritative, and the client block it also carries
  // describes a different toolset.
  const identitySections = options.systemSections === undefined || sections.some(section => section.name === HARNESS_IDENTITY_SECTION)
    ? sections
    : [{ name: HARNESS_IDENTITY_SECTION, text: identity, stable: false }, ...sections]
  const shared = identitySections.filter(section => section.stable)
  // The filter and the identity replacement apply whether or not any section is stable, so a
  // deployment whose sections are all session-specific still sends neither the machine-local
  // path nor a second identity.
  const system = options.systemSections === undefined
    ? toAnthropicSystem(options.system, messages)
    : shared.length === 0
      ? [...identitySections.map(section => section.text), ...toAnthropicSystem(undefined, messages)]
      : [
          ...shared.map(section => section.text),
          SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
          ...identitySections.filter(section => !section.stable).map(section => section.text),
          ...toAnthropicSystem(undefined, messages),
        ]
  const tools = options.tools !== undefined && options.tools.length > 0
    ? toAnthropicTools(options.tools)
    : undefined
  const resolvedEffort = claudeEffort(effort)
  const atis = clientAtisFor(account)
  const chain = chainFor(account, sessionId)
  return buildClaudeCodeRequest({
    accessToken: session.accessToken,
    model: options.model,
    maxTokens,
    // Absent when the caller states none: the pinned builder then supplies the same
    // compiled-in 1 the client does, under the capability gate the client applies.
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    messages: toAnthropicMessages(
      messages,
      options.model,
      // The same predicate that decides the beta header, so a mid-conversation
      // system message and its header are always decided together.
      supportsMidConversationSystem(options.model, CLAUDE_CODE_2_1_288_PROFILE),
    ),
    system,
    // The edits go out only where the catalogue gives the model context management, so the
    // request never states a policy the API would reject and the beta header follows the same
    // fact. Absent, the body is byte-identical to one built without this parameter.
    ...contextManagement === undefined || !supportsContextManagement(options.model)
      ? {}
      : { contextManagement },
    ...tools === undefined ? {} : { tools },
    // Caching on, with a marker on the system block and on the newest message. No tool
    // marker: the client's only tool-marker seam is an option its main-loop tool builder
    // never passes, so a genuine request carries three markers where a tool breakpoint made
    // ours four. The ttl is computed the way the client computes it, and the beta that
    // declares the longer ttl follows it rather than being sent unconditionally.
    cacheControl: {
      enabled: true,
      systemBreakpoint: true,
      toolBreakpoint: false,
      messageBreakpoint: true,
      ...usesExtendedCacheTtl(session) ? { ttl: '1h' as const } : {},
    },
    runtime: {
      sessionId,
      deviceId: session.deviceId,
      accountUuid: session.accountUuid,
      runtime: 'node',
      runtimeVersion: CLAUDE_CLIENT_RUNTIME_VERSION,
      os: CLAUDE_CLIENT_OS,
      arch: CLAUDE_CLIENT_ARCH,
      // This route is a programmatic client that supplies its own system prompt: the
      // headless shape, which selects the standalone agent identity line rather than
      // the interactive CLI one. The entrypoint and user agent come from the pinned
      // profile, which records `claude-desktop`.
      invocation: { isNonInteractive: true, hasAppendSystemPrompt: false },
    },
    // The display value is a per-version wire fact, so it belongs to the pinned
    // profile rather than to this adapter: overriding it here sent the wrong value
    // for the current release.
    ...thinking === undefined ? {} : { thinking },
    ...resolvedEffort === undefined
      ? {}
      : { effort: resolvedEffort, outputConfig: { effort: resolvedEffort } },
    // The desktop spawns its client with API_TIMEOUT_MS=900000, and the client reports
    // that timeout as x-stainless-timeout; a bare CLI would report 600.
    stainlessTimeoutSeconds: 900,
    stream: true,
    clientRequestId: randomUUID(),
    ...chain.previousRequestId === undefined ? {} : { previousRequestId: chain.previousRequestId },
    promptId: claudePromptId(sessionId, promptTurn(messages)),
    // The desktop identity. These names are not canonical for this package, so the
    // default strict policy accepts them; they are non-cacheable request headers and
    // do not disturb the body's own construction. The machine values are derived from
    // the account rather than read from this host, so one account presents one machine
    // and no two accounts present the same one.
    extraHeaders: [
      ...Object.entries(desktopClientHeaders()) as [string, string][],
      // The client attaches the ATIS token to every request it sends through the
      // first-party client, once a bootstrap read has disclosed one.
      ...atis === undefined ? [] : [['x-cc-atis', atis] as [string, string]],
    ],
  }, CLAUDE_CODE_2_1_288_PROFILE)
}
