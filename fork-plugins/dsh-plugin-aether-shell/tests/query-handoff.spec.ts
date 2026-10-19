/**
 * End-to-end foreground-query handoff through the real tool registry, local
 * subprocess provider, agent registry, and local job registry.
 *
 * The interpreter is an external fixture process, not a scripted producer, so
 * every case proves the same execution survived: one child invocation appends
 * one operation marker, waits on the caller's private release file, and emits
 * the native result the job later hands out. The job registry is mounted after
 * the plugin (the tools read `ctx.get('jobs')` per call), its controller is
 * attached directly, and a real registered Agent owns the work. No ToolJobs
 * plugin is needed because the assertions read the registry directly; the
 * model-facing `job_output` path has its own recorded-session coverage.
 *
 * All paths are under a private `mkdtemp` workspace. Scenario selection is by
 * explicit fixture argv and request JSON, never by ambient environment.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEvent } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Config as AetherConfig } from '../src/config.ts'
import { createHarness, text, valueOf } from './helpers/harness.ts'
import type { Harness } from './helpers/harness.ts'

/** Absolute path of the external interpreter fixture. */
const QUERY_FIXTURE = fileURLToPath(new URL('./fixtures/ae-query-handoff.mjs', import.meta.url))

/** Terminal job states. */
const TERMINAL = new Set(['completed', 'killed', 'failed'])

/** A live agent plus the lifecycle resources that own its jobs. */
interface LiveOwner {
  readonly agent: Agent
  /** Dispose the agent's own scope, as its composition being destroyed does. */
  disposeScope(): Promise<void>
  /** Remove the agent from the registry. */
  detach(): Promise<void>
}

