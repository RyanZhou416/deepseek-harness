/**
 * The one model-facing persistent-session tool, `aether_session`, whose
 * `action` selects open, eval, read, list, or close.
 *
 * A session is one real native interpreter process: variables, functions, and
 * the process-global current directory and environment persist across calls
 * that use its id. A tool result therefore reports a live handle rather than
 * the process itself, and the model sees only an opaque session id — the
 * interpreter's own id would expose its process and sequence numbers.
 *
 * `read` drains output a session wrote while no call was in flight, which is why
 * it exists separately from `eval`: a session may host a child or a service that
 * keeps writing. The other actions are lifecycle: open creates the handle, list
 * reports this agent's handles, and close terminates one.
 *
 * The complete result of every action is measured after projection, so an
 * oversized payload becomes one actionable failure instead of a partially
 * delivered value. Timestamps, idle deadlines, and durations are deliberately
 * absent from every canonical value and from every rendered line: they are
 * runtime facts the manager uses internally, and putting them in a model
 * result would make an otherwise stable transcript drift.
 *
 * Argument relevance is enforced before any owner lookup, session lookup, or
 * process effect: the tool refuses every undeclared field and every field the
 * selected action does not read, even when the value is falsy, instead of
 * silently ignoring it.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/session-tools
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { callTimeout } from './config.ts'
import { CWD_DESCRIPTION, FILE_POLICY_GUIDANCE } from './guidance.ts'
import type { ResolvedConfig } from './config.ts'
import { describeError } from './errors.ts'
import { RESULT_LIMIT_CODE } from './limit.ts'
import { assertRequestBytes } from './request.ts'
import { aetherSessionId } from './session-protocol.ts'
import type { AetherSessionId } from './session-protocol.ts'
import { AETHER_SESSION_BUSY, AetherSessions } from './sessions.ts'
import type {
  AetherSessionCall,
  AetherSessionDependencies,
  AetherSessionEvaluation,
  AetherSessionLogs,
  AetherSessionOwner,
  AetherSessionSettings,
  AetherSessionSummary,
} from './sessions.ts'

/** The lifecycle operations the unified session tool accepts. */
const SESSION_ACTIONS = ['open', 'eval', 'read', 'list', 'close'] as const

/** One accepted session action. */
type AetherSessionAction = (typeof SESSION_ACTIONS)[number]

/** Every argument field the unified session tool accepts besides `action`. */
const SESSION_ARGUMENTS = ['session_id', 'code', 'cwd', 'name', 'usage', 'timeoutMs'] as const

/** One accepted session argument field. */
type AetherSessionArgument = (typeof SESSION_ARGUMENTS)[number]

/**
 * Every key the unified tool's argument object may carry.
 *
 * The tool runtime leaves the implicit parameter root open, so an undeclared
 * key reaches `execute` unless this list refuses it. That check is a tool-JSON
 * input validation, not a duplicate of the static argument type.
 */
const SESSION_FIELDS: readonly string[] = ['action', ...SESSION_ARGUMENTS]

/**
 * The fields each action reads.
 *
 * Every other field is refused before an owner or a session is resolved, so an
 * inapplicable argument can never reach a process, a counters request, or a
 * close effect.
 */
const ACTION_ARGUMENTS: Record<AetherSessionAction, readonly AetherSessionArgument[]> = {
  open: ['cwd', 'name', 'timeoutMs'],
  eval: ['session_id', 'code', 'timeoutMs'],
  read: ['session_id'],
  list: ['usage', 'timeoutMs'],
  close: ['session_id', 'timeoutMs'],
}

/** The unified tool's arguments, as the model supplied them. */
interface AetherSessionArgs {
  readonly action: AetherSessionAction
  readonly session_id?: string
  readonly code?: string
  readonly cwd?: string
  readonly name?: string
  readonly usage?: boolean
  readonly timeoutMs?: number
}

/** Stable input code for a field an action does not read, or a required field that is missing or blank. */
const E_INPUT_SESSION_ARGS = 'E_INPUT_SESSION_ARGS'

/** A failure the interpreter reported, in the canonical vocabulary. */
interface AetherFailureValue {
  message: string
  code?: string
  builtin?: string
  hint?: string
  did_you_mean?: string[]
  retryable?: boolean
}

/** One collected interpreter stream, as the canonical value carries it. */
interface AetherStreamValue {
  text: string
  truncated: boolean
  spill_path?: string
}

