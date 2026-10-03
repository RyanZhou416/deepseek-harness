/**
 * Released-Agent retention in the Web composition under the shared synthetic
 * workload (`workload.ts`): concurrent roots, optionally seeded with long
 * history, fan out continuable children through real tools, follow streams,
 * retryable provider failures, compaction, mid-turn cancellation and idle
 * eviction. Every Agent and Session that announced disposal must then be
 * collectable. Any survivor fails with a heap snapshot and its shortest strong
 * retainer chains under `tmp/agent-lifetime/`.
 *
 * Knobs (environment), beside the workload knobs:
 * - DSH_STRESS_ROOTS: concurrent root Sessions (default 4).
 * - DSH_STRESS_ROUNDS: prompt rounds per root (default 2).
 * - DSH_STRESS_SOAK_MIN: when positive, repeat rounds for this many minutes and
 *   append periodic samples to `tmp/agent-lifetime/soak-<stamp>.ndjson`.
 * - DSH_STRESS_SAMPLE_S: soak sampling interval (default 30).
 * - DSH_STRESS_LONG_EVENTS: when positive, seed every root with a closed log of
 *   about this many events before its first prompt.
 * - DSH_STRESS_CANCEL_PERCENT: chance each root prompt is cancelled mid-turn (default 15).
 * - DSH_LIFETIME_GRACE_S: post-run collection window (default 35).
 * - DSH_LIFETIME_TRACE_RESOURCES: `1` lists native async resources still open
 *   at the end, labelled with the Agent whose context created them.
 * - DSH_LIFETIME_DETACH_WATCHERS: `1` creates every `fs.watch` / `fs.watchFile`
 *   handle in the test module's async context instead of the caller's, which
 *   isolates watcher-held Agent contexts from other retention.
 * - DSH_LIFETIME_LEAK_HANDLES: `1` opens one interval timer in the caller's
 *   async context on every model call and keeps all of them open through the
 *   survivor checks, standing in for transport handles (such as abandoned proxy
 *   tunnel sockets) that outlive their request.
 * - DSH_LIFETIME_OWNERSHIP_PROBE: path of a CommonJS diagnostic plugin (the
 *   profile-local memory ownership probe) to mount on the Host; its NDJSON goes
 *   to `tmp/agent-lifetime/probe-<stamp>/`.
 * - DSH_LIFETIME_BROWSER: `1` keeps a Web page open for the whole run that
 *   keeps switching between root and child Sessions in the sidebar; reachable
 *   released targets are counted once with the page still open, then the page
 *   closes before the final checks. Roots are always seeded with a title.
 */
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import fs, { createWriteStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Session as InspectorSession } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, type WebScaffold } from '../tests/scaffold.ts'
import { REPO_ROOT, newEnglishPage } from '../tests/support.ts'
import {
  EXTRA_TOOLS, FORK_PLUGINS, LONG_JOB_SECONDS, PROVIDER, ROOT_MODEL, ROUND_MARK, WorkloadAdapter, forkProfile,
  longHistoryFixture, positive, seedWorkspace, writeWorkloadOverlay,
} from './workload.ts'

const ROOTS = Math.max(1, positive('DSH_STRESS_ROOTS', 4))
const ROUNDS = Math.max(1, positive('DSH_STRESS_ROUNDS', 2))
const SOAK_MS = positive('DSH_STRESS_SOAK_MIN', 0) * 60_000
const SAMPLE_MS = Math.max(1, positive('DSH_STRESS_SAMPLE_S', 30)) * 1000
const LONG_EVENTS = positive('DSH_STRESS_LONG_EVENTS', 0)
const CANCEL_PERCENT = positive('DSH_STRESS_CANCEL_PERCENT', 15)
const BROWSE = process.env.DSH_LIFETIME_BROWSER === '1'
const IDLE_RETENTION_MS = 1500
// Bounded request timers (for example 30 s AbortSignal.timeout) may hold an Agent's async context until they fire.
const RELEASE_GRACE_MS = positive('DSH_LIFETIME_GRACE_S', 35) * 1000
const ROUND_TIMEOUT_MS = 300_000
const OUTPUT_DIR = join(REPO_ROOT, 'tmp', 'agent-lifetime')
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-')

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const LEAK_HANDLES = process.env.DSH_LIFETIME_LEAK_HANDLES === '1'
const leakedHandles: NodeJS.Timeout[] = []
const DETACH_WATCHERS = process.env.DSH_LIFETIME_DETACH_WATCHERS === '1'
if (DETACH_WATCHERS) {
  const detached = AsyncLocalStorage.snapshot()
  const { watch, watchFile } = fs
  fs.watch = ((...args: Parameters<typeof watch>) => detached(() => watch(...args))) as typeof watch
  fs.watchFile = ((...args: Parameters<typeof watchFile>) => detached(() => watchFile(...args))) as typeof watchFile
  syncBuiltinESMExports()
}

