/**
 * The four model-facing AetherShell tools: pageable ontology discovery, one
 * native builtin call, one native pipeline, and one interpreted program.
 *
 * Discovery keeps a hard deadline. Queries register one owned job when available:
 * foreground wait expiry hands back that job without restarting the operation.
 * A separate execution deadline and explicit cancellation still stop the run.
 * Persistent interpreter sessions remain a separate interface.
 *
 * The three tools that send argument data — discovery's query, one call, and one
 * pipeline — share their one deadline across every request they make. On the
 * `typed-v1` channel that includes the capability preflight, which is a real
 * interpreter request the model never sees; each request therefore receives what
 * remains rather than a second full deadline, and a call with nothing left
 * returns the interrupted arm instead of starting a process with no timer.
 * `aether_eval` sends a program, not data, so it takes no preflight.
 *
 * Each tool measures its complete result — the canonical value and the exact
 * text it renders — against the deployment's result budget after projection, so
 * an oversized payload becomes one actionable failure instead of a partially
 * delivered value.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/tools
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell-env'
import { callTimeout, queryExecutionTimeout } from './config.ts'
import { runForegroundQuery } from './foreground.ts'
import type { AetherQueryResult, AetherPromotedOutcome } from './foreground.ts'
import type { ResolvedConfig, StructuredDataMode } from './config.ts'
import type { AetherDiscoverOutcome, AetherOntologyPage } from './discovery.ts'
import { projectOntology } from './discovery.ts'
import type { AetherExecDeps, AetherProcesses } from './exec.ts'
import { deadlineExhaustedOutcome, runAether } from './exec.ts'
import { probeTypedCapabilities } from './capabilities.ts'
import { applyResultLimit } from './limit.ts'
import type { AetherRetention } from './limit.ts'
import type { AetherOutcome, AetherValueOutcome } from './outcome.ts'
import { isJsonObject } from './outcome.ts'
import { renderDiscovery, renderOutcome } from './render.ts'
import type { AetherResults } from './results.ts'
import {
  assertEvalCode,
  assertRequestBytes,
  callRequest,
  encodeRequest,
  ontologyDescribeRequest,
  ontologyManifestRequest,
  pipelineRequest,
} from './request.ts'

/** Process facts one outcome arm carries, independent of what the interpreter reported. */
const PROCESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    timeoutMs: { type: 'number', required: true },
    cleanupFailed: { type: 'boolean', required: true },
  },
} as const

/** The file-effect decision one call ran under. */
const SANDBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    mode: { type: 'string', required: true },
    enforcement: { type: 'string' },
    denied: { type: 'boolean', required: true },
  },
} as const

/** One collected interpreter stream retained for diagnostics. */
const DIAGNOSTICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    spillPath: { type: 'string' },
  },
} as const

/** A failure the interpreter reported. */
const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    message: { type: 'string', required: true },
    code: { type: 'string' },
    builtin: { type: 'string' },
    hint: { type: 'string' },
    didYouMean: { type: 'array', items: { type: 'string' } },
    retryable: { type: 'boolean' },
    details: { type: 'json' },
  },
} as const

/** The arm an exchange that produced a value returns. */
const VALUE_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'value' },
    value: { type: 'json', required: true },
    resultType: { type: 'string' },
    metadata: { type: 'json' },
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** The arm an exchange the interpreter reported as failed returns. */
const ERROR_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'error' },
    error: FAILURE_SCHEMA,
    resultType: { type: 'string' },
    metadata: { type: 'json' },
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** The arm an exchange the sandbox refused returns. */
const DENIED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'denied' },
    metadata: { type: 'json' },
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** The arm an exchange this plugin stopped before a result returns. */
const INTERRUPTED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'interrupted' },
    metadata: { type: 'json' },
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** The arm an exchange whose complete value was retained for paging returns. */
const RETAINED_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'retained' },
    result: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        id: { type: 'string', required: true, description: 'Retrieval id to pass to aether_result_page.' },
        originalResultType: { type: 'string', description: 'The interpreter\'s own result type name for the retained value, when it named one.' },
        bytes: { type: 'number', required: true, description: 'Serialized UTF-8 byte size of the retained value.' },
        total: { type: 'number', required: true, description: 'Units the retained value holds, counted in `unit`.' },
        unit: { type: 'string', required: true, enum: ['items', 'utf8_bytes'] },
        complete: { type: 'boolean', required: true, const: true, description: 'The whole value was retained; no part of it was dropped.' },
        inline: { type: 'boolean', required: true, const: false, description: 'False: the value was not delivered inline.' },
      },
    },
    metadata: { type: 'json' },
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** Canonical result of a call, a pipeline, or a program. */
const OUTCOME_SCHEMA = { oneOf: [VALUE_ARM, RETAINED_ARM, ERROR_ARM, DENIED_ARM, INTERRUPTED_ARM] } as const

