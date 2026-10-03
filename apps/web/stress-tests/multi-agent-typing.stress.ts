/**
 * Composer typing latency while many Agents stream, under the shared synthetic
 * workload (`workload.ts`). The real Host, Gateway and built Client run in one
 * temp world; roots seeded with long history and fresh roots fan out
 * continuable children while a Chromium page types into a long Session's
 * composer. Each phase reports browser Event Timing for key events (input
 * delay plus processing plus presentation), long tasks, Host event-loop delay,
 * inbound WebSocket frames and page heap. Timings are reported, not asserted.
 *
 * Knobs (environment), beside the workload knobs:
 * - DSH_STRESS_ROOTS: concurrent root Sessions (default 12).
 * - DSH_STRESS_LONG_ROOTS: how many of them are seeded with long history (default 4).
 * - DSH_STRESS_LONG_EVENTS: events per seeded root (default 4000).
 * - DSH_STRESS_IDLE_SESSIONS: closed short Sessions attached to the workspace (default 0).
 * - DSH_STRESS_TYPE_CHARS: characters typed per phase (default 80).
 * - DSH_STRESS_TYPE_DELAY_MS: delay between keys (default 60).
 * - DSH_STRESS_PROFILE: `1` saves browser and Host CPU profiles of the loaded phase under tmp/runtime-profiles.
 * - DSH_STRESS_DROP_MODES: comma-separated entry paths compared for lost
 *   characters after each phase (default `keys0,keys15,ime,send-type,click-insert`).
 * - DSH_STRESS_PAGE_JANK_MS: when positive, the page main thread blocks for up
 *   to this long every 0.3–1 s while those paths type.
 * - DSH_STRESS_TYPING_ROUNDS: prompt rounds on the same open page (default 1);
 *   each later round re-prompts every root, then measures and runs the paths.
 * - DSH_STRESS_BROWSER_PATH: Chromium-based browser executable to drive
 *   instead of Playwright's Chromium (always a fresh temporary profile).
 * - DSH_STRESS_PAGE_PROBE: path of a console script evaluated in the page after
 *   load; its `window.__dshTypingProbe.report()` is printed at the end.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type CDPSession, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from '../tests/scaffold.ts'
import { captureRuntimeProfile } from '../tests/runtime-profile.ts'
import { newEnglishPage, saveFailureShot } from '../tests/support.ts'
import {
  FORK_PLUGINS, PROVIDER, ROOT_MODEL, ROUND_MARK, WorkloadAdapter, forkProfile, longHistoryFixture, positive,
  seedWorkspace, writeWorkloadOverlay,
} from './workload.ts'

process.env.DSH_STRESS_PACE_MS ??= '20'
const ROOTS = Math.max(1, positive('DSH_STRESS_ROOTS', 12))
const LONG_ROOTS = Math.min(ROOTS, positive('DSH_STRESS_LONG_ROOTS', 4))
const LONG_EVENTS = Math.max(100, positive('DSH_STRESS_LONG_EVENTS', 4000))
const IDLE_SESSIONS = positive('DSH_STRESS_IDLE_SESSIONS', 0)
const TYPE_CHARS = Math.max(1, positive('DSH_STRESS_TYPE_CHARS', 80))
const TYPE_DELAY_MS = positive('DSH_STRESS_TYPE_DELAY_MS', 60)
const PROFILE = process.env.DSH_STRESS_PROFILE === '1'
const IDLE_RETENTION_MS = 300_000

interface PagePhase {
  keys: number
  slowKeys: number
  durations: number[]
  inputDelays: number[]
  echoes: number[]
  longTasks: number
  longTaskMs: number
  heapMiB: number
  domNodes: number
}

/** Install page observers once; each phase reads and resets them. */
async function installObservers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = {
      durations: [] as number[], inputDelays: [] as number[], echoes: [] as number[], keys: 0, longTasks: 0, longTaskMs: 0,
      pending: [] as { at: number; length: number }[],
    }
    Reflect.set(window, '__dshTyping', state)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (!['keydown', 'keypress', 'keyup', 'beforeinput', 'input'].includes(entry.name)) continue
        state.durations.push(entry.duration)
        state.inputDelays.push(entry.processingStart - entry.startTime)
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks++
        state.longTaskMs += entry.duration
      }
    }).observe({ type: 'longtask', buffered: false })
    // Echo latency: keydown timestamp until the first animation frame whose
    // focused editor text already contains that character.
    const length = (element: Element | null): number => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value.length
      : element?.textContent.length ?? 0
    const pending = state.pending
    const settle = (): void => {
      const now = performance.now()
      const current = length(document.activeElement)
      while (pending.length > 0 && pending[0]!.length <= current) state.echoes.push(now - pending.shift()!.at)
      if (pending.length > 0) requestAnimationFrame(settle)
    }
    document.addEventListener('keydown', (event) => {
      state.keys++
      if (event.key.length !== 1) {
        pending.length = 0
        return
      }
      const base = pending.at(-1)?.length ?? length(document.activeElement)
      if (pending.length === 0) requestAnimationFrame(settle)
      pending.push({ at: event.timeStamp, length: base + 1 })
    }, { capture: true })
  })
}