/** Weak lifecycle records; the scenario itself must never keep a released target alive. */
class LifetimeLedger {
  readonly live = new Set<SessionId>()
  readonly released: { kind: 'Agent' | 'Session'; id: SessionId; ref: WeakRef<object> }[] = []
  created = 0

  attach(world: WebScaffold): () => void {
    const offs = [
      world.ctx.on('agent/created', ({ agent }) => {
        this.created++
        this.live.add(agent.id)
      }),
      world.ctx.on('agent/disposed', ({ agent }) => {
        this.live.delete(agent.id)
        this.released.push({ kind: 'Agent', id: agent.id, ref: new WeakRef(agent) })
      }),
      world.ctx.on('session/disposed', (session) => {
        this.released.push({ kind: 'Session', id: session.id, ref: new WeakRef(session) })
      }),
    ]
    return () => { for (const off of offs) off() }
  }

  survivors(): { kind: 'Agent' | 'Session'; id: SessionId; ref: WeakRef<object> }[] {
    return this.released.filter(record => record.ref.deref() !== undefined)
  }
}

async function settle(world: WebScaffold, ledger: LifetimeLedger, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let quiet = 0
  while (quiet < 3) {
    if (Date.now() > deadline) {
      const busy = [...ledger.live].map(id => `${id}:${world.ctx.agents.get(id)?.status ?? 'gone'}`)
      throw new Error(`Agents did not settle within ${String(timeoutMs)} ms: ${busy.join(', ')}`)
    }
    await delay(200)
    const busy = [...ledger.live].some(id => world.ctx.agents.get(id)?.status === 'running')
    quiet = busy ? 0 : quiet + 1
  }
}

const TRACE_SKIP = new Set(['PROMISE', 'TickObject', 'Microtask', 'Timeout', 'Immediate', 'FSREQCALLBACK', 'FSREQPROMISE'])

/**
 * Native async resources created while tracing and not yet destroyed, grouped by
 * type and creation stack. Resources created under an initiating Agent capture
 * that Agent in their async context frame; they are labelled with its id.
 */
function traceResources(initiator: () => string | undefined): { stop: () => void; open: () => Record<string, number> } {
  const open = new Map<number, string>()
  const stackLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 40
  const hook = createHook({
    init(asyncId, type) {
      if (TRACE_SKIP.has(type)) return
      const frames = (new Error().stack ?? '').split('\n').slice(2)
        .filter(line => !line.includes('node:internal') && !line.includes('node:async_hooks'))
        .slice(0, 6).map(line => line.trim().replace(/^at /u, '').replace(REPO_ROOT, '').replace(/\\/gu, '/'))
      const agent = initiator()
      open.set(asyncId, `${agent === undefined ? '[host]' : '[agent]'} ${type} <- ${frames.join(' <- ')}`)
    },
    destroy(asyncId) { open.delete(asyncId) },
  }).enable()
  return {
    stop: () => {
      hook.disable()
      Error.stackTraceLimit = stackLimit
    },
    open: () => {
      const groups: Record<string, number> = {}
      for (const label of open.values()) groups[label] = (groups[label] ?? 0) + 1
      return groups
    },
  }
}

function countResources(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) ?? 0) + 1)
  return counts
}

/** Native handle and request types that outnumber the post-boot baseline; any of them may carry an Agent's async context. */
function resourceGrowth(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...after].flatMap(([type, count]) => {
    const added = count - (before.get(type) ?? 0)
    return added > 0 ? [[type, added]] : []
  }))
}

async function collectGarbage(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    await delay(50)
    collect()
  }
}