/** A still-running query transferred to the same registered job. */
const PROMOTED_ARM = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'promoted' },
    jobId: { type: 'string', required: true },
    cwd: { type: 'string', required: true },
    waitTimeoutMs: { type: 'number', required: true },
    executionTimeoutMs: { type: 'number', required: true },
  },
} as const
const QUERY_OUTCOME_SCHEMA = { oneOf: [...OUTCOME_SCHEMA.oneOf, PROMOTED_ARM] } as const

/** Render an inline outcome or the original job's collection instructions. */
function renderQueryOutcome(outcome: AetherOutcome | (Omit<AetherPromotedOutcome, 'jobId'> & { jobId: string })): string {
  if (outcome.kind !== 'promoted') {
    const preparation = (outcome.kind === 'denied' || outcome.kind === 'interrupted')
      && isJsonObject(outcome.metadata) && outcome.metadata.operation_started === false
    return `${preparation ? 'Capability preflight stopped; the requested operation was not started.\n' : ''}${renderOutcome(outcome)}`
  }
  const hard = outcome.executionTimeoutMs === 0 ? 'No outer execution deadline is set.' : `Execution remains bounded by ${outcome.executionTimeoutMs}ms.`
  return `aether execution ${outcome.jobId}: still running after ${outcome.waitTimeoutMs}ms; handed off to the original background job. No command was restarted. ${hard} Read the final canonical JSON outcome with job_output {job_id:"${outcome.jobId}"}; use job_kill to stop it. Native proc_run limits still apply.`
}

const HANDOFF_GUIDANCE = 'When a job registry and live owning agent are available and promoteOnTimeout is enabled, '
  + 'timeoutMs bounds only the foreground wait: expiry returns the original job id without stopping or repeating the operation. '
  + 'Collect its final canonical JSON outcome with job_output; use job_kill to stop it. executionTimeoutMs is the independent hard runtime limit, '
  + 'also capped by the deployment\'s maxBackgroundRuntimeMs. Omitted hard limits mean no outer runtime cap when that deployment cap is zero; '
  + 'native proc_run timeout_ms is unchanged. Explicit call cancellation stops and awaits the owned run. '
  + 'Without ownership/jobs, with promotion disabled, or if admission is refused before execution, the foreground wait remains a kill deadline. '

/**
 * What a tool that returns a complete value says about an oversized one.
 *
 * The rule is stated once because all three value-returning tools share it, and
 * it is stated for the model: a retained result is still delivered, so a caller
 * that reads only this sentence knows to page rather than to give up.
 */
const RETENTION_GUIDANCE = 'A result over the deployment\'s complete-result budget is retained whole and '
  + 'returned as an id you read with `aether_result_page`, which never runs the program again; when this '
  + 'deployment cannot retain it, the call fails loudly and names the narrowing remedy instead of returning a '
  + 'partial value. '

/**
 * Denial guidance every effect-capable tool carries.
 *
 * A backend can refuse a file effect and report it through the interpreter's
 * own failure envelope with a localized operating-system message, which this
 * plugin does not match against the backend's denial dialect; the refusal then
 * arrives as an ordinary failed result rather than the `denied` arm. The
 * guidance therefore states the rule for the model independently of how the
 * refusal was classified.
 */
const DENIAL_GUIDANCE = 'An access the DSH file policy denies is final for this call: retrying the same '
  + 'effect through another tool or shell is not a workaround, this plugin offers no in-turn escalation field, '
  + 'grants no permission automatically, and retries nothing with a native approval token — the user must '
  + 'change the policy explicitly for that effect to be allowed.'

