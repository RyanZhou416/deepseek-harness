/**
 * Main-view Session switch latency while many Agents stream, under the shared
 * synthetic workload (`workload.ts`). Long closed Sessions are seeded with
 * about two events per log frame, as recorded logs are, then opened once and
 * left to idle-evict so their projection checkpoints exist. A Chromium page
 * switches to each target through the sidebar, first with nothing running and
 * then while fresh roots keep streaming. A target's first open is cold (the
 * Host decodes its log and resumes its Agent); the next open is warm. Every
 * switch reports the time from the pointer press until the target's last
 * message is in the document, browser long tasks, Host event-loop delay and
 * inbound WebSocket bytes. Timings are reported, not asserted.
 *
 * Knobs (environment), beside the workload knobs:
 * - DSH_STRESS_ROOTS: fresh roots kept streaming in the loaded phase (default 16).
 * - DSH_STRESS_LONG_EVENTS: events per seeded target (default 60000).
 * - DSH_STRESS_SWITCH_TARGETS: targets per phase (default 2).
 * - DSH_STRESS_PROFILE: `1` saves browser and Host CPU profiles of the first
 *   loaded cold switch under tmp/runtime-profiles.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole } from '../tests/scaffold.ts'
import { captureRuntimeProfile } from '../tests/runtime-profile.ts'
import { newEnglishPage, saveFailureShot } from '../tests/support.ts'
import {
  FORK_PLUGINS, PROVIDER, ROOT_MODEL, ROUND_MARK, WorkloadAdapter, forkProfile, longHistoryFixture, positive,
  seedWorkspace, writeWorkloadOverlay,
} from './workload.ts'

process.env.DSH_STRESS_PACE_MS ??= '20'
const ROOTS = Math.max(1, positive('DSH_STRESS_ROOTS', 16))
const LONG_EVENTS = Math.max(100, positive('DSH_STRESS_LONG_EVENTS', 60_000))
const TARGETS = Math.max(1, positive('DSH_STRESS_SWITCH_TARGETS', 2))
const PROFILE = process.env.DSH_STRESS_PROFILE === '1'
// Short enough that warmed targets unload before measurement, long enough that a warm reopen finds them resident.
const IDLE_RETENTION_MS = 15_000
const EVENTS_PER_FRAME = 2

interface Target { id: SessionId; title: string; lastMessage: string }

/** The final assistant summary of a seeded fixture, which a switch must render. */
function lastSummary(fixture: string): string {
  const matches = [...fixture.matchAll(/Turn (\d+) summary\./gu)]
  const last = matches.at(-1)
  if (last === undefined) throw new Error('fixture has no turn summary')
  return last[0]
}

/** Inbound WebSocket bytes on the page's Host connection since the last take. */
function countInbound(page: Page): () => { frames: number; kib: number } {
  let frames = 0
  let bytes = 0
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      frames++
      bytes += typeof payload === 'string' ? payload.length : payload.byteLength
    })
  })
  return () => {
    const result = { frames, kib: Math.round(bytes / 1024) }
    frames = 0
    bytes = 0
    return result
  }
}