async function readPhase(page: Page): Promise<PagePhase> {
  return await page.evaluate(() => {
    const state = Reflect.get(window, '__dshTyping') as {
      durations: number[]
      inputDelays: number[]
      echoes: number[]
      keys: number
      longTasks: number
      longTaskMs: number
      pending: unknown[]
    }
    const memory = Reflect.get(performance, 'memory') as { usedJSHeapSize: number } | undefined
    const result = {
      keys: state.keys,
      slowKeys: state.durations.filter(duration => duration >= 100).length,
      durations: [...state.durations],
      inputDelays: [...state.inputDelays],
      echoes: [...state.echoes],
      longTasks: state.longTasks,
      longTaskMs: Math.round(state.longTaskMs),
      heapMiB: Math.round((memory?.usedJSHeapSize ?? 0) / 2 ** 20),
      domNodes: document.getElementsByTagName('*').length,
    }
    state.durations.length = 0
    state.inputDelays.length = 0
    state.echoes.length = 0
    state.pending.length = 0
    state.keys = 0
    state.longTasks = 0
    state.longTaskMs = 0
    return result
  })
}

const DROP_MODES = (process.env.DSH_STRESS_DROP_MODES ?? 'keys0,keys15,ime,send-type,click-insert').split(',').filter(mode => mode !== '')
const PAGE_JANK_MS = positive('DSH_STRESS_PAGE_JANK_MS', 0)
const TYPING_ROUNDS = Math.max(1, positive('DSH_STRESS_TYPING_ROUNDS', 1))
const BROWSER_PATH = process.env.DSH_STRESS_BROWSER_PATH
const PAGE_PROBE = process.env.DSH_STRESS_PAGE_PROBE

const IME_WORDS: readonly (readonly [string, string])[] = [
  ['测试', 'ceshi'], ['中文', 'zhongwen'], ['输入', 'shuru'], ['吞字', 'tunzi'], ['问题', 'wenti'],
  ['多个', 'duoge'], ['代理', 'daili'], ['同时', 'tongshi'], ['运行', 'yunxing'], ['前端', 'qianduan'],
]

interface DropResult { mode: string; expected: number; actual: number; lost: number; firstMismatch: number | null; tail: string }

/** Viewport point at the centre of the composer character at `offset`, or null when absent. */
async function characterPoint(composer: Locator, offset: number): Promise<{ x: number; y: number } | null> {
  return await composer.evaluate((root, target) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let remaining = target
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining < length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.setEnd(node, remaining + 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + 0.5, y: rect.top + rect.height / 2 }
      }
      remaining -= length
    }
    return null
  }, offset)
}

/**
 * Type one probe through a realistic entry path and compare the composer text
 * with what was entered. `send-type` sends one message and immediately keeps
 * typing the next one, the window in which a committed draft is cleared.
 * `reconnect` clicks into the middle of a draft, starts typing, and drops the
 * Remote WebSocket while the keys are still arriving.
 */
