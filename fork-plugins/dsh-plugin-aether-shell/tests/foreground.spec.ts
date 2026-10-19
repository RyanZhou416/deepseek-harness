/**
 * Foreground query promotion over the real job registry and agent registry.
 *
 * Every case uses a controlled producer promise rather than a host process:
 * what is under test is the hand-over between a foreground wait and the job's
 * own lifecycle — registration before the operation, promotion without a
 * second run, continuation by the original id, and cancellation that waits for
 * the producer to release. No host binary, network, or real subprocess is
 * involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHandle, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry, { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runForegroundQuery } from '../src/foreground.ts'
import type { AetherForegroundRequest, AetherPromotedOutcome } from '../src/foreground.ts'
import type { AetherOutcome } from '../src/outcome.ts'

/** A mounted registry and one live owning agent. */
interface ForegroundHarness {
  readonly ctx: Context
  readonly jobs: JobRegistry
  readonly owner: Agent
  readonly workspace: string
  /** Dispose the agent's own scope, as its composition being destroyed does. */
  disposeAgent(): Promise<void>
  /** Dispose the context. Safe to call once. */
  dispose(): Promise<void>
}

/** Options for one helper request; omitted fields use the harness defaults. */
interface RequestOptions {
  readonly jobs?: JobRegistry | null
  readonly owner?: Agent | null
  readonly promote?: boolean
  readonly waitTimeoutMs?: number
  readonly executionTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly label?: string
  readonly run: (signal: AbortSignal, timeoutMs: number) => Promise<AetherOutcome>
  readonly finish?: (outcome: AetherOutcome) => AetherOutcome
  readonly report?: (message: string) => void
}

const TERMINAL = new Set(['completed', 'killed', 'failed'])
let harness: ForegroundHarness | undefined
let callCounter = 0

afterEach(async () => {
  vi.restoreAllMocks()
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

/** A short bounded poll; the predicate is always the assertion. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/** A controlled promise; only the test decides when it settles. */
function barrier<T>(): { promise: Promise<T>; resolve(value: T): void } {
  const deferred = Promise.withResolvers<T>()
  return { promise: deferred.promise, resolve: deferred.resolve }
}

/** One successful value outcome with clean process facts. */
function valueOutcome(value: JsonValue = null): AetherOutcome {
  return {
    kind: 'value',
    value,
    sandbox: { mode: 'danger-full-access', denied: false },
    process: { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 0, cleanupFailed: false },
    stderr: { text: '', truncated: false },
  }
}

/**
 * A live agent registered under its session id, with a dedicated lifecycle
 * scope whose disposal is the job owner's teardown.
 * @param ctx - the context whose scope owns the agent.
 * @param id - session identity.
 * @param workspace - absolute session workspace.
 * @returns the agent and the disposer of its scope.
 */
function stubAgent(ctx: Context, id: SessionId, workspace: string): { agent: Agent; dispose(): Promise<void> } {
  const scopeFiber = ctx.plugin(() => {})
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd: workspace,
    isSeeded: false,
  })
  const agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle' as const,
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  } satisfies Agent
  return { agent, dispose: async () => { await scopeFiber.dispose() } }
}

/**
 * Mount the real agent registry and the real local job registry with the
 * controller their producer admission requires.
 * @param jobsConfig - registry configuration overrides.
 * @returns the mounted harness.
 */
async function createHarness(jobsConfig: JobsConfig = {}): Promise<ForegroundHarness> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, jobsConfig)
  ctx.jobs.attachController('aether-foreground-test')

  const workspace = process.cwd()
  const owned = stubAgent(ctx, SessionId('sess-aether-foreground'), workspace)
  const detach = await ctx.agents.register(owned.agent)
  let disposed = false
  return {
    ctx,
    jobs: ctx.jobs,
    owner: owned.agent,
    workspace,
    disposeAgent: owned.dispose,
    async dispose() {
      if (disposed) return
      disposed = true
      await detach()
      await ctx.fiber.dispose()
    },
  }
}