/** Unrelated stdout and the interpreter's own diagnostic stream for one request. */
interface AetherLogsValue {
  stdout: AetherStreamValue
  stderr: AetherStreamValue
}

/** One read of a session's counters, as the interpreter reported them. */
interface AetherUsageReading {
  evals?: number
  tokens_in?: number
  tokens_out?: number
  tokens_total?: number
}

/** One opened handle. */
interface AetherOpenedResult {
  kind: 'opened'
  session_id: string
  name?: string
  cwd: string
  policy: { mode: string; workspace_root: string; enforcement?: 'full' | 'partial' }
}

/** One evaluated program that produced a value. */
interface AetherValueResult {
  kind: 'value'
  session_id: string
  value: JsonValue
  result_type?: string
  logs: AetherLogsValue
}

/**
 * Any failed action: an argument refusal, a budget refusal, or an interpreter
 * failure.
 *
 * A refusal made before the interpreter ran carries the handle when the action
 * had one and no logs. A failure the interpreter reported carries its bounded
 * logs. One arm covers both, which is why the output schema has a single error
 * branch instead of overlapping refusal and failure branches.
 */
interface AetherErrorResult {
  kind: 'error'
  session_id?: string
  error: AetherFailureValue
  logs?: AetherLogsValue
}

/**
 * One handle's current state.
 *
 * `cwd` is the directory the interpreter process started in, not where a
 * program has since moved it: evaluate `pwd()` to read the current one.
 * `usage` is present on every entry because the output schema declares it as
 * part of the arm; it is an empty object when the call did not ask for counters
 * or when the handle was too busy to answer for them.
 */
interface AetherSummaryValue {
  session_id: string
  name?: string
  cwd: string
  phase: 'starting' | 'ready' | 'busy' | 'destroyed'
  policy_mode: string
  reason?: string
  usage: AetherUsageReading
}

/** This agent's handles. */
interface AetherListedResult {
  kind: 'listed'
  sessions: AetherSummaryValue[]
}

/** One closed handle. */
interface AetherClosedResult {
  kind: 'closed'
  session_id: string
  closed: boolean
  native_closed: boolean
}

/** One drain of a session's unread output. */
interface AetherReadResult {
  kind: 'read'
  session_id: string
  logs: AetherLogsValue
}

/** Every canonical result the open action may return. */
type AetherOpenResult = AetherOpenedResult | AetherErrorResult
/** Every canonical result the eval action may return. */
type AetherEvalResult = AetherValueResult | AetherErrorResult
/** Every canonical result the list action may return. */
type AetherListResult = AetherListedResult | AetherErrorResult
/** Every canonical result the close action may return. */
type AetherCloseResult = AetherClosedResult | AetherErrorResult
/** Every canonical result the read action may return. */
type AetherReadOutcome = AetherReadResult | AetherErrorResult
/** Every canonical result the unified tool may return. */
type AetherSessionOutcome =
  | AetherOpenResult
  | AetherEvalResult
  | AetherListResult
  | AetherCloseResult
  | AetherReadOutcome

/** One collected interpreter stream retained for diagnostics. */
const DIAGNOSTICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    spill_path: { type: 'string' },
  },
} as const

/** Unrelated stdout and the interpreter's own diagnostic stream for one request. */
const LOGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    stdout: DIAGNOSTICS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** A failure the interpreter reported for one evaluated program. */
const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    message: { type: 'string', required: true },
    code: { type: 'string' },
    builtin: { type: 'string' },
    hint: { type: 'string' },
    did_you_mean: { type: 'array', items: { type: 'string' } },
    retryable: { type: 'boolean' },
  },
} as const

/**
 * Bounded logs attached to an interpreter failure.
 *
 * This is {@link LOGS_SCHEMA} without the property-level `required` annotation:
 * a refusal has no logs, while a failure the interpreter returned always does.
 */
const FAILURE_LOGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stdout: DIAGNOSTICS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** The file-effect facts one handle was opened under. */
const POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    mode: { type: 'string', required: true },
    workspace_root: { type: 'string', required: true },
    enforcement: { type: 'string', enum: ['full', 'partial'] },
  },
} as const

/** One opened handle. */
const OPENED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'opened' },
    session_id: { type: 'string', required: true },
    name: { type: 'string' },
    cwd: { type: 'string', required: true, description: 'Absolute directory the interpreter process started in.' },
    policy: POLICY_SCHEMA,
  },
} as const

/** One evaluated program that produced a value. */
const SESSION_VALUE_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'value' },
    session_id: { type: 'string', required: true },
    value: { type: 'json', required: true },
    result_type: { type: 'string' },
    logs: LOGS_SCHEMA,
  },
} as const

