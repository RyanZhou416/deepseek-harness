/**
 * Background jobs through the real tool registry, subprocess provider, sandbox
 * policy service, agent registry, and job registry.
 *
 * The fixtures here decide every case by themselves: a program that writes and
 * then hangs proves streaming and cancellation, one that exits nonzero proves
 * the exit mapping, one that outlives a tiny deadline proves the deadline is a
 * stop rather than a program failure, and one that overflows the in-memory
 * budget proves truncation is reported as a fact rather than failing the work.
 * Nothing in this suite waits on a fixed sleep to decide an outcome — polls are
 * bounded and the polled predicate is the assertion.
 *
 * The one substituted collaborator is the OS sandbox runner: `ctx.sandbox` is a
 * recording provider, because the platform ACL/Landlock/Seatbelt runner is an
 * external, host-dependent boundary that cannot be part of a deterministic
 * assertion. What the plugin asked the boundary to do is still recorded.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEvent } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry, { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxEnforcement, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createAetherBackgroundTool } from '../src/background.ts'
import type { AetherBackgroundSettings } from '../src/background.ts'
import { resolveConfig } from '../src/config.ts'
import type { Config as AetherConfig } from '../src/config.ts'
import { AetherProcesses, createExecutableResolver } from '../src/exec.ts'
import { installedInterpreter } from './helpers/harness.ts'

/** Absolute path of the background fixture every job in this suite spawns. */
const BACKGROUND_FIXTURE = fileURLToPath(new URL('./fixtures/ae-background-fixture.mjs', import.meta.url))

/** The interpreter this host has installed, when it has one. */
const interpreter = installedInterpreter()

/** Terminal lifecycle states. */
const TERMINAL = new Set(['completed', 'killed', 'failed'])

let harness: BackgroundHarness | undefined

afterEach(async () => {
  const owned = harness
  harness = undefined
  await owned?.dispose()
})

/** One recorded `ctx.sandbox.confine` call. */
interface ConfineCall {
  /** The exact argv the plugin asked to have confined. */
  readonly argv: string[]
  /** The policy the plugin resolved for the owning session. */
  readonly policy: SandboxPolicy
}

/** How the recording sandbox provider answers `confine`. */
type SandboxBehavior = 'passthrough' | 'unavailable'

/** Options accepted by {@link createBackgroundHarness}. */
interface BackgroundHarnessOptions {
  /** Plugin configuration overrides, merged over the fixture interpreter settings. */
  readonly config?: AetherConfig
  /** Deployment file-effect mode the sandbox policy resolves (default `danger-full-access`). */
  readonly mode?: SandboxMode
  /** Sandbox runner behavior for this harness (default `passthrough`). */
  readonly sandbox?: SandboxBehavior
  /** Enforcement the recording backend claims (default `full`). */
  readonly enforcement?: SandboxEnforcement
  /** Trusted job-runtime cap the deployment supplies, when it supplies one. */
  readonly maxRuntimeMs?: number
  /** Job registry configuration overrides. */
  readonly jobsConfig?: JobsConfig
  /** Interpreter executable the plugin spawns (default the running Node). */
  readonly executable?: string
  /** Trusted argv between the executable and the subcommand (default the background fixture). */
  readonly executableArgs?: readonly string[]
}

/** A mounted background surface plus the observations a suite asserts on. */
interface BackgroundHarness {
  /** The mounted context. */
  readonly ctx: Context
  /** Absolute workspace root given to the sandbox policy and the session header. */
  readonly workspace: string
  /** Every `confine` call the plugin made, in order. */
  readonly confineCalls: ConfineCall[]
  /** Non-fatal diagnostics the plugin reported. */
  readonly reports: string[]
  /** The plugin's live-process registry, as the plugin composes it. */
  readonly processes: AetherProcesses
  /** The job-run grace period the harness configured. */
  readonly graceMs: number
  /** The registered stub agent that owns every job this suite starts. */
  readonly agent: Agent
  /** That agent's session identity. */
  readonly sessionId: SessionId
  /**
   * Execute one `aether_job_start` call through the real registry.
   * @param args - lossless model arguments.
   * @param options - optional call identity; `agent: null` executes with no calling session.
   * @returns the materialized registry result.
   */
  call(args: unknown, options?: { signal?: AbortSignal; agent?: Agent | null }): Promise<ToolExecutionResult>
  /** Non-consuming ring text for one job, for assertions about streamed output. */
  ringText(id: JobId): string
  /** The distinct channels the ring has received for one job. */
  ringChannels(id: JobId): string[];
  /** The canonical facts the first terminal read hands out. */
  factsOf(id: JobId): Record<string, unknown>
  /** Wait for one job to reach a terminal status, or fail loudly. */
  waitForTerminal(id: JobId, timeoutMs?: number): Promise<void>
  /** Every lifecycle event this harness observed, in order. */
  events(): JobEvent[]
  /** Dispose the owning agent's scope, as an agent leaving its composition does. */
  disposeAgent(): Promise<void>
  /** Dispose the context and remove the workspace. Safe to call once. */
  dispose(): Promise<void>
}