async function typeAndCompare(
  page: Page, cdp: CDPSession, composer: Locator, mode: string, sever?: () => Promise<void>,
  stall?: { hold: () => Promise<void>; release: () => Promise<void>; bursts: () => Promise<readonly number[]> },
): Promise<DropResult> {
  await composer.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect.poll(() => composer.textContent(), { timeout: 30_000, interval: 16 }).toBe('')
  let expected = ''
  switch (mode) {
    case 'keys0':
    case 'keys15': {
      expected = `${mode} the quick brown fox jumps over the lazy dog 0123456789 `.repeat(2)
      await composer.pressSequentially(expected, { delay: mode === 'keys0' ? 0 : 15 })
      break
    }
    case 'ime': {
      for (const [word, pinyin] of [...IME_WORDS, ...IME_WORDS]) {
        for (let index = 1; index <= pinyin.length; index++) {
          await cdp.send('Input.imeSetComposition', { text: pinyin.slice(0, index), selectionStart: index, selectionEnd: index })
          await delay(15)
        }
        await cdp.send('Input.insertText', { text: word })
        expected += word
        await delay(30)
      }
      break
    }
    case 'click-insert': {
      // Click before a character in the middle of existing text, then type.
      // A caret that the click did not move, or that something moved back,
      // puts the insert elsewhere (usually at the end).
      const left = 'left part of an existing draft '
      const right = 'right part of the same draft'
      const insert = 'INS'
      let failures = 0
      let atEnd = 0
      let caretMoves = 0
      const rounds = 12
      for (let round = 0; round < rounds; round++) {
        await composer.focus()
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.press('Backspace')
        await composer.pressSequentially(left + right, { delay: 0 })
        await expect.poll(() => composer.textContent(), { timeout: 30_000, interval: 16 }).toBe(left + right)
        const point = await characterPoint(composer, left.length)
        if (point === null) throw new Error('click-insert: target character not found')
        await page.mouse.click(point.x, point.y)
        // Watch the caret between the click and the first key.
        const moved = await page.evaluate(async (waitMs) => {
          const offsetOf = (): number => {
            const selection = getSelection()
            if (selection === null || selection.rangeCount === 0) return -1
            const range = selection.getRangeAt(0).cloneRange()
            const editor = document.querySelector('[data-composer-input]')
            if (editor === null) return -1
            range.setStart(editor, 0)
            return range.toString().length
          }
          const first = offsetOf()
          const until = performance.now() + waitMs
          let changed = false
          while (performance.now() < until) {
            await new Promise(resolve => requestAnimationFrame(resolve))
            if (offsetOf() !== first) changed = true
          }
          return { first, last: offsetOf(), changed }
        }, Math.round(Math.random() * 300))
        if (moved.changed) caretMoves++
        await composer.pressSequentially(insert, { delay: 15 })
        await delay(300)
        const actual = await composer.textContent() ?? ''
        if (actual !== left + insert + right) {
          failures++
          if (actual === left + right + insert) atEnd++
        }
      }
      return {
        mode, expected: rounds, actual: rounds - failures, lost: failures, firstMismatch: null,
        tail: `misplaced=${String(failures)}/${String(rounds)} atEnd=${String(atEnd)} caretMovedBeforeTyping=${String(caretMoves)}`,
      }
    }
    case 'reconnect': {
      if (sever === undefined) throw new Error('reconnect mode needs the routed Remote WebSocket')
      const left = 'left part of an existing draft '
      const right = 'right part of the same draft'
      const insert = 'typed across a dropped connection '
      const rounds = 8
      let exact = 0
      let atEnd = 0
      let lostChars = 0
      let editorReadOnly = 0
      const samples: string[] = []
      for (let round = 0; round < rounds; round++) {
        await composer.focus()
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.press('Backspace')
        await composer.pressSequentially(left + right, { delay: 0 })
        await expect.poll(() => composer.textContent(), { timeout: 30_000, interval: 16 }).toBe(left + right)
        const point = await characterPoint(composer, left.length)
        if (point === null) throw new Error('reconnect: target character not found')
        await page.mouse.click(point.x, point.y)
        await delay(100)
        // page.keyboard types into whatever holds focus, as a person does; no refocus.
        const typing = page.keyboard.type(insert, { delay: 40 })
        await delay(Math.random() * 600)
        await sever()
        const readOnly = await page.evaluate(() => document.querySelector('[data-composer-input]')?.getAttribute('contenteditable') !== 'true')
        if (readOnly) editorReadOnly++
        await typing
        await delay(2500)
        const actual = await composer.textContent() ?? ''
        if (actual === left + insert + right) exact++
        else {
          if (actual.startsWith(left + right)) atEnd++
          lostChars += Math.max(0, left.length + insert.length + right.length - actual.length)
          if (samples.length < 3) samples.push(JSON.stringify(actual))
        }
      }
      return {
        mode, expected: rounds, actual: exact, lost: rounds - exact, firstMismatch: null,
        tail: `exact=${String(exact)}/${String(rounds)} atEnd=${String(atEnd)} lostChars=${String(lostChars)} readOnlyRightAfterDrop=${String(editorReadOnly)} ${samples.join(' | ')}`,
      }
    }
    case 'stall': {
      // Host frames are held for a few seconds, then delivered at once; the
      // click and the typing land around the moment the backlog arrives.
      if (stall === undefined) throw new Error('stall mode needs the routed Remote WebSocket')
      const left = 'left part of an existing draft '
      const right = 'right part of the same draft'
      const insert = 'typed while the backlog lands '
      const rounds = 8
      let exact = 0
      let atEnd = 0
      let lostChars = 0
      const longest: number[] = []
      const samples: string[] = []
      const readOnlyAfterBurst: string[] = []
      for (let round = 0; round < rounds; round++) {
        await composer.focus()
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.press('Backspace')
        await composer.pressSequentially(left + right, { delay: 0 })
        await expect.poll(() => composer.textContent(), { timeout: 30_000, interval: 16 }).toBe(left + right)
        await page.evaluate(() => {
          const state = { max: 0 }
          Reflect.set(window, '__dshStallLongest', state)
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) state.max = Math.max(state.max, entry.duration)
          }).observe({ type: 'longtask' })
        })
        await stall.hold()
        await delay(3000 + Math.random() * 7000)
        const point = await characterPoint(composer, left.length)
        if (point === null) throw new Error('stall: target character not found')
        // The backlog lands up to 300 ms before or after the click.
        const lead = Math.random() * 600 - 300
        let released: Promise<void> = Promise.resolve()
        if (lead < 0) {
          await stall.release()
          await delay(-lead)
        } else {
          released = delay(lead).then(() => stall.release())
        }
        await page.mouse.click(point.x, point.y)
        await page.keyboard.type(insert, { delay: 40 })
        await released
        await delay(2500)
        longest.push(Math.round(await page.evaluate(() => (Reflect.get(window, '__dshStallLongest') as { max: number }).max)))
        const inputState = (): Promise<string> => page.evaluate(() => JSON.stringify([...document.querySelectorAll('[data-composer-input]')].map(element => ({
          editable: element.getAttribute('contenteditable'), phase: element.getAttribute('data-phase'),
          disabled: element.getAttribute('aria-disabled'), length: element.textContent?.length ?? 0,
        }))))
        if (await page.locator('[data-composer-input][contenteditable="true"]').count() === 0) {
          const stuck = await inputState()
          const since = performance.now()
          await saveFailureShot(page, `multi-agent-typing-stall-${String(round)}`)
          const recovered = await composer.waitFor({ timeout: 120_000 }).then(() => true, () => false)
          readOnlyAfterBurst.push(`${stuck}→${recovered ? `${String(Math.round(performance.now() - since))}ms` : 'never'} now ${await inputState()}`)
          if (!recovered) break
        }
        const actual = await composer.textContent() ?? ''
        if (actual === left + insert + right) exact++
        else {
          if (actual.startsWith(left + right)) atEnd++
          lostChars += Math.max(0, left.length + insert.length + right.length - actual.length)
          if (samples.length < 3) samples.push(JSON.stringify(actual))
        }
      }
      const bursts = (await stall.bursts()).slice(-rounds)
      return {
        mode, expected: rounds, actual: exact, lost: rounds - exact, firstMismatch: null,
        tail: `exact=${String(exact)}/${String(rounds)} atEnd=${String(atEnd)} lostChars=${String(lostChars)} burstFrames=${bursts.join('/')} longestTaskMs=${longest.join('/')} readOnlyAfterBurst=${JSON.stringify(readOnlyAfterBurst)} ${samples.join(' | ')}`,
      }
    }
    case 'send-type': {
      await composer.pressSequentially(`${ROUND_MARK} probe: summarize module 01.`, { delay: 0 })
      await page.keyboard.press('Enter')
      expected = 'next message typed while the previous send is committing '.repeat(2)
      await composer.pressSequentially(expected, { delay: 15 })
      break
    }
    default: throw new Error(`unknown typing mode ${mode}`)
  }
  // Let late editor commits land before comparing.
  await delay(1500)
  const actual = await composer.textContent() ?? ''
  let firstMismatch: number | null = null
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    if (expected[index] !== actual[index]) {
      firstMismatch = index
      break
    }
  }
  return {
    mode, expected: expected.length, actual: actual.length, lost: expected.length - actual.length, firstMismatch,
    tail: firstMismatch === null ? '' : `expected …${expected.slice(Math.max(0, firstMismatch - 8), firstMismatch + 16)}… got …${actual.slice(Math.max(0, firstMismatch - 8), firstMismatch + 16)}…`,
  }
}