/** Any failed action: an argument refusal, a budget refusal, or an interpreter failure. */
const ERROR_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'error' },
    session_id: { type: 'string', description: 'Handle the failed action concerned, when it had one.' },
    error: FAILURE_SCHEMA,
    logs: FAILURE_LOGS_SCHEMA,
  },
} as const

/** The interpreter's own counters for one session. */
const USAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    evals: { type: 'number' },
    tokens_in: { type: 'number' },
    tokens_out: { type: 'number' },
    tokens_total: { type: 'number' },
  },
} as const

/** One handle's current state. */
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // An array item is not a property, so it carries no `required` annotation;
  // each field below marks itself required instead.
  properties: {
    session_id: { type: 'string', required: true },
    name: { type: 'string' },
    cwd: { type: 'string', required: true, description: 'Absolute directory the interpreter process started in; a program may since have changed it.' },
    phase: { type: 'string', required: true, enum: ['starting', 'ready', 'busy', 'destroyed'] },
    policy_mode: { type: 'string', required: true },
    reason: { type: 'string' },
    usage: USAGE_SCHEMA,
  },
} as const

/** This owner's handles. */
const LISTED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'listed' },
    sessions: { type: 'array', required: true, items: SUMMARY_SCHEMA },
  },
} as const

/** One closed handle. */
const CLOSED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'closed' },
    session_id: { type: 'string', required: true },
    closed: { type: 'boolean', required: true },
    native_closed: { type: 'boolean', required: true },
  },
} as const

/** One drain of a session's unread output. */
const READ_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'read' },
    session_id: { type: 'string', required: true },
    logs: LOGS_SCHEMA,
  },
} as const

/** Every canonical result the unified tool may return. */
const SESSION_OUTCOME_SCHEMA = {
  oneOf: [OPENED_ARM, SESSION_VALUE_ARM, ERROR_ARM, LISTED_ARM, READ_ARM, CLOSED_ARM],
} as const

/** The unified tool's `action` parameter. */
const ACTION_PARAMETER = {
  type: 'string',
  required: true,
  enum: SESSION_ACTIONS,
  description: 'Session operation: open starts a process and returns its id; eval runs source in it; read drains unread output without running code; '
    + 'list reports this agent\'s handles; close terminates one. cwd and name apply only to open, usage only to list, and timeoutMs to every action except read.',
} as const

/** The session id argument the handle operations accept. */
const SESSION_ID_PARAMETER = {
  type: 'string',
  description: 'Id from action open; private to this agent. Required for eval, read, and close; omit for open and list.',
} as const

/** Deadline argument shared with the foreground tools. */
const TIMEOUT_PARAMETER = {
  type: 'number',
  description: 'Hard deadline (ms); timeout/cancel kills the session. Deployment default/cap apply. Not accepted by action read.',
} as const

/** The manager plus the unified tool definition that registers against it. */
export interface AetherSessionTools {
  /** The manager, so the caller can dispose it with the plugin fiber. */
  readonly sessions: AetherSessions
  /** The unified tool definition. */
  readonly tools: readonly ToolDefinition[]
}

/**
 * Build one printable argument refusal.
 * @param detail - what is wrong, naming the action, the field, and the safe next step.
 * @returns the refusal to throw.
 */
function sessionArgsFailure(detail: string): HarnessError {
  return new HarnessError(`aether-shell [${E_INPUT_SESSION_ARGS}]: ${detail}`, E_INPUT_SESSION_ARGS)
}

/**
 * Reject every undeclared field and every field the selected action does not
 * read.
 *
 * Presence is tested against `undefined`, so a falsy value such as `false` or
 * `0` is still refused rather than silently ignored. The scans run before an
 * owner is looked up, a session is resolved, or a process is started.
 * @param args - the model-supplied arguments.
 * @throws HarnessError with E_INPUT_SESSION_ARGS when an undeclared or inapplicable field is present.
 */
function assertActionFields(args: AetherSessionArgs): void {
  for (const field of Object.keys(args)) {
    if (SESSION_FIELDS.includes(field)) continue
    throw sessionArgsFailure(
      `aether_session action "${args.action}" does not accept "${field}"; pass only action, session_id, code, cwd, name, usage, and timeoutMs`,
    )
  }
  const accepted = ACTION_ARGUMENTS[args.action]
  for (const field of SESSION_ARGUMENTS) {
    if (accepted.includes(field) || args[field] === undefined) continue
    throw sessionArgsFailure(
      `aether_session action "${args.action}" does not accept "${field}"; omit ${field} and pass only the fields that action reads (${accepted.join(', ')})`,
    )
  }
}