it('reports main-view switch latency to long Sessions while many Agents stream', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'dsh-switch-stress-'))
  const overlay = await writeWorkloadOverlay(configRoot, IDLE_RETENTION_MS)
  const profile = forkProfile()
  const world = await launchWebScaffold({
    extraOverlayPath: [fileURLToPath(new URL('../tests/pin-browse-picker.overlay.yml', import.meta.url)), overlay],
    ...profile === undefined ? {} : { profile },
  })
  let browser: Browser | undefined
  const load = new AbortController()
  try {
    await seedWorkspace(world.workspaceCwd)
    const adapter = new WorkloadAdapter(world.workspaceCwd)
    world.ctx.effect(() => world.ctx.llm.registerAdapter([PROVIDER], adapter))
    await world.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: ROOT_MODEL })
    const controller = world.ctx.sessionController
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)

    const seedStarted = performance.now()
    const seed = async (id: string, title: string, events: number): Promise<Target> => {
      const fixture = longHistoryFixture(id, title, events)
      const sessionId = await seedSession(world, fixture, id, undefined, { appendBatch: EVENTS_PER_FRAME })
      await workspace.attachSession(sessionId)
      return { id: sessionId, title, lastMessage: lastSummary(fixture) }
    }
    const base = await seed('switch-base', 'Switch base', 40)
    const targets: Target[] = []
    for (let index = 0; index < TARGETS * 2; index++) {
      targets.push(await seed(`switch-target-${String(index)}`, `Switch target ${String(index)}`, LONG_EVENTS + index))
    }
    const seedMs = Math.round(performance.now() - seedStarted)
    const sizes = await Promise.all(targets.map(async target => (await world.ctx.sessionPersistence.stat(target.id))?.sizeBytes ?? 0))
    const logMiB = Math.round(sizes.reduce((sum, size) => sum + size, 0) / targets.length / 2 ** 20)

    // One opening promotes each target; its idle eviction then writes the projection checkpoint a real cold open reads.
    const warmStarted = performance.now()
    for (const target of targets) {
      const opened = new AbortController()
      const frames = controller.follow({ address: { kind: 'session', sessionId: target.id }, assistantStream: true }, opened.signal)
      const iterator = frames[Symbol.asyncIterator]()
      await iterator.next()
      // Promotion starts once the opening frame's consumer asks for the next frame.
      const next = iterator.next()
      await expect.poll(() => world.ctx.agents.get(target.id) !== undefined, { timeout: 120_000 }).toBe(true)
      opened.abort()
      await next.catch((error: unknown) => {
        if (!opened.signal.aborted) throw error
      })
    }
    await expect.poll(() => targets.filter(target => world.ctx.agents.get(target.id) !== undefined).length,
      { timeout: 180_000, interval: 500 }).toBe(0)
    const warmMs = Math.round(performance.now() - warmStarted)

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    const inbound = countInbound(page)
    await page.addInitScript((current) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: current }))
      const state = { down: 0, longTasks: [] as number[] }
      document.addEventListener('pointerdown', (event) => { state.down = event.timeStamp }, { capture: true })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
      }).observe({ type: 'longtask', buffered: false })
      Reflect.set(window, '__dshSwitch', state)
    }, base.id)
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    try {
      await page.getByText(base.lastMessage).first().waitFor({ timeout: 60_000 })
      await page.getByRole('treeitem').filter({ hasText: base.title }).first().waitFor({ timeout: 60_000 })
    } catch (error) {
      await saveFailureShot(page, 'session-switch-open')
      throw error
    }
    const loop = monitorEventLoopDelay({ resolution: 5 })
    loop.enable()

    const row = async (target: Target): Promise<void> => {
      const item = page.getByRole('treeitem').filter({ hasText: target.title }).first()
      const overflow = page.locator('[data-row-key^="overflow:"]')
      if (!await item.isVisible() && await overflow.count() > 0) await overflow.first().click()
      try {
        await item.click({ timeout: 30_000 })
      } catch (error) {
        const rows = await page.getByRole('treeitem').allTextContents()
        throw new Error(`no sidebar row for ${target.title}; rows: ${JSON.stringify(rows.map(text => text.slice(0, 60)))}`, { cause: error })
      }
    }
    const cdp = PROFILE ? await page.context().newCDPSession(page) : undefined
    let profiled = false
    const switchTo = async (target: Target, label: string): Promise<object> => {
      await page.evaluate(() => { (Reflect.get(window, '__dshSwitch') as { longTasks: number[] }).longTasks.length = 0 })
      inbound()
      loop.reset()
      const residentBefore = world.ctx.agents.get(target.id) !== undefined
      const capture = cdp !== undefined && !profiled && label === 'loaded-cold'
        ? await captureRuntimeProfile(page, cdp, `session-switch-${String(LONG_EVENTS)}`)
        : undefined
      profiled ||= capture !== undefined
      // Resolves at the first animation frame after the press whose conversation column holds the target's last message.
      const shown = page.evaluate(async (needle) => {
        const state = Reflect.get(window, '__dshSwitch') as { down: number }
        const started = state.down
        while (state.down === started || !(document.querySelector('[data-chat-flow]')?.textContent ?? '').includes(needle)) {
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
        return performance.now() - state.down
      }, target.lastMessage)
      // The race below reports a failed wait; this keeps a page closed by an earlier failure from surfacing as unhandled.
      shown.catch(() => undefined)
      await row(target)
      let shownMs: number
      try {
        shownMs = await Promise.race([shown, delay(180_000).then(() => { throw new Error(`${label} switch to ${target.title} did not render`) })])
      } catch (error) {
        await saveFailureShot(page, `session-switch-${label}`)
        throw error
      }
      await capture?.stop()
      const page_ = await page.evaluate(() => {
        const longTasks = (Reflect.get(window, '__dshSwitch') as { longTasks: number[] }).longTasks
        const memory = Reflect.get(performance, 'memory') as { usedJSHeapSize: number } | undefined
        return {
          longTasks: longTasks.length,
          longTaskMs: Math.round(longTasks.reduce((sum, duration) => sum + duration, 0)),
          longestTaskMs: Math.round(Math.max(0, ...longTasks)),
          heapMiB: Math.round((memory?.usedJSHeapSize ?? 0) / 2 ** 20),
          domNodes: document.getElementsByTagName('*').length,
        }
      })
      return {
        label, target: target.title, residentBefore,
        running: world.ctx.agents.list().filter(agent => agent.status === 'running').length,
        shownMs: Math.round(shownMs), ...page_,
        hostLoopMs: { p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6) },
        inbound: inbound(),
      }
    }
    const phase = async (name: string, phaseTargets: readonly Target[]): Promise<object[]> => {
      const results: object[] = []
      for (const target of phaseTargets) {
        results.push(await switchTo(target, `${name}-cold`))
        results.push(await switchTo(base, `${name}-base`))
        results.push(await switchTo(target, `${name}-warm`))
        results.push(await switchTo(base, `${name}-base`))
      }
      for (const result of results) process.stdout.write(`SESSION_SWITCH ${JSON.stringify(result)}\n`)
      return results
    }

    const idle = await phase('idle', targets.slice(0, TARGETS))
    const roots: SessionId[] = []
    for (let index = 0; index < ROOTS; index++) roots.push((await controller.create({ cwd: world.workspaceCwd })).sessionId)
    let prompts = 0
    // Keeps every root busy: an idle root is prompted again until the loaded phase ends.
    const feeding = (async () => {
      while (!load.signal.aborted) {
        await Promise.all(roots.map(async (sessionId) => {
          const status = world.ctx.agents.get(sessionId)?.status
          if (status === 'running') return
          await controller.prompt({
            requestId: `switch-${String(prompts++)}` as SessionRequestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: `${ROUND_MARK} ${String(prompts)}: audit the workspace modules with helpers.` }],
          }, load.signal).catch((error: unknown) => {
            if (!load.signal.aborted) throw error
          })
        }))
        await delay(1000)
      }
    })()
    await expect.poll(() => world.ctx.agents.list().filter(agent => agent.status === 'running').length, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(Math.ceil(ROOTS * 0.75))
    const loaded = await phase('loaded', targets.slice(TARGETS))
    load.abort()
    await feeding
    loop.disable()

    process.stdout.write(`SESSION_SWITCH_SUMMARY ${JSON.stringify({
      roots: ROOTS, longEvents: LONG_EVENTS, logMiB, targets: TARGETS, forkPlugins: FORK_PLUGINS, seedMs, warmMs, prompts,
      idle: idle.length, loaded: loaded.length, model: adapter.counters.calls, pageErrors: tripwire.pageErrors.length,
    })}\n`)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    load.abort()
    await browser?.close()
    await world.close()
    await rm(configRoot, { recursive: true, force: true })
  }
}, 1_800_000)
