/**
 * Execution of one interpreter request through the harness capability seams.
 *
 * Nothing here is shell-mediated: the interpreter is resolved with
 * `ctx.subprocess.resolveExecutable`, wrapped by `ctx.sandbox.confine` whenever
 * the calling session's policy is not `danger-full-access`, and spawned
 * directly. The child receives a scrubbed environment in which every ambient
 * `AETHER_*`/`AE_*` control setting is cleared before this deployment's values
 * are set, so an inherited permissive policy, blanket approval, or workspace
 * jail cannot outrank what this plugin decided. The interpreter's own `sh` jail
 * is never treated as the sandbox — `ctx.sandbox` is the only confinement this
 * plugin relies on, and it is a file-effect policy: it governs what the
 * confined child writes or deletes under the resolved mode, not reads, network
 * access, or process control.
 *
 * Three lifecycle rules hold here. A confining runner that fails is an
 * infrastructure failure, not a command result, so it fails closed before any
 * output is read. A managed range is held to quiescence on every settlement,
 * successful or not, because the interpreter can leave `proc_spawn`
 * descendants behind; a range that does not empty within the grace period is
 * reported loudly and marked on the outcome instead of being called clean, so
 * quiescence is a proven fact only when the backend can prove it. And teardown
 * never yields a late spawn: the registry owns each preparation from before its
 * first lookup, cancels in-flight preparations when the fiber unloads, and
 * terminates any process that is registered after teardown began. A resolver or
 * provider that ignores its cancellation cannot hold the call open, because
 * each preparation step is raced against the fused abort.
 *
 * {@link runAether} decodes the interpreter's own protocol; {@link runAetherFacts}
 * is its decode-free sibling, reporting the same process, confinement, stop, and
 * stream facts without reading any stream as a document. A consumer that streams
 * the raw output uses the latter, so a program that prints arbitrary text is a
 * completed run rather than a protocol failure.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/exec
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxProvider,
} from '@deepseek-ai/dsh-sandbox'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.ts'
import { describeError, toolAborted } from './errors.ts'
import type { AetherDiagnostics, AetherOutcome, AetherProcessFacts, AetherSandboxFacts } from './outcome.ts'
import { recovery } from './outcome.ts'
import { decodeEnvelope, decodeEvalOutcome, toOutcome } from './protocol.ts'
import { AGENT_API_ARGV, evalArgv } from './request.ts'

/** Timeout code this plugin stamps on its own deadline, so a nested deadline's abort is not read as this one's. */
export const AETHER_TIMEOUT_CODE = 'AETHER_TIMEOUT'

/**
 * Every ambient name in the interpreter's own control namespace. A tombstone
 * for each is emitted before the explicit values below, so an inherited
 * permissive policy, blanket approval, or pre-set workspace jail cannot
 * outrank this deployment's configuration.
 */
const AETHER_CONTROL_NAME = /^(?:AETHER|AE)_/i

/** How one interpreted request reaches the interpreter. */
export type AetherInvocation =
  | { readonly transport: 'agent-api'; readonly requestText: string }
  | { readonly transport: 'command-line'; readonly code: string }

/** One interpreter run. */
export interface AetherRunRequest {
  readonly invocation: AetherInvocation
  /** Working directory for the interpreter, already resolved to an absolute path. */
  readonly cwd: string
  /**
   * Deadline in milliseconds, already resolved against the deployment budgets.
   * `0` arms no timer, which is how a run without a deadline (background work)
   * is expressed: the deadline seam forwards only the caller's cancellation.
   */
  readonly timeoutMs: number
  /** Cancellation owned by the calling tool execution. */
  readonly signal: AbortSignal
}

/**
 * Why this plugin stopped a run instead of the process ending on its own: its
 * own deadline elapsed, the caller cancelled, or the plugin unloaded.
 */
export type AetherRunStop = 'deadline' | 'cancelled' | 'teardown'

/** The confining runner failed before the interpreter ran. */
export interface AetherRunnerFailure {
  /** Mode whose enforcing runner failed. */
  readonly mode: ConfinedSandboxMode
  /** The runner's own failure detail. */
  readonly detail: string
}

/**
 * Raw, undecoded result of one settled interpreter run.
 *
 * This is the record a consumer that streams output needs: the process's own
 * exit facts, the confinement it was admitted under, both collected streams, and
 * why this plugin stopped it when it did. Nothing here interprets the
 * interpreter's protocol, so arbitrary program output is a completed run rather
 * than a protocol failure; {@link runAether} adds that decoding for the tools
 * whose result is the interpreter's own document.
 */
export interface AetherRunFacts {
  /** Exit facts of the interpreter process. */
  readonly process: AetherProcessFacts
  /** The file-effect decision this run was admitted under. */
  readonly sandbox: AetherSandboxFacts
  /** The interpreter's collected stdout, as retained (a tail when `truncated`). */
  readonly stdout: AetherDiagnostics
  /** The interpreter's collected stderr, as retained (a tail when `truncated`). */
  readonly stderr: AetherDiagnostics
  /**
   * Why this plugin stopped the run; absent when the process ended on its own.
   * A stop is the first cause: nothing the child wrote counts as a result.
   */
  readonly stop?: AetherRunStop
  /**
   * The confining runner failed before the interpreter ran, so this run is an
   * infrastructure failure rather than a command result.
   */
  readonly runnerFailure?: AetherRunnerFailure
}

