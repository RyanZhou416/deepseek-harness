/**
 * The five model-facing persistent-session tools: open, evaluate, read, list,
 * and close. `aether_session_read` drains output a session wrote while no call
 * was in flight, which is why the read surface exists separately from
 * evaluation: a session may host a child or a service that keeps writing.
 *
 * These tools exist because the interpreter keeps real native state in one
 * process: variables, functions, the current directory, and the process
 * environment. A tool result therefore reports a live handle rather than the
 * process itself, and the model sees only an opaque session id — the
 * interpreter's own id would expose its process and sequence numbers.
 *
 * The complete result of every tool is measured after projection, so an
 * oversized payload becomes one actionable failure instead of a partially
 * delivered value. Timestamps, idle deadlines, and durations are deliberately
 * absent from every canonical value and from every rendered line: they are
 * runtime facts the manager uses internally, and putting them in a model
 * result would make an otherwise stable transcript drift.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/session-tools
 */

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

/** The failure arm this plugin substitutes when a complete result exceeds the deployment budget. */
interface AetherLimitResult {
  kind: 'error'
  session_id?: string
  error: AetherFailureValue
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

/** One evaluated program the interpreter reported as failed. */
interface AetherErrorResult {
  kind: 'error'
  session_id: string
  error: AetherFailureValue
  logs: AetherLogsValue
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

/** Every canonical result the open tool may return. */
type AetherOpenResult = AetherOpenedResult | AetherLimitResult
/** Every canonical result the eval tool may return. */
type AetherEvalResult = AetherValueResult | AetherErrorResult | AetherLimitResult
/** Every canonical result the list tool may return. */
type AetherListResult = AetherListedResult | AetherLimitResult
/** Every canonical result the close tool may return. */
type AetherCloseResult = AetherClosedResult | AetherLimitResult
/** Every canonical result the read tool may return. */
type AetherReadOutcome = AetherReadResult | AetherLimitResult

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

/** The arm that reports a result this deployment's budget refused to hand back. */
const LIMIT_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'error' },
    session_id: { type: 'string' },
    error: FAILURE_SCHEMA,
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

/** One evaluated program the interpreter reported as failed. */
const SESSION_ERROR_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'error' },
    session_id: { type: 'string', required: true },
    error: FAILURE_SCHEMA,
    logs: LOGS_SCHEMA,
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

/** Open-tool result. */
const OPEN_OUTCOME_SCHEMA = { oneOf: [OPENED_ARM, LIMIT_ARM] } as const
/** Eval-tool result. */
const EVAL_OUTCOME_SCHEMA = { oneOf: [SESSION_VALUE_ARM, SESSION_ERROR_ARM, LIMIT_ARM] } as const
/** List-tool result. */
const LIST_OUTCOME_SCHEMA = { oneOf: [LISTED_ARM, LIMIT_ARM] } as const
/** Close-tool result. */
const CLOSE_OUTCOME_SCHEMA = { oneOf: [CLOSED_ARM, LIMIT_ARM] } as const
/** Read-tool result. */
const READ_OUTCOME_SCHEMA = { oneOf: [READ_ARM, LIMIT_ARM] } as const

/** The session id argument every follow-up tool accepts. */
const SESSION_ID_PARAMETER = {
  type: 'string',
  required: true,
  description: 'Id from aether_session_open; private to this agent.',
} as const

/** Deadline argument shared with the foreground tools. */
const TIMEOUT_PARAMETER = {
  type: 'number',
  description: 'Hard deadline (ms); timeout/cancel kills the session. Deployment default/cap apply.',
} as const

/** The manager plus the tool definitions that register against it. */
export interface AetherSessionTools {
  /** The manager, so the caller can dispose it with the plugin fiber. */
  readonly sessions: AetherSessions
  /** The tool definitions in registration order. */
  readonly tools: readonly ToolDefinition[]
}

/** Reject a blank working directory before it reaches a spawn. */
function assertWorkdir(cwd: string | undefined): void {
  if (cwd !== undefined && cwd.trim().length === 0) {
    throw new Error('aether-shell: cwd must be a non-empty path')
  }
}

