/**
 * One foreground AetherShell query that keeps running as a background job
 * when its caller's wait expires.
 *
 * The query is registered before its capability operation begins, so the job
 * exists from the moment work can start and the caller can collect it by the
 * original id. The operation is gated on a registry commit plus the caller's
 * first wait registration: `jobs.start` invokes the producer before it records
 * the job, so a body that probed the interpreter immediately would run before
 * the id existed. The gate is an explicit admission signal, not a microtask
 * ordering assumption.
 *
 * A fast result stays a foreground result: the job record is dropped once the
 * call has collected its terminal state and the model never sees the id. A
 * wait that expires without cancellation returns {@link AetherPromotedOutcome}
 * naming the still-live job, without reading or consuming its output. The job
 * names no output sources: while live its ring is empty, and its result is the
 * bounded final outcome's JSON, delivered once by the first terminal
 * `job_output`. A cancelled call stops the job through the same controller and
 * waits for the operation to release its resources before reporting the abort.
 *
 * @module @ryanzhou416/dsh-plugin-aether-shell/foreground
 */

import type { FiberState } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobOutcome, JobRegistry, JobToolCall, JobView } from '@deepseek-ai/dsh-jobs'
import { isHarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describeError, toolAborted } from './errors.ts'
import type { AetherOutcome } from './outcome.ts'
// The `aether` job kind is declared beside its background producer.
import type {} from './background.ts'

/** A foreground query handed to the background registry. */
export interface AetherPromotedOutcome {
  /** The still-live job that now owns the operation. */
  readonly kind: 'promoted'
  /** Registry-issued id, resolvable by the owning session until settlement. */
  readonly jobId: JobId
  /** Absolute working directory the operation was admitted with. */
  readonly cwd: string
  /** Wait budget the foreground call spent before promotion, in milliseconds. */
  readonly waitTimeoutMs: number
  /** Hard runtime the operation runs under, in milliseconds; `0` means none. */
  readonly executionTimeoutMs: number
}

/** Result of one foreground query: the ordinary outcome, or the job that continues it. */
export type AetherQueryResult = AetherOutcome | AetherPromotedOutcome

/** Everything one foreground query needs before its operation starts. */
export interface AetherForegroundRequest {
  /** Mounted job registry; omission runs the query in the foreground under the hard deadline. */
  readonly jobs?: JobRegistry
  /** Owning agent; omission is the legacy foreground path with no background continuation. */
  readonly owner?: Agent
  /** Exact tool invocation, retained in the job's lifecycle records. */
  readonly callId: ToolCallId
  /** Root model-requested invocation owning this execution. */
  readonly rootCallId: ToolCallId
  /** One-line job label; the program source is never echoed into it. */
  readonly label: string
  /** Absolute working directory the operation was admitted with. */
  readonly cwd: string
  /** Bound on the foreground wait before the job is promoted, in milliseconds. */
  readonly waitTimeoutMs: number
  /** Hard runtime for the operation, in milliseconds; `0` arms no timer. */
  readonly executionTimeoutMs: number
  /** The calling tool execution's cancellation. */
  readonly signal: AbortSignal
  /**
   * Begin the capability operation and resolve with its canonical outcome.
   * The call starts only after the job is registered and the first wait is attached.
   * @param signal - this job's own cancellation.
   * @param timeoutMs - the hard runtime the operation must finish under; `0` means none.
   * @returns the operation's canonical outcome.
   */
  run(signal: AbortSignal, timeoutMs: number): Promise<AetherOutcome>
  /**
   * Apply the deployment's inline-result budget and finish the outcome.
   * Called exactly once for an operation that started, before its outcome is collected.
   * @param outcome - the operation's raw canonical outcome.
   * @returns the bounded final outcome.
   */
  finish(outcome: AetherOutcome): AetherOutcome
  /**
   * Optional receipt validation before interpreter work starts; omission adds no receipt constraint.
   * @param receipt - the actual registered id and execution settings that may be returned.
   */
  validateHandoff?(receipt: AetherPromotedOutcome): void
  /**
   * Receive non-model-facing diagnostics, such as a contained record cleanup failure.
   * @param message - the diagnostic line.
   */
  report(message: string): void
  /** Whether a live registry and owner may continue the query as a job. */
  readonly promote: boolean
}

/** How this job's operation settled before it is projected onto the registry's outcome. */
type AetherCompletion =
  | { readonly kind: 'outcome'; readonly outcome: AetherOutcome }
  | { readonly kind: 'failure'; readonly error: unknown }