/** Mount a harness for the current test. */
async function setup(jobsConfig: JobsConfig = {}): Promise<ForegroundHarness> {
  harness = await createHarness(jobsConfig)
  return harness
}

/**
 * Build one request; `jobs: null` and `owner: null` leave those fields absent.
 * @param mounted - the mounted harness.
 * @param options - request fields and the controlled operation.
 * @returns the helper request.
 */
function makeRequest(mounted: ForegroundHarness, options: RequestOptions): AetherForegroundRequest {
  const jobs = options.jobs === undefined ? mounted.jobs : options.jobs
  const owner = options.owner === undefined ? mounted.owner : options.owner
  const id = ++callCounter
  return {
    ...jobs === null ? {} : { jobs },
    ...owner === null ? {} : { owner },
    callId: ToolCallId(`aether-fg-call-${id}`),
    rootCallId: ToolCallId(`aether-fg-root-${id}`),
    label: options.label ?? 'foreground query',
    cwd: mounted.workspace,
    waitTimeoutMs: options.waitTimeoutMs ?? 1_000,
    executionTimeoutMs: options.executionTimeoutMs ?? 1_000,
    signal: options.signal ?? new AbortController().signal,
    run: options.run,
    finish: options.finish ?? (outcome => outcome),
    report: options.report ?? (() => {}),
    promote: options.promote ?? true,
  }
}

/** The one live job this owner holds, failing loudly when there is not exactly one. */
function onlyJob(mounted: ForegroundHarness): JobId {
  const owned = mounted.jobs.list(mounted.owner.id)
  if (owned.length !== 1) throw new Error(`expected exactly one job, found ${owned.length}`)
  return owned[0]!.id
}

/** Pin the registry wait to a non-consuming projection so the wait returns before settlement. */
function pinRunningWait(mounted: ForegroundHarness) {
  const spy = vi.spyOn(mounted.jobs, 'wait')
  spy.mockImplementation(async (id, _timeoutMs, caller) => mounted.jobs.get(id, caller))
  return spy
}