/** Snapshot the heap with released targets addressed by heap object id, then report their retainers. */
async function reportRetainers(survivors: { kind: string; id: SessionId; ref: WeakRef<object> }[]): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const snapshotFile = join(OUTPUT_DIR, `lifetime-${STAMP}.heapsnapshot`)
  const inspector = new InspectorSession()
  inspector.connect()
  const ids: number[] = []
  const slot = Symbol.for('dsh.agent-lifetime.target')
  try {
    await inspector.post('HeapProfiler.enable')
    await collectGarbage()
    const out = createWriteStream(snapshotFile)
    inspector.on('HeapProfiler.addHeapSnapshotChunk', ({ params }) => { out.write(params.chunk) })
    await inspector.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => { if (error) reject(error); else resolve() }) })
    // V8 assigns heap object ids while snapshotting, so targets are addressed afterwards.
    for (const survivor of survivors.slice(0, 200)) {
      const target = survivor.ref.deref()
      if (target === undefined) continue
      // `process` is shared with the inspector's evaluation realm; the test realm's globalThis may not be.
      Reflect.set(process, slot, target)
      const { result } = await inspector.post('Runtime.evaluate', { expression: 'process[Symbol.for(\'dsh.agent-lifetime.target\')]' })
      Reflect.deleteProperty(process, slot)
      if (result.objectId === undefined) continue
      const { heapSnapshotObjectId } = await inspector.post('HeapProfiler.getHeapObjectId', { objectId: result.objectId })
      await inspector.post('Runtime.releaseObject', { objectId: result.objectId })
      ids.push(Number(heapSnapshotObjectId))
    }
  } finally {
    inspector.disconnect()
  }
  const { readHeapSnapshot, findRetainers, formatRetainers } = await import(
    /* @vite-ignore */ new URL('../../../fork-runtime/diagnostics/retainers.mjs', import.meta.url).href,
  ) as typeof import('../../../fork-runtime/diagnostics/retainers.mjs')
  const report = findRetainers(await readHeapSnapshot(snapshotFile), { ids, maxGroups: 12 })
  const text = formatRetainers(report)
  const reportFile = snapshotFile.replace(/\.heapsnapshot$/u, '.retainers.txt')
  await writeFile(reportFile, text)
  return `${text}\nsnapshot: ${snapshotFile}\nreport: ${reportFile}`
}

/** Keep opening random Session rows of the sidebar (children included) until aborted. */
async function browse(page: Page, signal: AbortSignal): Promise<{ opens: number; maxRows: number; misses: number; missReasons: string[] }> {
  const counts = { opens: 0, maxRows: 0, misses: 0, missReasons: [] as string[] }
  // The first rows are the workspace group and its New Session entry.
  const rows = page.getByRole('treeitem').filter({ hasNotText: /^New Session$/u })
  while (!signal.aborted) {
    try {
      const count = await rows.count()
      counts.maxRows = Math.max(counts.maxRows, count)
      if (count < 2) throw new Error('no session rows')
      await rows.nth(1 + Math.floor(Math.random() * (count - 1))).click({ timeout: 5000 })
      counts.opens++
    } catch (error) {
      // A row can move or unmount between lookup and click while sessions stream; the miss is counted and browsing goes on.
      counts.misses++
      if (counts.missReasons.length < 3) counts.missReasons.push(String(error).split('\n')[0]!.slice(0, 200))
    }
    await delay(800 + Math.random() * 2500)
  }
  return counts
}

/** Periodic soak samples: heap, live and released-but-reachable lifecycle objects, loop delay and handles. */
function startSampler(world: WebScaffold, ledger: LifetimeLedger, adapter: WorkloadAdapter, file: string): () => Promise<void> {
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const started = performance.now()
  let stopped = false
  const sampling = (async () => {
    while (!stopped) {
      await delay(SAMPLE_MS)
      if (stopped) break
      collect()
      const memory = process.memoryUsage()
      const sample = {
        atS: Math.round((performance.now() - started) / 1000),
        heapMiB: Math.round(memory.heapUsed / 2 ** 20),
        rssMiB: Math.round(memory.rss / 2 ** 20),
        liveAgents: ledger.live.size,
        runningAgents: [...ledger.live].filter(id => world.ctx.agents.get(id)?.status === 'running').length,
        released: ledger.released.length,
        releasedReachable: ledger.survivors().length,
        loopP50Ms: Math.round(loop.percentile(50) / 1e6),
        loopP99Ms: Math.round(loop.percentile(99) / 1e6),
        loopMaxMs: Math.round(loop.max / 1e6),
        activeResources: process.getActiveResourcesInfo().length,
        modelCalls: adapter.counters.calls,
      }
      loop.reset()
      await appendFile(file, `${JSON.stringify(sample)}\n`)
      process.stdout.write(`AGENT_SOAK ${JSON.stringify(sample)}\n`)
    }
  })()
  return async () => {
    stopped = true
    loop.disable()
    await sampling
  }
}