/** Longest status detail this helper builds; the model-facing detail is one line. */
const MAX_DETAIL_CHARS = 400

/** Longest failure text copied into a failed job's result record. */
const MAX_ERROR_BYTES = 512

/** Failure class used when the caught value is not a harness error with its own code. */
const EXECUTION_FAILURE_CODE = 'E_AETHER_EXECUTION'

/** Fail on an impossible branch of a closed union. */
function assertNever(value: never): never {
  throw new Error(`aether-shell: unhandled outcome ${JSON.stringify(value)}`)
}

/**
 * Bound one diagnostic line without changing its informative head.
 * @param text - raw diagnostic text.
 * @param maxChars - maximum retained characters.
 * @returns the original text, or its head followed by an omission marker.
 */
function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/**
 * Render why an operation was stopped, preferring a named reason.
 * @param reason - an abort reason, which need not be an Error.
 * @returns the reason text, or a generic cancellation line.
 */
function reasonText(reason: unknown): string {
  if (reason === undefined || reason === null) return 'the foreground query was cancelled'
  const text = describeError(reason)
  return text.length === 0 ? 'the foreground query was cancelled' : text
}

/**
 * The stable failure class of a caught value.
 * @param error - the caught value.
 * @returns the harness code when the value is a HarnessError, otherwise the execution code.
 */
function failureCode(error: unknown): string {
  return isHarnessError(error) && error.code.length > 0 ? error.code : EXECUTION_FAILURE_CODE
}

/**
 * The public failure record a failed job hands out once.
 * @param error - the operation failure.
 * @returns the JSON-safe error record stored as the job result.
 */
function boundedFailureText(message: string, maxBytes = MAX_ERROR_BYTES): string {
  let kept = ''
  let bytes = 2
  for (const scalar of message) {
    bytes += Buffer.byteLength(JSON.stringify(scalar), 'utf8') - 2
    if (bytes > maxBytes) return `${kept}… [diagnostic truncated]`
    kept += scalar
  }
  return kept
}

function failureRecord(error: unknown): Record<string, unknown> {
  return {
    error: {
      code: boundedFailureText(failureCode(error), 128),
      message: boundedFailureText(describeError(error)),
      side_effects: 'unknown',
      safe_to_retry: false,
    },
  }
}

/**
 * Map one settled outcome onto the job status.
 *
 * A managed range that did not reach quiescence outranks the outcome kind: it
 * fails the record without claiming that resources are gone. The remaining
 * kinds are exhaustive, with interruption split by its own flags.
 * @param outcome - the bounded final outcome.
 * @returns the registry status.
 */
function statusOf(outcome: AetherOutcome): JobOutcome['status'] {
  if (outcome.process.cleanupFailed) return 'failed'
  switch (outcome.kind) {
    case 'value':
    case 'retained':
      return 'completed'
    case 'error':
    case 'denied':
      return 'failed'
    case 'interrupted':
      return outcome.timedOut || outcome.aborted ? 'killed' : 'failed'
    default:
      return assertNever(outcome)
  }
}

/**
 * Map one settled outcome onto the job's one-line detail.
 * @param outcome - the bounded final outcome.
 * @returns a bounded detail line.
 */
function detailOf(outcome: AetherOutcome): string {
  if (outcome.process.cleanupFailed) {
    return 'the managed process range did not stop within the grace period'
  }
  switch (outcome.kind) {
    case 'value':
    case 'retained':
      return 'query completed'
    case 'error':
      return bounded(outcome.error.code !== undefined && outcome.error.code.length > 0 ? outcome.error.code : outcome.error.message, MAX_DETAIL_CHARS)
    case 'denied':
      return `the file-effect policy denied the operation under ${outcome.sandbox.mode} mode`
    case 'interrupted':
      if (outcome.timedOut) return `deadline exceeded (${outcome.process.timeoutMs}ms)`
      if (outcome.aborted) return 'the query was stopped by this plugin'
      return 'the interpreter was interrupted'
    default:
      return assertNever(outcome)
  }
}

/**
 * Project the producer's settled completion onto the registry outcome.
 *
 * A cancellation request is the job's stop, so it outranks the producer's own
 * classification. The result is always the final outcome's JSON for an
 * outcome branch, never a rendered value or a bare payload.
 * @param completion - the operation's outcome or its failure.
 * @param signal - this job's cancellation signal.
 * @returns the registry outcome.
 */
