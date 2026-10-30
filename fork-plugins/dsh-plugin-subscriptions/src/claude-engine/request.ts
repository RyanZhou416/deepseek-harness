/**
 * Raw Anthropic Messages DTO → one wire request, for a single account.
 *
 * The caller supplies the request body it already holds and the identity it wants attributed;
 * this module validates both and hands them to the maintained
 * `@tormentalabs/claude-code-wire-compat` builder, which owns the protocol identity, billing
 * header and beta composition. Nothing here re-implements or copies that package, and nothing
 * here invents a platform: an identity that is absent or internally inconsistent is refused
 * rather than filled in.
 *
 * Validation is strict by design, at every level. A field or nested member this engine does not
 * model is reported, never dropped: silently discarding it would send a request the caller did
 * not ask for.
 *
 * @module dsh-plugin-subscriptions/claude-engine/request
 */

import {
  CLAUDE_CODE_2_1_288_PROFILE,
  ClaudeCodeWireError,
  buildClaudeCodeRequest,
  checkProfileCoherence,
} from '@tormentalabs/claude-code-wire-compat'
import { createHash } from 'node:crypto'
import type {
  ClaudeCodeRequestInput,
  Message,
  SystemInput,
  ToolDefinition,
} from '@tormentalabs/claude-code-wire-compat'

/** The tool-choice directive, taken from the builder's own input contract. */
type ToolChoice = NonNullable<ClaudeCodeRequestInput['toolChoice']>
import { resolveSuppressBetas } from './request-policy.js'
import type { ClaudeEnginePolicy } from './request-policy.js'
import type {
  ClaudeEngineChain,
  ClaudeEngineFailure,
  ClaudeEngineIdentity,
  ClaudeEngineRequest,
  ClaudeEngineRequestEvidence,
} from './types.js'

/** The wire OS vocabulary the builder expects, mapped from the caller's platform token. */
const WIRE_OS: Readonly<Record<ClaudeEngineIdentity['os'], 'Windows' | 'Linux' | 'macOS'>> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
}

/** Body keys this engine models in V1. */
const KNOWN_BODY_FIELDS: ReadonlySet<string> = new Set([
  'model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice',
  'thinking', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata', 'stream',
])

/** Body keys that name a feature this engine does not implement in V1. */
const UNSUPPORTED_BODY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  mcp_servers: 'MCP servers are not part of the V1 single-account Messages engine',
  container: 'remote containers are not part of the V1 single-account Messages engine',
  context_management: 'the route sends no context editing, and this engine refuses a caller-supplied field',
  output_format: 'structured output is not part of the V1 engine',
  speed: 'fast tier selection is not part of the V1 engine',
  service_tier: 'service tiers are not part of the V1 engine',
})

/**
 * The id grammar the client emits for a continuation.
 *
 * The builder splices this value into the billing text, so the engine admits exactly the shape the
 * client produces and nothing that could restructure that field.
 */
const CONTINUATION_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,36}$/

/**
 * Whether a value can travel verbatim as a header value.
 *
 * Printable ASCII below 0x21 is excluded, which also excludes CR, LF, space and tab: a value that
 * could end the header line or be trimmed is not forwarded.
 * @param value - the candidate value.
 * @returns true when every character is printable ASCII in 0x21-0x7e.
 */
function isPrintableAsciiToken(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x21 || code > 0x7e) return false
  }
  return value.length > 0
}

/** Content block types the V1 conversation vocabulary accepts. */
const KNOWN_CONTENT_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'tool_use', 'tool_result'])

/** The result of validating one caller-supplied body. */
export type ClaudeEngineValidation =
  | { readonly ok: true; readonly body: ClaudeEngineValidatedBody }
  | { readonly ok: false; readonly failure: ClaudeEngineFailure }