/** Capability services, resolved configuration, and plugin-owned state one run reads. */
export interface AetherExecDeps {
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
  /** File-effect policy resolved from the calling session for this call. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Managed `DSH_*` facts for the child, applied after the policy environment. */
  readonly managedEnv: Readonly<Record<string, string>>
  readonly config: ResolvedConfig
  readonly processes: AetherProcesses
  /** Resolve the configured interpreter in this execution world. */
  readonly resolveExecutable: (signal?: AbortSignal) => Promise<string>
  /**
   * Receives the spawned managed process once this run has claimed it and
   * before its outcome is awaited, so an observer can bind the process's
   * collected streams. The run still owns termination, quiescence, and the
   * outcome, and a throwing observer is reported and contained.
   */
  readonly onSpawn?: (handle: SubprocessHandle) => void
  /** Receives non-fatal teardown and cleanup diagnostics; never model-facing. */
  readonly report: (message: string) => void
}

/** The confinement one invocation ran under. */
interface AetherConfinement {
  /** File-effect mode the call's policy resolved to. */
  readonly mode: SandboxMode
  /** Mode the wrapping backend enforces; undefined when nothing wrapped the argv. */
  readonly enforcing: ConfinedSandboxMode | undefined
  /** Enforcement completeness reported by the wrapping backend. */
  readonly enforcement: SandboxEnforcement | undefined
  readonly denialSignatures: readonly string[]
  readonly runnerFailureRules: readonly RunnerFailureRule[]
  /** argv[0] of the wrapping runner — the executable that establishes confinement. */
  readonly runnerProgram: string | undefined
}

/** Raw facts plus the backend dialect that only the protocol decoder reads. */
interface AetherDecodableFacts extends AetherRunFacts {
  readonly denialSignatures: readonly string[]
}

/** One prepared invocation: the exact argv to spawn and the confinement behind it. */
interface AetherPreparedInvocation {
  readonly argv: readonly string[]
  readonly confinement: AetherConfinement
}

/** One tracked interpreter process and the outside facts its call must report. */
export interface AetherTrackedProcess {
  /** Stop tracking; the call has settled its own managed range. */
  release(): void
  /** True once plugin teardown terminated this process's managed range. */
  terminatedByTeardown(): boolean
}

/** One owned preparation: the claim taken before the first asynchronous step. */
export interface AetherPreparation {
  /** Cancellation for this preparation: the call's deadline, its caller, and plugin teardown fused. */
  readonly signal: AbortSignal
  /** Release the claim once the call has spawned its process or given up. */
  release(): void
}

/** Teardown reason carried by a preparation the registry cancelled. */
const TEARDOWN_REASON = 'aether-shell: the plugin unloaded during this call'

/**
 * Await one preparation step under the call's cancellation.
 *
 * A resolver or sandbox provider that ignores its signal still cannot hold the
 * call open: the race settles on abort, and the abandoned operation's later
 * settlement is consumed here so it never surfaces as an unhandled rejection
 * and never reaches a spawn.
 * @param work - the preparation promise to await.
 * @param signal - the fused cancellation for this preparation.
 * @returns the work's result when it wins the race.
 * @throws the signal's abort reason when cancellation wins.
 */