function percentiles(values: readonly number[]): { n: number; p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0)
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0) }
}

/** Inbound WebSocket frame counter for the page's multiplexed Host connection. */
function countFrames(page: Page): { take: () => { frames: number; kib: number } } {
  let frames = 0
  let bytes = 0
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      frames++
      bytes += typeof payload === 'string' ? payload.length : payload.byteLength
    })
  })
  return {
    take: () => {
      const result = { frames, kib: Math.round(bytes / 1024) }
      frames = 0
      bytes = 0
      return result
    },
  }
}

it('reports composer typing latency while many Agents stream', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'dsh-typing-stress-'))
  const overlay = await writeWorkloadOverlay(configRoot, IDLE_RETENTION_MS)
  const profile = forkProfile()
  let world: WebScaffold | undefined
  let browser: Browser | undefined
  const load = new AbortController()
  try {
    world = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('../tests/pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      ...profile === undefined ? {} : { profile },
    })
    const scaffold = world
    await seedWorkspace(scaffold.workspaceCwd)
    const adapter = new WorkloadAdapter(scaffold.workspaceCwd)
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter))
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: ROOT_MODEL })
    const controller = scaffold.ctx.sessionController
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const roots: SessionId[] = []
    const seedStarted = performance.now()
    for (let index = 0; index < ROOTS; index++) {
      if (index < LONG_ROOTS) {
        const id = `stress-long-${String(index)}`
        const sessionId = await seedSession(scaffold, longHistoryFixture(id, `Stress long ${String(index)}`, LONG_EVENTS), id)
        await workspace.attachSession(sessionId)
        roots.push(sessionId)
      } else {
        roots.push((await controller.create({ cwd: scaffold.workspaceCwd })).sessionId)
      }
    }
    for (let batch = 0; batch < IDLE_SESSIONS; batch += 32) {
      await Promise.all(Array.from({ length: Math.min(32, IDLE_SESSIONS - batch) }, async (_, offset) => {
        const id = `stress-idle-${String(batch + offset)}`
        await workspace.attachSession(await seedSession(scaffold, longHistoryFixture(id, `Stress idle ${String(batch + offset)}`, 40), id))
      }))
    }
    const seedMs = Math.round(performance.now() - seedStarted)

    browser = await chromium.launch(BROWSER_PATH === undefined
      ? {}
      : { executablePath: BROWSER_PATH, headless: false, args: ['--headless=new'] })
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    const frames = countFrames(page)
    await page.addInitScript(({ account, current }) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: current }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace', orderBy: 'updated', groupExpansion: { [account]: true } }))
    }, { account: workspace.id, current: roots[0] })
    // Connection faults are injected inside the page: routing every frame
    // through Playwright would add per-frame work to the test process, which
    // also runs the Host. While held, inbound frames queue as they do behind a
    // stalled Host event loop, then arrive as one burst; sever closes the
    // current socket from the client side.
    await page.addInitScript(() => {
      const Native = window.WebSocket
      const state = { hold: false, queue: [] as { socket: WebSocket; data: unknown }[], bursts: [] as number[], sockets: [] as WebSocket[] }
      const replayed = new WeakSet<Event>()
      Reflect.set(window, '__dshWs', state)
      window.WebSocket = class extends Native {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args)
          state.sockets.push(this)
          this.addEventListener('message', (event) => {
            if (!state.hold || replayed.has(event)) return
            event.stopImmediatePropagation()
            state.queue.push({ socket: this, data: event.data })
          })
        }
      }
      // The browser delivers each received frame as its own task, so input can
      // interleave with a backlog; the replay keeps one task per frame.
      const channel = new MessageChannel()
      const pending: { socket: WebSocket; data: unknown }[] = []
      channel.port1.onmessage = () => {
        const next = pending.shift()
        if (next === undefined) return
        const event = new MessageEvent('message', { data: next.data })
        replayed.add(event)
        next.socket.dispatchEvent(event)
      }
      Reflect.set(window, '__dshWsRelease', () => {
        state.hold = false
        const queued = state.queue.splice(0)
        state.bursts.push(queued.length)
        for (const frame of queued) {
          pending.push(frame)
          channel.port2.postMessage(null)
        }
      })
    })
    const sever = async (): Promise<void> => {
      const before = await page.evaluate(() => {
        const state = Reflect.get(window, '__dshWs') as { sockets: WebSocket[] }
        state.sockets.at(-1)?.close(4000, 'stress connection loss')
        return state.sockets.length
      })
      void expect.poll(() => page.evaluate(() => (Reflect.get(window, '__dshWs') as { sockets: WebSocket[] }).sockets.length), { timeout: 30_000 })
        .toBeGreaterThan(before).catch((error: unknown) => { process.stdout.write(`TYPING_RECONNECT_MISSING ${String(error)}\n`) })
    }
    const stall = {
      hold: () => page.evaluate(() => { (Reflect.get(window, '__dshWs') as { hold: boolean }).hold = true }),
      release: () => page.evaluate(() => { (Reflect.get(window, '__dshWsRelease') as () => void)() }),
      bursts: () => page.evaluate(() => (Reflect.get(window, '__dshWs') as { bursts: number[] }).bursts),
    }
    const openStarted = performance.now()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    try {
      await composer.waitFor({ timeout: 60_000 })
    } catch (error) {
      await saveFailureShot(page, 'multi-agent-typing-open')
      throw error
    }
    const openLongMs = Math.round(performance.now() - openStarted)
    await installObservers(page)
    if (PAGE_PROBE !== undefined) await page.evaluate(await readFile(PAGE_PROBE, 'utf8'))
    const loop = monitorEventLoopDelay({ resolution: 5 })
    loop.enable()

    const typed: string[] = []
    const phase = async (label: string): Promise<object> => {
      const running = (): number => scaffold.ctx.agents.list().filter(agent => agent.status === 'running').length
      await readPhase(page)
      frames.take()
      loop.reset()
      const runningAtStart = running()
      const text = `${label} typing probe `.padEnd(TYPE_CHARS, 'x').slice(0, TYPE_CHARS)
      typed.push(text)
      const started = performance.now()
      await composer.focus()
      await page.keyboard.press('End')
      await composer.pressSequentially(text, { delay: TYPE_DELAY_MS })
      const typedMs = performance.now() - started
      await expect.poll(() => composer.textContent(), { timeout: 60_000, interval: 16 }).toBe(typed.join(''))
      const echoMs = Math.round(performance.now() - started - typedMs)
      const result = await readPhase(page)
      return {
        label,
        runningAtStart,
        runningAtEnd: running(),
        keys: result.keys,
        keysOver100ms: result.slowKeys,
        eventDurationMs: percentiles(result.durations),
        inputDelayMs: percentiles(result.inputDelays),
        echoMs: percentiles(result.echoes),
        trailingEchoMs: echoMs,
        longTasks: result.longTasks,
        longTaskMs: result.longTaskMs,
        hostLoopMs: {
          p50: Math.round(loop.percentile(50) / 1e6), p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6),
        },
        inbound: frames.take(),
        pageHeapMiB: result.heapMiB,
        domNodes: result.domNodes,
      }
    }

    const dropCdp = await page.context().newCDPSession(page)
    const drops: Record<string, DropResult[]> = {}
    const battery = async (label: string): Promise<void> => {
      const runningAtStart = scaffold.ctx.agents.list().filter(agent => agent.status === 'running').length
      const results: DropResult[] = []
      if (PAGE_JANK_MS > 0) {
        await page.evaluate((jankMs) => {
          const tick = (): void => {
            const until = performance.now() + jankMs * (0.3 + 0.7 * Math.random())
            while (performance.now() < until) { /* busy main thread */ }
            Reflect.set(window, '__dshJank', setTimeout(tick, 300 + Math.random() * 700))
          }
          Reflect.set(window, '__dshJank', setTimeout(tick, 100))
        }, PAGE_JANK_MS)
      }
      for (const mode of DROP_MODES) results.push(await typeAndCompare(page, dropCdp, composer, mode, sever, stall))
      if (PAGE_JANK_MS > 0) await page.evaluate(() => { clearTimeout(Reflect.get(window, '__dshJank') as number) })
      drops[`${label} (running ${String(runningAtStart)})`] = results
      await composer.focus()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.press('Backspace')
      await expect.poll(() => composer.textContent(), { timeout: 30_000, interval: 16 }).toBe('')
      typed.length = 0
    }

    const idle = await phase('idle')
    await battery('idle')
    const prompting = Promise.all(roots.map((sessionId, index) => controller.prompt({
      requestId: `typing-${String(index)}` as SessionRequestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `${ROUND_MARK} 0: audit the workspace modules with helpers.` }],
    }, load.signal)))
    await prompting
    await expect.poll(() => scaffold.ctx.agents.list().filter(agent => agent.status === 'running').length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(Math.ceil(ROOTS / 2))
    const cdp = PROFILE ? await page.context().newCDPSession(page) : undefined
    const capture = cdp === undefined ? undefined : await captureRuntimeProfile(page, cdp, `multi-agent-typing-${String(ROOTS)}`)
    const loaded = await phase('loaded')
    await capture?.stop()
    await battery('loaded')
    const loadedAgain = await phase('loaded-2')
    await battery('loaded-2')
    const soak: object[] = []
    for (let round = 1; round < TYPING_ROUNDS; round++) {
      await Promise.all(roots.map((sessionId, index) => controller.prompt({
        requestId: `typing-${String(round)}-${String(index)}` as SessionRequestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `${ROUND_MARK} ${String(round)}: audit the workspace modules with helpers.` }],
      }, load.signal)))
      await expect.poll(() => scaffold.ctx.agents.list().filter(agent => agent.status === 'running').length, { timeout: 120_000 })
        .toBeGreaterThanOrEqual(Math.ceil(ROOTS / 2))
      const result = await phase(`round-${String(round)}`)
      await battery(`round-${String(round)}`)
      soak.push(result)
      process.stdout.write(`TYPING_ROUND ${JSON.stringify(result)}\n`)
    }
    loop.disable()
    const summary = {
      roots: ROOTS, longRoots: LONG_ROOTS, longEvents: LONG_EVENTS, idleSessions: IDLE_SESSIONS, forkPlugins: FORK_PLUGINS,
      seedMs, openLongMs,
      typeDelayMs: TYPE_DELAY_MS, phases: [idle, loaded, loadedAgain, ...soak], drops, model: adapter.counters,
      pageErrors: tripwire.pageErrors.length,
    }
    process.stdout.write(`TYPING_STRESS ${JSON.stringify(summary)}\n`)
    if (PAGE_PROBE !== undefined) {
      process.stdout.write(`TYPING_PAGE_PROBE ${await page.evaluate('window.__dshTypingProbe.report()') as string}\n`)
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    load.abort()
    await browser?.close()
    await world?.close()
    await rm(configRoot, { recursive: true, force: true })
  }
}, 600_000 + IDLE_SESSIONS * 250 + TYPING_ROUNDS * 180_000)