/** A body that passed validation, with its wire-shaped members narrowed. */
export interface ClaudeEngineValidatedBody {
  /** Model id the body declares. */
  readonly model: string
  /** Output cap the body declares. */
  readonly maxTokens: number
  /** Conversation messages, validated at every level. */
  readonly messages: readonly Message[]
  /** System blocks, as the builder accepts them. */
  readonly system?: readonly SystemInput[]
  /** Tool definitions, validated. */
  readonly tools?: readonly ToolDefinition[]
  /** Tool-choice directive, forwarded verbatim once validated. */
  readonly toolChoice?: ToolChoice
  /** Thinking configuration, when the caller requested one. */
  readonly thinking?: { readonly type: 'enabled' | 'adaptive' | 'disabled'; readonly budgetTokens?: number }
  /** Sampling controls the caller set. */
  readonly temperature?: number
  /** Nucleus sampling the caller set. */
  readonly topP?: number
  /** Top-k sampling the caller set. */
  readonly topK?: number
  /** Stop sequences the caller set. */
  readonly stopSequences?: readonly string[]
  /** Validated metadata values the caller attached. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

/** Report one invalid field. */
function invalid(field: string, detail: string): ClaudeEngineValidation {
  return { ok: false, failure: { kind: 'invalid-request', field, detail } }
}

/** Report one unsupported feature. */
function unsupported(feature: string, detail: string): ClaudeEngineValidation {
  return { ok: false, failure: { kind: 'unsupported', feature, detail } }
}

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What the caller can prove about the files a request refers to.
 *
 * V1 accepts inline content and files this pool uploaded itself. A file id the caller cannot
 * prove it owns is not a request this engine will build: a foreign id would attribute another
 * account's upload to this one, so an absent proof refuses rather than assumes.
 */
export interface ClaudeEngineFileOwnership {
  /**
   * Whether this pool uploaded the given file id.
   * @param fileId - the id the request names.
   * @returns true only when the caller can prove this pool owns that upload.
   */
  readonly ownsFile: (fileId: string) => boolean
}

/** The recursion depth tool-result content may reach. */
const TOOL_RESULT_DEPTH_LIMIT = 8

/** The byte budget one tool result's nested content may consume. */
const TOOL_RESULT_BYTE_BUDGET = 1_048_576

/** Fields each block type may carry; anything else is rejected rather than ignored. */
const BLOCK_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  text: new Set(['type', 'text', 'cache_control']),
  image: new Set(['type', 'source', 'cache_control']),
  tool_use: new Set(['type', 'id', 'name', 'input', 'cache_control']),
  tool_result: new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']),
})

/** Fields a message may carry. */
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['role', 'content'])

/**
 * Validate one content block.
 *
 * The block's own type decides what it must carry and which fields it may carry at all: text
 * needs a string body, an image must be inline base64 or a file this pool proved it owns, a tool
 * call needs an id and a name, and a tool result needs the call it answers plus content that is
 * itself validated. A block type, a field or a value this engine does not model is refused rather
 * than passed through.
 * @param block - the raw block.
 * @param where - the field path the block sits at, for the failure report.
 * @param ownership - the caller's file proof, when it has one.
 * @returns the failure, or undefined when the block is acceptable.
 */