function jobOutcome(completion: AetherCompletion, signal: AbortSignal): JobOutcome {
  if (signal.aborted) {
    return {
      status: 'killed',
      detail: bounded(reasonText(signal.reason), MAX_DETAIL_CHARS),
      result: JSON.stringify(completion.kind === 'outcome' ? completion.outcome : failureRecord(completion.error)),
    }
  }
  if (completion.kind === 'failure') {
    return {
      status: 'failed',
      detail: bounded(describeError(completion.error), MAX_DETAIL_CHARS),
      result: JSON.stringify(failureRecord(completion.error)),
    }
  }
  return {
    status: statusOf(completion.outcome),
    detail: detailOf(completion.outcome),
    result: JSON.stringify(completion.outcome),
  }
}

/**
 * The hard deadline a legacy foreground call runs under: the smaller positive
 * of its positive wait budget and any nonzero runtime budget.
 * @param waitTimeoutMs - the foreground wait budget.
 * @param executionTimeoutMs - the operation's own runtime budget.
 * @returns the milliseconds to pass to `run`.
 */
function foregroundTimeout(waitTimeoutMs: number, executionTimeoutMs: number): number {
  return executionTimeoutMs === 0 ? waitTimeoutMs : Math.min(waitTimeoutMs, executionTimeoutMs)
}

// The Host erases this const enum from its runtime exports. The member type pins
// its value without introducing an unavailable ESM value import in this bundle.
const ACTIVE_FIBER_STATE = 2 satisfies FiberState.ACTIVE

/** Whether the owning agent's composition is still active enough to receive a result. */
function ownerActive(owner: Agent): boolean {
  return owner.ctx.fiber.state === ACTIVE_FIBER_STATE
}

/**
 * Drop a settled record whose id the model never received.
 *
 * A record may disappear first when its owner or registry was disposed. Missing
 * visible records need no removal; other cleanup failures are reported while
 * the already-collected result remains intact.
 * @param jobs - the mounted registry.
 * @param id - the record to drop.
 * @param owner - the record's owner.
 * @param request - the foreground request, used for diagnostics.
 */
async function discardRecord(
  jobs: JobRegistry,
  id: JobId,
  owner: Agent,
  request: AetherForegroundRequest,
): Promise<void> {
  if (!ownerActive(owner)) return
  let view = jobs.list(owner.id).find(job => job.id === id)
  if (view === undefined) return
  if (view.status === 'running' || view.status === 'stopping') {
    // The producer has released its resources but the registry may not have
    // committed the settlement yet; one bounded wait observes that commit
    // without treating a slow teardown as a foreground failure.
    try {
      await jobs.wait(id, request.waitTimeoutMs, owner.id)
    } catch (error) {
      if (ownerActive(owner) && jobs.list(owner.id).some(job => job.id === id) && !request.signal.aborted) {
        request.report(`aether-shell: the query job record could not be awaited for removal: ${describeError(error)}`)
      }
      return
    }
    if (!ownerActive(owner)) return
    view = jobs.list(owner.id).find(job => job.id === id)
    if (view === undefined) return
  }
  if (view.status === 'running' || view.status === 'stopping') return
  try {
    jobs.remove(id, owner.id)
  } catch (error) {
    request.report(`aether-shell: the query job record could not be removed: ${describeError(error)}`)
  }
}

/**
 * Run one foreground query, promoting it to the background registry when its
 * wait expires.
 *
 * With no registry, no owner, or promotion disabled, the query is the legacy
 * foreground call under one hard deadline. Otherwise the job is registered
 * first; an admission refusal before the producer runs falls back to that same
 * foreground path, while a failure after the producer ran aborts its own
 * controller and is rethrown without a second run. An expired wait returns the
 * original job id, so `job_output` continues from the same execution.
 * @param request - the operation, its budgets, and its lifecycle callbacks.
 * @returns the bounded foreground outcome, or the still-live job that continues it.
 * @throws the operation's own failure, or the structured tool abort when this call was cancelled.
 */
