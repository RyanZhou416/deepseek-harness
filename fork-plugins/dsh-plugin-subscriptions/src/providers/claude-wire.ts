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
  modelCapability,
} from '@tormentalabs/claude-code-wire-compat'
import { desktopClientHeaders } from './claude-desktop.js'
import { unifiedRateLimitFor } from './unified-rate-limit.js'
import type {
  BuiltClaudeCodeRequest,
  ClaudeCodeEffort,
  ClaudeCodeRequestInput,
} from '@tormentalabs/claude-code-wire-compat'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ClaudeSession } from '../auth/store.js'
import type { TranslatableMessage } from '../translate/resolved.js'
import { toAnthropicMessages, toAnthropicSystem, toAnthropicTools } from '../translate/anthropic.js'
import { resolveSuppressBetas } from '../claude-engine/request-policy.js'
import type { ClaudeEnginePolicy } from '../claude-engine/request-policy.js'
import { oversizeWireError } from './claude-images.js'
import { CLAUDE_PROTOCOL_PROFILE, claudeRoleHeaders } from './claude-protocol.js'

/**
 * Pinned CLI identity this route presents on every subscription endpoint.
 *
 * The compatibility profile owns the claim; this is the name the request-building path
 * already used for it.
 */
export const CLAUDE_USER_AGENT: string = CLAUDE_PROTOCOL_PROFILE.userAgent

/**
 * The user agent the client uses on endpoints that are not the transport.
 *
 * The client has two: the transport one carries the entrypoint clause (what
 * {@link CLAUDE_USER_AGENT} is), and the plain one is `claude-code/<version>` with no
 * qualifier. Bootstrap, the OAuth profile read and the Files API use the plain form, so a
 * client process emits both and this plugin has to as well.
 */