function checkContentBlock(
  block: unknown,
  where: string,
  ownership: ClaudeEngineFileOwnership | undefined,
): ClaudeEngineFailure | undefined {
  if (typeof block === 'string') return undefined
  if (!isRecord(block)) {
    return { kind: 'invalid-request', field: where, detail: 'each content member must be an object or a string' }
  }
  const type = block['type']
  if (typeof type !== 'string') return { kind: 'invalid-request', field: `${where}.type`, detail: 'content member type is required' }
  if (!KNOWN_CONTENT_TYPES.has(type)) {
    return {
      kind: 'unsupported',
      feature: `${where}.${type}`,
      detail: `content type "${type}" is not part of the V1 conversation vocabulary`,
    }
  }
  const allowed = BLOCK_FIELDS[type]
  if (allowed !== undefined) {
    for (const key of Object.keys(block)) {
      if (!allowed.has(key)) {
        return { kind: 'invalid-request', field: `${where}.${key}`, detail: `"${key}" is not a field of a ${type} block` }
      }
    }
  }
  if (type === 'text' && typeof block['text'] !== 'string') {
    return { kind: 'invalid-request', field: `${where}.text`, detail: 'a text block needs a string text' }
  }
  if (type === 'image') {
    const source = block['source']
    if (!isRecord(source)) {
      return { kind: 'invalid-request', field: `${where}.source`, detail: 'an image block needs a source object' }
    }
    const kind = source['type']
    if (kind === 'url') {
      // V1 carries inline content only: an arbitrary external URL is not this engine's to fetch.
      return {
        kind: 'unsupported',
        feature: `${where}.source.url`,
        detail: 'external image URLs are not part of V1; supply inline base64 content',
      }
    }
    if (kind === 'file') {
      const fileId = source['file_id']
      if (typeof fileId !== 'string' || fileId.length === 0) {
        return { kind: 'invalid-request', field: `${where}.source.file_id`, detail: 'a file source needs a file_id string' }
      }
      if (ownership?.ownsFile(fileId) !== true) {
        // Without a proof that this pool uploaded the file, the id could name another account's
        // upload; V1 refuses it rather than attributing it here.
        return {
          kind: 'unsupported',
          feature: `${where}.source.file`,
          detail: 'a file_id is accepted only with a caller-supplied proof that this pool uploaded it',
        }
      }
    } else if (kind !== 'base64') {
      return { kind: 'invalid-request', field: `${where}.source.type`, detail: 'source.type must be "base64" or "file"' }
    } else if (typeof source['data'] !== 'string' || typeof source['media_type'] !== 'string') {
      return { kind: 'invalid-request', field: `${where}.source`, detail: 'a base64 source needs data and media_type strings' }
    }
  }
  if (type === 'tool_use') {
    if (typeof block['id'] !== 'string' || typeof block['name'] !== 'string') {
      return { kind: 'invalid-request', field: where, detail: 'a tool_use block needs string id and name' }
    }
    if (block['input'] !== undefined && !isRecord(block['input'])) {
      return { kind: 'invalid-request', field: `${where}.input`, detail: 'tool_use input must be an object' }
    }
  }
  if (type === 'tool_result') {
    if (typeof block['tool_use_id'] !== 'string') {
      return { kind: 'invalid-request', field: `${where}.tool_use_id`, detail: 'a tool_result block needs the call id it answers' }
    }
    if (block['is_error'] !== undefined && typeof block['is_error'] !== 'boolean') {
      return { kind: 'invalid-request', field: `${where}.is_error`, detail: 'is_error must be a boolean' }
    }
    const budget = { bytes: 0 }
    return checkToolResultContent(block['content'], `${where}.content`, ownership, 1, budget)
  }
  return undefined
}

/**
 * Validate a tool result's content, which the wire allows to be text, an inline image, or a list
 * of either.
 * @param content - the raw content.
 * @param where - the field path, for the failure report.
 * @param ownership - the caller's file proof, when it has one.
 * @param depth - the current recursion depth.
 * @param budget - the byte budget shared across this result's nesting.
 * @returns the failure, or undefined when the content is acceptable.
 */
