/**
 * The public surface of the framework-independent Claude engine.
 *
 * A caller outside the harness imports this barrel: it builds one wire request from a raw
 * Anthropic Messages DTO, runs one single-account turn over an injected transport, and reads the
 * typed failures. Everything exported here is defined in this directory and re-exported unchanged
 * — the barrel is a list, not a wrapper — and nothing in this directory imports the harness, the
 * home directory, the environment, an account pool or file credentials.
 *
 * @module dsh-plugin-subscriptions/claude-engine
 */

export { buildClaudeEngineRequest, validateAnthropicBody } from './request.js'
export { MID_CONVERSATION_SUPPRESSED_BETAS, resolveSuppressBetas } from './request-policy.js'
export { runClaudeEngineTurn } from './stream.js'
export {
  CLAUDE_VERSION_REJECTION_MARKERS,
  anthropicErrorEventRule,
  isKnownAnthropicErrorCode,
  matchesClaudeVersionRejection,
} from './failure-rules.js'
export {
  SSE_FRAME_LIMIT_BYTES,
  SSE_TAIL_LIMIT_BYTES,
  createSseFramer,
  parseSseBytes,
} from './sse.js'

export type {
  ClaudeEngineBuildInput,
  ClaudeEngineBuildResult,
  ClaudeEngineFileOwnership,
  ClaudeEngineValidatedBody,
  ClaudeEngineValidation,
} from './request.js'
export type { ClaudeEnginePolicy } from './request-policy.js'
export type {
  ClaudeEngineRecovery,
  ClaudeEngineTurnHooks,
  ClaudeEngineTurnInput,
  ClaudeEngineVerdict,
} from './stream.js'
export type {
  ClaudeErrorEventRule,
  ClaudeRuleDisposition,
  ClaudeRuleScope,
} from './failure-rules.js'
export type {
  ClaudeEngineSseEvent,
  ClaudeEngineSseFramer,
  ClaudeEngineSsePushResult,
} from './sse.js'
export type {
  ClaudeEngineChain,
  ClaudeEngineEvent,
  ClaudeEngineFailure,
  ClaudeEngineHead,
  ClaudeEngineHeaderPair,
  ClaudeEngineIdentity,
  ClaudeEngineLifecycle,
  ClaudeEngineOs,
  ClaudeEngineOutcome,
  ClaudeEngineRequest,
  ClaudeEngineRequestEvidence,
  ClaudeEngineRetryDisposition,
  ClaudeEngineRuntime,
  ClaudeEngineScope,
  ClaudeEngineTransport,
  ClaudeEngineTransportResult,
  ClaudeEngineUsage,
} from './types.js'