async function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attached before the race so a late rejection is consumed rather than
  // escaping as an unhandled one.
  work.catch(() => undefined)
  if (signal.aborted) signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([work, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Plugin-owned registry of in-flight interpreter processes, held to quiescence
 * when the owning fiber unloads. The subprocess service also terminates what it
 * manages when the service unloads, but this plugin's own teardown must not
 * depend on the service's unload order.
 */
export class AetherProcesses {
  private readonly live = new Map<SubprocessHandle, { terminated: boolean }>()
  private readonly preparations = new Set<AbortController>()
  private teardownStarted = false

  /**
   * @param report - receives cleanup diagnostics that the model never sees.
   */
  constructor(private readonly report: (message: string) => void) {}

  /** True once teardown began; a call that observes it must not spawn a new interpreter. */
  get disposed(): boolean {
    return this.teardownStarted
  }

  /**
   * Claim one preparation before its first asynchronous step, so teardown can
   * cancel a lookup or confinement that is still in flight and no result of it
   * can reach a spawn.
   * @param upstream - the call's own cancellation, already carrying its deadline.
   * @returns the fused preparation signal and the claim's release.
   */
  beginPreparation(upstream: AbortSignal): AetherPreparation {
    const cancellation = new AbortController()
    if (this.teardownStarted) cancellation.abort(TEARDOWN_REASON)
    else this.preparations.add(cancellation)
    return {
      signal: AbortSignal.any([upstream, cancellation.signal]),
      release: () => { this.preparations.delete(cancellation) },
    }
  }

  /**
   * Track one spawned handle for the lifetime of its call.
   * @param handle - the live managed process.
   * @returns the call's tracking receipt; a handle spawned after teardown began is terminated immediately.
   */
  track(handle: SubprocessHandle): AetherTrackedProcess {
    if (this.teardownStarted) {
      this.terminateQuietly(handle)
      return { release: () => { this.live.delete(handle) }, terminatedByTeardown: () => true }
    }
    const entry = { terminated: false }
    this.live.set(handle, entry)
    return {
      release: () => { this.live.delete(handle) },
      terminatedByTeardown: () => entry.terminated,
    }
  }

  /**
   * Hold one managed range to quiescence: drain it within the grace period, then
   * terminate and drain again when descendants still hold it open.
   * @param handle - the managed process whose range is awaited.
   * @param graceMs - the deployment's grace period in milliseconds.
   * @returns true only when the range is proven empty; a failed wait is reported and never counted as success.
   */
  async settle(handle: SubprocessHandle, graceMs: number): Promise<boolean> {
    if (await this.waitQuiet(handle, graceMs)) return true
    this.terminateQuietly(handle)
    if (await this.waitQuiet(handle, graceMs)) return true
    this.report(`aether-shell: the interpreter's managed process range did not stop within ${graceMs}ms after termination; a descendant may still be running`)
    return false
  }

  /**
   * Terminate every in-flight managed range, cancel every in-flight
   * preparation, join each provider settlement, and await quiescence. A spawn
   * that still arrives after this call is terminated as it is tracked, and the
   * tools unregister before this disposer runs — cordis runs disposers in
   * reverse registration order and stops at the first rejection, so this method
   * never rejects.
   * @param graceMs - the deployment's grace period in milliseconds.
   */
  async dispose(graceMs: number): Promise<void> {
    this.teardownStarted = true
    for (const cancellation of [...this.preparations]) cancellation.abort(TEARDOWN_REASON)
    const entries = [...this.live.entries()]
    await Promise.all(entries.map(async ([handle, entry]) => {
      entry.terminated = true
      this.terminateQuietly(handle)
      // Join the provider's own settlement first: a rejection there is the
      // provider's report about a range this plugin is already tearing down.
      await handle.done.catch((error: unknown) => {
        this.report(`aether-shell: the interpreter exited with a provider failure during teardown: ${describeError(error)}`)
      })
      await this.settle(handle, graceMs)
    }))
  }

  /**
   * Request range termination without letting a provider's own failure escape
   * into a teardown path. A disposer that rejects stops cordis from running the
   * disposers after it, so nothing here is allowed to throw.
   */
  private terminateQuietly(handle: SubprocessHandle): void {
    try {
      handle.terminate()
    } catch (error) {
      this.report(`aether-shell: terminating the interpreter's managed range failed: ${describeError(error)}`)
    }
  }

  /** Wait out one grace period for the range to empty; `false` means it did not, or cannot be observed. */
  private async waitQuiet(handle: SubprocessHandle, graceMs: number): Promise<boolean> {
    try {
      return await handle.waitForExit(AbortSignal.timeout(graceMs))
    } catch (error) {
      // A provider that can no longer observe its range cannot prove quiescence.
      this.report(`aether-shell: waiting for the interpreter's managed range failed: ${describeError(error)}`)
      return false
    }
  }
}

/**
 * Build the child environment for one run.
 * @param config - the resolved deployment configuration.
 * @param managed - the managed `DSH_*` facts for this execution, applied last.
 * @param ambient - the parent environment whose control names are tombstoned.
 * @returns the explicit environment overlay for the child.
 */
export function aetherEnvironment(
  config: ResolvedConfig,
  managed: Readonly<Record<string, string>>,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(ambient)) {
    if (AETHER_CONTROL_NAME.test(name)) env[name] = undefined
  }
  env.AETHER_MODE = config.mode
  env.AE_DETERMINISTIC = '1'
  env.AETHER_ALLOW_SH = config.allowShell ? 'true' : 'false'
  // The response is exactly one JSON document; a color-capable renderer must not decorate it.
  env.NO_COLOR = '1'
  Object.assign(env, managed)
  return env
}

/**
 * Build a resolver for the configured interpreter.
 *
 * Resolution runs per call with that call's own signal: a cache would bind the
 * lookup to whichever call arrived first, so a cancellation in one call could
 * reject a concurrent call's lookup.
 * @param subprocess - the subprocess service whose execution world is searched.
 * @param declared - the configured executable, an absolute path or a bare name.
 * @returns the resolver every call shares.
 */
export function createExecutableResolver(
  subprocess: SubprocessRuntime,
  declared: string,
): (signal?: AbortSignal) => Promise<string> {
  return async (signal) => {
    try {
      return await subprocess.resolveExecutable(declared, undefined, signal)
    } catch (error) {
      // An aborted lookup is the caller's own cancellation, reported as itself.
      if (signal?.aborted === true) throw error
      throw new Error(`aether-shell [E_EXECUTABLE]: ${JSON.stringify(declared)} was not found in this execution world; set the plugin's "executable" config to the interpreter's absolute path (${describeError(error)})`)
    }
  }
}

/** The sandbox facts of an exchange no confinement classified: the resolved mode, nothing denied. */
function policySandbox(mode: SandboxMode): AetherSandboxFacts {
  return { mode, denied: false }
}

/** The sandbox facts of one classified exchange. */
function sandboxFacts(confinement: AetherConfinement, denied: boolean): AetherSandboxFacts {
  return {
    mode: confinement.mode,
    ...confinement.enforcement === undefined ? {} : { enforcement: confinement.enforcement },
    denied,
  }
}

/** The empty diagnostics a run reports when nothing was read from one stream. */
function noDiagnostics(): AetherDiagnostics {
  return { text: '', truncated: false }
}

/**
 * The facts of a run this plugin stopped before the interpreter produced a
 * process: resolution or confinement ended first, so there are no exit facts
 * and no stream content.
 * @param deps - capability services and the resolved configuration.
 * @param request - the run that was stopped.
 * @param stop - which stop applies.
 * @returns the synthetic facts, marked with the stop and the policy's mode.
 */
function stoppedFacts(deps: AetherExecDeps, request: AetherRunRequest, stop: AetherRunStop): AetherDecodableFacts {
  return {
    process: {
      exitCode: null,
      signal: null,
      timedOut: stop === 'deadline',
      aborted: stop === 'teardown',
      timeoutMs: request.timeoutMs,
      cleanupFailed: false,
    },
    sandbox: policySandbox(deps.sandboxPolicy.mode),
    stdout: noDiagnostics(),
    stderr: noDiagnostics(),
    denialSignatures: [],
    stop,
  }
}

/**
 * The outcome for a call this plugin stopped before the interpreter reported
 * anything. The deadline and teardown facts a foreground call reports are
 * unchanged by the raw-facts split: this arm is built from the stop reason
 * alone rather than from whatever a partially run process left behind.
 * @param deps - capability services and the resolved configuration.
 * @param timeoutMs - the deadline this call applied, in milliseconds.
 * @param timedOut - whether the run's own deadline elapsed.
 * @param aborted - whether plugin teardown stopped the run.
 * @returns the canonical interrupted outcome.
 */
function interruptedOutcome(
  deps: AetherExecDeps,
  timeoutMs: number,
  timedOut: boolean,
  aborted: boolean,
): AetherOutcome {
  return {
    kind: 'interrupted',
    timedOut,
    aborted,
    sandbox: policySandbox(deps.sandboxPolicy.mode),
    process: {
      exitCode: null,
      signal: null,
      timedOut,
      aborted,
      timeoutMs,
      cleanupFailed: false,
    },
    stderr: noDiagnostics(),
  }
}

/**
 * The interrupted outcome for a call whose overall deadline was already spent
 * when its next interpreter request would have started.
 *
 * A caller that shares one deadline across several requests reaches this instead
 * of starting a process with no time left. Starting one would be worse than
 * refusing: a non-positive deadline arms no timer at all, so the request would
 * run unbounded while the call claimed a deadline. The arm is the same one a
 * deadline inside a run returns, so a caller reads one vocabulary for both.
 * @param deps - capability services and the resolved configuration.
 * @param timeoutMs - the overall deadline this call had spent, in milliseconds.
 * @returns the canonical interrupted outcome, marked as a deadline.
 */
export function deadlineExhaustedOutcome(deps: AetherExecDeps, timeoutMs: number): AetherOutcome {
  return interruptedOutcome(deps, timeoutMs, true, false)
}

/** The outcome for an exchange the sandbox refused. */
function deniedOutcome(
  sandbox: AetherSandboxFacts,
  process: AetherProcessFacts,
  stderr: AetherDiagnostics,
): AetherOutcome {
  return { kind: 'denied', sandbox: { ...sandbox, denied: true }, process, stderr }
}

/** The complete argv for one invocation, plus the confinement it runs under. */
async function prepareInvocation(
  deps: AetherExecDeps,
  invocation: AetherInvocation,
  executable: string,
  signal: AbortSignal,
): Promise<AetherPreparedInvocation> {
  const tail = invocation.transport === 'agent-api' ? AGENT_API_ARGV : evalArgv(invocation.code)
  const argv = [executable, ...deps.config.executableArgs, ...tail]
  const policy = deps.sandboxPolicy
  const { mode } = policy
  if (mode === 'danger-full-access') {
    return {
      argv,
      confinement: {
        mode,
        enforcing: undefined,
        enforcement: undefined,
        denialSignatures: [],
        runnerFailureRules: [],
        runnerProgram: undefined,
      },
    }
  }
  signal.throwIfAborted()
  const confined = await deps.sandbox.confine(argv, { ...policy, mode }, signal)
  return {
    argv: confined.argv,
    confinement: {
      mode,
      enforcing: mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules,
      runnerProgram: confined.argv[0],
    },
  }
}

/** Spawn one fully specified interpreter process. */
function spawnAether(
  deps: AetherExecDeps,
  request: AetherRunRequest,
  prepared: AetherPreparedInvocation,
  signal: AbortSignal,
): SubprocessHandle {
  const { config } = deps
  const collect = (): SubprocessCollect => ({ maxBytes: config.maxOutputBytes, spill: { maxBytes: config.maxSpillBytes } })
  const spec: SubprocessSpawnSpec = {
    argv: prepared.argv,
    cwd: request.cwd,
    stdio: {
      stdin: request.invocation.transport === 'agent-api' ? { data: request.invocation.requestText } : 'ignore',
      stdout: collect(),
      stderr: collect(),
    },
    graceMs: config.graceMs,
    signal,
    env: aetherEnvironment(config, deps.managedEnv),
  }
  try {
    return deps.subprocess.spawn(spec)
  } catch (error) {
    const { enforcing, runnerProgram } = prepared.confinement
    // A rejection that names the runner executable proves confinement never
    // started, so it fails closed rather than reading as a command failure.
    if (enforcing !== undefined && isRunnerSpawnFailure(error, runnerProgram, request.cwd)) {
      throw new SandboxUnavailableError(enforcing, describeError(error))
    }
    throw new Error(`aether-shell [E_SPAWN]: could not start ${JSON.stringify(prepared.argv[0] ?? config.executable)}: ${describeError(error)}`)
  }
}

/** The collect-mode reader this plugin requested for one stream. */
function collectedReader(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): SubprocessOutputReader {
  const reader = stream === 'stdout' ? handle.collected.stdout : handle.collected.stderr
  if (reader === undefined) {
    throw new Error(`aether-shell [E_SPAWN]: the subprocess provider dropped the requested ${stream} collect stream`)
  }
  return reader
}

/** Read one collected stream after settlement: the whole text, or the retained tail with its spill file. */
function readDiagnostics(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): AetherDiagnostics {
  const read = collectedReader(handle, stream).readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath === undefined ? {} : { spillPath: read.spillPath },
  }
}