function checkToolResultContent(
  content: unknown,
  where: string,
  ownership: ClaudeEngineFileOwnership | undefined,
  depth: number,
  budget: { bytes: number },
): ClaudeEngineFailure | undefined {
  if (content === undefined) return undefined
  if (depth > TOOL_RESULT_DEPTH_LIMIT) {
    return { kind: 'invalid-request', field: where, detail: `tool result content nests deeper than ${String(TOOL_RESULT_DEPTH_LIMIT)} levels` }
  }
  if (typeof content === 'string') {
    budget.bytes += content.length
    if (budget.bytes > TOOL_RESULT_BYTE_BUDGET) {
      return { kind: 'invalid-request', field: where, detail: 'tool result content exceeds the byte budget' }
    }
    return undefined
  }
  if (Array.isArray(content)) {
    for (const [index, member] of content.entries()) {
      const failure = checkToolResultContent(member, `${where}[${String(index)}]`, ownership, depth + 1, budget)
      if (failure !== undefined) return failure
    }
    return undefined
  }
  if (!isRecord(content)) {
    // A number, boolean or null here is not content this engine will forward.
    return { kind: 'invalid-request', field: where, detail: 'tool result content must be a string, a block or an array of them' }
  }
  const type = content['type']
  if (type === 'text') {
    if (typeof content['text'] !== 'string') {
      return { kind: 'invalid-request', field: `${where}.text`, detail: 'a text block needs a string text' }
    }
    budget.bytes += content['text'].length
    if (budget.bytes > TOOL_RESULT_BYTE_BUDGET) {
      return { kind: 'invalid-request', field: where, detail: 'tool result content exceeds the byte budget' }
    }
    return undefined
  }
  if (type === 'image') {
    // Only the inline and pool-owned forms are part of V1, exactly as at the top level.
    return checkContentBlock(content, where, ownership)
  }
  return {
    kind: 'unsupported',
    feature: `${where}.${typeof type === 'string' ? type : 'unknown'}`,
    detail: 'V1 tool result content carries text and inline images only',
  }
}

/**
 * Validate one message.
 * @param message - the raw message.
 * @param where - the field path, for the failure report.
 * @param ownership - the caller's file proof, when it has one.
 * @returns the failure, or undefined when the message is acceptable.
 */
function checkMessage(
  message: unknown,
  where: string,
  ownership: ClaudeEngineFileOwnership | undefined,
): ClaudeEngineFailure | undefined {
  if (!isRecord(message)) return { kind: 'invalid-request', field: where, detail: 'each message must be an object' }
  for (const key of Object.keys(message)) {
    if (!MESSAGE_FIELDS.has(key)) {
      return { kind: 'invalid-request', field: `${where}.${key}`, detail: `"${key}" is not a field of a message` }
    }
  }
  const role = message['role']
  if (role !== 'user' && role !== 'assistant') {
    return { kind: 'invalid-request', field: `${where}.role`, detail: 'role must be "user" or "assistant"' }
  }
  const content = message['content']
  if (content === undefined) return { kind: 'invalid-request', field: `${where}.content`, detail: 'content is required' }
  if (typeof content === 'string') return undefined
  if (!Array.isArray(content)) {
    return { kind: 'invalid-request', field: `${where}.content`, detail: 'content must be a string or an array of blocks' }
  }
  for (const [index, block] of content.entries()) {
    const failure = checkContentBlock(block, `${where}.content[${String(index)}]`, ownership)
    if (failure !== undefined) return failure
  }
  return undefined
}

/**
 * Validate one tool definition.
 * @param tool - the raw definition.
 * @param where - the field path, for the failure report.
 * @returns the failure, or undefined when the definition is acceptable.
 */
function checkTool(tool: unknown, where: string): ClaudeEngineFailure | undefined {
  if (!isRecord(tool)) return { kind: 'invalid-request', field: where, detail: 'each tool must be an object' }
  if (typeof tool['name'] !== 'string' || tool['name'].length === 0) {
    return { kind: 'invalid-request', field: `${where}.name`, detail: 'a tool needs a non-empty name' }
  }
  if (tool['description'] !== undefined && typeof tool['description'] !== 'string') {
    return { kind: 'invalid-request', field: `${where}.description`, detail: 'a tool description must be a string' }
  }
  if (tool['input_schema'] !== undefined && !isRecord(tool['input_schema'])) {
    return { kind: 'invalid-request', field: `${where}.input_schema`, detail: 'input_schema must be an object' }
  }
  return undefined
}

