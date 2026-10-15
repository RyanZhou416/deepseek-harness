/**
 * The four model-facing AetherShell tools: pageable ontology discovery, one
 * native builtin call, one native pipeline, and one interpreted program.
 *
 * Every tool is foreground-only under a hard deadline. There is no background
 * mode and no persistent interpreter: a job handle would promise a lifetime
 * this plugin does not own, and the interpreter's own process surface already
 * covers the long-running cases through its builtins.
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
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell-env'
import { callTimeout } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import type { AetherDiscoverOutcome, AetherOntologyPage } from './discovery.ts'
import { projectOntology } from './discovery.ts'
import type { AetherExecDeps, AetherProcesses } from './exec.ts'
import { runAether } from './exec.ts'
import { applyResultLimit } from './limit.ts'
import type { AetherOutcome } from './outcome.ts'
import { renderDiscovery, renderOutcome } from './render.ts'
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
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    sandbox: SANDBOX_SCHEMA,
    process: PROCESS_SCHEMA,
    stderr: DIAGNOSTICS_SCHEMA,
  },
} as const

/** Canonical result of a call, a pipeline, or a program. */
const OUTCOME_SCHEMA = { oneOf: [VALUE_ARM, ERROR_ARM, DENIED_ARM, INTERRUPTED_ARM] } as const

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
 * @param query - the category or builtin name the call named, when it named one.
 * @param outcome - the canonical outcome of the discovery request.
 * @param page - the validated and capped page.
 * @returns the discovery outcome, unchanged for a failure or an interruption.
 */
function projectDiscovery(
  query: string | undefined,
  outcome: AetherOutcome,
  page: AetherOntologyPage,
): AetherDiscoverOutcome {
  if (outcome.kind !== 'value') return outcome
  const { value, discovery } = projectOntology(query, outcome.value, page)
  return { ...outcome, value, discovery }
}

/**
 * Build the four AetherShell tools. Registration is the caller's effect, so
 * disposing the plugin fiber removes every tool.
 * @param dependencies - context, resolved configuration, and plugin-owned state.
 * @returns the tool definitions in registration order.
 */
export function createAetherTools(dependencies: AetherToolDependencies): ToolDefinition[] {
  const { ctx, config, processes, resolveExecutable } = dependencies

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
      const requestText = encodeRequest(args.query === undefined ? ontologyManifestRequest() : ontologyDescribeRequest(args.query))
      assertRequestBytes(requestText, config)
      const outcome = await runAether(depsFor(exec), {
        invocation: { transport: 'agent-api', requestText },
        cwd: resolveWorkdir(args.cwd, exec),
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
      })
      const projected = projectDiscovery(args.query, outcome, page)
      return applyResultLimit(projected, renderDiscovery(projected), config.maxResultBytes)
    },
  })

  const call = defineTool({
    name: 'aether_call',
    description: 'Call one native AetherShell builtin with positional JSON arguments and return its typed result. '
      + '`builtin` is one flat native name (`ls`, `crypto_hash`, `json_parse`); find names with `aether_discover`. '
      + 'Arguments are data, never AetherShell source: a string containing `${` is rejected because the interpreter '
      + 'would interpolate it as code, and every object key must be a plain identifier because the interpreter writes '
      + 'keys unquoted. A process-capable builtin runs under this call\'s DSH file policy, which governs writes and '
      + 'deletes rather than reads, network, or process control; the interpreter\'s own `sh` switch starts off as a '
      + 'convenience default, not a boundary. Foreground only, under a hard deadline. A '
      + 'result larger than the deployment\'s budgets fails loudly and names the narrowing remedy instead of returning '
      + 'a partial value. '
      + DENIAL_GUIDANCE,
    parameters: {
      builtin: { type: 'string', required: true, description: 'Flat native builtin name, for example "ls" or "crypto_hash".' },
      args: {
        type: 'array',
        items: { type: 'json' },
        description: 'Positional arguments in the order the builtin\'s signature declares them; JSON data only.',
      },
      ...CWD_AND_TIMEOUT_ENTRIES,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      const requestText = encodeRequest(callRequest(args.builtin, args.args))
      assertRequestBytes(requestText, config)
      const outcome = await runAether(depsFor(exec), {
        invocation: { transport: 'agent-api', requestText },
        cwd: resolveWorkdir(args.cwd, exec),
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
      })
      return applyResultLimit(outcome, renderOutcome(outcome), config.maxResultBytes)
    },
  })

  const pipeline = defineTool({
    name: 'aether_pipeline',
    description: 'Run an ordered native AetherShell pipeline, each step calling one flat builtin and feeding its '
      + 'result to the next. `select` maps each item of that step\'s result through a dotted field path, so '
      + '`select: "name"` reads the `name` field of every element. `predicate` is an AetherShell expression passed to '
      + 'that step\'s builtin as its lambda first argument and replaces the step\'s `args`. `input` starts the '
      + 'pipeline from a value instead of from the first call. Step arguments are data with the same `${` and object '
      + 'key limits as `aether_call`, and every step runs under this call\'s DSH file policy. Foreground only, '
      + 'under a hard deadline. '
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
        description: 'Value that starts the pipeline; omit it to start from the first step\'s call. An explicit null is rejected because the native request reads it as "no input" rather than the None value — seed None with aether_eval instead.',
      },
      ...CWD_AND_TIMEOUT_ENTRIES,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      const requestText = encodeRequest(pipelineRequest(args.steps, args.input, config))
      assertRequestBytes(requestText, config)
      const outcome = await runAether(depsFor(exec), {
        invocation: { transport: 'agent-api', requestText },
        cwd: resolveWorkdir(args.cwd, exec),
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
      })
      return applyResultLimit(outcome, renderOutcome(outcome), config.maxResultBytes)
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
      + 'Foreground only, under a hard deadline. '
      + DENIAL_GUIDANCE,
    parameters: {
      code: { type: 'string', required: true, description: 'AetherShell program text: an expression, a lambda, or a sequence of statements.' },
      ...CWD_AND_TIMEOUT_ENTRIES,
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    async execute(args, exec) {
      assertWorkdir(args.cwd)
      assertEvalCode(args.code, config)
      const outcome = await runAether(depsFor(exec), {
        invocation: { transport: 'command-line', code: args.code },
        cwd: resolveWorkdir(args.cwd, exec),
        timeoutMs: callTimeout(args.timeoutMs, config),
        signal: exec.signal,
      })
      return applyResultLimit(outcome, renderOutcome(outcome), config.maxResultBytes)
    },
  })

  return [discover, call, pipeline, evaluate]
}