describe('runForegroundQuery foreground fallback', () => {
  it('runs once under the smaller positive budget when no registry is mounted', async () => {
    const mounted = await setup()
    const calls: Array<{ signal: AbortSignal; timeoutMs: number }> = []
    const outcome = valueOutcome('foreground')
    const request = makeRequest(mounted, {
      jobs: null,
      waitTimeoutMs: 4_000,
      executionTimeoutMs: 900,
      run: async (signal, timeoutMs) => {
        calls.push({ signal, timeoutMs })
        return outcome
      },
    })

    await expect(runForegroundQuery(request)).resolves.toBe(outcome)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.timeoutMs).toBe(900)
    expect(calls[0]?.signal).toBe(request.signal)
    expect(mounted.jobs.list(mounted.owner.id)).toEqual([])
  })

  it('runs in the foreground when promotion is disabled', async () => {
    const mounted = await setup()
    const start = vi.spyOn(mounted.jobs, 'start')
    let runs = 0
    const result = await runForegroundQuery(makeRequest(mounted, {
      promote: false,
      run: async () => { runs += 1; return valueOutcome('plain') },
    }))

    expect(result).toMatchObject({ kind: 'value', value: 'plain' })
    expect(runs).toBe(1)
    expect(start).not.toHaveBeenCalled()
  })

  it('runs in the foreground when no owner can own a job', async () => {
    const mounted = await setup()
    const start = vi.spyOn(mounted.jobs, 'start')
    let runs = 0
    await runForegroundQuery(makeRequest(mounted, {
      owner: null,
      run: async () => { runs += 1; return valueOutcome('ownerless') },
    }))

    expect(runs).toBe(1)
    expect(start).not.toHaveBeenCalled()
  })

  it('reports an admission refusal and runs the operation once under the fallback budget', async () => {
    const mounted = await setup({ maxConcurrentJobsPerOwner: 1 })
    const cancel = new AbortController()
    const filler = mounted.jobs.start({
      kind: 'aether',
      label: 'occupies the owner limit',
      owner: mounted.owner.id,
      run: () => ({
        cancel: (reason) => { cancel.abort(reason) },
        done: new Promise<JobOutcome>((resolve) => {
          cancel.signal.addEventListener('abort', () => { resolve({ status: 'killed' }) }, { once: true })
        }),
      }),
    })
    const start = vi.spyOn(mounted.jobs, 'start')
    const reports: string[] = []
    const calls: number[] = []
    const result = await runForegroundQuery(makeRequest(mounted, {
      waitTimeoutMs: 500,
      executionTimeoutMs: 0,
      report: message => { reports.push(message) },
      run: async (_signal, timeoutMs) => { calls.push(timeoutMs); return valueOutcome('fallback') },
    }))

    expect(result).toMatchObject({ kind: 'value', value: 'fallback' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([500])
    expect(reports.join('\n')).toContain('was not admitted')
    mounted.jobs.kill(filler, mounted.owner.id, 'test cleanup')
    await mounted.jobs.wait(filler, 1_000, mounted.owner.id)
    mounted.jobs.remove(filler, mounted.owner.id)
  })
})

describe('runForegroundQuery admitted job', () => {
  it('starts exactly one job with the tool invocation and removes a fast record', async () => {
    const mounted = await setup()
    const start = vi.spyOn(mounted.jobs, 'start')
    const outcome = valueOutcome({ ok: true })
    let finishes = 0
    const request = makeRequest(mounted, {
      label: 'fast query',
      run: async () => outcome,
      finish: (raw) => { finishes += 1; return raw },
    })

    await expect(runForegroundQuery(request)).resolves.toBe(outcome)
    expect(finishes).toBe(1)
    expect(start).toHaveBeenCalledTimes(1)
    const spec = start.mock.calls[0]?.[0]
    expect(spec).toMatchObject({
      kind: 'aether',
      label: 'fast query',
      owner: mounted.owner.id,
      toolCall: { callId: request.callId, rootCallId: request.rootCallId },
    })
    expect(spec?.outputLimitBytes).toBeUndefined()
    expect(mounted.jobs.list(mounted.owner.id)).toEqual([])
  })

  it('passes the 0 hard-runtime sentinel to the operation unchanged', async () => {
    const mounted = await setup()
    let seen: number | undefined
    const result = await runForegroundQuery(makeRequest(mounted, {
      executionTimeoutMs: 0,
      run: async (_signal, timeoutMs) => { seen = timeoutMs; return valueOutcome('unbounded') },
    }))

    expect(result).toMatchObject({ kind: 'value', value: 'unbounded' })
    expect(seen).toBe(0)
  })

  it('returns the original id when the wait expires, without killing the job', async () => {
    const mounted = await setup()
    const wait = pinRunningWait(mounted)
    const kill = vi.spyOn(mounted.jobs, 'kill')
    const started = barrier<void>()
    const release = barrier<AetherOutcome>()
    let seenTimeout: number | undefined
    const request = makeRequest(mounted, {
      waitTimeoutMs: 4_000,
      executionTimeoutMs: 0,
      run: (signal, timeoutMs) => {
        seenTimeout = timeoutMs
        void signal
        started.resolve(undefined)
        return release.promise
      },
    })

    const result = await runForegroundQuery(request)
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('expected a promoted outcome')
    await started.promise
    const promoted: AetherPromotedOutcome = result
    expect(promoted.jobId).toBe(onlyJob(mounted))
    expect(promoted).toMatchObject({
      cwd: mounted.workspace,
      waitTimeoutMs: 4_000,
      executionTimeoutMs: 0,
    })
    expect(seenTimeout).toBe(0)
    expect(wait).toHaveBeenCalledWith(promoted.jobId, 4_000, mounted.owner.id, request.signal)
    expect(kill).not.toHaveBeenCalled()
    expect(mounted.jobs.get(promoted.jobId, mounted.owner.id).status).toBe('running')
    wait.mockRestore()
    release.resolve(valueOutcome('continued'))
    await mounted.jobs.wait(promoted.jobId, 1_000, mounted.owner.id)
    mounted.jobs.remove(promoted.jobId, mounted.owner.id)
  })

  it('does not keep the finished foreground call cancellation attached after handoff', async () => {
    const mounted = await setup()
    const wait = pinRunningWait(mounted)
    const release = barrier<AetherOutcome>()
    const call = new AbortController()
    let running: AbortSignal | undefined
    const result = await runForegroundQuery(makeRequest(mounted, {
      signal: call.signal, run: signal => { running = signal; return release.promise },
    }))
    if (result.kind !== 'promoted') throw new Error('Expected handoff')
    call.abort('the foreground invocation has ended')
    expect(running?.aborted).toBe(false)
    wait.mockRestore()
    release.resolve(valueOutcome('same execution completed'))
    await mounted.jobs.wait(result.jobId, 1_000, mounted.owner.id)
    expect(mounted.jobs.get(result.jobId, mounted.owner.id).status).toBe('completed')
  })

  it('bounds encoded failure diagnostics without breaking Unicode or JSON', async () => {
    const mounted = await setup()
    const wait = pinRunningWait(mounted)
    const release = Promise.withResolvers<AetherOutcome>()
    void release.promise.catch(() => {})
    const result = await runForegroundQuery(makeRequest(mounted, { run: () => release.promise }))
    if (result.kind !== 'promoted') throw new Error('Expected handoff')
    wait.mockRestore()
    release.reject(new Error('\u0000😀'.repeat(4_000)))
    await mounted.jobs.wait(result.jobId, 1_000, mounted.owner.id)
    const encoded = mounted.jobs.read(result.jobId, mounted.owner.id).result
    if (encoded === undefined) throw new Error('Expected a final diagnostic')
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(1_024)
    expect(JSON.parse(encoded).error).toMatchObject({ code: 'E_AETHER_EXECUTION', safe_to_retry: false, side_effects: 'unknown' })
    expect(encoded).toContain('diagnostic truncated')
    expect(encoded).not.toContain('\uFFFD')
  })

  it('continues the original id and hands out its terminal result once', async () => {
    const mounted = await setup()
    const wait = pinRunningWait(mounted)
    const started = barrier<void>()
    const release = barrier<AetherOutcome>()
    const final = valueOutcome('finished later')
    const request = makeRequest(mounted, {
      waitTimeoutMs: 2_000,
      run: () => {
        started.resolve(undefined)
        return release.promise
      },
    })

    const result = await runForegroundQuery(request)
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('expected a promoted outcome')
    await started.promise
    wait.mockRestore()
    release.resolve(final)
    await mounted.jobs.wait(result.jobId, 1_000, mounted.owner.id)

    const first = mounted.jobs.read(result.jobId, mounted.owner.id)
    expect(first.result).toBe(JSON.stringify(final))
    expect(JSON.parse(first.result ?? 'null')).toEqual(final)
    const second = mounted.jobs.read(result.jobId, mounted.owner.id)
    expect(second.result).toBeUndefined()
    mounted.jobs.remove(result.jobId, mounted.owner.id)
  })

  it('waits for producer cleanup before reporting a cancelled call', async () => {
    const mounted = await setup()
    const tool = new AbortController()
    const started = barrier<void>()
    const release = barrier<void>()
    let runSignal: AbortSignal | undefined
    const statuses: string[] = []
    const unsubscribe = mounted.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled') statuses.push(event.job.status)
    })
    const run = vi.fn((signal: AbortSignal) => {
      runSignal = signal
      started.resolve(undefined)
      return release.promise.then(() => valueOutcome('released after cleanup'))
    })
    const request = makeRequest(mounted, {
      signal: tool.signal,
      waitTimeoutMs: 25,
      executionTimeoutMs: 0,
      run,
    })

    let settled = false
    let rejection: unknown
    const observed = runForegroundQuery(request).then(
      () => { settled = true; return 'resolved' as const },
      (error: unknown) => { settled = true; rejection = error; return 'rejected' as const },
    )
    await started.promise
    const id = onlyJob(mounted)
    tool.abort()
    await waitFor(() => mounted.jobs.get(id, mounted.owner.id).status === 'stopping', 'the job to stop')
    expect(settled).toBe(false)
    expect(runSignal?.aborted).toBe(true)

    release.resolve(undefined)
    expect(await observed).toBe('rejected')
    expect(rejection).toBeInstanceOf(HarnessError)
    if (!(rejection instanceof HarnessError)) throw new Error('expected a HarnessError')
    expect(rejection.code).toBe(TOOL_ABORTED)
    expect(run).toHaveBeenCalledTimes(1)
    expect(statuses).toContain('killed')
    expect(mounted.jobs.list(mounted.owner.id)).toEqual([])
    unsubscribe()
  })

  it('lets a second query start after the first call was cancelled', async () => {
    const mounted = await setup()
    const tool = new AbortController()
    const started = barrier<void>()
    const first = runForegroundQuery(makeRequest(mounted, {
      signal: tool.signal,
      waitTimeoutMs: 25,
      run: (signal) => {
        started.resolve(undefined)
        return new Promise<AetherOutcome>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('first operation stopped')) }, { once: true })
        })
      },
    }))
    await started.promise
    tool.abort()
    await expect(first).rejects.toMatchObject({ code: TOOL_ABORTED })

    const second = await runForegroundQuery(makeRequest(mounted, {
      run: async () => valueOutcome('second query'),
    }))
    expect(second).toMatchObject({ kind: 'value', value: 'second query' })
  })
})

