/**
 * Background execution of one AetherShell program through `ctx.jobs`.
 *
 * A background job is one decode-free interpreter run: the program travels the
 * interpreter's own command line, its raw stdout and stderr stream into the
 * registry's output ring while it runs, and the job settles on the process facts
 * alone. Nothing here reads a stream as a document, so a program that prints
 * arbitrary text — logs, mixed JSON and prose, nothing at all — is a completed
 * run rather than a protocol failure. That is the deliberate difference from the
 * four foreground tools: `aether_eval` is the strict one-value contract, this is
 * the streaming one.
 *
 * The job owns its own cancellation and deadline. The job's own controller is
 * the only stop the run knows: a `job_kill`, the owning session's disposal, or
 * the jobs service unloading aborts it, a plugin unload terminates its managed
 * range, and the call's own `exec.signal` is not consulted after the id is
 * published — a background job outlives the call that started it by design. The
 * run's managed range is held to quiescence on every settlement, so a job that
 * reports a stopped process has proven its range empty, and one that cannot is
 * marked `cleanupFailed` instead of being called clean.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/background
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JobHooks, JobId, JobOutcome, JobOutputSource, JobRegistry, JobSpec } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { AetherExecDeps, AetherRunFacts, AetherRunStop } from './exec.ts'
import { runAetherFacts } from './exec.ts'
import { describeError, toolAborted } from './errors.ts'
import { assertEvalCode } from './request.ts'
import type { AetherToolDependencies } from './tools.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** One background AetherShell program. */
    aether: 'aether'
  }
}

/** Denial guidance every background run carries, matching the foreground tools. */
const DENIAL_GUIDANCE = 'An access the DSH file policy denies is final for this job: retrying the same '
  + 'effect through another tool or shell is not a workaround, this plugin offers no in-turn escalation field, '
  + 'grants no permission automatically, and retries nothing with a native approval token — the user must '
  + 'change the policy explicitly for that effect to be allowed.'

/**
 * Longest model-facing job label. The registry renders the label inside one
 * roster row and one completion notice, so a whole program must not become the
 * label.
 */
const MAX_LABEL_CHARS = 120

/**
 * Trusted deployment settings for background runs.
 *
 * They travel beside the tool rather than through the plugin's own resolved
 * configuration, so the background surface is wired without changing what the
 * four foreground tools resolve.
 */
export interface AetherBackgroundSettings {
  /**
   * Cap on one job's total runtime in milliseconds. Omitted or `0` means no
   * cap, matching the no-timer sentinel the run's own deadline uses; the
   * model's `timeoutMs` hint is capped by this value rather than replacing it.
   */
  readonly maxRuntimeMs?: number
}

/** Capability services, resolved configuration, plugin-owned state, and the registry this tool starts jobs in. */
export interface AetherBackgroundDependencies extends AetherToolDependencies {
  /** The mounted job registry; the whole surface exists only while this does. */
  readonly jobs: JobRegistry
}

/**
 * Canonical terminal facts of one background run, delivered once as the job's
 * result by the first `job_output` read after settlement.
 *
 * These are the process's own facts, not the interpreter's decoded result:
 * `stdout` and `stderr` reach the model as the raw streams they were, and this
 * record says how the process ended and what happened to those streams.
 */
export interface AetherJobFacts {
  /** Interpreter exit code; `null` when a signal ended it. */
  readonly exitCode: number | null
  /** Terminating signal name; `null` on a normal exit. */
  readonly signal: string | null
  /** The job's own deadline elapsed. */
  readonly timedOut: boolean
  /** The deadline actually applied to this job, in milliseconds; `0` means none. */
  readonly timeoutMs: number
  /** Why this plugin stopped the run; absent when the program ended on its own. */
  readonly stop?: AetherRunStop
  /** The managed process range did not reach quiescence within the grace period. */
  readonly cleanupFailed: boolean
  /** The file-effect decision this job ran under. */
  readonly sandbox: { readonly mode: string; readonly enforcement?: string }
  /** The in-memory stdout window lost its head, so the retained text is a tail. */
  readonly stdoutTruncated: boolean
  /** Complete stdout stream, when the provider kept one. */
  readonly stdoutSpillPath?: string
  /** The in-memory stderr window lost its head, so the retained text is a tail. */
  readonly stderrTruncated: boolean
  /** Complete stderr stream, when the provider kept one. */
  readonly stderrSpillPath?: string
}