/**
 * Classify whether the wrapping runner itself failed, so a broken confinement
 * never reads as a command result. Runner failure is classified from the
 * runner's own diagnostic stream, where a runner that never reached the target
 * writes.
 * @param confinement - the confinement this run was admitted under.
 * @param exitCode - the settled process's exit code.
 * @param stderrText - the retained diagnostic stream.
 * @returns the failure to fail closed with, or undefined when the runner is healthy.
 */
function runnerFailureOf(
  confinement: AetherConfinement,
  exitCode: number | null,
  stderrText: string,
): AetherRunnerFailure | undefined {
  const { enforcing, runnerFailureRules } = confinement
  if (enforcing === undefined) return undefined
  const runnerFailure = classifyRunnerFailure(exitCode, stderrText, runnerFailureRules)
  return runnerFailure === undefined ? undefined : { mode: enforcing, detail: runnerFailure.detail }
}

/**
 * Whether a failed exchange's diagnostics name the backend's denial dialect.
 *
 * The interpreter can report a denial through its own failure channel — the
 * Agent API exits 0 and puts the message in the envelope — so this check covers
 * the reported failure text beside the collected diagnostics, and it is only
 * ever reached for an exchange that already failed.
 *
 * Matching is limited to the signatures the backend itself publishes, and one
 * captured refusal shows why nothing broader is attempted: `file_write` under a
 * denying policy reports `E_UNKNOWN` with `file_write: failed to write temp
 * file <path>\.aether_tmp_<pid>`, an "inspect rather than retry" hint, exit 0,
 * and empty stderr. The operating-system error is swallowed there, so the same
 * shape covers a denied write and a full disk; it stays an ordinary failed
 * result and no heuristic reclassifies it. A backend whose refusal text is
 * localized matches no published signature either. The tool descriptions
 * therefore state the denial rule for the model independently of how, or
 * whether, a refusal was classified.
 */