/**
 * Validate one tool-choice directive.
 * @param choice - the raw directive.
 * @returns the failure, or undefined when the directive is acceptable.
 */
function checkToolChoice(choice: unknown): ClaudeEngineFailure | undefined {
  if (!isRecord(choice)) return { kind: 'invalid-request', field: 'tool_choice', detail: 'tool_choice must be an object' }
  const type = choice['type']
  if (type !== 'auto' && type !== 'any' && type !== 'tool' && type !== 'none') {
    return {
      kind: 'invalid-request',
      field: 'tool_choice.type',
      detail: 'tool_choice.type must be "auto", "any", "tool" or "none"',
    }
  }
  if (type === 'tool' && (typeof choice['name'] !== 'string' || choice['name'].length === 0)) {
    return { kind: 'invalid-request', field: 'tool_choice.name', detail: 'a "tool" choice needs the tool name' }
  }
  if (choice['disable_parallel_tool_use'] !== undefined && typeof choice['disable_parallel_tool_use'] !== 'boolean') {
    return {
      kind: 'invalid-request',
      field: 'tool_choice.disable_parallel_tool_use',
      detail: 'disable_parallel_tool_use must be a boolean',
    }
  }
  return undefined
}

/**
 * Validate one caller-supplied Anthropic Messages body.
 *
 * The supported set is exactly the V1 conversation vocabulary: text, inline-image and file
 * content, system blocks, tool definitions and tool results, tool choice, thinking with a token
 * budget, and the sampling controls. A body asking for `stream: false` is refused — this engine
 * exists to stream — and a member the engine does not model is reported by name rather than
 * dropped, at every nesting level.
 * @param body - the caller's raw body (parsed JSON or an equivalent object).
 * @param ownership - the caller's proof of which files this pool uploaded, when the body names
 * any; without it a file reference is refused rather than attributed to this account.
 * @returns the validated body, or the typed failure that refuses it.
 */