describe('runForegroundQuery interrupted settlement', () => {
  it('does not start interpreter work when its actual handoff receipt is refused', async () => {
    const mounted = await setup()
    const run = vi.fn(async () => valueOutcome('must not run'))
    const request = makeRequest(mounted, { run })
    await expect(runForegroundQuery({
      ...request, validateHandoff: () => { throw new Error('handoff receipt refused') },
    })).rejects.toThrow('handoff receipt refused')
    expect(run).not.toHaveBeenCalled()
    expect(mounted.jobs.list(mounted.owner.id)).toEqual([])
  })
  it('releases the admission gate when the initial wait throws synchronously', async () => {
    const mounted = await setup()
    const run = vi.fn(async () => valueOutcome('must not start'))
    vi.spyOn(mounted.jobs, 'wait').mockImplementationOnce(() => { throw new Error('wait attachment failed') })
    await expect(runForegroundQuery(makeRequest(mounted, { run }))).rejects.toThrow('wait attachment failed')
    expect(run).not.toHaveBeenCalled()
    expect(mounted.jobs.list(mounted.owner.id)).toEqual([])
  })
  it('aborts and joins a producer that ran before the registry refused the commit', async () => {
    const mounted = await setup()
    const handle: JobHandle = { id: JobId('aether-foreground-fake'), append: () => {}, updateProgress: () => {} }
    const run = vi.fn(async () => valueOutcome('must not start'))
    vi.spyOn(mounted.jobs, 'start').mockImplementation((spec) => {
      spec.run(handle)
      throw new Error('registry refused the commit after the producer ran')
    })
    const reports: string[] = []

    await expect(runForegroundQuery(makeRequest(mounted, {
      report: message => { reports.push(message) },
      run,
    }))).rejects.toThrow('registry refused the commit after the producer ran')
    // The operation stayed behind the admission gate: no fallback and no run.
    expect(run).not.toHaveBeenCalled()
    expect(reports).toEqual([])
  })

  it('does not claim a result when the owner is disposed mid-wait', async () => {
    const mounted = await setup()
    const started = barrier<void>()
    const pending = runForegroundQuery(makeRequest(mounted, {
      waitTimeoutMs: 5_000,
      run: (signal) => {
        started.resolve(undefined)
        return new Promise<AetherOutcome>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('owner disposed')); return }
          signal.addEventListener('abort', () => { reject(new Error('owner disposed')) }, { once: true })
        })
      },
    }))
    await started.promise
    expect(TERMINAL.has(mounted.jobs.get(onlyJob(mounted), mounted.owner.id).status)).toBe(false)

    await mounted.disposeAgent()
    await expect(pending).rejects.toMatchObject({ code: TOOL_ABORTED })
    expect(mounted.jobs.list(mounted.owner.id)).toEqual([])
  })
})