function namesDenial(denialSignatures: readonly string[], stderrText: string, failureMessage: string): boolean {
  const lowered = `${stderrText}\n${failureMessage}`.toLowerCase()
  return denialSignatures.some(signature => signature.trim().length > 0 && lowered.includes(signature.toLowerCase()))
}

/**
 * One bounded read of a spilled interpreter stream.
 *
 * `text` is the complete stream. `unavailable` carries the exact reason no
 * complete copy exists, because this plugin falls back to nothing: a truncated
 * response with no recoverable copy must fail and say why.
 */
type AetherSpillRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unavailable'; readonly detail: string }

/**
 * Read a complete spilled stream from the subprocess provider's own file.
 *
 * The provider publishes the path only when the whole stream fit its own
 * `maxSpillBytes` budget, and the file is the provider's private scratch copy of
 * that stream, never a model-supplied path. The read is bounded by that same
 * budget: one extra byte distinguishes "the whole stream" from a file that
 * outgrew the contract, so a replaced or appended file is refused instead of read
 * without limit, and the bytes are decoded strictly so a torn or re-encoded tail
 * is a refusal rather than a silently altered document. The public collect type
 * publishes no spill-failure callback, so this read reports the operating-system
 * or decoding failure it observed itself.
 * @param spillPath - the provider's spill file, when it created one.
 * @param maxBytes - the deployment's whole-stream cap for one spill file.
 * @returns the decoded stream, or the reason no complete copy could be read.
 */