export function validateAnthropicBody(body: unknown, ownership?: ClaudeEngineFileOwnership): ClaudeEngineValidation {
  if (!isRecord(body)) return invalid('body', 'the request body must be a JSON object')
  for (const key of Object.keys(body)) {
    const unsupportedReason = UNSUPPORTED_BODY_FIELDS[key]
    if (unsupportedReason !== undefined) return unsupported(key, unsupportedReason)
    if (!KNOWN_BODY_FIELDS.has(key)) {
      return invalid(key, 'unknown request field; the engine does not drop what it does not model')
    }
  }
  if (body['stream'] !== undefined && body['stream'] !== true) {
    return unsupported('stream', 'V1 streams only: a non-streaming Messages call is refused')
  }
  const model = body['model']
  if (typeof model !== 'string' || model.length === 0) return invalid('model', 'model must be a non-empty string')
  const maxTokens = body['max_tokens']
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    return invalid('max_tokens', 'max_tokens must be a positive integer')
  }
  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) return invalid('messages', 'messages must be a non-empty array')
  for (const [index, message] of messages.entries()) {
    const failure = checkMessage(message, `messages[${String(index)}]`, ownership)
    if (failure !== undefined) return { ok: false, failure }
  }
  let system: readonly SystemInput[] | undefined
  const rawSystem = body['system']
  if (rawSystem !== undefined) {
    if (typeof rawSystem === 'string') {
      // The API accepts a plain string system prompt; it is normalized into the block form the
      // builder takes rather than cast into it.
      system = [{ type: 'text', text: rawSystem }]
    } else if (Array.isArray(rawSystem)) {
      for (const [index, block] of rawSystem.entries()) {
        const failure = checkContentBlock(block, `system[${String(index)}]`, ownership)
        if (failure !== undefined) return { ok: false, failure }
      }
      system = rawSystem as readonly SystemInput[]
    } else {
      return invalid('system', 'system must be a string or an array of blocks')
    }
  }
  let tools: readonly ToolDefinition[] | undefined
  const rawTools = body['tools']
  if (rawTools !== undefined) {
    if (!Array.isArray(rawTools)) return invalid('tools', 'tools must be an array')
    for (const [index, tool] of rawTools.entries()) {
      const failure = checkTool(tool, `tools[${String(index)}]`)
      if (failure !== undefined) return { ok: false, failure }
    }
    tools = rawTools as readonly ToolDefinition[]
  }
  let toolChoice: ToolChoice | undefined
  const rawChoice = body['tool_choice']
  if (rawChoice !== undefined) {
    const failure = checkToolChoice(rawChoice)
    if (failure !== undefined) return { ok: false, failure }
    if ((rawChoice as { type: string }).type !== 'auto') {
      // The pinned builder composes this field from its own capability decisions and does not
      // carry a caller-supplied directive through; forwarding one would send the caller a request
      // whose tool choice they did not get.
      return unsupported('tool_choice', 'the pinned builder composes tool_choice itself; only the default "auto" is expressible')
    }
    toolChoice = rawChoice as ToolChoice
  }
  const thinking = body['thinking']
  if (thinking !== undefined) {
    if (!isRecord(thinking)) return invalid('thinking', 'thinking must be an object')
    const type = thinking['type']
    if (type !== 'enabled' && type !== 'adaptive' && type !== 'disabled') {
      return invalid('thinking.type', 'thinking.type must be "enabled", "adaptive" or "disabled"')
    }
    const budget = thinking['budget_tokens']
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0)) {
      return invalid('thinking.budget_tokens', 'budget_tokens must be a positive integer')
    }
  }
  for (const key of ['temperature', 'top_p', 'top_k'] as const) {
    const value = body[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      return invalid(key, `${key} must be a finite number`)
    }
  }
  const stop = body['stop_sequences']
  if (stop !== undefined) {
    if (!Array.isArray(stop) || stop.some(entry => typeof entry !== 'string')) {
      return invalid('stop_sequences', 'stop_sequences must be an array of strings')
    }
  }
  const metadata = body['metadata']
  if (metadata !== undefined) {
    if (!isRecord(metadata)) return invalid('metadata', 'metadata must be an object')
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return invalid(`metadata.${key}`, 'metadata values must be strings, numbers or booleans')
      }
    }
  }
  const thinkingShape = thinking as { type: 'enabled' | 'adaptive' | 'disabled'; budget_tokens?: number } | undefined
  return {
    ok: true,
    body: {
      model,
      maxTokens,
      messages: messages as readonly Message[],
      ...system === undefined ? {} : { system },
      ...tools === undefined ? {} : { tools },
      ...toolChoice === undefined ? {} : { toolChoice },
      ...thinkingShape === undefined
        ? {}
        : {
          thinking: {
            type: thinkingShape.type,
            ...thinkingShape.budget_tokens === undefined ? {} : { budgetTokens: thinkingShape.budget_tokens },
          },
        },
      ...typeof body['temperature'] === 'number' ? { temperature: body['temperature'] } : {},
      ...typeof body['top_p'] === 'number' ? { topP: body['top_p'] } : {},
      ...typeof body['top_k'] === 'number' ? { topK: body['top_k'] } : {},
      ...stop === undefined ? {} : { stopSequences: stop as readonly string[] },
      ...metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, string | number | boolean>> },
    },
  }
}

/** Everything one build needs from the caller. */
export interface ClaudeEngineBuildInput {
  /** The caller's raw Anthropic Messages body. */
  readonly body: unknown
  /** Access token the Mac vault holds; never logged and never stored here. */
  readonly accessToken: string
  /** Identity the request is attributed to. */
  readonly identity: ClaudeEngineIdentity
  /** Opaque per-request id the caller generates. */
  readonly clientRequestId: string
  /** The caller's continuation chain, when it keeps one. */
  readonly chain?: ClaudeEngineChain
  /**
   * Trusted policy the caller states out of band, from its own policy adapter.
   *
   * Not a request-body field: the DTO has no such member, so a caller cannot suppress a beta by
   * sending one.
   */
  readonly policy?: ClaudeEnginePolicy
  /**
   * The caller's proof of which files this pool uploaded.
   *
   * Required for any request that names a file: the engine cannot tell a pool-owned upload from a
   * foreign id, so an absent proof refuses the reference instead of attributing it here.
   */
  readonly files?: ClaudeEngineFileOwnership
}