/**
 * Read the non-empty handle an eval, read, or close call requires.
 * @param args - the model-supplied arguments.
 * @param action - the action that requires a handle.
 * @returns the handle id to resolve.
 * @throws HarnessError with E_INPUT_SESSION_ARGS when the id is missing or blank.
 */
function requireSessionId(args: AetherSessionArgs, action: 'eval' | 'read' | 'close'): string {
  const sessionId = args.session_id
  if (sessionId === undefined || sessionId.trim().length === 0) {
    throw sessionArgsFailure(
      `aether_session action "${action}" requires "session_id"; pass the id returned by action "open"`,
    )
  }
  return sessionId
}

/**
 * Read the non-empty, size-bounded program an eval call requires.
 * @param args - the model-supplied arguments.
 * @param resolved - the resolved configuration supplying the request budget.
 * @returns the program to evaluate.
 * @throws HarnessError with E_INPUT_SESSION_ARGS when the program is missing or blank.
 * @throws Error naming the actual and permitted sizes when the program exceeds the request budget.
 */
function requireCode(args: AetherSessionArgs, resolved: ResolvedConfig): string {
  const code = args.code
  if (code === undefined || code.trim().length === 0) {
    throw sessionArgsFailure('aether_session action "eval" requires "code"; pass a non-empty AetherShell program')
  }
  assertRequestBytes(code, resolved)
  return code
}

/** Reject a blank working directory before it reaches a spawn. */
function assertWorkdir(cwd: string | undefined): void {
  if (cwd !== undefined && cwd.trim().length === 0) {
    throw new Error('aether-shell: cwd must be a non-empty path')
  }
}

/** Longest caller-supplied session label kept, in characters. */
const MAX_SESSION_NAME_CHARS = 120

/**
 * Accept a caller-supplied label as one bounded line of text.
 *
 * The label reaches the model in every listing, so it is normalized here
 * rather than trusted: a multi-line or control-bearing value would let a
 * caller forge listing structure, and an unbounded one would join the
 * complete-result budget.
 * @param name - the model-supplied label, when it gave one.
 * @returns the label to store, or undefined when none was given.
 * @throws Error when the label is empty or carries a control character.
 */
function readSessionName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  if (name.trim().length === 0) {
    throw new Error('aether-shell [E_INPUT_NAME]: name must be a non-empty label when given')
  }
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      throw new Error('aether-shell [E_INPUT_NAME]: name must be one line of printable text')
    }
  }
  return name.length > MAX_SESSION_NAME_CHARS ? `${name.slice(0, MAX_SESSION_NAME_CHARS)}…` : name
}

/** Build the limit failure body shared by every action. */
function limitError(message: string): AetherFailureValue {
  return {
    code: RESULT_LIMIT_CODE,
    message,
    hint: 'read less in one call: evaluate a program that projects or pages its own result, or list fewer sessions.',
    retryable: false,
  }
}

/** The exact rendered line for one opened handle. */
function renderOpened(value: AetherOpenResult): string {
  if (value.kind === 'error') return renderLimit(value.error)
  const label = value.name === undefined ? '' : ` (${value.name})`
  const enforcement = value.policy.enforcement === undefined ? '' : `, enforcement ${value.policy.enforcement}`
  return `aether session: opened ${value.session_id}${label} in ${value.cwd} under policy ${value.policy.mode} (workspace ${value.policy.workspace_root}${enforcement})`
}

/** The exact rendered line for a complete result this deployment's budget refused. */
function renderLimit(error: AetherFailureValue): string {
  return `aether session: ${error.message}. ${error.hint ?? ''}`.trim()
}

/** Render one bounded log stream, naming truncation and the complete-stream pointer. */
function renderLog(name: 'stdout' | 'stderr', stream: AetherStreamValue): string {
  const text = stream.text.trim()
  if (text.length === 0) return ''
  const cut = stream.truncated ? ' (earlier bytes dropped)' : ''
  const spill = stream.spill_path === undefined ? '' : ` (complete stream: ${stream.spill_path})`
  return `\n[${name}]${cut}${spill}: ${text}`
}

/** Render the diagnostics one session request retained. */
function renderLogs(logs: AetherLogsValue | undefined): string {
  if (logs === undefined) return ''
  return `${renderLog('stdout', logs.stdout)}${renderLog('stderr', logs.stderr)}`
}