function readSpilledStream(spillPath: string | undefined, maxBytes: number): AetherSpillRead {
  if (spillPath === undefined) {
    return { kind: 'unavailable', detail: 'the subprocess provider kept no complete copy of that stream' }
  }
  let descriptor: number
  try {
    descriptor = openSync(spillPath, 'r')
  } catch (error) {
    return { kind: 'unavailable', detail: `the provider's spill file could not be opened: ${describeError(error)}` }
  }
  try {
    const capacity = maxBytes + 1
    const buffer = Buffer.allocUnsafe(capacity)
    let filled = 0
    while (filled < capacity) {
      const read = readSync(descriptor, buffer, filled, capacity - filled, filled)
      if (read <= 0) break
      filled += read
    }
    // Filling the extra byte proves the file is larger than the cap the provider
    // promised, so no complete copy exists to decode.
    if (filled >= capacity) {
      return { kind: 'unavailable', detail: `the spill file holds more than the ${maxBytes}-byte cap, so it is not the complete stream the provider promises` }
    }
    try {
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, filled)) }
    } catch (error) {
      return { kind: 'unavailable', detail: `the spill file is not valid UTF-8, so a response read from it could differ from what the interpreter wrote: ${describeError(error)}` }
    }
  } catch (error) {
    return { kind: 'unavailable', detail: `reading the provider's spill file failed: ${describeError(error)}` }
  } finally {
    try { closeSync(descriptor) } catch { /* a failed close is not a decode failure; the descriptor closes with the process */ }
  }
}

/**
 * The interpreter's complete standard output, recovered from the provider's
 * spill file when the in-memory window dropped bytes.
 * @param deps - capability services and the resolved configuration supplying both stream budgets.
 * @param stdout - the collected stdout, a tail when `truncated`.
 * @returns the complete output text.
 * @throws Error when the output was truncated and no complete copy could be read.
 */
function completeStdout(deps: AetherExecDeps, stdout: AetherDiagnostics): string {
  if (!stdout.truncated) return stdout.text
  const recovered = readSpilledStream(stdout.spillPath, deps.config.maxSpillBytes)
  if (recovered.kind === 'text') return recovered.text
  throw new Error(`aether-shell [E_PROTOCOL_TRUNCATED]: the response exceeded the ${deps.config.maxOutputBytes}-byte in-memory budget and this plugin reads no partial reply, so the call has no result: ${recovered.detail}; the effects of this invocation are unknown${recovery(stdout.spillPath)}`)
}

/**
 * The collected-output facts a decoder reads once the complete text is known.
 * @param stdout - the collected stdout the run reported.
 * @param text - the complete output text, recovered when the in-memory tail was cut.
 * @returns the diagnostics a protocol decoder reads, with no truncation left to describe.
 */
function completeDiagnostics(stdout: AetherDiagnostics, text: string): AetherDiagnostics {
  return {
    text,
    truncated: false,
    ...stdout.spillPath === undefined ? {} : { spillPath: stdout.spillPath },
  }
}

/**
 * Read one settled exchange as the interpreter's protocol defines it.
 *
 * Decoding is what makes a stream a document, so an in-memory truncation is
 * answered here rather than in the run that produced it: the provider's complete
 * spilled copy is read when it exists, and the call fails only when no complete
 * copy does. A consumer that only streams the raw output never reaches this
 * function and reports the truncation as a fact instead.
 * @param deps - capability services and the resolved configuration supplying the stream budgets.
 * @param request - the invocation whose transport decides which protocol applies.
 * @param facts - raw facts of a run this plugin did not stop before settlement.
 * @returns the canonical outcome.
 * @throws Error when a truncated response has no readable complete copy.
 * @throws SandboxUnavailableError when the confining runner itself failed.
 * @throws AetherProtocolError when the stream is not the document its transport promises.
 */
