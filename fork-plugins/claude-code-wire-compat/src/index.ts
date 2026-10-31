// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Public entry point for the Claude Code wire compatibility package.
 *
 * Only the surfaces listed below are public. Internal protocol modules remain
 * private; the documented builder, parser, anti-verbosity helpers, read-only
 * model queries and the transcribed beta registries are exported here, and
 * nothing else.
 *
 * Importing this module has no side effects. It reads no environment, opens
 * no network connection, touches no clock or random source, and holds no
 * mutable module-level state.
 */

export type {
  AntiVerbosityPolicy,
  AntiVerbositySection,
  BuiltClaudeCodeCountTokensRequest,
  BuiltClaudeCodeRequest,
  ClaudeCodeBetaOverrides,
  ClaudeCodeBetaPolicy,
  ClaudeCodeCapabilities,
  ClaudeCodeCapabilityDecisions,
  ClaudeCodeCatalogueEntry,
  ClaudeCodeCountTokensInput,
  ClaudeCodeEffort,
  ClaudeCodeExtraHeaderPolicy,
  ClaudeCodeInvocationMode,
  ClaudeCodeMetadataOverrides,
  ClaudeCodeModelFamily,
  ClaudeCodeProtocolProfile,
  ClaudeCodeRequestInput,
  ClaudeCodeRuntimeIdentity,
  ClaudeCodeTurnPosition,
  ClaudeCodeWireErrorCode,
  ContextManagementConfig,
  HeaderPair,
  JsonPrimitive,
  JsonValue,
  Message,
  MessageContent,
  RedactedRequestEvidence,
  ServerToolUseBlock,
  SystemInput,
  TextBlock,
  ThinkingDisplay,
  ToolDefinition,
  ToolResultBlock,
  ToolSearchToolResultBlock,
  ToolUseBlock,
} from "./contracts.js";

export { ClaudeCodeWireError } from "./contracts.js";

export {
  DEFAULT_ANTI_VERBOSITY_POLICY,
  antiVerbosityText,
  selectAntiVerbositySection,
} from "./anti-verbosity.js";

export { BETA_REGISTRY } from "./beta-registry.js";

export {
  buildClaudeCodeCountTokensRequest,
  buildClaudeCodeRequest,
  parseBuiltClaudeCodeRequest,
} from "./build-request.js";

export { TOKEN_COUNTING_BETA } from "./count-tokens.js";

export {
  hasOneMillionContext,
  isAdaptiveThinkingModel,
  isClaude3Model,
  isEligibleFor1MContext,
  isFable5Model,
  isHaikuModel,
  isMythos5Model,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
  isSonnet46Model,
  modelCapability,
  supportsStructuredOutputs,
  supportsWebSearch,
} from "./model-queries.js";

export {
  buildCanonicalSystem,
  IDENTITY_TEXT,
  IDENTITY_TEXTS,
  IDENTITY_TEXT_AGENT,
  IDENTITY_TEXT_AGENT_SDK,
  isIdentityText,
  REPORTING_TEXT,
  selectIdentityText,
} from "./system-prompt.js";

/*
 * Exported so a consumer that keys its own tables by model id (context and
 * output limits, thinking shape, effort levels, fast tier) can ask the same
 * identity question the catalogue lookup here asks. A caller that keys by the
 * wire id instead would miss the dated, dotted and request-time-marked
 * spellings of one model.
 */
export { normalizeModelId } from "./model-identity.js";

export { BETA_REGISTRY_2_1_233 } from "./profiles/beta-registry-2.1.233.js";
export { BETA_REGISTRY_2_1_280 } from "./profiles/beta-registry-2.1.280.js";
export { BETA_REGISTRY_2_1_288 } from "./profiles/beta-registry-2.1.288.js";
export { CLAUDE_CODE_2_1_195_PROFILE } from "./profiles/claude-code-2.1.195.js";
export { CLAUDE_CODE_2_1_233_PROFILE } from "./profiles/claude-code-2.1.233.js";
export { CLAUDE_CODE_2_1_280_PROFILE } from "./profiles/claude-code-2.1.280.js";
export { CLAUDE_CODE_2_1_288_PROFILE } from "./profiles/claude-code-2.1.288.js";
export {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemAtBoundary,
} from "./system-prompt.js";
export type { BoundarySplit } from "./system-prompt.js";
export {
  BETA_INTRODUCED_IN,
  BETA_REMOVED_IN,
  checkBetaVintage,
  checkProfileCoherence,
  compareVersions,
  composeUserAgent,
  describeStaleness,
} from "./profile-coherence.js";
export type { VersionBearingProfile } from "./profile-coherence.js";
export { supportsMidConversationSystem } from "./model-capabilities.js";
export { supportsContextManagement } from "./model-capabilities.js";