/** Render one drain of a session's unread output. */
function renderRead(value: AetherReadOutcome): string {
  if (value.kind === 'error') return renderLimit(value.error)
  const logs = renderLogs(value.logs)
  return logs.length === 0
    ? `aether session ${value.session_id}: no unread output`
    : `aether session ${value.session_id}:${logs}`
}

/** The exact rendered line for one evaluated program. */
function renderEvaluation(value: AetherEvalResult): string {
  if (value.kind === 'value') {
    return `aether session ${value.session_id}: ${value.result_type ?? 'value'} = ${JSON.stringify(value.value)}${renderLogs(value.logs)}`
  }
  // The budget-refusal arm carries no logs; the interpreter's own failure arm always does.
  if (value.logs === undefined) return renderLimit(value.error)
  const session = value.session_id === undefined ? 'aether session' : `aether session ${value.session_id}`
  return `${session}: failed${value.error.code === undefined ? '' : ` [${value.error.code}]`}: ${value.error.message}`
    + `${value.error.hint === undefined ? '' : `\nhint: ${value.error.hint}`}${renderLogs(value.logs)}`
}

/**
 * Render any failed action.
 *
 * The optional `logs` field distinguishes the two failure paths: a refusal made
 * before the interpreter ran has none and renders as the one-line limit
 * message, while a failure the interpreter reported renders with its bounded
 * logs. The error arm carries no action, so this decision is made from the
 * fields the failing call actually produced.
 * @param value - the canonical error arm.
 * @returns the exact model-facing text.
 */
function renderError(value: AetherErrorResult): string {
  return value.logs === undefined ? renderLimit(value.error) : renderEvaluation(value)
}

/** The exact rendered line for one handle's state. */
function renderSummary(summary: AetherSummaryValue): string {
  const label = summary.name === undefined ? '' : ` (${summary.name})`
  const reason = summary.reason === undefined ? '' : ` — ${summary.reason}`
  const usage = Object.keys(summary.usage).length === 0 ? '' : ` usage ${JSON.stringify(summary.usage)}`
  return `  ${summary.session_id}${label}: ${summary.phase}, initial cwd ${summary.cwd}, ${summary.policy_mode}${usage}${reason}`
}

/** The exact rendered block for one listing. */
function renderListing(value: AetherListResult): string {
  if (value.kind === 'error') return renderLimit(value.error)
  if (value.sessions.length === 0) return 'aether sessions: none open'
  return `aether sessions (${value.sessions.length}):\n${value.sessions.map(renderSummary).join('\n')}`
}

/** The exact rendered line for one close. */
function renderClosed(value: AetherCloseResult): string {
  if (value.kind === 'error') return renderLimit(value.error)
  if (!value.closed) return `aether session ${value.session_id}: no such open session for this agent`
  return `aether session ${value.session_id}: closed${value.native_closed ? '' : ' (the interpreter did not confirm its own close; the process was terminated anyway)'}`
}

/**
 * Render one canonical result by its discriminant.
 * @param value - the validated canonical result.
 * @returns the exact model-facing text.
 */
function renderSession(value: AetherSessionOutcome): string {
  switch (value.kind) {
    case 'opened': return renderOpened(value)
    case 'value': return renderEvaluation(value)
    case 'error': return renderError(value)
    case 'listed': return renderListing(value)
    case 'read': return renderRead(value)
    case 'closed': return renderClosed(value)
    /* v8 ignore next 2 -- the canonical result union is closed; this is the static exhaustiveness guard. */
    default: return assertNever(value)
  }
}

/**
 * Build the persistent-session manager and its one unified tool.
 *
 * Registration stays the caller's effect, so disposing the owner's fiber
 * removes the tool and the caller disposes the manager in the same unwinding.
 * @param dependencies - context, resolved configuration, the plugin's process registry, and the interpreter resolver.
 * @param settings - the deployment's session budgets.
 * @returns the manager and the tool definition.
 * @throws Error when no live-agent registry is mounted, because ownership could not then be proven.
 */