let callCounter = 0

/** Wait one short interval; only ever used inside a bounded poll. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Poll a predicate until it holds.
 * @param predicate - the fact under test.
 * @param what - description used in the failure.
 * @param timeoutMs - bound for the poll, in milliseconds.
 * @throws Error when the predicate never held inside the bound.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return
    await pause(20)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/** Join the text blocks of a tool result, which is the model-visible output. */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** The job id a start call returned, failing loudly when the call did not start one. */
function jobIdOf(result: ToolExecutionResult): JobId {
  if (result.isError) throw new Error(`expected a started job, got: ${textOf(result)}`)
  const value = result.value as { jobId?: unknown }
  if (typeof value.jobId !== 'string' || value.jobId.length === 0) {
    throw new Error(`the start call carried no job id: ${textOf(result)}`)
  }
  return JobId(value.jobId)
}

/**
 * A session-shaped agent with its own scope, registered under its session id so
 * the job registry can resolve it as a live owner and attach its cleanup.
 * @param ctx - the context whose scope owns the agent.
 * @param id - session identity.
 * @param cwd - absolute session workspace.
 * @returns the agent and the disposer of its scope.
 */
function stubAgent(ctx: Context, id: SessionId, cwd: string): { agent: Agent; dispose(): Promise<void> } {
  const scopeFiber = ctx.plugin(() => {})
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd,
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
 * Mount the background tool over the real capability services.
 * @param options - harness configuration; omitted fields use deterministic fixture defaults.
 * @returns the mounted harness, ready for tool calls.
 */
async function createBackgroundHarness(options: BackgroundHarnessOptions = {}): Promise<BackgroundHarness> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-aether-bg-'))
  const confineCalls: ConfineCall[] = []
  const reports: string[] = []
  const seen: JobEvent[] = []
  const behavior = options.sandbox ?? 'passthrough'

  class RecordingSandboxProvider extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      void signal
      confineCalls.push({ argv: [...argv], policy })
      if (behavior === 'unavailable') {
        throw new SandboxUnavailableError(policy.mode, 'the recording test provider refuses every confinement')
      }
      return { argv: [...argv], enforcement: options.enforcement ?? 'full', denialSignatures: [], runnerFailureRules: [] }
    }
  }

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: options.mode ?? 'danger-full-access', workspaceRoot: workspace })
  await ctx.plugin(RecordingSandboxProvider)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, options.jobsConfig ?? {})
  // The controller a composition's job tool plugin attaches; without one the
  // registry refuses to start owned work at all.
  ctx.jobs.attachController('aether-background-test')

  const resolved = resolveConfig({
    executable: options.executable ?? process.execPath,
    executableArgs: [...(options.executableArgs ?? [BACKGROUND_FIXTURE])],
    ...options.config,
  })
  const processes = new AetherProcesses((message: string) => { reports.push(message) })
  const settings: AetherBackgroundSettings = options.maxRuntimeMs === undefined
    ? {}
    : { maxRuntimeMs: options.maxRuntimeMs }
  ctx.tools.register(createAetherBackgroundTool({
    ctx,
    config: resolved,
    processes,
    resolveExecutable: createExecutableResolver(ctx.subprocess, resolved.executable),
    jobs: ctx.jobs,
  }, settings))
  ctx.effect(() => () => processes.dispose(resolved.graceMs), 'aether-background-test.processes')

  ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { seen.push(event) })

  const sessionId = SessionId('sess-background')
  const owned = stubAgent(ctx, sessionId, workspace)
  const detachAgent = await ctx.agents.register(owned.agent)

  return {
    ctx,
    workspace,
    confineCalls,
    reports,
    processes,
    graceMs: resolved.graceMs,
    agent: owned.agent,
    sessionId,
    call: (args, callOptions = {}) => ctx.tools.execute({
      callId: ToolCallId(`aether-bg-${++callCounter}`),
      name: 'aether_job_start',
      arguments: args,
      signal: callOptions.signal ?? new AbortController().signal,
      ...callOptions.agent === null ? {} : { agent: callOptions.agent ?? owned.agent },
    }),
    ringText: (id) => ctx.jobs.readAt(id, 0, sessionId).chunks.map(chunk => chunk.text).join(''),
    ringChannels: (id) => [...new Set(ctx.jobs.readAt(id, 0, sessionId).chunks.map(chunk => chunk.channel ?? 'stdout'))],
    factsOf: (id) => {
      const read = ctx.jobs.read(id, sessionId)
      if (read.result === undefined) throw new Error(`job ${id} settled without a result record`)
      return JSON.parse(read.result) as Record<string, unknown>
    },
    waitForTerminal: async (id, timeoutMs = 15_000) => {
      await waitFor(() => TERMINAL.has(ctx.jobs.get(id, sessionId).status), `job ${id} to settle`, timeoutMs)
    },
    events: () => [...seen],
    disposeAgent: async () => { await owned.dispose() },
    async dispose() {
      detachAgent()
      await ctx.fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

/** Mount one harness for the current test. */
async function setup(options: BackgroundHarnessOptions = {}): Promise<BackgroundHarness> {
  harness = await createBackgroundHarness(options)
  return harness
}

describe('aether_job_start admission', () => {
  it('starts a job and returns its id without waiting for the program', async () => {
    const mounted = await setup()
    const result = await mounted.call({ code: 'bg:logthenhang:started' })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toMatch(/^started background job aether-[\da-f]{16}$/u)
    const id = jobIdOf(result)
    const view = mounted.ctx.jobs.get(id, mounted.sessionId)
    expect(view).toMatchObject({ kind: 'aether', status: 'running', owner: mounted.sessionId })
    expect(view.label).toBe('bg:logthenhang:started')
    mounted.ctx.jobs.kill(id, mounted.sessionId, 'test cleanup')
    await mounted.waitForTerminal(id)
  })

  it('refuses a non-positive deadline before registering anything', async () => {
    const mounted = await setup()
    const result = await mounted.call({ code: 'bg:echo:hi', timeoutMs: -1 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('positive finite number')
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('requires an owning session', async () => {
    const mounted = await setup()
    const result = await mounted.call({ code: 'bg:echo:hi' }, { agent: null })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('owning agent session')
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('refuses a deadline beyond the runtime timer bound instead of starting a doomed job', async () => {
    const mounted = await setup()
    const result = await mounted.call({ code: 'bg:echo:hi', timeoutMs: 3_000_000_000 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no greater than')
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('refuses a deployment cap beyond the runtime timer bound', async () => {
    const mounted = await setup({ maxRuntimeMs: 3_000_000_000 })
    const result = await mounted.call({ code: 'bg:echo:hi' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no greater than')
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('refuses a call that was already aborted, before admitting work', async () => {
    const mounted = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await mounted.call({ code: 'bg:echo:hi' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('refuses a job when the owner is already at its job limit', async () => {
    const mounted = await setup({ jobsConfig: { maxConcurrentJobsPerOwner: 1 } })
    const id = jobIdOf(await mounted.call({ code: 'bg:logthenhang:occupies the limit' }))
    const refused = await mounted.call({ code: 'bg:echo:second' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('background job limit reached')
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(1)
    mounted.ctx.jobs.kill(id, mounted.sessionId, 'test cleanup')
    await mounted.waitForTerminal(id)
  })
})

describe('aether_job_start raw output', () => {
  it('streams both raw streams while the program is still running', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:logthenhang:streamed-line' }))
    await waitFor(() => mounted.ringText(id).includes('streamed-line'), 'the stdout line to reach the ring')
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).status).toBe('running')
    await waitFor(() => mounted.ringText(id).includes('bg-diagnostic'), 'the stderr line to reach the ring')
    expect(mounted.ringChannels(id)).toEqual(expect.arrayContaining(['stdout', 'stderr']))
    mounted.ctx.jobs.kill(id, mounted.sessionId, 'test cleanup')
    await mounted.waitForTerminal(id)
  })

  it('settles a program that prints prose and JSON as one completed run', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:mixed:prose before json' }))
    await mounted.waitForTerminal(id)
    const view = mounted.ctx.jobs.get(id, mounted.sessionId)
    expect(view).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
    expect(mounted.ringText(id)).toContain('prose before json')
    expect(mounted.ringText(id)).toContain('{"ok":true}')
    expect(mounted.factsOf(id)).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      timeoutMs: 0,
      cleanupFailed: false,
      stdoutTruncated: false,
      sandbox: { mode: 'danger-full-access' },
    })
  })

  it('reports a nonzero exit as a failed job', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:exit:3' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId)).toMatchObject({ status: 'failed', detail: 'exit code: 3' })
    expect(mounted.factsOf(id)).toMatchObject({ exitCode: 3, timedOut: false, cleanupFailed: false })
  })

  it('reports an oversized stream as facts instead of failing the work', async () => {
    const mounted = await setup({ config: { maxOutputBytes: 1_024, maxSpillBytes: 8_192 } })
    const id = jobIdOf(await mounted.call({ code: 'bg:big:8000' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).status).toBe('completed')
    const facts = mounted.factsOf(id)
    expect(facts).toMatchObject({ exitCode: 0, stdoutTruncated: true })
    expect(typeof facts['stdoutSpillPath']).toBe('string')
  })

  it('honours the requested working directory', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:pwd', cwd: mounted.workspace }))
    await mounted.waitForTerminal(id)
    expect(mounted.ringText(id)).toContain(mounted.workspace)
  })

  it('scrubs the child environment and applies this deployment\'s control values', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:env' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ringText(id)).toContain('mode=human deterministic=1 allowSh=false noColor=1 ambient=0')
  })
})

describe('aether_job_start lifecycle', () => {
  it('reports a caller kill as stopped with a proven process range', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:logthenhang:to be stopped' }))
    await waitFor(() => mounted.ringText(id).includes('to be stopped'), 'the job to produce output')
    expect(mounted.ctx.jobs.kill(id, mounted.sessionId, 'no longer needed')).toBe('requested')
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId)).toMatchObject({
      status: 'killed',
      detail: 'stopped; no longer needed',
    })
    expect(mounted.factsOf(id)).toMatchObject({ stop: 'cancelled', timedOut: false, cleanupFailed: false })
  })

  it('keeps running after the call that started it is aborted', async () => {
    const mounted = await setup()
    const controller = new AbortController()
    const id = jobIdOf(await mounted.call({ code: 'bg:logthenhang:outlives its call' }, { signal: controller.signal }))
    controller.abort()
    await pause(0)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).status).toBe('running')
    await waitFor(() => mounted.ringText(id).includes('outlives its call'), 'the job to keep producing output')
    mounted.ctx.jobs.kill(id, mounted.sessionId, 'test cleanup')
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).status).toBe('killed')
  })

  it('stops at its own deadline and reports a stop rather than a program failure', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:slowexit:5000:0', timeoutMs: 80 }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId)).toMatchObject({
      status: 'killed',
      detail: 'deadline exceeded (80ms)',
    })
    expect(mounted.factsOf(id)).toMatchObject({
      stop: 'deadline',
      timedOut: true,
      timeoutMs: 80,
      cleanupFailed: false,
    })
  })

  it('bounds a job by the deployment cap when the call gives no deadline', async () => {
    const mounted = await setup({ maxRuntimeMs: 80 })
    const id = jobIdOf(await mounted.call({ code: 'bg:slowexit:5000:0' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId)).toMatchObject({
      status: 'killed',
      detail: 'deadline exceeded (80ms)',
    })
    expect(mounted.factsOf(id)).toMatchObject({ stop: 'deadline', timeoutMs: 80 })
  })

  it('caps a larger model deadline at the deployment cap', async () => {
    const mounted = await setup({ maxRuntimeMs: 80 })
    const id = jobIdOf(await mounted.call({ code: 'bg:slowexit:5000:0', timeoutMs: 60_000 }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).detail).toBe('deadline exceeded (80ms)')
  })

  it('treats a zero deployment cap as no ceiling', async () => {
    const mounted = await setup({ maxRuntimeMs: 0 })
    const id = jobIdOf(await mounted.call({ code: 'bg:echo:unbounded' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).status).toBe('completed')
    expect(mounted.factsOf(id)).toMatchObject({ timeoutMs: 0, timedOut: false })
  })

  it('refuses a negative deployment cap instead of arming an unusable timer', async () => {
    const mounted = await setup({ maxRuntimeMs: -1 })
    const result = await mounted.call({ code: 'bg:echo:hi' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('maxRuntimeMs')
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('stops the job when its owner is disposed', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:logthenhang:owned work' }))
    await waitFor(() => mounted.ringText(id).includes('owned work'), 'the job to start')
    await mounted.disposeAgent()
    const settled = mounted.events().filter((event): event is Extract<JobEvent, { type: 'settled' }> => event.type === 'settled')
    expect(settled.at(-1)).toMatchObject({ cause: 'teardown', job: { id, status: 'killed' } })
    // The record leaves with its owner: an owner-scoped read can no longer see it.
    expect(mounted.ctx.jobs.list(mounted.sessionId)).toHaveLength(0)
  })

  it('stops the job and proves its range empty when the plugin unloads', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:logthenhang:plugin unload' }))
    await waitFor(() => mounted.ringText(id).includes('plugin unload'), 'the job to start')
    await mounted.processes.dispose(mounted.graceMs)
    await mounted.waitForTerminal(id, 20_000)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId)).toMatchObject({
      status: 'killed',
      detail: 'the interpreter was stopped because the plugin unloaded',
    })
    expect(mounted.processes.disposed).toBe(true)
    expect(mounted.reports.filter(message => message.includes('did not stop'))).toEqual([])
  })
})

describe('aether_job_start confinement', () => {
  it('confines a non-full-access job with the session policy', async () => {
    const mounted = await setup({ mode: 'read-only' })
    const id = jobIdOf(await mounted.call({ code: 'bg:echo:confined' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId).status).toBe('completed')
    expect(mounted.confineCalls).toHaveLength(1)
    expect(mounted.confineCalls[0]?.policy.mode).toBe('read-only')
    expect(mounted.factsOf(id)).toMatchObject({ sandbox: { mode: 'read-only', enforcement: 'full' } })
  })

  it('spawns a full-access job without a confining runner', async () => {
    const mounted = await setup()
    const id = jobIdOf(await mounted.call({ code: 'bg:echo:unconfined' }))
    await mounted.waitForTerminal(id)
    expect(mounted.confineCalls).toEqual([])
    expect(mounted.factsOf(id)).toMatchObject({ sandbox: { mode: 'danger-full-access' } })
  })

  it('fails the job when the confining runner is unavailable', async () => {
    const mounted = await setup({ mode: 'read-only', sandbox: 'unavailable' })
    const id = jobIdOf(await mounted.call({ code: 'bg:echo:never runs' }))
    await mounted.waitForTerminal(id)
    const view = mounted.ctx.jobs.get(id, mounted.sessionId)
    expect(view.status).toBe('failed')
    expect(view.detail).toContain('refuses every confinement')
  })
})

describe.skipIf(interpreter === undefined)('aether_job_start against the installed interpreter', () => {
  it('runs a real program in the background and reports its raw output', async () => {
    const mounted = await setup({
      ...interpreter === undefined ? {} : { executable: interpreter },
      executableArgs: [],
    })
    const id = jobIdOf(await mounted.call({ code: '1 + 1' }))
    await mounted.waitForTerminal(id)
    expect(mounted.ctx.jobs.get(id, mounted.sessionId)).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
    expect(mounted.ringText(id)).toContain('2')
    expect(mounted.factsOf(id)).toMatchObject({ exitCode: 0, stdoutTruncated: false, cleanupFailed: false })
  })
})