/** How one page of ontology discovery was bounded. */
const DISCOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    shape: { type: 'string', required: true, enum: ['manifest', 'category', 'builtin', 'unknown'] },
    query: { type: 'string' },
    offset: { type: 'number' },
    shown: { type: 'number' },
    total: { type: 'number' },
    nextOffset: { type: 'number' },
    truncated: { type: 'boolean', required: true },
  },
} as const

/** The value arm of a discovery outcome, which also carries the page's shape facts. */
const DISCOVERY_VALUE_ARM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'value' },
    value: { type: 'json', required: true },
    resultType: { type: 'string' },
    metadata: { type: 'json' },
    discovery: DISCOVERY_SCHEMA,
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** Canonical result of one ontology discovery. */
const DISCOVERY_OUTCOME_SCHEMA = { oneOf: [DISCOVERY_VALUE_ARM, ERROR_ARM, DENIED_ARM, INTERRUPTED_ARM] } as const

/** Working-directory argument every tool accepts. */
const CWD_PARAMETER = {
  type: 'string',
  description: 'Working directory for this call. Defaults to the session workspace; a relative path is resolved against it.',
} as const

/** Deadline argument every tool accepts. */
const TIMEOUT_PARAMETER = {
  type: 'number',
  description: 'Deadline in milliseconds before this plugin kills the interpreter. The deployment applies its configured default and cap.',
} as const

/** The working-directory and deadline arguments every tool accepts. */
const CWD_AND_TIMEOUT_ENTRIES = { cwd: CWD_PARAMETER, timeoutMs: TIMEOUT_PARAMETER } as const

/** Independent query wait and execution limits; discovery keeps its existing hard deadline. */
const QUERY_EXECUTION_ENTRIES = {
  cwd: CWD_PARAMETER,
  timeoutMs: { type: 'number', description: 'Foreground wait in milliseconds, capped by maxTimeoutMs. With job ownership and promotion enabled, expiry hands off the same execution; otherwise it is a kill deadline.' },
  executionTimeoutMs: { type: 'number', description: 'Independent positive hard execution deadline in milliseconds. Omitted, only maxBackgroundRuntimeMs applies (zero means no outer cap). Native proc_run timeout_ms remains independent.' },
} as const

/**
 * The argument-channel facts a data tool states to the model, keyed by the mode
 * this deployment selected. The text matches the checks this deployment really
 * applies, because the mode is trusted configuration and never a call argument.
 */
const CALL_ARGUMENT_CHANNEL: Record<StructuredDataMode, string> = {
  legacy: 'Arguments are data, never AetherShell source: a string containing `${` is rejected because the interpreter '
    + 'would interpolate it as code, and every object key must be a plain identifier because the interpreter writes '
    + 'keys unquoted. ',
  'typed-v1': 'Arguments travel on the interpreter\'s typed argument channel, which this call verified, so a string '
    + 'containing `${` and a non-identifier object key are data rather than source. ',
}

/** The same fact for one pipeline step; the seed's null rule is stated by the `input` parameter instead. */
const STEP_ARGUMENT_CHANNEL: Record<StructuredDataMode, string> = {
  legacy: 'Step arguments are data with the same `${` and object key limits as `aether_call`, and every step runs under this call\'s DSH file policy. ',
  'typed-v1': 'Step arguments travel on the same verified typed channel as `aether_call`, and every step runs under this call\'s DSH file policy. ',
}

/** The `input` parameter's null rule, which only the converting channel cannot honour. */
const PIPELINE_SEED_DESCRIPTION: Record<StructuredDataMode, string> = {
  legacy: 'Value that starts the pipeline; omit it to start from the first step\'s call. An explicit null is rejected because the native request reads it as "no input" rather than the None value — seed None with aether_eval instead.',
  'typed-v1': 'Value that starts the pipeline; omit it to start from the first step\'s call. An explicit null is sent as the None value, which this deployment verified the interpreter delivers.',
}

/** Smallest remaining budget that can still start one interpreter request. */
const MIN_REQUEST_BUDGET_MS = 1

/**
 * The unspent part of this call's overall deadline.
 *
 * Floored, so no request is ever granted more time than the call has left; a
 * rounded-up budget could hand the last request more than the deployment
 * permitted.
 * @param timeoutMs - the call's overall deadline in milliseconds.
 * @param startedAt - `performance.now()` when the call's first request began.
 * @returns the remaining milliseconds, possibly zero or negative.
 */