export const CLAUDE_PLAIN_USER_AGENT = CLAUDE_PROTOCOL_PROFILE.plainUserAgent

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
interface BoundedTwoLevelMap<V> {
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
 * The per-request facts the continuation owner prepared before this request is built.
 *
 * Every member is an explicit input. The wire session identity is the one the span store committed
 * for this request's span, the pin is the one that span froze (or nothing when it sends none), and
 * the previous request id is the one the log-derived selector chose — none of them is minted,
 * looked up or defaulted here, because a second source for any of them would disagree with the
 * durable one after a restart.
 */
export interface ClaudeWireContinuation {
  /** The wire session identity this request declares. */
  readonly sessionId: string
  /** The `x-cc-atis` token the span froze, or undefined when it sends none. */
  readonly atisPin: string | undefined
  /** The earlier turn's `request-id` this request chains, or undefined when it chains none. */
  readonly previousRequestId: string | undefined
}

/**
 * The shape the client gives both the session identity it declares and the
 * `session_id` its correlation metadata carries.
 */
const WIRE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
 * The `speed` field a request carries for one session's tier.
 *
 * The client sends the field only on the fast tier, and it is also what the pinned builder
 * reads to push `fast-mode-2026-02-01`, so the body value and the beta identifier are decided
 * from this one input. Standard routing is the field's absence: a `"standard"` literal would be
 * a request no client sends.
 *
 * @param fast - whether the session serving this request selected the fast tier.
 * @returns the field to spread into the builder input, or nothing on standard routing.
 */
export function claudeSpeedField(fast: boolean): Pick<ClaudeCodeRequestInput, 'speed'> {
  return fast ? { speed: 'fast' } : {}
}

/**
 * The OAuth scope the client reads to treat an account as a subscriber; the plan label a
 * profile read returns is not part of that decision.
 */
const USER_INFERENCE_SCOPE = 'user:inference'

/**
 * The cache ttl a request declares, computed as the client computes it.
 *
 * Only a `main` request whose granted scopes include `user:inference`, and whose account is not
 * drawing on overage, declares an hour. An explicit `auxiliary`, `subagent` or `compaction`
 * class, a helper purpose (`compaction`, `session-title`), and an account on overage omit the
 * field, so the server's own default applies. The beta that declares the longer ttl follows the
 * field rather than the account. An explicit class outranks purpose for both the field and the
 * header; the client's source allowlist excludes subagent, so it takes the default. The overage
 * reading is the account's already-captured unified rate-limit report, so this performs no I/O;
 * a plan label is not an input.
 *
 * @param session - the account whose request this is.
 * @param account - the canonical account key that report is filed under.
 * @param purpose - the call kind the caller classified, when it classified one.
 * @param requestClass - the caller's explicit call class, which outranks purpose.
 * @returns whether the request declares the longer ttl.
 */
function usesExtendedCacheTtl(
  session: ClaudeSession,
  account: string,
  purpose: GenerateOptions['purpose'],
  requestClass: GenerateOptions['requestClass'],
): boolean {
  if (claudeRequestClass(purpose, requestClass) !== 'main') return false
  if (!session.scopes.split(/\s+/).includes(USER_INFERENCE_SCOPE)) return false
  const report = unifiedRateLimitFor('claude', account)
  const onOverage = report?.status === 'rejected'
    && (report.overageStatus === 'allowed' || report.overageStatus === 'allowed_warning')
  return !onOverage
}

/**
 * The harness sections a client-shaped request never carries.
 *
 * `harness:source` names the on-disk harness checkout, and `app:web-surface` names the
 * harness's own Web GUI, its loopback endpoint, and that GUI's dev-server contract. Both
 * describe this deployment rather than the client the request claims to be, and neither is a
 * fact about the work: the route's own identity line already states that the user reads its
 * replies in a local client.
 *
 * The harness identity section is deliberately not listed. What the model is told about its
 * own environment is a deployment decision — the harness exposes `includeHarnessIdentity` and
 * the persona for it — and removing it here would also discard a deployment's replacement.
 */
const HARNESS_LOCAL_SECTIONS: ReadonlySet<string> = new Set(['harness:source', 'app:web-surface'])

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
const DEFAULT_CLAUDE_IDENTITY_LINE = `You are an AI coding agent running inside a local agent harness on the user's machine.
The tools listed in this request are the complete and authoritative set available to you: call them exactly as documented, and ignore tool names, commands, and workflows that belong to other environments. Shell commands run on the user's machine in the workspace the request context describes, and the user reads your replies in a local client.`

/**
 * The platform the anchored identity claims, and the architecture with it.
 *
 * The pinned profile is the Windows desktop, so these are constants rather than this
 * host's values: a client reporting `claude-desktop` for Windows while sending another
 * platform, or an architecture that application is not built for, contradicts itself, and
 * a host-specific value would also identify the operator.
 *
 * The runtime version is deliberately NOT pinned with them. The client reports the
 * version of the runtime that performs the fetch, so a constant names a runtime that
 * issued nothing: this route reports `process.version` of whichever runtime sends the
 * request, and the Bun transport reports its own.
 */
export const CLAUDE_CLIENT_OS = 'Windows'

/** Architecture the Windows desktop application is built for. */
export const CLAUDE_CLIENT_ARCH = 'x64'

const CLAUDE_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

/** The request effort when it is a wire-legal Claude effort id. */
function claudeEffort(value: string | undefined): ClaudeCodeEffort | undefined {
  if (value === undefined || !CLAUDE_EFFORTS.has(value)) return undefined
  return value as ClaudeCodeEffort
}

/**
 * The request class the client reports for the call kind this route is issuing.
 *
 * The client derives the header from the query source that spawned the request: a compact query
 * reports `compaction`, and its own session-title generator runs under the
 * `generate_session_title` source, which reports `auxiliary`, and a delegated child reports
 * `subagent`.
 *
 * The client sends the header unconditionally on an ordinary first-party session: its emission
 * predicate short-circuits true at the host check, so the feature flag that would otherwise
 * decide emission is reached only for a base URL that is not Anthropic's own — a case this route
 * never produces. The header therefore carries the request class as its value on every request
 * here. The caller's explicit `requestClass` outranks purpose; `subagent` is reachable when a
 * delegated child session runs on this route. `workflow` remains unreachable.
 *
 * @param purpose - the provider-neutral classification the caller set on the request.
 * @param requestClass - the caller's explicit call class, when it set one.
 * @returns the class the genuine client would report for that call kind.
 */
export function claudeRequestClass(
  purpose: GenerateOptions['purpose'],
  requestClass: GenerateOptions['requestClass'],
): NonNullable<ClaudeCodeRequestInput['requestClass']> {
  if (requestClass !== undefined) return requestClass
  if (purpose === 'compaction') return 'compaction'
  if (purpose === 'session-title') return 'auxiliary'
  return 'main'
}

/**
 * Refuse a conversation shape that a withholding policy cannot express.
 *
 * The mid-conversation betas are what carry a system role inside the conversation. When a policy
 * withholds them, such a message has no wire form this route may send, and rewriting it as a
 * top-level prompt would send a request the caller never asked for. A leading system message is a
 * different thing: it opens the conversation and states the same instruction the top-level system
 * prompt carries, so it stays legal.
 * @param messages - the translated conversation.
 * @param model - the model the request is for.
 * @throws LlmError naming the unsupported shape, with a forbidding retry disposition.
 */
export function assertPolicyRequestShape(messages: readonly TranslatableMessage[], model: string): void {
  void model
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'system' || index === 0) continue
    // A local policy decision, not a server statement about this client's version: reporting it as
    // a version refusal would block the shared provider profile and send the user to an upgrade
    // that cannot help. The message is fixed and carries no part of the conversation.
    throw new LlmError(
      'claude request shape unsupported under the account policy: a mid-conversation system message cannot be expressed while that policy withholds the mid-conversation betas',
      'POLICY_UNSUPPORTED',
      { retryDisposition: 'forbid' },
    )
  }
}