it('releases every disposed Agent and Session after realistic concurrent delegated work and idle eviction', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-lifetime-'))
  const overlay = await writeWorkloadOverlay(configRoot, IDLE_RETENTION_MS)
  const profile = forkProfile()
  let world: WebScaffold | undefined
  const ledger = new LifetimeLedger()
  const follows = new AbortController()
  const browseStop = new AbortController()
  let browser: Browser | undefined
  let page: Page | undefined
  try {
    world = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('../tests/pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      ...profile === undefined ? {} : { profile },
    })
    const scaffold = world
    const probePath = process.env.DSH_LIFETIME_OWNERSHIP_PROBE
    if (probePath !== undefined) {
      process.env.DSH_DIAGNOSTICS = join(OUTPUT_DIR, `probe-${STAMP}`)
      const probe = createRequire(import.meta.url)(probePath) as Parameters<typeof scaffold.ctx.plugin>[0]
      await scaffold.ctx.plugin(probe, { intervalMs: 5000, retainedDetailAfterMs: 60_000 })
    }
    await seedWorkspace(scaffold.workspaceCwd)
    const adapter = new WorkloadAdapter(scaffold.workspaceCwd)
    if (LEAK_HANDLES) {
      const stream = adapter.stream.bind(adapter)
      adapter.stream = (options) => {
        leakedHandles.push(setInterval(() => {}, 2 ** 30))
        return stream(options)
      }
    }
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter))
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: ROOT_MODEL })
    const controller = scaffold.ctx.sessionController
    const roots: SessionId[] = []
    const seedEvents = BROWSE ? Math.max(LONG_EVENTS, 40) : LONG_EVENTS
    for (let index = 0; index < ROOTS; index++) {
      if (seedEvents > 0) {
        roots.push(await seedSession(scaffold, longHistoryFixture(`stress-long-${String(index)}`, `Stress long ${String(index)}`, seedEvents), `stress-long-${String(index)}`))
      } else {
        roots.push((await controller.create({ cwd: scaffold.workspaceCwd })).sessionId)
      }
    }
    adapter.sessionTargets = roots
    if (BROWSE) {
      const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
      for (const sessionId of roots) await workspace.attachSession(sessionId)
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('[data-composer-input]').first().waitFor({ timeout: 60_000 })
      await mkdir(OUTPUT_DIR, { recursive: true })
      await page.getByRole('treeitem').first().waitFor({ timeout: 60_000 }).catch(async (error: unknown) => {
        await page!.screenshot({ path: join(OUTPUT_DIR, `browse-${STAMP}.png`) })
        throw error
      })
    }
    const browsing = page === undefined ? undefined : browse(page, browseStop.signal)
    const detach = ledger.attach(scaffold)
    await collectGarbage()
    const baselineHeap = process.memoryUsage().heapUsed
    const baselineResources = countResources()
    const tracer = process.env.DSH_LIFETIME_TRACE_RESOURCES === '1'
      ? traceResources(() => scaffold.ctx.agents.currentInitiator()?.id)
      : undefined
    await mkdir(OUTPUT_DIR, { recursive: true })
    const stopSampler = SOAK_MS > 0
      ? startSampler(scaffold, ledger, adapter, join(OUTPUT_DIR, `soak-${STAMP}.ndjson`))
      : undefined
    const started = performance.now()
    let cancels = 0
    let round = 0
    const followed: Promise<void>[] = []
    while (round < ROUNDS || performance.now() - started < SOAK_MS) {
      const roundFollows = new AbortController()
      const signal = AbortSignal.any([roundFollows.signal, follows.signal])
      for (const sessionId of roots) {
        followed.push((async () => {
          try {
            for await (const frame of controller.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, signal)) {
              void frame
            }
          } catch (error) {
            if (!signal.aborted) throw error
          }
        })())
      }
      await Promise.all(roots.map(async (sessionId, index) => {
        await controller.prompt({
          requestId: `stress-${String(round)}-${String(index)}` as SessionRequestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `${ROUND_MARK} ${String(round)}: audit the workspace modules with helpers.` }],
        }, follows.signal)
        if (Math.random() * 100 < CANCEL_PERCENT) {
          await delay(300 + Math.random() * 2000)
          if (scaffold.ctx.agents.get(sessionId)?.status === 'running') {
            controller.cancel({ sessionId })
            cancels++
          }
        }
      }))
      await settle(scaffold, ledger, ROUND_TIMEOUT_MS)
      roundFollows.abort()
      round++
    }
    follows.abort()
    await Promise.all(followed)
    await stopSampler?.()
    const workMs = performance.now() - started

    let pageOpen: object | undefined
    if (browsing !== undefined) {
      const openDeadline = Date.now() + 20_000
      while (ledger.live.size > 1 && Date.now() < openDeadline) await delay(250)
      const graceDeadline = Date.now() + RELEASE_GRACE_MS
      let reachable = ledger.survivors()
      while (reachable.length > 0 && Date.now() < graceDeadline) {
        await delay(500)
        await collectGarbage()
        reachable = ledger.survivors()
      }
      pageOpen = {
        live: ledger.live.size,
        releasedReachable: reachable.length,
        reachableKinds: reachable.reduce<Record<string, number>>((counts, record) => {
          counts[record.kind] = (counts[record.kind] ?? 0) + 1
          return counts
        }, {}),
        pageHeapMiB: Math.round(await page!.evaluate(() =>
          (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20),
      }
      browseStop.abort()
      pageOpen = { ...pageOpen, ...await browsing }
      await browser?.close()
      browser = undefined
    }

    const evictionDeadline = Date.now() + 60_000 + (EXTRA_TOOLS.has('jobs') ? LONG_JOB_SECONDS * 1000 : 0)
    while (ledger.live.size > 0 && Date.now() < evictionDeadline) await delay(250)
    const stillLive = [...ledger.live]
    const jobs = scaffold.ctx.get('jobs') as { list(owner: SessionId): { status: string }[] } | undefined
    const stillLiveDetail = stillLive.map((id) => {
      const agent = scaffold.ctx.agents.get(id)
      return {
        id,
        status: agent?.status,
        inbox: agent === undefined ? undefined : agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
        children: agent === undefined
          ? undefined
          : scaffold.ctx.agents.list().filter(child => scaffold.ctx.agents.isOwnedBy(child.id, agent)).length,
        activeJobs: jobs?.list(id).filter(job => job.status === 'running' || job.status === 'stopping').length,
      }
    })
    detach()
    // Disposal finishes through asynchronous flushes and timers; only a target
    // that outlives this window is reported.
    const releaseDeadline = Date.now() + RELEASE_GRACE_MS
    let survivors = ledger.survivors()
    while (survivors.length > 0 && Date.now() < releaseDeadline) {
      await delay(500)
      await collectGarbage()
      survivors = ledger.survivors()
    }
    const endHeap = process.memoryUsage().heapUsed
    const summary = {
      roots: ROOTS, rounds: round, longEvents: LONG_EVENTS, forkPlugins: FORK_PLUGINS, detachWatchers: DETACH_WATCHERS,
      leakedHandles: leakedHandles.length, cancels, pageOpen,
      agentsCreated: ledger.created, model: adapter.counters,
      released: ledger.released.length, survivors: survivors.length,
      survivorKinds: survivors.reduce<Record<string, number>>((counts, record) => {
        counts[record.kind] = (counts[record.kind] ?? 0) + 1
        return counts
      }, {}),
      stillLive: stillLive.length,
      stillLiveDetail,
      addedResources: resourceGrowth(baselineResources, countResources()),
      workMs: Math.round(workMs),
      heapMiB: { baseline: Math.round(baselineHeap / 2 ** 20), end: Math.round(endHeap / 2 ** 20) },
    }
    process.stdout.write(`AGENT_LIFETIME ${JSON.stringify(summary)}\n`)
    if (tracer !== undefined) {
      tracer.stop()
      process.stdout.write(`AGENT_LIFETIME_OPEN_RESOURCES ${JSON.stringify(tracer.open(), null, 1)}\n`)
    }
    const retainers = survivors.length === 0 ? '' : await reportRetainers(survivors)
    if (retainers.length > 0) process.stdout.write(`AGENT_LIFETIME_RETAINERS\n${retainers}\n`)
    expect(stillLive, 'owned Agents should unload after idle eviction').toEqual([])
    expect(survivors.map(record => `${record.kind}:${record.id}`), retainers).toEqual([])
  } finally {
    for (const handle of leakedHandles.splice(0)) clearInterval(handle)
    follows.abort()
    browseStop.abort()
    await browser?.close()
    await world?.close()
    await rm(configRoot, { recursive: true, force: true })
  }
})