export function createAetherSessionTools(
  dependencies: AetherSessionDependencies,
  settings: AetherSessionSettings,
): AetherSessionTools {
  const { ctx, config } = dependencies
  const sessions = new AetherSessions(dependencies, settings)

  /**
   * The calling agent, which every session operation requires.
   * @param exec - the calling execution.
   * @returns the live Agent that owns this call.
   * @throws Error when the call has no calling agent.
   */
  const ownerOf = (exec: ToolRunContext): AetherSessionOwner => {
    const owner = exec.agent
    if (owner === undefined) {
      throw new Error('aether-shell [E_SESSION_OWNER]: a persistent session must belong to a calling agent, and this call has none')
    }
    return owner
  }

  /**
   * Measure one complete result against the deployment's budget.
   * @param value - the canonical value about to be returned.
   * @param rendered - the exact text the renderer produces for it.
   * @returns the overflow description, or undefined when both forms fit.
   */
  const overflow = (value: unknown, rendered: string): string | undefined => {
    const measured = Math.max(Buffer.byteLength(JSON.stringify(value), 'utf8'), Buffer.byteLength(rendered, 'utf8'))
    return measured > config.maxResultBytes
      ? `the result is ${measured} bytes, over the maxResultBytes budget of ${config.maxResultBytes}`
      : undefined
  }

  /**
   * Read one session's counters for a listing, tolerating a handle that started
   * executing after the listing was taken.
   * @param owner - the calling agent.
   * @param sessionId - the handle to read.
   * @param call - the resolved deadline and cancellation for this read.
   * @returns the interpreter's counters, or undefined when the handle is now busy.
   */
  const readCounters = async (
    owner: AetherSessionOwner,
    sessionId: AetherSessionId,
    call: AetherSessionCall,
  ): Promise<JsonValue | undefined> => {
    try {
      const usage = await sessions.usage(owner, { sessionId, timeoutMs: call.timeoutMs, signal: call.signal })
      return usage.kind === 'value' ? usage.value : undefined
    } catch (error) {
      // The handle began executing between the listing and this read: its
      // counters are simply unavailable for this listing.
      if (error instanceof Error && error.message.includes(AETHER_SESSION_BUSY)) return undefined
      throw error
    }
  }

  /**
   * Run the open action: start one interpreter process and report its handle.
   * @param args - the model-supplied arguments.
   * @param exec - the calling execution and its cancellation.
   * @returns the opened handle, or the refusal when its complete result is over budget.
   * @throws Error when the working directory is blank, the label is unusable, or the session cannot start.
   */
  const openSession = async (args: AetherSessionArgs, exec: ToolRunContext): Promise<AetherOpenResult> => {
    assertWorkdir(args.cwd)
    const name = readSessionName(args.name)
    const timeoutMs = callTimeout(args.timeoutMs, config)
    const owner = ownerOf(exec)
    const result = await sessions.open(owner, {
      ...args.cwd === undefined ? {} : { cwd: args.cwd },
      ...name === undefined ? {} : { name },
      timeoutMs,
      signal: exec.signal,
      managedEnv: ctx.get('shellEnv')?.collect(exec) ?? {},
    })
    const canonical: AetherOpenResult = {
      kind: 'opened',
      session_id: result.sessionId,
      ...result.name === undefined ? {} : { name: result.name },
      cwd: result.cwd,
      policy: {
        mode: result.policy.mode,
        workspace_root: result.policy.workspaceRoot,
        ...result.policy.enforcement === undefined ? {} : { enforcement: result.policy.enforcement },
      },
    }
    const rendered = renderSession(canonical)
    const over = overflow(canonical, rendered)
    if (over === undefined) return canonical
    // A handle whose result the model never receives must not stay alive, so
    // the oversized result is refused only after the session is closed.
    const failure = limitError(over)
    try {
      await sessions.close(owner, { sessionId: result.sessionId, timeoutMs, signal: exec.signal })
    } catch (error) {
      return {
        kind: 'error',
        session_id: result.sessionId,
        error: { ...failure, hint: `the session opened by this call could not be closed: ${describeError(error)}` },
      }
    }
    return { kind: 'error', session_id: result.sessionId, error: failure }
  }

  /**
   * Run the eval action: execute one program inside an owned session.
   * @param args - the model-supplied arguments.
   * @param exec - the calling execution and its cancellation.
   * @returns the value or the interpreter's failure, or the refusal when the complete result is over budget.
   * @throws Error when the handle is missing, blank, foreign, busy, or was opened under a changed policy.
   */
  const evaluateSession = async (args: AetherSessionArgs, exec: ToolRunContext): Promise<AetherEvalResult> => {
    const sessionId = requireSessionId(args, 'eval')
    const code = requireCode(args, config)
    const timeoutMs = callTimeout(args.timeoutMs, config)
    const owner = ownerOf(exec)
    const result = await sessions.evaluate(owner, {
      sessionId: aetherSessionId(sessionId),
      code,
      timeoutMs,
      signal: exec.signal,
    })
    const canonical: AetherEvalResult = evaluationValue(sessionId, result)
    const rendered = renderSession(canonical)
    const over = overflow(canonical, rendered)
    if (over !== undefined) return { kind: 'error', session_id: sessionId, error: limitError(over) }
    return canonical
  }

  /**
   * Run the read action: drain a session's unread between-call output.
   * @param args - the model-supplied arguments.
   * @param exec - the calling execution.
   * @returns the unread logs, or the refusal when the complete result is over budget.
   * @throws Error when the handle is missing, blank, foreign, busy, or was opened under a changed policy.
   */
  const readSession = async (args: AetherSessionArgs, exec: ToolRunContext): Promise<AetherReadOutcome> => {
    const sessionId = requireSessionId(args, 'read')
    const owner = ownerOf(exec)
    const result = await sessions.read(owner, { sessionId: aetherSessionId(sessionId) })
    const canonical: AetherReadOutcome = {
      kind: 'read',
      session_id: result.sessionId,
      logs: { stdout: diagnosticsValue(result.logs.stdout), stderr: diagnosticsValue(result.logs.stderr) },
    }
    const rendered = renderSession(canonical)
    const over = overflow(canonical, rendered)
    if (over !== undefined) return { kind: 'error', session_id: result.sessionId, error: limitError(over) }
    return canonical
  }

  /**
   * Run the list action: report this agent's handles.
   * @param args - the model-supplied arguments.
   * @param exec - the calling execution and its cancellation.
   * @returns one summary per handle, or the refusal when the complete result is over budget.
   * @throws Error when the deployment deadline hint is unusable or a counters request cannot be answered.
   */
  const listSessions = async (args: AetherSessionArgs, exec: ToolRunContext): Promise<AetherListResult> => {
    const timeoutMs = callTimeout(args.timeoutMs, config)
    const owner = ownerOf(exec)
    const summaries = await sessions.list(owner)
    const entries: AetherSummaryValue[] = []
    for (const summary of summaries) {
      // Only an idle handle can answer a counters request: a busy one is
      // executing and would refuse it, so asking would turn an informative
      // listing into one failure.
      if (args.usage !== true || summary.phase !== 'ready') {
        entries.push(summaryValue(summary))
        continue
      }
      entries.push(summaryValue(summary, await readCounters(owner, summary.sessionId, {
        timeoutMs,
        signal: exec.signal,
      })))
    }
    const canonical: AetherListResult = { kind: 'listed', sessions: entries }
    const rendered = renderSession(canonical)
    const over = overflow(canonical, rendered)
    if (over !== undefined) return { kind: 'error', error: limitError(over) }
    return canonical
  }

  /**
   * Run the close action: ask the native session to close, then terminate its process.
   * @param args - the model-supplied arguments.
   * @param exec - the calling execution and its cancellation.
   * @returns whether the handle existed and whether the interpreter confirmed its own close.
   * @throws Error when the handle is missing, blank, foreign, or the close request itself failed.
   */
  const closeSession = async (args: AetherSessionArgs, exec: ToolRunContext): Promise<AetherCloseResult> => {
    const sessionId = requireSessionId(args, 'close')
    const timeoutMs = callTimeout(args.timeoutMs, config)
    const owner = ownerOf(exec)
    const result = await sessions.close(owner, {
      sessionId: aetherSessionId(sessionId),
      timeoutMs,
      signal: exec.signal,
    })
    const canonical: AetherCloseResult = {
      kind: 'closed',
      session_id: result.sessionId,
      closed: result.closed,
      native_closed: result.nativeClosed,
    }
    const rendered = renderSession(canonical)
    const over = overflow(canonical, rendered)
    if (over !== undefined) return { kind: 'error', session_id: result.sessionId, error: limitError(over) }
    return canonical
  }

  const tool = defineTool({
    name: 'aether_session',
    description: 'One persistent interpreter session tool; action selects open, eval, read, list, or close. '
      + 'A session is one long-lived process: variables, functions, cwd and env persist across eval calls, while files, network and services are shared with this host. '
      + 'Sessions are agent-private, count- and idle-limited, and a policy change closes one. '
      + 'No checkpoint/replay, and none survive plugin unload or Host restart. '
      + 'One eval at a time; logs are bounded; a failed program does not roll back earlier effects. '
      + 'Timeout/cancel kills the whole session; open a new session instead of replaying. ' + FILE_POLICY_GUIDANCE,
    parameters: {
      action: ACTION_PARAMETER,
      session_id: SESSION_ID_PARAMETER,
      code: {
        type: 'string',
        description: 'AetherShell source executed in the existing process; required for eval only.',
      },
      cwd: {
        type: 'string',
        description: `${CWD_DESCRIPTION} Only for action open.`,
      },
      name: { type: 'string', description: 'Label for the handle, shown by action list; only for action open.' },
      usage: {
        type: 'boolean',
        description: 'Include native evaluation/token counters, one extra request per ready session; only for action list.',
      },
      timeoutMs: TIMEOUT_PARAMETER,
    },
    output: {
      schema: SESSION_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSession(value) }],
      presentationMeta: (_args, value) => value.kind === 'opened'
        ? { sessionId: value.session_id, cwd: value.cwd }
        : undefined,
    },
    async execute(args, exec): Promise<AetherSessionOutcome> {
      // Relevance is checked once for every action, before an owner, a session,
      // or a process is touched.
      assertActionFields(args)
      switch (args.action) {
        case 'open': return openSession(args, exec)
        case 'eval': return evaluateSession(args, exec)
        case 'read': return readSession(args, exec)
        case 'list': return listSessions(args, exec)
        case 'close': return closeSession(args, exec)
        /* v8 ignore next 2 -- the tool schema's action enum rejects actions outside this union. */
        default: return assertNever(args.action)
      }
    },
  })

  return { sessions, tools: [tool] }
}