/**
 * Build the pinned Claude Code request for one attempt.
 * @param options - the caller's generate options.
 * @param session - the account session the request is made under.
 * @param messages - the translated conversation.
 * @param maxTokens - the output cap for this request.
 * @param thinking - the thinking parameter, when the model takes one.
 * @param effort - the requested effort level, when the model takes one.
 * @param continuation - the wire session identity, sent pin and chained request id the durable
 *   owner prepared for this request; each is used exactly as given.
 * @param account - the account the request is billed to.
 * @param identityLine - the deployment's own identity line, when it configured one.
 * @param fast - whether this session selected the fast tier.
 * @param policy - the caller's resolved policy, when it stated one.
 * @returns the built request: pinned URL, header plan, and serialized body.
 */
export async function buildClaudeWireRequest(
  options: GenerateOptions,
  session: ClaudeSession,
  messages: readonly TranslatableMessage[],
  maxTokens: number,
  thinking: ClaudeWireThinking | undefined,
  effort: string | undefined,
  continuation: ClaudeWireContinuation,
  account: string,
  identityLine?: string,
  fast = false,
  policy?: ClaudeEnginePolicy,
): Promise<BuiltClaudeCodeRequest> {
  const sessionId = continuation.sessionId
  if (session.deviceId === undefined || session.accountUuid === undefined) {
    throw new Error('dsh-plugin-subscriptions: claude wire identity is missing; backfill it before building')
  }
  // The client's session identity is a UUID in both places it appears — the
  // `X-Claude-Code-Session-Id` header and the `session_id` of its correlation
  // metadata — so a value of any other shape is a request no client sends.
  if (!WIRE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new LlmError(
      `claude request assembly failed: the wire session id "${sessionId}" is not a UUID, the only shape the client declares its session in`,
      'INVALID_REQUEST',
    )
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
  // The harness's own sections describe this deployment rather than the client: the identity
  // line names the product, the source section names the checkout, and the Web surface section
  // names the harness's GUI and its loopback endpoint. A request shaped as the client carries
  // the client's own identity block, so sending them leaves the model with two identities, a
  // path that belongs to no client, and an endpoint the client never serves.
  const identity = identityLine ?? DEFAULT_CLAUDE_IDENTITY_LINE
  const sections = (options.systemSections ?? [])
    .filter(section => !HARNESS_LOCAL_SECTIONS.has(section.name))
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
  //
  // When the loop supplied the prompt as sections, those sections are the prompt's ONLY
  // carrier. The same rendered prompt is also the leading system-role message of the derived
  // history, so lifting that message into the system array would send the prompt twice — and
  // that copy is the unfiltered one, still naming the harness and the machine-local checkout
  // this route exists to keep off the wire. The builder emits the prompt once, from the
  // sections.
  const system = options.systemSections === undefined
    ? toAnthropicSystem(options.system, messages)
    : shared.length === 0
      ? identitySections.map(section => section.text)
      : [
          ...shared.map(section => section.text),
          SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
          ...identitySections.filter(section => !section.stable).map(section => section.text),
        ]
  const tools = options.tools !== undefined && options.tools.length > 0
    ? toAnthropicTools(options.tools)
    : undefined
  const resolvedEffort = claudeEffort(effort)
  // The pin belongs to this account span of the conversation, and the span store is the only owner
  // that decides it: the first request freezes it, and a bootstrap read that lands later cannot
  // change what this span sends.
  const atis = continuation.atisPin
  const suppressBetas = resolveSuppressBetas(policy)
  const built = await buildClaudeCodeRequest({
    accessToken: session.accessToken,
    model: options.model,
    maxTokens,
    // Absent when the caller states none: the pinned builder then supplies the same
    // compiled-in 1 the client does, under the capability gate the client applies.
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    messages: toAnthropicMessages(
      messages,
      options.model,
      // The same predicate that decides the beta header, so a mid-conversation system message and
      // its header are always decided together. A suppressing policy turns the predicate off: the
      // message is refused by the caller's own gate rather than degraded into a top-level prompt.
      modelCapability(options.model, 'mid_conv_system', CLAUDE_CODE_2_1_288_PROFILE)
        && resolveSuppressBetas(policy) === undefined,
    ),
    system,
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
      ...usesExtendedCacheTtl(session, account, options.purpose, options.requestClass) ? { ttl: '1h' as const } : {},
    },
    runtime: {
      sessionId,
      deviceId: session.deviceId,
      accountUuid: session.accountUuid,
      runtime: 'node',
      // The runtime that issues the request reports itself, as the genuine client's
      // SDK does. With the Bun transport active the child replaces this with its own
      // `process.version`; on the direct path this IS the sending runtime's.
      runtimeVersion: process.version,
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
    // The fast tier is one field: the pinned builder emits `speed` from it and pushes the beta
    // that declares the tier in the same composition, so nothing else here names either.
    ...claudeSpeedField(fast),
    // The caller's resolved policy, expressed in the builder's own switch: withheld exactly when
    // it said so, absent otherwise. The beta names come from the engine's helper, never a copy.
    ...suppressBetas === undefined ? {} : { suppressBetas },
    // The desktop spawns its client with API_TIMEOUT_MS=900000, and the client reports
    // that timeout as x-stainless-timeout; a bare CLI would report 600.
    stainlessTimeoutSeconds: 900,
    stream: true,
    clientRequestId: randomUUID(),
    // An explicit class wins; otherwise the purpose maps compaction and session-title to
    // their client classes, and everything else is the conversation's own Messages request.
    requestClass: claudeRequestClass(options.purpose, options.requestClass),
    ...continuation.previousRequestId === undefined ? {} : { previousRequestId: continuation.previousRequestId },
    promptId: claudePromptId(sessionId, promptTurn(messages)),
    // Messages carry the desktop platform/version pair, not the application-only
    // memory profile. These extra headers do not alter the body construction.
    extraHeaders: [
      ...Object.entries(desktopClientHeaders()) as [string, string][],
      // The client attaches the ATIS token to the requests of the conversation that was
      // handed it. Here that is the account span this request belongs to, frozen at its
      // first request, so nothing sent later in the span can change the value.
      ...atis === undefined ? [] : [['x-cc-atis', atis] as [string, string]],
    ],
  }, CLAUDE_CODE_2_1_288_PROFILE)
  return built
}