function decodeFacts(deps: AetherExecDeps, request: AetherRunRequest, facts: AetherDecodableFacts): AetherOutcome {
  const { process, stderr, stdout, sandbox } = facts
  const text = completeStdout(deps, stdout)
  const { runnerFailure } = facts
  if (runnerFailure !== undefined) throw new SandboxUnavailableError(runnerFailure.mode, runnerFailure.detail)
  if (request.invocation.transport === 'command-line') {
    const outcome = decodeEvalOutcome(process, completeDiagnostics(stdout, text), stderr, sandbox)
    return outcome.kind === 'error' && namesDenial(facts.denialSignatures, stderr.text, outcome.error.message)
      ? deniedOutcome(sandbox, process, stderr)
      : outcome
  }
  // The Agent API exits 0 even when it reports a failed request, so a non-zero
  // exit with no reply is a process or confinement failure — never a protocol
  // complaint about a document that was never written.
  if (process.exitCode !== null && process.exitCode !== 0 && text.trim().length === 0) {
    // Both streams are searched because a denied file effect can surface on
    // either one; the exit gate keeps this to an exchange that already failed.
    if (matchesSignature(process.exitCode, `${stderr.text}\n${text}`, facts.denialSignatures)) {
      return deniedOutcome(sandbox, process, stderr)
    }
    return {
      kind: 'error',
      error: {
        code: 'E_PROCESS_EXIT',
        message: `the interpreter exited with code ${process.exitCode} without writing a response`,
        retryable: false,
      },
      sandbox,
      process,
      stderr,
    }
  }
  const envelope = decodeEnvelope(text, stdout.spillPath)
  const outcome = toOutcome(envelope, process, stderr, sandbox)
  if (outcome.kind === 'error'
    && namesDenial(facts.denialSignatures, stderr.text, outcome.error.message)) {
    return deniedOutcome(sandbox, process, stderr)
  }
  return outcome
}

/**
 * Wait for one spawned process, then report the raw facts of what it did,
 * decoding nothing.
 *
 * A stop this plugin caused is the first cause, so it is classified before any
 * provider failure and before anything the child wrote is read as a result; the
 * collected streams still travel with the facts, because a consumer that
 * streams them reports what the process actually produced. Truncation is
 * deliberately not a failure here — only a consumer that must read the stream
 * as one document can be misled by a retained tail.
 * @param request - the run being settled.
 * @param confinement - the confinement this run was admitted under.
 * @param handle - the live managed process.
 * @param signal - the run's fused cancellation, carrying its deadline.
 * @param tracked - the run's tracking receipt.
 * @returns the raw facts, with `stop` when this plugin ended the run.
 * @throws Error when the subprocess provider failed before reporting an exit.
 * @throws SandboxUnavailableError when the failure names the confining runner.
 */
async function settleFacts(
  request: AetherRunRequest,
  confinement: AetherConfinement,
  handle: SubprocessHandle,
  signal: AbortSignal,
  tracked: AetherTrackedProcess,
): Promise<AetherDecodableFacts> {
  let outcome: SubprocessOutcome | undefined
  let providerFailure: { error: unknown } | undefined
  try {
    outcome = await handle.done
  } catch (error) {
    providerFailure = { error }
  }
  const timedOut = timeoutOf(signal, AETHER_TIMEOUT_CODE) !== undefined
  const aborted = tracked.terminatedByTeardown()
  const process: AetherProcessFacts = {
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    aborted,
    timeoutMs: request.timeoutMs,
    cleanupFailed: false,
  }
  const stderr = readDiagnostics(handle, 'stderr')
  const stdout = readDiagnostics(handle, 'stdout')
  const sandbox = sandboxFacts(confinement, false)
  const shared = { process, sandbox, stdout, stderr, denialSignatures: confinement.denialSignatures }
  const stop: AetherRunStop | undefined = timedOut
    ? 'deadline'
    : aborted ? 'teardown' : signal.aborted ? 'cancelled' : undefined
  if (stop !== undefined) return { ...shared, stop }
  if (providerFailure !== undefined) {
    if (isRunnerSpawnFailure(providerFailure.error, confinement.runnerProgram, request.cwd)) {
      const { enforcing } = confinement
      if (enforcing !== undefined) throw new SandboxUnavailableError(enforcing, describeError(providerFailure.error))
    }
    // The provider's own diagnostic travels with the failure: a generic spawn
    // error would hide what the provider actually reported.
    const diagnostic = stderr.text.trim()
    throw new Error(`aether-shell [E_SPAWN]: the subprocess provider failed before reporting an exit: ${describeError(providerFailure.error)}${diagnostic.length === 0 ? '' : `\n[stderr]\n${diagnostic}`}`)
  }
  const runnerFailure = runnerFailureOf(confinement, process.exitCode, stderr.text)
  return runnerFailure === undefined ? shared : { ...shared, runnerFailure }
}

/**
 * Prepare, spawn, and settle one interpreter request, returning its raw facts
 * and the backend dialect the decoder reads.
 * @param deps - capability services, resolved configuration, and plugin-owned state.
 * @param request - the invocation, directory, deadline, and cancellation.
 * @returns the raw facts, with `stop` when this plugin ended the run.
 * @throws Error for infrastructure failures: a missing interpreter, a failed confinement runner, a spawn that never started, a provider failure.
 */