/** Project one evaluation onto the eval action's canonical value. */
function evaluationValue(sessionId: string, result: AetherSessionEvaluation): AetherEvalResult {
  const logs = {
    stdout: diagnosticsValue(result.logs.stdout),
    stderr: diagnosticsValue(result.logs.stderr),
  }
  if (result.kind === 'value') {
    return {
      kind: 'value',
      session_id: sessionId,
      value: result.value ?? null,
      ...result.resultType === undefined ? {} : { result_type: result.resultType },
      logs,
    }
  }
  return {
    kind: 'error',
    session_id: sessionId,
    error: failureValue(result.error),
    logs,
  }
}

/** Project one interpreter failure onto the canonical failure vocabulary. */
function failureValue(error: AetherSessionEvaluation['error']): AetherFailureValue {
  return {
    message: error?.message ?? 'the session call failed without a message',
    ...error?.code === undefined ? {} : { code: error.code },
    ...error?.builtin === undefined ? {} : { builtin: error.builtin },
    ...error?.hint === undefined ? {} : { hint: error.hint },
    ...error?.didYouMean === undefined ? {} : { did_you_mean: error.didYouMean },
    ...error?.retryable === undefined ? {} : { retryable: error.retryable },
  }
}

/** Project one handle's summary onto the list action's canonical value. */
function summaryValue(summary: AetherSessionSummary, usage?: JsonValue): AetherSummaryValue {
  return {
    session_id: summary.sessionId,
    ...summary.name === undefined ? {} : { name: summary.name },
    cwd: summary.cwd,
    phase: summary.phase,
    policy_mode: summary.policyMode,
    ...summary.reason === undefined ? {} : { reason: summary.reason },
    usage: usage === undefined ? {} : usageValue(usage),
  }
}

/** Project the interpreter's usage record onto the counters this tool advertises. */
function usageValue(value: JsonValue): AetherUsageReading {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const read = (key: string): number | undefined => {
    const entry = record[key]
    return typeof entry === 'number' ? entry : undefined
  }
  const evals = read('evals')
  const tokensIn = read('tokens_in')
  const tokensOut = read('tokens_out')
  const tokensTotal = read('tokens_total')
  return {
    ...evals === undefined ? {} : { evals },
    ...tokensIn === undefined ? {} : { tokens_in: tokensIn },
    ...tokensOut === undefined ? {} : { tokens_out: tokensOut },
    ...tokensTotal === undefined ? {} : { tokens_total: tokensTotal },
  }
}

/** Project one collected stream onto the canonical diagnostics value. */
function diagnosticsValue(stream: AetherSessionLogs['stdout']): { text: string; truncated: boolean; spill_path?: string } {
  return {
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath === undefined ? {} : { spill_path: stream.spillPath },
  }
}

/** Compile-time exhaustiveness guard for the closed action and result unions. */
function assertNever(value: never): never {
  throw new Error(`aether-shell: unhandled session result ${JSON.stringify(value)}`)
}