function remainingBudget(timeoutMs: number, startedAt: number): number {
  return Math.floor(timeoutMs - (performance.now() - startedAt))
}

/**
 * Run one native argument request under a single overall deadline.
 *
 * On the `typed-v1` channel the capability preflight runs first, under the same
 * capability services, sandbox policy, environment, and working directory as the
 * request itself, so the interpreter that answers is the one this call would
 * reach. An exchange the preflight could not carry — refused by the file-effect
 * policy, or stopped by a spent deadline — is returned with its own outcome and
 * facts rather than reported as a capability verdict. The converting channel
 * makes exactly one request, so that request receives the deployment's deadline
 * unchanged rather than a recomputed remainder.
 * @param deps - capability services, resolved configuration, and plugin-owned state for this call.
 * @param options - the working directory, the call's deadline and cancellation, its channel, and the encoded request.
 * @returns the canonical outcome, including the preflight's own refused or interrupted arm.
 * @throws Error when the deployment's channel cannot be verified for this interpreter.
 * @throws the structured abort when the caller cancelled the call.
 */
async function runNativeRequest(
  deps: AetherExecDeps,
  options: {
    readonly cwd: string
    readonly timeoutMs: number
    readonly signal: AbortSignal
    readonly structured: StructuredDataMode
    readonly requestText: string
  },
): Promise<AetherOutcome> {
  const request = (timeoutMs: number): Promise<AetherOutcome> => runAether(deps, {
    invocation: { transport: 'agent-api', requestText: options.requestText },
    cwd: options.cwd,
    timeoutMs,
    signal: options.signal,
  })
  if (options.structured === 'legacy') return request(options.timeoutMs)
  const startedAt = performance.now()
  const probeBudget = options.timeoutMs === 0 ? deps.config.maxTimeoutMs : Math.min(deps.config.maxTimeoutMs, remainingBudget(options.timeoutMs, startedAt))
  if (probeBudget < MIN_REQUEST_BUDGET_MS) return deadlineExhaustedOutcome(deps, options.timeoutMs)
  const probe = await probeTypedCapabilities(deps, { cwd: options.cwd, timeoutMs: probeBudget, signal: options.signal })
  if (probe.kind === 'stopped') return {
    ...probe.outcome,
    metadata: { phase: 'capabilities', operation_started: false, side_effects: 'unknown', safe_to_retry: false },
  }
  if (options.timeoutMs === 0) return request(0)
  const budget = remainingBudget(options.timeoutMs, startedAt)
  if (budget < MIN_REQUEST_BUDGET_MS) return deadlineExhaustedOutcome(deps, options.timeoutMs)
  return request(budget)
}

/** The capability services and plugin-owned state the tools read. */
export interface AetherToolDependencies {
  /** Context supplying `subprocess`, `sandbox`, `sandboxPolicy`, the optional `shellEnv`, and the tool registry. */
  readonly ctx: Context
  /** Resolved deployment configuration. */
  readonly config: ResolvedConfig
  /** Live-process registry owned by the plugin fiber. */
  readonly processes: AetherProcesses
  /** Interpreter resolver shared by every call. */
  readonly resolveExecutable: (signal?: AbortSignal) => Promise<string>
  /** Retained-result store the value-returning tools hand an oversized value to. */
  readonly results: AetherResults
}

/** Reject a blank working directory before it reaches a spawn. */
function assertWorkdir(cwd: string | undefined): void {
  if (cwd !== undefined && cwd.trim().length === 0) {
    throw new Error('aether-shell: cwd must be a non-empty path')
  }
}

/**
 * Resolve the model's working directory: an explicit relative path is resolved
 * against the session workspace, and an omitted one falls back to that
 * workspace and then to the harness process directory.
 * @param requested - the model-supplied directory, when it gave one.
 * @param exec - the calling execution, which carries the session workspace.
 * @returns the absolute working directory for the interpreter.
 */
function resolveWorkdir(requested: string | undefined, exec: ToolRunContext): string {
  const workspace = exec.agent?.session.header.cwd
  if (requested === undefined) return workspace ?? process.cwd()
  if (workspace !== undefined && !isAbsolute(requested)) return resolvePath(workspace, requested)
  return requested
}