/** One mounted handoff surface and the private workspace its fixture writes. */
interface QueryHarness {
  readonly base: Harness
  readonly ctx: Context
  readonly workspace: string
  readonly owner: LiveOwner
  /** Register one more live agent, for ownership-fence cases. */
  addOwner(id: string): Promise<LiveOwner>
  /** Execute one query as the primary owner. */
  call(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<ToolExecutionResult>
  /** Dispose the primary owner, leaving the rest of the context mounted. */
  disposeOwner(): Promise<void>
  /** Dispose every owner, the context, and the private workspace. */
  dispose(): Promise<void>
}

/** Options accepted by {@link setup}. */
interface SetupOptions {
  /** Plugin configuration overrides. */
  readonly config?: AetherConfig
  /** Registry configuration overrides. */
  readonly jobsConfig?: JobsConfig
}

let active: QueryHarness | undefined

afterEach(async () => {
  const mounted = active
  active = undefined
  await mounted?.dispose()
})

/** Wait one short interval; used only by bounded polls. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Poll a predicate under a deadline.
 * @param predicate - the fact under test.
 * @param what - failure description.
 * @param timeoutMs - bound for the poll.
 * @throws Error when the predicate never held.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return
    await pause(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/** Read the non-empty lines of a fixture marker file; a missing file has none. */
async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(line => line.length > 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Wait until one fixture marker file contains the expected line. */
async function waitForLine(path: string, line: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(async () => (await lines(path)).includes(line), `${path} to contain ${JSON.stringify(line)}`, timeoutMs)
}

/** Create the private release barrier the fixture waits on. */
async function release(path: string): Promise<void> {
  await writeFile(path, 'release\n')
}

/** The workspace-relative fixture marker path. */
function marker(workspace: string, name: string): string {
  return join(workspace, name)
}

/**
 * A real registered agent with its own lifecycle scope.
 * @param ctx - context owning the agent scope.
 * @param id - session identity.
 * @param workspace - absolute session workspace.
 * @returns the live owner and its idempotent cleanup.
 */
async function makeOwner(ctx: Context, id: SessionId, workspace: string): Promise<LiveOwner> {
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
  const unregister = await ctx.agents.register(agent)
  let scopeDisposed = false
  let detached = false
  return {
    agent,
    async disposeScope() {
      if (scopeDisposed) return
      scopeDisposed = true
      await scopeFiber.dispose()
    },
    async detach() {
      if (detached) return
      detached = true
      await unregister()
    },
  }
}

/**
 * Mount the plugin, then the real job and agent registries, then one owner.
 * @param options - plugin and registry overrides.
 * @returns the mounted harness.
 */
async function setup(options: SetupOptions = {}): Promise<QueryHarness> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-aether-query-handoff-'))
  const base = await createHarness({
    workspaceRoot: workspace,
    executable: process.execPath,
    executableArgs: [QUERY_FIXTURE, `--handoff-root=${workspace}`],
    config: { graceMs: 1_000, ...options.config },
  })
  // The query tools read `ctx.get('jobs')` lazily, so mounting these after the
  // plugin is the real composition order under test, not a test-only shim.
  await base.ctx.plugin(AgentRegistry)
  await base.ctx.plugin(LocalJobRegistry, options.jobsConfig ?? {})
  base.ctx.jobs.attachController('aether-query-handoff-test')
  const owner = await makeOwner(base.ctx, SessionId('sess-query-handoff'), workspace)
  const extras: LiveOwner[] = []
  let disposed = false

  const mounted: QueryHarness = {
    base,
    ctx: base.ctx,
    workspace,
    owner,
    async addOwner(id) {
      const extra = await makeOwner(base.ctx, SessionId(id), workspace)
      extras.push(extra)
      return extra
    },
    call(name, args, callOptions = {}) {
      return base.call(name, args, {
        agent: owner.agent,
        ...callOptions.signal === undefined ? {} : { signal: callOptions.signal },
      })
    },
    async disposeOwner() {
      await owner.disposeScope()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const extra of extras.splice(0)) {
        await extra.disposeScope()
        await extra.detach()
      }
      await owner.disposeScope()
      await owner.detach()
      await base.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
  return mounted
}

/** Mount a harness as the active one for the current test. */
async function open(options: SetupOptions = {}): Promise<QueryHarness> {
  const mounted = await setup(options)
  active = mounted
  return mounted
}

/** The one live job owned by an agent, failing loudly when the count differs. */
function onlyJob(mounted: QueryHarness, owner: LiveOwner = mounted.owner): JobId {
  const owned = mounted.ctx.jobs.list(owner.agent.id)
  if (owned.length !== 1) throw new Error(`expected exactly one job, found ${owned.length}`)
  return owned[0]!.id
}

/** Narrow a successful tool result to its promoted arm and job id. */
function promotedOf(result: ToolExecutionResult): { readonly id: JobId; readonly value: Record<string, unknown> } {
  const value = valueOf(result)
  if (value['kind'] !== 'promoted') throw new Error(`expected a promoted outcome, got: ${text(result)}`)
  const id = value['jobId']
  if (typeof id !== 'string' || id.length === 0) throw new Error(`promoted outcome carries no job id: ${text(result)}`)
  return { id: JobId(id), value }
}

/** Wait for a completed settlement, then consume the final canonical JSON through the registry. */
async function finalOutcome(mounted: QueryHarness, id: JobId, owner: LiveOwner = mounted.owner): Promise<Record<string, unknown>> {
  const view = await mounted.ctx.jobs.wait(id, 10_000, owner.agent.id)
  if (!TERMINAL.has(view.status)) throw new Error(`job ${id} did not settle, status: ${view.status}`)
  if (view.status !== 'completed') throw new Error(`job ${id} settled ${view.status}, not completed: ${view.detail ?? ''}`)
  const read = mounted.ctx.jobs.read(id, owner.agent.id)
  if (read.result === undefined) throw new Error(`job ${id} settled without a result record`)
  return JSON.parse(read.result) as Record<string, unknown>
}

/** Release the fixture and consume the settled job's final JSON once. */
async function finish(mounted: QueryHarness, id: JobId, releasePath: string): Promise<Record<string, unknown>> {
  await release(releasePath)
  return finalOutcome(mounted, id)
}

/** Drop a settled record whose id the model never received. */
function drop(mounted: QueryHarness, id: JobId): void {
  mounted.ctx.jobs.remove(id, mounted.owner.agent.id)
}

describe('foreground query handoff', () => {
  it.skipIf(process.env['DSH_AETHER_TYPED_TEST_EXECUTABLE'] === undefined)('hands off the installed native interpreter and its child without repeating either effect', async () => {
    const executable = process.env['DSH_AETHER_TYPED_TEST_EXECUTABLE']
    if (executable === undefined) throw new Error('Select the installed native interpreter explicitly')
    const mounted = await open({ config: { executable, executableArgs: [] } })
    const barrier = marker(mounted.workspace, 'release-native')
    const once = marker(mounted.workspace, 'native-starts.txt')
    const childCode = JSON.stringify({ marker: 'cli', release: barrier, value: 42 })
    const child = [process.execPath, QUERY_FIXTURE, `--handoff-root=${mounted.workspace}`, '--deterministic', '-c', childCode]
    const code = `file_append(${JSON.stringify(once)}, "once\\n"); proc_run(${JSON.stringify(child)}, {timeout_ms:10000}); 42`
    const result = await mounted.call('aether_eval', { code, timeoutMs: 1, executionTimeoutMs: 15_000 })
    const { id } = promotedOf(result)
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'cli')
    expect(await lines(once)).toEqual(['once'])
    const final = await finish(mounted, id, barrier)
    expect(final).toMatchObject({ kind: 'value', value: 42, process: { exitCode: 0, cleanupFailed: false } })
    expect(await lines(once)).toEqual(['once'])
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['cli'])
    expect(await lines(marker(mounted.workspace, 'spawns.txt'))).toHaveLength(1)
    expect(mounted.ctx.jobs.read(id, mounted.owner.agent.id).result).toBeUndefined()
  })

  it('keeps a slow call in its original job and returns the native business value once', async () => {
    const mounted = await open()
    const barrier = marker(mounted.workspace, 'release-call')
    const result = await mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: barrier, value: 'call-finished' }],
      timeoutMs: 50,
    })
    const promoted = promotedOf(result)
    expect(promoted.value).toMatchObject({
      kind: 'promoted',
      cwd: mounted.workspace,
      waitTimeoutMs: 50,
      executionTimeoutMs: 0,
    })
    const { id } = promoted
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id)).toMatchObject({
      kind: 'aether',
      status: 'running',
      owner: mounted.owner.agent.id,
      label: 'aether_call',
    })
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id).label).not.toContain('call-finished')

    const final = await finish(mounted, id, barrier)
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id).status).toBe('completed')
    expect(final['kind']).toBe('value')
    expect(final['value']).toMatchObject({ success: false, marker: 'call', value: 'call-finished' })
    expect(final['metadata']).toMatchObject({ fixture: 'ae-query-handoff' })
    expect(final['sandbox']).toMatchObject({ mode: 'danger-full-access', denied: false })
    expect(final['process']).toMatchObject({ exitCode: 0, timedOut: false, cleanupFailed: false })
    const consumed = mounted.ctx.jobs.read(id, mounted.owner.agent.id)
    expect(consumed.result).toBeUndefined()
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['call'])
    expect(await lines(marker(mounted.workspace, 'spawns.txt'))).toHaveLength(1)
    drop(mounted, id)
  })

  it('keeps a slow pipeline in its original job and returns the native business value once', async () => {
    const mounted = await open()
    const barrier = marker(mounted.workspace, 'release-pipeline')
    const result = await mounted.call('aether_pipeline', {
      steps: [{ builtin: 'slow', args: [{ release: barrier, value: 'pipeline-finished' }] }],
      timeoutMs: 50,
    })
    const { id } = promotedOf(result)
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'pipeline')
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id)).toMatchObject({ status: 'running', label: 'aether_pipeline' })

    const final = await finish(mounted, id, barrier)
    expect(final['kind']).toBe('value')
    expect(final['value']).toMatchObject({ success: false, marker: 'pipeline', value: 'pipeline-finished' })
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['pipeline'])
    drop(mounted, id)
  })

  it('keeps a slow eval in its original job and returns the command-line value once', async () => {
    const mounted = await open()
    const barrier = marker(mounted.workspace, 'release-cli')
    const code = JSON.stringify({ marker: 'cli', release: barrier, value: 'cli-finished' })
    const result = await mounted.call('aether_eval', { code, timeoutMs: 50 })
    const { id } = promotedOf(result)
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'cli')
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id)).toMatchObject({ status: 'running', label: 'aether_eval' })

    const final = await finish(mounted, id, barrier)
    expect(final['kind']).toBe('value')
    expect(final['value']).toBe('cli-finished')
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['cli'])
    drop(mounted, id)
  })

  it('counts a typed-v1 capability probe separately from the one operation', async () => {
    const mounted = await open({ config: { structuredDataMode: 'typed-v1' } })
    const barrier = marker(mounted.workspace, 'release-typed')
    const result = await mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: barrier, value: 'typed-finished' }],
      timeoutMs: 50,
    })
    const { id } = promotedOf(result)
    await waitForLine(marker(mounted.workspace, 'probes.txt'), 'probe')
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id).status).toBe('running')

    const final = await finish(mounted, id, barrier)
    expect(final['kind']).toBe('value')
    expect(final['value']).toMatchObject({ success: false, marker: 'call', value: 'typed-finished' })
    expect(await lines(marker(mounted.workspace, 'probes.txt'))).toEqual(['probe'])
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['call'])
    expect(await lines(marker(mounted.workspace, 'spawns.txt'))).toHaveLength(2)
    drop(mounted, id)
  })

  it('kills the operation at executionTimeoutMs without starting it again', async () => {
    const mounted = await open()
    const events: JobEvent[] = []
    const unsubscribe = mounted.ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { events.push(event) })
    const barrier = marker(mounted.workspace, 'never-released')
    const pending = mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: barrier, value: 'must-not-finish' }],
      timeoutMs: 10_000,
      executionTimeoutMs: 2_000,
    })
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    expect(mounted.ctx.jobs.get(onlyJob(mounted), mounted.owner.agent.id).status).toBe('running')
    const value = valueOf(await pending)
    unsubscribe()

    expect(value['kind']).toBe('interrupted')
    expect(value['process']).toMatchObject({ timedOut: true, timeoutMs: 2_000, cleanupFailed: false })
    expect(mounted.ctx.jobs.list(mounted.owner.agent.id)).toEqual([])
    const settled = events.filter((event): event is Extract<JobEvent, { type: 'settled' }> => event.type === 'settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.job.status).toBe('killed')
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['call'])
  })

  it('waits for cleanup after a foreground cancellation and still runs a new query', async () => {
    const mounted = await open()
    const controller = new AbortController()
    const barrier = marker(mounted.workspace, 'release-cancelled')
    const pending = mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: barrier, value: 'cancelled' }],
      timeoutMs: 10_000,
    }, { signal: controller.signal })
    const rejection = pending
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    const id = onlyJob(mounted)
    expect(mounted.ctx.jobs.get(id, mounted.owner.agent.id).status).toBe('running')
    controller.abort()
    const error = await rejection
    expect(error).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED } } })
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['call'])
    expect(mounted.ctx.jobs.list(mounted.owner.agent.id)).toEqual([])

    const secondBarrier = marker(mounted.workspace, 'release-after-cancel')
    await release(secondBarrier)
    const second = valueOf(await mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: secondBarrier, value: 'after-cancel' }],
      timeoutMs: 5_000,
    }))
    expect(second['kind']).toBe('value')
    expect(second['value']).toMatchObject({ success: false, marker: 'call', value: 'after-cancel' })
  })

  it('stops the long-running job and releases resources when its owner is disposed', async () => {
    const mounted = await open()
    const barrier = marker(mounted.workspace, 'release-owner-disposed')
    const pending = mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: barrier, value: 'owner-disposed' }],
      timeoutMs: 10_000,
    })
    const rejection = pending
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    expect(mounted.ctx.jobs.get(onlyJob(mounted), mounted.owner.agent.id).status).toBe('running')
    await mounted.disposeOwner()
    const error = await rejection
    expect(error).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED } } })
    expect(mounted.ctx.jobs.list(mounted.owner.agent.id)).toEqual([])
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['call'])
  })

  it('settles an already-promoted query when the adapter unloads', async () => {
    const mounted = await open()
    const result = await mounted.call('aether_call', {
      builtin: 'slow', args: [{ release: marker(mounted.workspace, 'never-release-unloaded'), value: 1 }], timeoutMs: 1,
    })
    const { id } = promotedOf(result)
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    await mounted.base.pluginFiber.dispose()
    const view = await mounted.ctx.jobs.wait(id, 10_000, mounted.owner.agent.id)
    expect(view.status).toBe('killed')
    const final = mounted.ctx.jobs.read(id, mounted.owner.agent.id).result
    if (final === undefined) throw new Error('Unloaded query did not publish its terminal outcome')
    expect(JSON.parse(final)).toMatchObject({ kind: 'interrupted', aborted: true, process: { cleanupFailed: false } })
    expect(await lines(marker(mounted.workspace, 'starts.txt'))).toEqual(['call'])
  })

  it('keeps the job fenced to the exact owning session', async () => {
    const mounted = await open()
    const other = await mounted.addOwner('sess-query-handoff-other')
    const barrier = marker(mounted.workspace, 'release-fenced')
    const result = await mounted.call('aether_call', {
      builtin: 'slow',
      args: [{ release: barrier, value: 'fenced' }],
      timeoutMs: 50,
    })
    const { id } = promotedOf(result)
    await waitForLine(marker(mounted.workspace, 'starts.txt'), 'call')
    expect(() => mounted.ctx.jobs.get(id, other.agent.id)).toThrow(/another session/u)
    expect(() => mounted.ctx.jobs.read(id, other.agent.id)).toThrow(/another session/u)
    expect(() => mounted.ctx.jobs.kill(id, other.agent.id, 'not allowed')).toThrow(/another session/u)

    mounted.ctx.jobs.kill(id, mounted.owner.agent.id, 'test cleanup')
    await mounted.ctx.jobs.wait(id, 10_000, mounted.owner.agent.id)
    mounted.ctx.jobs.remove(id, mounted.owner.agent.id)
    expect(mounted.ctx.jobs.list(mounted.owner.agent.id)).toEqual([])
  })
})