async function runAetherInternal(deps: AetherExecDeps, request: AetherRunRequest): Promise<AetherDecodableFacts> {
  const execution = deadline(request.signal, request.timeoutMs, AETHER_TIMEOUT_CODE)
  try {
    const preparation = deps.processes.beginPreparation(execution.signal)
    let prepared: AetherPreparedInvocation
    try {
      const executable = await waitWithAbort(deps.resolveExecutable(preparation.signal), preparation.signal)
      prepared = await waitWithAbort(
        prepareInvocation(deps, request.invocation, executable, preparation.signal),
        preparation.signal,
      )
      // Nothing spawns once the deadline elapsed or teardown began during
      // preparation, whatever the abandoned lookup eventually returns.
      preparation.signal.throwIfAborted()
    } catch (error) {
      if (timeoutOf(execution.signal, AETHER_TIMEOUT_CODE) !== undefined) return stoppedFacts(deps, request, 'deadline')
      if (request.signal.aborted) return stoppedFacts(deps, request, 'cancelled')
      if (deps.processes.disposed) return stoppedFacts(deps, request, 'teardown')
      throw error
    } finally {
      preparation.release()
    }
    if (deps.processes.disposed) return stoppedFacts(deps, request, 'teardown')
    let handle: SubprocessHandle
    try {
      handle = spawnAether(deps, request, prepared, execution.signal)
    } catch (error) {
      // A spawn refused because its signal was already aborted reports this
      // call's own cancellation, not a process that failed to start.
      if (timeoutOf(execution.signal, AETHER_TIMEOUT_CODE) !== undefined) return stoppedFacts(deps, request, 'deadline')
      if (request.signal.aborted) return stoppedFacts(deps, request, 'cancelled')
      if (deps.processes.disposed) return stoppedFacts(deps, request, 'teardown')
      throw error
    }
    const tracked = deps.processes.track(handle)
    // The observer runs after tracking and is contained, so an observer that
    // throws can neither leak an untracked range nor fail a run this plugin
    // already owns the teardown of.
    try {
      deps.onSpawn?.(handle)
    } catch (error) {
      deps.report(`aether-shell: the spawn observer threw: ${describeError(error)}`)
    }
    let facts: AetherDecodableFacts
    try {
      facts = await settleFacts(request, prepared.confinement, handle, execution.signal, tracked)
    } catch (error) {
      await deps.processes.settle(handle, deps.config.graceMs)
      tracked.release()
      throw error
    }
    const quiescent = await deps.processes.settle(handle, deps.config.graceMs)
    tracked.release()
    return quiescent ? facts : { ...facts, process: { ...facts.process, cleanupFailed: true } }
  } finally {
    execution[Symbol.dispose]()
  }
}

/**
 * Run one interpreter request to settlement and return its raw facts, decoding
 * nothing. Every lifecycle rule of {@link runAether} holds here: the run is
 * prepared under fused cancellation, tracked from its first lookup, and its
 * managed range is held to quiescence on every settlement.
 * @param deps - capability services, resolved configuration, and plugin-owned state.
 * @param request - the invocation, directory, deadline, and cancellation.
 * @returns the raw facts, carrying `stop` when this plugin ended the run.
 * @throws Error for infrastructure failures: a missing interpreter, a failed confinement runner, a spawn that never started, a provider failure.
 */
export async function runAetherFacts(deps: AetherExecDeps, request: AetherRunRequest): Promise<AetherRunFacts> {
  const facts = await runAetherInternal(deps, request)
  return {
    process: facts.process,
    sandbox: facts.sandbox,
    stdout: facts.stdout,
    stderr: facts.stderr,
    ...facts.stop === undefined ? {} : { stop: facts.stop },
    ...facts.runnerFailure === undefined ? {} : { runnerFailure: facts.runnerFailure },
  }
}

/**
 * Run one interpreter request under a hard deadline and return its canonical outcome.
 *
 * The deadline covers resolution, confinement, and the run. Cancellation by the
 * calling execution throws the structured abort; the plugin's own teardown and
 * the deadline both return the interrupted outcome, because each is an
 * orthogonal fact about the process rather than a reported failure.
 * @param deps - capability services, resolved configuration, and plugin-owned state.
 * @param request - the invocation, directory, deadline, and cancellation.
 * @returns the canonical outcome, marked when its managed range outlived the grace period.
 * @throws Error for infrastructure failures: a missing interpreter, a failed confinement runner, a spawn that never started, a corrupted or truncated stream.
 */
export async function runAether(deps: AetherExecDeps, request: AetherRunRequest): Promise<AetherOutcome> {
  const facts = await runAetherInternal(deps, request)
  const { stop } = facts
  if (stop !== undefined) {
    // The caller's own cancellation is the structured abort a tool call
    // requires; the deadline and plugin teardown are the interrupted outcome
    // this plugin has always returned for them, whatever the raw facts carry.
    if (stop === 'cancelled') throw toolAborted()
    const interrupted = interruptedOutcome(deps, request.timeoutMs, stop === 'deadline', stop !== 'deadline')
    return facts.process.cleanupFailed
      ? { ...interrupted, process: { ...interrupted.process, cleanupFailed: true } }
      : interrupted
  }
  return decodeFacts(deps, request, facts)
}