/** One admitted background run: everything the starter needs, resolved before the job exists. */
interface AetherBackgroundRun {
  readonly deps: AetherToolDependencies
  readonly invocation: { readonly transport: 'command-line'; readonly code: string }
  readonly label: string
  readonly cwd: string
  readonly policy: SandboxExecutionPolicy
  readonly managedEnv: Readonly<Record<string, string>>
  /** Deadline for the whole job in milliseconds; `0` arms no timer. */
  readonly timeoutMs: number
  /** Model-facing read and completion-notice cap in UTF-8 bytes. */
  readonly outputLimitBytes: number
}

/** A settled run's status, the line every reader sees beside it, and the facts the result carries. */
interface AetherJobReport {
  readonly status: JobOutcome['status']
  readonly detail: string
  readonly facts: AetherJobFacts
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
 * The one-line label for one job: the caller's own label when it supplied one,
 * otherwise the program's first non-blank line. Whitespace is collapsed because
 * the registry renders the label inside a single roster row.
 * @param provided - the model-supplied label, when it gave one.
 * @param code - the program text the job will run.
 * @returns a non-empty, single-line label within the display bound.
 */
function jobLabel(provided: string | undefined, code: string): string {
  const declared = provided?.trim() ?? ''
  const source = declared.length > 0
    ? declared
    : code.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? 'aether program'
  const text = source.replace(/\s+/g, ' ')
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS)}…` : text
}

/**
 * Resolve one job's whole-run deadline.
 *
 * An omitted hint means no deadline (`0`, the deadline seam's no-timer
 * sentinel) unless the deployment capped job runtime, which then bounds it; a
 * supplied hint must be a positive finite number of milliseconds within the
 * runtime's timer bound, or the call fails before anything is registered. That
 * bound is checked here because the deadline seam owns it and would otherwise
 * throw inside the already-registered run, turning an unusable hint into a
 * started job that immediately fails.
 * @param requested - the model-supplied hint, when it gave one.
 * @param settings - trusted deployment settings for background runs.
 * @returns the effective deadline in milliseconds; `0` means none.
 * @throws Error when the hint or the configured cap is not a positive finite number within the timer bound.
 */
function jobDeadline(requested: number | undefined, settings: AetherBackgroundSettings): number {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0 || requested > MAX_TIMER_DELAY_MS)) {
    throw new Error(`aether-shell [E_INPUT_TIMEOUT]: timeoutMs must be a positive finite number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}, got ${JSON.stringify(requested)}`)
  }
  const cap = settings.maxRuntimeMs
  // A cap of `0` is the same no-ceiling sentinel the run's own deadline uses,
  // so a deployment that spells "unlimited" as `0` and one that omits the
  // setting agree instead of one of them failing every job.
  if (cap === undefined || cap === 0) return requested ?? 0
  if (!Number.isFinite(cap) || cap < 0 || cap > MAX_TIMER_DELAY_MS) {
    throw new Error(`aether-shell: the deployment's maxRuntimeMs must be 0 or a positive finite number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}, got ${JSON.stringify(cap)}`)
  }
  return Math.min(requested ?? cap, cap)
}

/**
 * The interpreter's collected streams as registry pull sources.
 *
 * The two sources are a stable proxy: they exist from the registration commit,
 * before the process does, and a read before the asynchronous spawn yields
 * nothing rather than failing. Reads never consume, so the pump, the run's own
 * settlement, and any observer keep independent offsets.
 * @param live - the spawned handle, or undefined until the starter has spawned it.
 * @returns one source per stream, stdout first.
 */
