/**
 * Real continuable children, persistence, WebSocket recovery and browser input.
 * The shipped scaffold resolves Host source and serves built Client assets;
 * only model output is synthetic. All state and listeners belong to its temp world.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type WebSocketRoute } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from '../tests/scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from '../tests/support.ts'

const CHILDREN = 8
const DELTAS = 256
const PACE_MS = 16
const PROVIDER = 'subagent-reconnect-test'
const PARENT_MODEL = 'reconnect-parent'
const TITLE = 'Concurrent children recovery'
const DRAFT = 'Unsent parent draft'
const TYPED = ' typed during child streams'

function childText(index: number, delta: number): string {
  return `CHILD_${String(index)}_PART_${String(delta).padStart(3, '0')} `
}

function expectedText(index: number): string {
  return Array.from({ length: DELTAS }, (_, delta) => childText(index, delta)).join('')
}

/** Fixed, independently paced streams with carrier-phase barriers and bounded output. */
class ConcurrentChildrenAdapter extends LlmAdapter {
  readonly counts = Array<number>(CHILDREN).fill(0)
  readonly calls = Array<number>(CHILDREN).fill(0)
  readonly start = Promise.withResolvers<void>()
  readonly disconnect = Promise.withResolvers<void>()
  readonly recovered = Promise.withResolvers<void>()
  readonly stopped = new AbortController()