/**
 * Validate and cap one discovery page against the deployment's entry budget.
 * @param offset - the requested zero-based start index.
 * @param limit - the requested page size.
 * @param maxEntries - the deployment's ontology-entry budget, which caps the page.
 * @returns the page to project with.
 * @throws Error when either bound is not a whole number in range.
 */
function ontologyPage(offset: number | undefined, limit: number | undefined, maxEntries: number): AetherOntologyPage {
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new Error('aether-shell [E_INPUT_PAGE]: offset must be a non-negative integer')
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('aether-shell [E_INPUT_PAGE]: limit must be a positive integer')
  }
  return { offset: offset ?? 0, limit: Math.min(limit ?? maxEntries, maxEntries) }
}

/**
 * Attach the bounded ontology page to an outcome that produced a value.
 *
 * Discovery is bounded by its own entry budget and is never given a retention,
 * so the retained arm is unreachable here; it is refused rather than returned,
 * because this tool's schema declares no such arm.
 * @param query - the category or builtin name the call named, when it named one.
 * @param outcome - the canonical outcome of the discovery request.
 * @param page - the validated and capped page.
 * @returns the discovery outcome, unchanged for a failure or an interruption.
 * @throws Error when an ontology page was retained, which this plugin never asks for.
 */
function projectDiscovery(
  query: string | undefined,
  outcome: AetherOutcome,
  page: AetherOntologyPage,
): AetherDiscoverOutcome {
  switch (outcome.kind) {
    case 'value': {
      const { value, discovery } = projectOntology(query, outcome.value, page)
      return { ...outcome, value, discovery }
    }
    case 'retained':
      throw new Error('aether-shell: aether_discover cannot return a retained result')
    case 'error':
    case 'denied':
    case 'interrupted':
      return outcome
  }
}

/**
 * Build the four AetherShell tools. Registration is the caller's effect, so
 * disposing the plugin fiber removes every tool.
 * @param dependencies - context, resolved configuration, and plugin-owned state.
 * @returns the tool definitions in registration order.
 */