function aetherJobSources(live: () => Pick<SubprocessHandle, 'collected'> | undefined): JobOutputSource[] {
  const source = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte) => {
      const handle = live()
      const reader = handle === undefined
        ? undefined
        : channel === 'stdout' ? handle.collected.stdout : handle.collected.stderr
      return reader === undefined
        ? { text: '', nextOffset: fromByte, lossy: false }
        : reader.readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * Project one settled run onto the job's terminal report.
 *
 * A stop this plugin caused is `killed` — the job's deadline is a stop, not a
 * failure of the program — while a nonzero exit, a signalled process, or an
 * unproven managed range is `failed`, because none of those is an outcome the
 * caller asked for. The runner verdict outranks the exit facts: a runner that
 * never reached the interpreter produced no command result at all.
 * @param facts - raw facts of the settled run.
 * @returns the status, its one-line detail, and the facts the result carries.
 */
function jobReport(facts: AetherRunFacts): AetherJobReport {
  const recorded: AetherJobFacts = {
    exitCode: facts.process.exitCode,
    signal: facts.process.signal,
    timedOut: facts.process.timedOut,
    timeoutMs: facts.process.timeoutMs,
    ...facts.stop === undefined ? {} : { stop: facts.stop },
    cleanupFailed: facts.process.cleanupFailed,
    sandbox: {
      mode: facts.sandbox.mode,
      ...facts.sandbox.enforcement === undefined ? {} : { enforcement: facts.sandbox.enforcement },
    },
    stdoutTruncated: facts.stdout.truncated,
    ...facts.stdout.spillPath === undefined ? {} : { stdoutSpillPath: facts.stdout.spillPath },
    stderrTruncated: facts.stderr.truncated,
    ...facts.stderr.spillPath === undefined ? {} : { stderrSpillPath: facts.stderr.spillPath },
  }
  const { runnerFailure } = facts
  if (runnerFailure !== undefined) {
    return { status: 'failed', detail: `the sandbox runner failed under ${runnerFailure.mode} mode: ${runnerFailure.detail}`, facts: recorded }
  }
  const { stop } = facts
  if (stop === 'deadline') {
    return { status: 'killed', detail: `deadline exceeded (${facts.process.timeoutMs}ms)`, facts: recorded }
  }
  if (stop === 'cancelled') {
    // The registry appends the recorded kill reason to this detail, so the stop
    // is named once, by whoever asked for it.
    return { status: 'killed', detail: 'stopped', facts: recorded }
  }
  if (stop === 'teardown') {
    return { status: 'killed', detail: 'the interpreter was stopped because the plugin unloaded', facts: recorded }
  }
  const { exitCode, signal } = facts.process
  if (exitCode === 0) return { status: 'completed', detail: 'exit code: 0', facts: recorded }
  if (exitCode === null) return { status: 'failed', detail: `signal: ${signal ?? 'unknown'}`, facts: recorded }
  return { status: 'failed', detail: `exit code: ${exitCode}`, facts: recorded }
}

/**
 * Render one report as the producer's terminal outcome.
 *
 * The detail and the result record are built together, so the one-line status
 * every reader sees and the canonical facts the first terminal read hands out
 * cannot disagree. A managed range that did not stop within the grace period is
 * reported in both and fails the record rather than passing for a clean run.
 * @param report - the settled run's status, detail, and facts.
 * @returns the outcome for the `ctx.jobs` registration.
 */
function jobOutcome(report: AetherJobReport): JobOutcome {
  const { cleanupFailed } = report.facts
  return {
    status: cleanupFailed ? 'failed' : report.status,
    detail: cleanupFailed
      ? `${report.detail}; the managed process range did not stop within the grace period`
      : report.detail,
    result: JSON.stringify(report.facts),
  }
}

/**
 * Producer hooks for one background run.
 *
 * `done` resolves only once the run's managed range has settled, and it never
 * rejects: a stop this job caused is `killed`, and any other rejection is an
 * infrastructure failure. `cancel` is synchronous and idempotent, matching the
 * registry's contract.
 * @param run - starts the decode-free run under this job's own cancellation.
 * @returns the hooks for one `ctx.jobs` registration.
 */
function jobHooks(run: (signal: AbortSignal) => Promise<AetherRunFacts>): JobHooks {
  const cancellation = new AbortController()
  const done: Promise<JobOutcome> = (async (): Promise<JobOutcome> => {
    try {
      return jobOutcome(jobReport(await run(cancellation.signal)))
    } catch (error: unknown) {
      // A rejection while this job's own controller is aborted is the stop it
      // asked for; anything else is an infrastructure failure.
      if (cancellation.signal.aborted) return { status: 'killed', detail: 'stopped' }
      return { status: 'failed', detail: describeError(error) }
    }
  })()
  return {
    cancel: (reason) => {
      if (cancellation.signal.aborted) return
      cancellation.abort(reason)
    },
    done,
  }
}

/**
 * Build the capability inputs one job reads.
 *
 * The calling session's file policy and managed environment are captured here,
 * while the call is still on the stack: the producer runs after it returns, so
 * nothing may hold the execution that started the job.
 * @param run - the run's resolved inputs.
 * @param live - receives the spawned handle, so the pull sources can bind it.
 * @returns the dependencies for the decode-free run.
 */
function jobDeps(run: AetherBackgroundRun, live: { handle?: SubprocessHandle }): AetherExecDeps {
  const { ctx } = run.deps
  return {
    subprocess: ctx.subprocess,
    sandbox: ctx.sandbox,
    sandboxPolicy: run.policy,
    managedEnv: run.managedEnv,
    config: run.deps.config,
    processes: run.deps.processes,
    resolveExecutable: run.deps.resolveExecutable,
    onSpawn: (handle) => { live.handle = handle },
    report: (message: string) => { ctx.logger.warn(message) },
  }
}

/**
 * Register one background interpreter run.
 *
 * The process starts inside the producer, after the registry admitted the job:
 * an admission refusal registers nothing and spawns nothing, and every failure
 * after that becomes a job status rather than a rejected tool call. The run is
 * cancelled by this job's own controller, so the call that started it can end
 * without ending the work.
 * @param jobs - the mounted job registry.
 * @param owner - owning session, whose live agent's disposal cancels and awaits this job.
 * @param run - the run's resolved inputs.
 * @returns the registry-issued id (`aether-N`).
 * @throws Error when the registry refuses admission: no controller, no live owner, or the owner's job limit.
 */
function startBackgroundJob(
  jobs: JobRegistry,
  owner: NonNullable<JobSpec['owner']>,
  run: AetherBackgroundRun,
): JobId {
  const live: { handle?: SubprocessHandle } = {}
  const deps = jobDeps(run, live)
  return jobs.start({
    kind: 'aether',
    label: run.label,
    owner,
    outputLimitBytes: run.outputLimitBytes,
    output: aetherJobSources(() => live.handle),
    run: () => jobHooks(signal => runAetherFacts(deps, {
      invocation: run.invocation,
      cwd: run.cwd,
      timeoutMs: run.timeoutMs,
      signal,
    })),
  })
}

/**
 * Build the one background tool.
 *
 * Registration is the caller's effect, and the tool exists exactly while a job
 * registry is mounted: a job id no controller can collect or stop would be worse
 * than an absent tool.
 * @param dependencies - context, resolved configuration, plugin-owned state, and the job registry.
 * @param settings - trusted deployment settings for background runs.
 * @returns the `aether_job_start` definition.
 */
export function createAetherBackgroundTool(
  dependencies: AetherBackgroundDependencies,
  settings: AetherBackgroundSettings = {},
): ToolDefinition {
  const { ctx, config, jobs } = dependencies
  return defineTool({
    name: 'aether_job_start',
    description: 'Start one AetherShell program as a background job and return its job id immediately. '
      + 'This is the streaming counterpart of `aether_eval`: the program runs on the interpreter\'s own command '
      + 'line, but no result document is read, so a program that prints logs, mixed JSON, or nothing at all '
      + 'still completes. Read the interpreter\'s raw stdout and stderr with `job_output`; the canonical exit '
      + 'facts and any spill file arrive with the first read after settlement. `job_kill` requests a stop; '
      + 'settlement follows managed-process cleanup. Each job is a fresh interpreter process: no variables, functions, '
      + 'or directory changes persist. The job runs without a deadline unless this deployment caps job runtime '
      + 'or the call supplies `timeoutMs`. The job belongs to this session and is stopped when this session\'s '
      + 'agent is disposed or the plugin unloads. Output a program\'s own children produce through the '
      + 'interpreter\'s process builtins may be captured by the interpreter until it returns it, so realtime '
      + 'child logs are not promised. The job uses this session\'s DSH file policy as it stood when the job started, '
      + 'which governs writes and deletes rather than file reads, network access, or process control; the '
      + 'interpreter\'s `sh` switch starts off as a convenience default, not a boundary. '
      + DENIAL_GUIDANCE,
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'AetherShell program text to run in the background: an expression, a lambda, or a sequence of statements.',
      },
      label: {
        type: 'string',
        description: 'Short human-facing label for this job, shown in job listings and the UI. Omit to use the program\'s first line.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for this job. Defaults to the session workspace; a relative path is resolved against it.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Deadline in milliseconds for the whole job. Omitted, the job runs until it finishes or `job_kill` stops it, bounded only by this deployment\'s job-runtime cap when one is set.',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started background job ${value.jobId}` }],
    },
    execute(args, exec) {
      assertWorkdir(args.cwd)
      assertEvalCode(args.code, config)
      const owner = exec.agent
      if (owner === undefined) {
        throw new Error('aether-shell [E_INPUT_OWNER]: aether_job_start requires an owning agent session; a background job belongs to the session that started it')
      }
      // The deadline is validated before the registry is asked to admit the
      // job, so an unusable hint registers nothing and spawns nothing.
      const timeoutMs = jobDeadline(args.timeoutMs, settings)
      if (exec.signal.aborted) throw toolAborted()
      const jobId = startBackgroundJob(jobs, owner.id, {
        deps: dependencies,
        invocation: { transport: 'command-line', code: args.code },
        label: jobLabel(args.label, args.code),
        cwd: resolveWorkdir(args.cwd, exec),
        policy: ctx.sandboxPolicy.resolve({ session: owner.session }),
        managedEnv: ctx.get('shellEnv')?.collect(exec) ?? {},
        timeoutMs,
        outputLimitBytes: config.maxResultBytes,
      })
      return Promise.resolve({ kind: 'background' as const, jobId })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: jobLabel(args.label, args.code),
      kind: 'execute',
      rawInput: args.code,
    }),
  })
}