/** The outcome of one build. */
export type ClaudeEngineBuildResult =
  | { readonly ok: true; readonly request: ClaudeEngineRequest }
  | { readonly ok: false; readonly failure: ClaudeEngineFailure }

/**
 * Build one Messages request from a caller-supplied DTO.
 *
 * The pinned 2.1.288 profile is passed to the builder explicitly — the package's own default is a
 * different release — so the request a Mac caller sends is the profile this engine reports. The
 * profile is verified for internal coherence first, and the caller's identity must name all three
 * identifiers: a profile or identity the caller cannot state consistently is refused instead of
 * being completed with a platform guess.
 * @param input - the body, credential, identity and correlation the caller supplies.
 * @returns the request to hand to a transport, or the typed failure that refuses it.
 */
export async function buildClaudeEngineRequest(input: ClaudeEngineBuildInput): Promise<ClaudeEngineBuildResult> {
  const disagreements = checkProfileCoherence(CLAUDE_CODE_2_1_288_PROFILE)
  if (disagreements.length > 0) {
    return { ok: false, failure: { kind: 'incoherent-profile', detail: disagreements.join('; ') } }
  }
  const identityFailure = checkIdentity(input.identity)
  if (identityFailure !== undefined) return { ok: false, failure: identityFailure }
  if (input.accessToken.length === 0) {
    return { ok: false, failure: { kind: 'incoherent-profile', detail: 'no access token was supplied' } }
  }
  const suppressBetas = resolveSuppressBetas(input.policy)
  const chain = input.chain
  const previousRequestId = chain?.previousRequestId
  if (previousRequestId !== undefined && !CONTINUATION_REQUEST_ID_PATTERN.test(previousRequestId)) {
    // The pinned builder splices this value into the billing text as `cc_prev_req=`, so only the
    // id grammar the client itself emits is admitted; anything else could restructure that field.
    return {
      ok: false,
      failure: {
        kind: 'invalid-request',
        field: 'chain.previousRequestId',
        detail: 'previousRequestId must match ^req_[A-Za-z0-9_-]{1,36}$',
      },
    }
  }
  const atis = chain?.atis
  if (atis !== undefined && atis !== '' && !isPrintableAsciiToken(atis)) {
    // The value travels as a header verbatim: no trimming, no re-encoding, and nothing that could
    // terminate the header line.
    return {
      ok: false,
      failure: {
        kind: 'invalid-request',
        field: 'chain.atis',
        detail: 'atis must be printable ASCII in 0x21-0x7e, with no whitespace or control characters',
      },
    }
  }
  const validation = validateAnthropicBody(input.body, input.files)
  if (!validation.ok) return { ok: false, failure: validation.failure }
  const validated = validation.body
  try {
    const built = await buildClaudeCodeRequest({
      accessToken: input.accessToken,
      model: validated.model,
      maxTokens: validated.maxTokens,
      messages: validated.messages,
      ...validated.system === undefined ? {} : { system: validated.system },
      ...validated.tools === undefined ? {} : { tools: validated.tools },
      ...validated.toolChoice === undefined ? {} : { toolChoice: validated.toolChoice },
      runtime: {
        sessionId: input.identity.sessionUuid,
        deviceId: input.identity.deviceUuid,
        accountUuid: input.identity.accountUuid,
        runtime: input.identity.runtime,
        runtimeVersion: input.identity.runtimeVersion,
        os: WIRE_OS[input.identity.os],
        arch: input.identity.arch,
      },
      ...validated.thinking === undefined ? {} : { thinking: validated.thinking },
      ...validated.temperature === undefined ? {} : { temperature: validated.temperature },
      ...validated.topP === undefined ? {} : { topP: validated.topP },
      ...validated.topK === undefined ? {} : { topK: validated.topK },
      ...validated.stopSequences === undefined ? {} : { stopSequences: validated.stopSequences },
      ...validated.metadata === undefined ? {} : { metadata: validated.metadata },
      // The chain the caller already selected: the engine never derives a request id from the
      // conversation, and the billing text carries it rather than a body field of its own.
      ...previousRequestId === undefined ? {} : { previousRequestId },
      // An absent or empty pin is omitted, which is the client's no-header state; an empty string
      // is the caller stating exactly that, not a value to be invented here.
      ...atis === undefined || atis === '' ? {} : { extraHeaders: [['x-cc-atis', atis] as const] },
      // The policy adapter's decision, expressed in the builder's own switch; absent when nothing
      // is suppressed, so an ordinary build keeps every beta the profile binds.
      ...suppressBetas === undefined ? {} : { suppressBetas },
      clientRequestId: input.clientRequestId,
      stream: true,
    }, CLAUDE_CODE_2_1_288_PROFILE)
    const request: ClaudeEngineRequest = {
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: built.body,
      evidence: evidenceOf(built.url, built.headers, built.body, built.evidence.modelFamily, built.evidence.betaFeatures),
    }
    return { ok: true, request }
  } catch (error: unknown) {
    if (error instanceof ClaudeCodeWireError) {
      // The builder's own code names what it refused; the engine reports it as an unsupported or
      // invalid request rather than inventing a status for it.
      const detail = `${error.code}${Object.keys(error.safeDetails).length === 0 ? '' : ` (${JSON.stringify(error.safeDetails)})`}`
      if (error.code === 'UNSUPPORTED_CAPABILITY') {
        return { ok: false, failure: { kind: 'unsupported', feature: error.code, detail } }
      }
      return { ok: false, failure: { kind: 'invalid-request', field: error.code, detail } }
    }
    throw error
  }
}