  stop(): void {
    this.stopped.abort()
    this.start.resolve()
    this.disconnect.resolve()
    this.recovered.resolve()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.model === PARENT_MODEL) {
      const text = 'Parent acknowledgement.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const match = /^reconnect-child-([0-7])$/u.exec(options.model)
    if (match === null) throw new Error(`Unexpected synthetic model: ${options.model}`)
    const index = Number(match[1])
    this.calls[index] = (this.calls[index] ?? 0) + 1
    if (this.calls[index] !== 1) throw new Error('A reconnect restarted a child model request')
    const signal = options.signal === undefined
      ? this.stopped.signal
      : AbortSignal.any([options.signal, this.stopped.signal])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await this.start.promise
    for (let delta = 0; delta < DELTAS; delta++) {
      if (delta === DELTAS / 4) await this.disconnect.promise
      // Recovery can outlast the paced prefix without ending any child turn.
      if (delta === DELTAS / 2) await this.recovered.promise
      signal.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: childText(index, delta) }
      this.counts[index] = delta + 1
      await delay(PACE_MS, undefined, { signal })
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: expectedText(index) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('recovers a browser while eight continuable children stream without losing their durable results', async () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  const adapter = new ConcurrentChildrenAdapter()
  const cleanupErrors: unknown[] = []
  let testError: unknown
  try {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('../tests/pin-browse-picker.overlay.yml', import.meta.url)),
    })
    const world = scaffold
    world.ctx.effect(() => world.ctx.llm.registerAdapter([PROVIDER], adapter))
    await world.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: PARENT_MODEL })
    const starts: SessionId[] = []
    const ends: { id: SessionId; stopReason: string }[] = []
    world.ctx.on('subagent/start', (info) => { starts.push(info.id) })
    world.ctx.on('subagent/end', (info) => { ends.push({ id: info.id, stopReason: info.stopReason }) })

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
    let readyFrames = 0
    let followBaselines = 0
    await page.routeWebSocket('**/api/remote.mux', (client) => {
      const server = client.connectToServer()
      sockets.push({ client, server })
      const endpoints = new Map<string, string>()
      client.onMessage((message) => {
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as { type?: string; streamId: string; endpoint: string }
          if (frame.type === 'open') endpoints.set(frame.streamId, frame.endpoint)
        }
        server.send(message)
      })
      server.onMessage((message) => {
        if (typeof message === 'string') {
          const frame = JSON.parse(message) as { type?: string; streamId: string; value?: { type?: string } }
          if (frame.type === 'item' && frame.value?.type === 'ready') readyFrames++
          if (frame.type === 'item' && endpoints.get(frame.streamId) === 'session/follow'
            && frame.value?.type === 'snapshot') followBaselines++
        }
        client.send(message)
      })
    })
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, world.workspaceCwd)
    const parent = world.ctx.agents.roots()[0]
    if (parent === undefined) throw new Error('Workspace did not create a parent Agent')
    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    const initialSettled = world.whenTurnSettled()
    await writeComposerDraft(page, composer, 'Prepare the concurrent child test.')
    await composer.press('Enter')
    expect(await initialSettled).toBe(parent.id)
    await world.ctx.sessionController.rename({ sessionId: parent.id, title: TITLE })
    const title = page.getByRole('treeitem').filter({ has: page.getByText(TITLE, { exact: true }) })
    await title.waitFor({ timeout: 20_000 })

    const children = await Promise.all(Array.from({ length: CHILDREN }, (_, index) => world.ctx.subagents.startContinuable({
      provider: 'spawn', label: `Concurrent child ${String(index)}`, signal: adapter.stopped.signal,
      request: {
        parent, prompt: [{ type: 'text', text: `Generate the fixed child ${String(index)} stream.` }],
        agentOptions: { provider: PROVIDER, model: `reconnect-child-${String(index)}` },
      },
    })))
    const childIds = children.map(child => child.childId)
    expect(new Set(childIds).size).toBe(CHILDREN)
    await expect.poll(() => adapter.calls).toEqual(Array<number>(CHILDREN).fill(1))
    await page.getByRole('button', { name: '8 subagents running', exact: true }).hover()
    await page.getByRole('treeitem', { name: /Concurrent child 0/u })
      .getByRole('button', { name: 'Open Concurrent child 0 in sidebar', exact: true }).click()
    const sidebar = page.locator('[data-sidebar-chat]')
    await sidebar.waitFor()
    await writeComposerDraft(page, composer, DRAFT)
    adapter.start.resolve()
    await expect.poll(() => Math.min(...adapter.counts)).toBeGreaterThan(3)
    await expect.poll(() => sidebar.textContent()).toContain(childText(0, 0).trim())

    await composer.focus()
    await composer.evaluate((element) => {
      element.addEventListener('input', (event) => {
        element.setAttribute('data-stress-trusted-input', String(event.isTrusted))
      }, { once: true })
    })
    const inputStarted = performance.now()
    await composer.press('End')
    await composer.pressSequentially(TYPED)
    await expect.poll(() => composer.textContent()).toBe(DRAFT + TYPED)
    const inputMs = performance.now() - inputStarted
    expect(await composer.getAttribute('data-stress-trusted-input')).toBe('true')
    expect(childIds.every(id => world.ctx.agents.get(id)?.status === 'running')).toBe(true)

    const root = await page.locator('[data-slot="root"]').elementHandle()
    if (root === null) throw new Error('Application root is missing before disconnect')
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })
    const oldReady = readyFrames
    const oldBaselines = followBaselines
    const beforeDisconnect = [...adapter.counts]
    const socket = sockets.at(-1)
    if (socket === undefined) throw new Error('Browser has no observed WebSocket')
    const recoveryStarted = performance.now()
    adapter.disconnect.resolve()
    await Promise.all([
      socket.client.close({ code: 1012, reason: 'synthetic concurrent child reconnect' }),
      socket.server.close({ code: 1012, reason: 'synthetic concurrent child reconnect' }),
    ])
    await expect.poll(() => readyFrames, { timeout: 30_000 }).toBeGreaterThan(oldReady)
    await expect.poll(() => followBaselines, { timeout: 30_000 }).toBeGreaterThan(oldBaselines)
    await expect.poll(() => adapter.counts.every((count, index) => count > beforeDisconnect[index]!)).toBe(true)
    const recoveryMs = performance.now() - recoveryStarted
    const atRecovery = [...adapter.counts]
    expect(childIds.every(id => world.ctx.agents.get(id)?.status === 'running')).toBe(true)
    expect(await root.evaluate(element => element.isConnected)).toBe(true)
    expect(navigations).toBe(0)
    expect(await title.count()).toBe(1)
    expect(await composer.textContent()).toBe(DRAFT + TYPED)
    expect(starts.toSorted()).toEqual(childIds.toSorted())
    adapter.recovered.resolve()

    await expect.poll(() => ends.length, { timeout: 45_000 }).toBe(CHILDREN)
    await expect.poll(() => childIds.every(id => world.ctx.agents.get(id) === undefined), { timeout: 30_000 }).toBe(true)
    expect(ends.map(end => end.id).toSorted()).toEqual(childIds.toSorted())
    expect(ends.every(end => end.stopReason === 'completed')).toBe(true)
    expect(adapter.calls).toEqual(Array<number>(CHILDREN).fill(1))
    expect(adapter.counts).toEqual(Array<number>(CHILDREN).fill(DELTAS))
    await expect.poll(() => sidebar.textContent(), { timeout: 20_000 }).toContain(expectedText(0).trim())

    for (const [index, id] of childIds.entries()) {
      const handle = await world.ctx.sessionPersistence.open(id, 'read')
      try {
        const { events } = await handle.read()
        expect(events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
        expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
        const messages = events.filter(event => event.type === 'assistant/message')
        expect(messages).toHaveLength(1)
        expect(messages.flatMap(event => event.data.message.content)
          .flatMap(block => block.type === 'text' ? [block.text] : []).join('')).toBe(expectedText(index))
        expect(events.filter(event => event.type === 'user/message'
          && event.data.content.some(block => block.type === 'text'
            && block.text.startsWith(`Generate the fixed child ${String(index)} stream.`)))).toHaveLength(1)
      } finally {
        await handle.close()
      }
    }
    const parentHandle = await world.ctx.sessionPersistence.open(parent.id, 'read')
    try {
      const { events } = await parentHandle.read()
      expect(events.filter(event => event.type === 'subagent/catalog').map(event => event.data.childId).toSorted())
        .toEqual(childIds.toSorted())
    } finally {
      await parentHandle.close()
    }
    await page.locator('[data-sidebar-right-panel] [data-dockkit-tab-close]').click()
    await sidebar.waitFor({ state: 'detached' })
    expect(await composer.textContent()).toBe(DRAFT + TYPED)
    expect(console.pageErrors).toEqual([])
    process.stdout.write(`SUBAGENT_RECONNECT_STRESS ${JSON.stringify({
      children: CHILDREN, deltasPerChild: DELTAS, paceMs: PACE_MS,
      beforeDisconnect, atRecovery, inputMs, recoveryMs,
      childStarts: starts.length, childEnds: ends.length, modelCalls: adapter.calls,
      memory: 'No Host or browser retained-memory claim; this scenario checks behavior and reports endpoint timing.',
    })}\n`)
  } catch (error) {
    testError = error
    throw error
  } finally {
    adapter.stop()
    await browser?.close().catch((error: unknown) => cleanupErrors.push(error))
    await scaffold?.close().catch((error: unknown) => cleanupErrors.push(error))
    if (cleanupErrors.length > 0) {
      throw new AggregateError(testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        'Subagent reconnect scenario teardown failed')
    }
  }
})