export async function runForegroundQuery(request: AetherForegroundRequest): Promise<AetherQueryResult> {
  const { jobs, owner } = request
  if (request.signal.aborted) throw toolAborted()
  if (jobs === undefined || owner === undefined || !request.promote) {
    return request.finish(await request.run(request.signal, foregroundTimeout(request.waitTimeoutMs, request.executionTimeoutMs)))
  }

  const controller = new AbortController()
  // `jobs.start` calls the producer before it commits the record, so the
  // operation stays behind this gate until the id exists and the first wait is
  // attached. Cancellation releases the gate too, so owner teardown can never
  // deadlock on a producer that is still parked.
  const admitted = Promise.withResolvers<void>()
  const completion = Promise.withResolvers<AetherCompletion>()
  let hookInvoked = false
  let producerDone: Promise<JobOutcome> | undefined

  const cancel = (reason?: string): void => {
    if (!controller.signal.aborted) controller.abort(reason ?? 'the foreground query was cancelled')
    admitted.resolve()
  }

  const startProducer = (): Promise<JobOutcome> => {
    hookInvoked = true
    producerDone = (async (): Promise<JobOutcome> => {
      await admitted.promise
      if (!controller.signal.aborted) {
        try {
          const raw = await request.run(controller.signal, request.executionTimeoutMs)
          completion.resolve({ kind: 'outcome', outcome: request.finish(raw) })
        } catch (error) {
          completion.resolve({ kind: 'failure', error })
        }
      } else {
        completion.resolve({ kind: 'failure', error: controller.signal.reason })
      }
      return jobOutcome(await completion.promise, controller.signal)
    })()
    return producerDone
  }

  let id: JobId
  try {
    id = jobs.start({
      kind: 'aether',
      label: request.label,
      owner: owner.id,
      toolCall: { callId: request.callId, rootCallId: request.rootCallId } satisfies JobToolCall,
      run: (): JobHooks => {
        const done = startProducer()
        return { cancel, done }
      },
    })
  } catch (error) {
    if (!hookInvoked) {
      request.report(`aether-shell: the query job was not admitted; running it in the foreground instead: ${describeError(error)}`)
      return request.finish(await request.run(request.signal, foregroundTimeout(request.waitTimeoutMs, request.executionTimeoutMs)))
    }
    // The registry may have invoked the producer before refusing the commit.
    // Its operation has not started because the gate is still closed; aborting
    // and releasing that gate lets the producer finish without a second run.
    cancel('the query job could not be committed')
    await producerDone
    throw error
  }

  const done = producerDone
  if (done === undefined) throw new Error('aether-shell: the job registry committed without starting the query producer')
  const receipt: AetherPromotedOutcome = {
    kind: 'promoted', jobId: id, cwd: request.cwd,
    waitTimeoutMs: request.waitTimeoutMs, executionTimeoutMs: request.executionTimeoutMs,
  }
  // Attach the wait before releasing the operation: the wait owns the startup
  // budget, so admission time counts against the foreground wait.
  let view: JobView
  try {
    request.validateHandoff?.(receipt)
    const waiting = jobs.wait(id, request.waitTimeoutMs, owner.id, request.signal)
    if (request.signal.aborted) cancel('the foreground call was cancelled')
    else admitted.resolve()
    view = await waiting
  } catch (error) {
    const reason = 'the foreground wait was interrupted'
    cancel(reason)
    try {
      if (ownerActive(owner) && jobs.list(owner.id).some(job => job.id === id)) jobs.kill(id, owner.id, reason)
    } catch (killError) {
      request.report(`aether-shell: the query job could not be stopped: ${describeError(killError)}`)
    }
    // Prove the operation released its resources before reporting an
    // infrastructure failure; a tiny registry wait is not that proof.
    await done
    await discardRecord(jobs, id, owner, request)
    if (request.signal.aborted || !ownerActive(owner)) throw toolAborted()
    throw error
  }

  if (request.signal.aborted || controller.signal.aborted) {
    cancel('the foreground query was cancelled')
    try {
      if (ownerActive(owner) && jobs.list(owner.id).some(job => job.id === id)) jobs.kill(id, owner.id, 'the foreground query was cancelled')
    } catch (error) {
      request.report(`aether-shell: the query job could not be stopped: ${describeError(error)}`)
    }
    await done
    await discardRecord(jobs, id, owner, request)
    throw toolAborted()
  }

  if (view.status === 'running' || view.status === 'stopping') {
    return receipt
  }

  const live = ownerActive(owner)
  if (live) await discardRecord(jobs, id, owner, request)
  const settled = await completion.promise
  if (!live) throw toolAborted()
  if (settled.kind === 'failure') throw settled.error
  return settled.outcome
}