/**
 * Refuse an identity the caller cannot state completely.
 * @param identity - the caller's identity.
 * @returns the failure, or undefined when every identifier is usable.
 */
function checkIdentity(identity: ClaudeEngineIdentity): ClaudeEngineFailure | undefined {
  for (const [field, value] of [
    ['accountUuid', identity.accountUuid],
    ['deviceUuid', identity.deviceUuid],
    ['sessionUuid', identity.sessionUuid],
    ['arch', identity.arch],
    ['runtimeVersion', identity.runtimeVersion],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      return { kind: 'incoherent-profile', detail: `identity.${field} must be a non-empty string` }
    }
  }
  if (WIRE_OS[identity.os] === undefined) {
    return { kind: 'incoherent-profile', detail: `identity.os must be one of ${Object.keys(WIRE_OS).join(', ')}` }
  }
  return undefined
}

/**
 * Describe what was built without exposing it.
 * @param url - endpoint the request addresses.
 * @param headers - header pairs the builder composed.
 * @param body - serialized body.
 * @param modelFamily - family the builder resolved.
 * @param betaFeatures - beta identifiers the request carries.
 * @returns the non-secret evidence record.
 */
function evidenceOf(
  url: string,
  headers: readonly (readonly [string, string])[],
  body: string,
  modelFamily: string,
  betaFeatures: readonly string[],
): ClaudeEngineRequestEvidence {
  return {
    profileId: CLAUDE_CODE_2_1_288_PROFILE.id,
    url,
    modelFamily,
    betaFeatures: [...betaFeatures],
    headerNames: headers.map(([name]) => name.toLowerCase()),
    bodySha256: createHash('sha256').update(body).digest('hex'),
    bodyByteLength: Buffer.byteLength(body, 'utf8'),
  }
}