export function createAetherTools(dependencies: AetherToolDependencies): ToolDefinition[] {
  const { ctx, config, processes, resolveExecutable, results } = dependencies

  /** Complete execution inputs for one call, including the calling session's own sandbox policy. */
  const depsFor = (exec: ToolRunContext): AetherExecDeps => ({
    subprocess: ctx.subprocess,
    sandbox: ctx.sandbox,
    sandboxPolicy: ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }),
    managedEnv: ctx.get('shellEnv')?.collect(exec) ?? {},
    config,
    processes,
    resolveExecutable,
    report: (message: string) => { ctx.logger.warn(message) },
  })

  /**
   * How this call retains an oversized value, when it can retain one at all.
   *
   * A call with no calling agent cannot own a retained result, and the store
   * refuses one whose agent is not the live registered Agent for its id; either
   * way the bound falls back to the coded limit failure rather than advertising
   * an id nothing can resolve.
   * @param exec - the calling execution.
   * @returns the retention for this call, or undefined when no agent owns it.
   */
  const retentionFor = (exec: ToolRunContext): AetherRetention | undefined => {
    const owner = exec.agent
    if (owner === undefined) return undefined
    return {
      retain: (outcome: AetherValueOutcome) => {
        const stored = results.retain(owner, outcome.value, outcome.resultType)
        if (stored.kind === 'refused') return { reason: stored.reason }
        return {
          outcome: {
            kind: 'retained',
            result: stored.value.summary,
            ...outcome.metadata === undefined ? {} : { metadata: outcome.metadata },
            sandbox: outcome.sandbox,
            process: outcome.process,
            stderr: outcome.stderr,
          },
          discard: () => { stored.value.discard() },
        }
      },
    }
  }

  /** Capture policy, result ownership and execution settings while the call is active. */
  const query = (
    exec: ToolRunContext,
    args: { cwd?: string; timeoutMs?: number; executionTimeoutMs?: number },
    label: string,
    run: (deps: AetherExecDeps, cwd: string, signal: AbortSignal, timeoutMs: number) => Promise<AetherOutcome>,
  ): Promise<AetherQueryResult> => {
    const cwd = resolveWorkdir(args.cwd, exec)
    const deps = depsFor(exec)
    const retention = retentionFor(exec)
    const jobs = ctx.get('jobs')
    return runForegroundQuery({
      ...jobs === undefined ? {} : { jobs },
      ...exec.agent === undefined ? {} : { owner: exec.agent },
      callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId,
      label, cwd, waitTimeoutMs: callTimeout(args.timeoutMs, config),
      executionTimeoutMs: queryExecutionTimeout(args.executionTimeoutMs, config),
      signal: exec.signal, promote: config.promoteOnTimeout,
      run: (signal, timeoutMs) => run(deps, cwd, signal, timeoutMs),
      finish: outcome => applyResultLimit(outcome, renderQueryOutcome(outcome), config.maxResultBytes, retention),
      validateHandoff: receipt => {
        if (Math.max(Buffer.byteLength(JSON.stringify(receipt), 'utf8'), Buffer.byteLength(renderQueryOutcome(receipt), 'utf8')) > config.maxResultBytes) {
          throw new HarnessError('The handoff receipt exceeds maxResultBytes; use a shorter cwd or raise the result budget. The requested operation was not started.', 'E_INPUT_RECEIPT')
        }
      },
      report: message => { ctx.logger.warn(message) },
    })
  }

  const discover = defineTool({
    name: 'aether_discover',
    description: 'Read the native AetherShell ontology. Without `query`, return one page of the category manifest with '
      + 'each category\'s builtin count and effect classes. With a category name, return one page of that category\'s '
      + 'builtins with their signatures and effects. With a builtin name, return its parameters, return type, effects, '
      + 'aliases, and examples. A name the ontology does not know returns the interpreter\'s own unknown-name reply, '
      + 'which is a successful result rather than a failure. Page a list with `offset` and `limit`; a page that leaves '
      + 'entries behind reports `nextOffset`. Foreground only, under a hard deadline.',
    parameters: {
      query: {
        type: 'string',
        description: 'Ontology category or builtin name to describe (for example "Crypto" or "crypto_hash"). Omit for the category manifest.',
      },
      offset: {
        type: 'number',
        description: 'Zero-based index of the first entry to return (default 0). Continue a list with the previous page\'s nextOffset.',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries in this page; the deployment\'s ontology-entry budget caps it.',
      },
      ...CWD_AND_TIMEOUT_ENTRIES,
    },
    output: {
      schema: DISCOVERY_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDiscovery(value) }],
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      if (args.query !== undefined && args.query.trim().length === 0) {
        throw new Error('aether-shell [E_INPUT_QUERY]: query must be a non-empty category or builtin name')
      }
      const page = ontologyPage(args.offset, args.limit, config.maxManifestEntries)
      const requestText = encodeRequest(args.query === undefined ? ontologyManifestRequest() : ontologyDescribeRequest(args.query, config.structuredDataMode))
      assertRequestBytes(requestText, config)
      const outcome = await runNativeRequest(depsFor(exec), {
        cwd: resolveWorkdir(args.cwd, exec),
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
        structured: config.structuredDataMode,
        requestText,
      })
      const projected = projectDiscovery(args.query, outcome, page)
      return applyResultLimit(projected, renderDiscovery(projected), config.maxResultBytes)
    },
  })

  const call = defineTool({
    name: 'aether_call',
    description: 'Call one native AetherShell builtin with positional JSON arguments and return its typed result. '
      + '`builtin` is one flat native name (`ls`, `crypto_hash`, `json_parse`); find names with `aether_discover`. '
      + CALL_ARGUMENT_CHANNEL[config.structuredDataMode]
      + 'A process-capable builtin runs under this call\'s DSH file policy, which governs writes and '
      + 'deletes rather than reads, network, or process control; the interpreter\'s own `sh` switch starts off as a '
      + 'convenience default, not a boundary. '
      + HANDOFF_GUIDANCE
      + RETENTION_GUIDANCE
      + DENIAL_GUIDANCE,
    parameters: {
      builtin: { type: 'string', required: true, description: 'Flat native builtin name, for example "ls" or "crypto_hash".' },
      args: {
        type: 'array',
        items: { type: 'json' },
        description: 'Positional arguments in the order the builtin\'s signature declares them; JSON data only.',
      },
      ...QUERY_EXECUTION_ENTRIES,
    },
    output: {
      schema: QUERY_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderQueryOutcome(value) }],
      presentationMeta: (_args, value) => value.kind === 'retained' ? { resultId: value.result.id }
        : value.kind === 'promoted' ? { jobId: value.jobId } : undefined,
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      const requestText = encodeRequest(callRequest(args.builtin, args.args, config.structuredDataMode))
      assertRequestBytes(requestText, config)
      return query(exec, args, 'aether_call', (deps, cwd, signal, timeoutMs) => runNativeRequest(deps, {
        cwd, timeoutMs, signal, structured: config.structuredDataMode, requestText,
      }))
    },
  })

  const pipeline = defineTool({
    name: 'aether_pipeline',
    description: 'Run an ordered native AetherShell pipeline, each step calling one flat builtin and feeding its '
      + 'result to the next. `select` maps each item of that step\'s result through a dotted field path, so '
      + '`select: "name"` reads the `name` field of every element. `predicate` is an AetherShell expression passed to '
      + 'that step\'s builtin as its lambda first argument and replaces the step\'s `args`. `input` starts the '
      + 'pipeline from a value instead of from the first call. '
      + STEP_ARGUMENT_CHANNEL[config.structuredDataMode]
      + HANDOFF_GUIDANCE
      + RETENTION_GUIDANCE
      + DENIAL_GUIDANCE,
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: 'Steps in execution order; at least one is required.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            builtin: { type: 'string', required: true, description: 'Flat native builtin name this step calls.' },
            args: { type: 'array', items: { type: 'json' }, description: 'Positional arguments for this step; JSON data only.' },
            select: { type: 'string', description: 'Dotted field path read from each element of this step\'s result, for example "name" or "meta.size".' },
            predicate: { type: 'string', description: 'AetherShell expression passed to this step\'s builtin as `fn(x) => <predicate>`; replaces this step\'s args.' },
          },
        },
      },
      input: {
        type: 'json',
        description: PIPELINE_SEED_DESCRIPTION[config.structuredDataMode],
      },
      ...QUERY_EXECUTION_ENTRIES,
    },
    output: {
      schema: QUERY_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderQueryOutcome(value) }],
      presentationMeta: (_args, value) => value.kind === 'retained' ? { resultId: value.result.id }
        : value.kind === 'promoted' ? { jobId: value.jobId } : undefined,
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      const requestText = encodeRequest(pipelineRequest(args.steps, args.input, config, config.structuredDataMode))
      assertRequestBytes(requestText, config)
      return query(exec, args, 'aether_pipeline', (deps, cwd, signal, timeoutMs) => runNativeRequest(deps, {
        cwd, timeoutMs, signal, structured: config.structuredDataMode, requestText,
      }))
    },
  })

  const evaluate = defineTool({
    name: 'aether_eval',
    description: 'Evaluate one AetherShell program and return its canonical JSON value. Unlike the other tools, the '
      + 'program runs on the interpreter\'s own command line, so lambdas, modules such as `file.read("notes.txt")`, '
      + 'and multi-statement programs work and are not limited to flat builtin names. The program must exit '
      + 'successfully for a value; a failing program returns the interpreter\'s own error text. A program that prints '
      + 'nothing reports `resultType: "none"`. Everything the program does runs under this call\'s DSH file policy, '
      + 'which governs writes and deletes rather than file reads, network access, or process control. The '
      + 'interpreter\'s `sh` switch starts off, but that is a convenience default rather than a boundary, because '
      + 'the program can change its own environment and reach the process builtins either way. Numbers outside the '
      + 'exact integer range this runtime can carry are rejected rather than rounded, so ask for such a value as text. '
      + HANDOFF_GUIDANCE
      + RETENTION_GUIDANCE
      + DENIAL_GUIDANCE,
    parameters: {
      code: { type: 'string', required: true, description: 'AetherShell program text: an expression, a lambda, or a sequence of statements.' },
      ...QUERY_EXECUTION_ENTRIES,
    },
    output: {
      schema: QUERY_OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderQueryOutcome(value) }],
      presentationMeta: (_args, value) => value.kind === 'retained' ? { resultId: value.result.id }
        : value.kind === 'promoted' ? { jobId: value.jobId } : undefined,
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      assertEvalCode(args.code, config)
      const code = args.code
      return query(exec, args, 'aether_eval', (deps, cwd, signal, timeoutMs) => runAether(deps, {
        invocation: { transport: 'command-line', code }, cwd, timeoutMs, signal,
      }))
    },
  })

  return [discover, call, pipeline, evaluate]
}
