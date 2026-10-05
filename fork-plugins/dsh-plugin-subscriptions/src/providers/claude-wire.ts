/**
 * Claude Code 2.1.280 wire construction for the claude provider.
 *
 * `buildClaudeCodeRequest` from `@tormentalabs/claude-code-wire-compat` owns
 * the pinned wire contract: the billing fingerprint and identity system
 * blocks, beta composition, correlation metadata (`user_id`), and the full
 * header plan. This module maps a resolved harness request onto that builder,
 * supplies the runtime identity and the per-session previous-request-id
 * chain, and keeps the pinned profile as the single source of the CLI
 * identity impersonated on the wire.
 */

import { randomUUID } from 'node:crypto'
import {
  buildClaudeCodeRequest,
  CLAUDE_CODE_2_1_280_PROFILE,
  ClaudeCodeWireError,
} from '@tormentalabs/claude-code-wire-compat'
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
export const CLAUDE_USER_AGENT: string = CLAUDE_CODE_2_1_280_PROFILE.userAgent

/** The `thinking` object this module maps onto the wire (display is fixed here). */
export interface ClaudeWireThinking {
  type: 'enabled' | 'adaptive'
  budgetTokens?: number
}

/**
 * Bounded per-account, per-session conversation-chaining state: the last
 * response `request-id` (chained as `cc_prev_req`) and the current user
 * turn's `cc_prompt_id`. Keyed by the canonical account key first, so a pool
 * switching accounts mid-session never chains one account's request id into
 * another account's requests. Upstream semantics: the prompt id is a UUIDv4
 * minted on each new user prompt turn and reused across that turn's tool
 * continuations, and a response without a request-id clears the chained id.
 */
interface ClaudeChainState {
  previousRequestId?: string
  promptId?: string
}

const CHAIN_LIMIT = 256
/** Account key → session id → chain state. */
const chains = new Map<string, Map<string, ClaudeChainState>>()
let chainCount = 0

/** Delete one oldest leaf from a two-level map, freeing one slot for growth. */
function evictOldest<K, V>(twoLevel: Map<K, Map<string, V>>): void {
  for (const [outer, inner] of twoLevel) {
    const oldest = inner.keys().next().value
    if (oldest !== undefined) {
      inner.delete(oldest)
      if (inner.size === 0) twoLevel.delete(outer)
      return
    }
  }
}

function chainFor(account: string, sessionId: string): ClaudeChainState {
  let bySession = chains.get(account)
  if (bySession === undefined) {
    bySession = new Map()
    chains.set(account, bySession)
  }
  const existing = bySession.get(sessionId)
  if (existing !== undefined) return existing
  if (chainCount >= CHAIN_LIMIT) {
    evictOldest(chains)
    chainCount -= 1
  }
  const state: ClaudeChainState = {}
  bySession.set(sessionId, state)
  chainCount += 1
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
const wireSessions = new Map<string, Map<string, string>>()
let wireSessionCount = 0

/**
 * The wire session id for one account span of a harness session.
 * @param account - the canonical account key serving this request.
 * @param harnessSessionId - the harness session the conversation belongs to.
 * @returns the stable `x-claude-code-session-id` for this (account, session).
 */
export function claudeWireSessionId(account: string, harnessSessionId: string): string {
  let byAccount = wireSessions.get(harnessSessionId)
  if (byAccount === undefined) {
    byAccount = new Map()
    wireSessions.set(harnessSessionId, byAccount)
  }
  const existing = byAccount.get(account)
  if (existing !== undefined) return existing
  if (wireSessionCount >= WIRE_SESSION_LIMIT) {
    evictOldest(wireSessions)
    wireSessionCount -= 1
  }
  // The first account span keeps the harness id; later spans roll a new one.
  const wireId = byAccount.size === 0 ? harnessSessionId : randomUUID()
  byAccount.set(account, wireId)
  wireSessionCount += 1
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

/** Whether the last message starts a new user prompt turn rather than continuing a tool step. */
function isNewPromptTurn(messages: readonly TranslatableMessage[]): boolean {
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'user') return false
  return !last.content.some(block => block.type === 'tool-result')
}

/** The `cc_prompt_id` for this request: a new UUIDv4 per user turn, reused across tool continuations. */
function claudePromptId(account: string, sessionId: string, messages: readonly TranslatableMessage[]): string {
  const state = chainFor(account, sessionId)
  if (isNewPromptTurn(messages) || state.promptId === undefined) {
    state.promptId = randomUUID()
  }
  return state.promptId
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

function claudeOs(): 'Windows' | 'Linux' | 'macOS' {
  switch (process.platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    default: return 'Linux'
  }
}

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
): Promise<BuiltClaudeCodeRequest> {
  if (session.deviceId === undefined || session.accountUuid === undefined) {
    throw new Error('dsh-plugin-subscriptions: claude wire identity is missing; backfill it before building')
  }
  const system = toAnthropicSystem(options.system, messages)
  const tools = options.tools !== undefined && options.tools.length > 0
    ? toAnthropicTools(options.tools)
    : undefined
  const resolvedEffort = claudeEffort(effort)
  const chain = chainFor(account, sessionId)
  return buildClaudeCodeRequest({
    accessToken: session.accessToken,
    model: options.model,
    maxTokens,
    messages: toAnthropicMessages(messages, options.model),
    ...system.length === 0 ? {} : { system },
    ...tools === undefined ? {} : { tools },
    // Preserve the fork's historical breakpoint behavior: caching on, with a
    // marker on the last system block, the last tool, and the newest message.
    // The genuine client ships 1h cache markers, so the ttl matches its bytes.
    cacheControl: { enabled: true, systemBreakpoint: true, toolBreakpoint: true, messageBreakpoint: true, ttl: '1h' },
    runtime: {
      sessionId,
      deviceId: session.deviceId,
      accountUuid: session.accountUuid,
      runtime: 'node',
      runtimeVersion: process.versions.node,
      os: claudeOs(),
      arch: process.arch,
    },
    ...thinking === undefined ? {} : { thinking: { ...thinking, display: 'summarized' } },
    ...resolvedEffort === undefined
      ? {}
      : { effort: resolvedEffort, outputConfig: { effort: resolvedEffort } },
    stream: true,
    clientRequestId: randomUUID(),
    ...chain.previousRequestId === undefined ? {} : { previousRequestId: chain.previousRequestId },
    promptId: claudePromptId(account, sessionId, messages),
  }, CLAUDE_CODE_2_1_280_PROFILE)
}