/** Reject a blank or oversized program before any interpreter sees it. */
function assertSessionCode(code: string, resolved: ResolvedConfig): void {
  if (code.trim().length === 0) {
    throw new Error('aether-shell [E_INPUT_CODE]: code must be a non-empty program')
  }
  assertRequestBytes(code, resolved)
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

/** Build the limit failure body shared by every tool. */
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
  // The budget-limit arm carries no logs; the interpreter's own failure arm always does.
  if (!('logs' in value)) return renderLimit(value.error)
  return `aether session ${value.session_id}: failed${value.error.code === undefined ? '' : ` [${value.error.code}]`}: ${value.error.message}`
    + `${value.error.hint === undefined ? '' : `\nhint: ${value.error.hint}`}${renderLogs(value.logs)}`
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
 * Build the persistent-session manager and its tools.
 *
 * Registration stays the caller's effect, so disposing the owner's fiber
 * removes the tools and the caller disposes the manager in the same unwinding.
 * @param dependencies - context, resolved configuration, the plugin's process registry, and the interpreter resolver.
 * @param settings - the deployment's session budgets.
 * @returns the manager and the tool definitions in registration order.
 * @throws Error when no live-agent registry is mounted, because ownership could not then be proven.
 */
export function createAetherSessionTools(
  dependencies: AetherSessionDependencies,
  settings: AetherSessionSettings,
): AetherSessionTools {
  const { ctx, config } = dependencies
  const sessions = new AetherSessions(dependencies, settings)

  /**
   * The calling agent, which every session tool requires.
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

  const open = defineTool({
    name: 'aether_session_open',
    description: 'Open a real persistent interpreter; use its id with aether_session_eval. Variables, functions, cwd and env persist per session, '
      + 'but files/network/services share this host. Agent-private, count/idle-limited; policy changes close it. '
      + 'No checkpoint/replay or survival across reopen, plugin unload or Host restart. ' + FILE_POLICY_GUIDANCE,
    parameters: {
      cwd: {
        type: 'string',
        description: CWD_DESCRIPTION,
      },
      name: { type: 'string', description: 'Label shown by aether_session_list.' },
      timeoutMs: TIMEOUT_PARAMETER,
    },
    output: {
      schema: OPEN_OUTCOME_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'error' ? renderLimit(value.error) : renderOpened(value),
      }],
      presentationMeta: (_args, value) => value.kind === 'opened'
        ? { sessionId: value.session_id, cwd: value.cwd }
        : {},
    },
    async execute(args, exec): Promise<AetherOpenResult> {
      assertWorkdir(args.cwd)
      const owner = ownerOf(exec)
      const timeoutMs = callTimeout(args.timeoutMs, config)
      const name = readSessionName(args.name)
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
      const rendered = renderOpened(canonical)
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
    },
  })

  const evaluate = defineTool({
    name: 'aether_session_eval',
    description: 'Run AetherShell source/modules in the session process; variables/functions/cwd/env persist as in aether_session_open. '
      + 'Returns a typed value plus bounded printed logs (not result text); one evaluation at a time. '
      + 'Failure does not roll back earlier effects. Timeout/cancel kills the whole session; open a new one, without replay. '
      + FILE_POLICY_GUIDANCE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      code: {
        type: 'string',
        required: true,
        description: 'AetherShell source executed in the existing process.',
      },
      timeoutMs: TIMEOUT_PARAMETER,
    },
    output: {
      schema: EVAL_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderEvaluation(value) }],
    },
    async execute(args, exec): Promise<AetherEvalResult> {
      assertSessionCode(args.code, config)
      const owner = ownerOf(exec)
      const result = await sessions.evaluate(owner, {
        sessionId: aetherSessionId(args.session_id),
        code: args.code,
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
      })
      const canonical: AetherEvalResult = evaluationValue(args.session_id, result)
      const rendered = renderEvaluation(canonical)
      const over = overflow(canonical, rendered)
      if (over !== undefined) return { kind: 'error', session_id: args.session_id, error: limitError(over) }
      return canonical
    },
  })

  const list = defineTool({
    name: 'aether_session_list',
    description: 'List only this agent\'s sessions: ids, labels, startup cwd, state and file-policy mode. '
      + 'Policy-mismatched sessions are closed and reported destroyed. usage adds counters with one request per ready session.',
    parameters: {
      usage: { type: 'boolean', description: 'Include native evaluation/token counters (extra request per ready session).' },
      timeoutMs: TIMEOUT_PARAMETER,
    },
    output: {
      schema: LIST_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderListing(value) }],
    },
    async execute(args, exec): Promise<AetherListResult> {
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
          timeoutMs: callTimeout(args.timeoutMs, config),
          signal: exec.signal,
        })))
      }
      const canonical: AetherListResult = { kind: 'listed', sessions: entries }
      const rendered = renderListing(canonical)
      const over = overflow(canonical, rendered)
      if (over !== undefined) return { kind: 'error', error: limitError(over) }
      return canonical
    },
  })

  const close = defineTool({
    name: 'aether_session_close',
    description: 'Close this agent\'s session, then terminate its process regardless of the native reply; no new policy grant needed. '
      + 'An unknown id returns closed:false without changes; a foreign agent\'s id is refused.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      timeoutMs: TIMEOUT_PARAMETER,
    },
    output: {
      schema: CLOSE_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderClosed(value) }],
    },
    async execute(args, exec): Promise<AetherCloseResult> {
      const owner = ownerOf(exec)
      const result = await sessions.close(owner, {
        sessionId: aetherSessionId(args.session_id),
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
      })
      const canonical: AetherCloseResult = {
        kind: 'closed',
        session_id: result.sessionId,
        closed: result.closed,
        native_closed: result.nativeClosed,
      }
      const rendered = renderClosed(canonical)
      const over = overflow(canonical, rendered)
      if (over !== undefined) return { kind: 'error', session_id: result.sessionId, error: limitError(over) }
      return canonical
    },
  })

  const read = defineTool({
    name: 'aether_session_read',
    description: 'Drain unread between-call output once, without running code; eval already returns output it saw. '
      + 'No new output means empty logs. Busy/closed/unknown sessions are refused. Logs are bounded; cut tails include the full-stream path.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
    },
    output: {
      schema: READ_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
    },
    async execute(args, exec): Promise<AetherReadOutcome> {
      const owner = ownerOf(exec)
      const result = await sessions.read(owner, { sessionId: aetherSessionId(args.session_id) })
      const canonical: AetherReadOutcome = {
        kind: 'read',
        session_id: result.sessionId,
        logs: { stdout: diagnosticsValue(result.logs.stdout), stderr: diagnosticsValue(result.logs.stderr) },
      }
      const rendered = renderRead(canonical)
      const over = overflow(canonical, rendered)
      if (over !== undefined) return { kind: 'error', session_id: result.sessionId, error: limitError(over) }
      return canonical
    },
  })

  return { sessions, tools: [open, evaluate, read, list, close] }
}

/** Project one evaluation onto the eval tool's canonical value. */
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

/** Project one handle's summary onto the list tool's canonical value. */
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
