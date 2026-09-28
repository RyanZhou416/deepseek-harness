/** Real WebSocket loss without replacing Client plugins or navigating the page. */
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { chromium, type Browser, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

it.each([false, true])('retains the mounted application across WebSocket recovery with an active Session: %s', async (activeSession) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const title = 'Connection recovery session'
  const draft = 'Unsent draft retained across connection recovery'
  if (activeSession) {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
    const sessionId = await seedSession(scaffold, await readFile(seed, 'utf8'), 'connection-recovery-session')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title })
  }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery'))
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  let readyFrames = 0
  let sessionBaselines = 0
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
          && frame.value?.type === 'snapshot') sessionBaselines++
      }
      client.send(message)
    })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  if (activeSession) {
    await page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) }).click({ timeout: 20_000 })
    await writeComposerDraft(page, composer, draft)
    await expect.poll(() => sessionBaselines).toBeGreaterThan(0)
  } else {
    await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 20_000 })
  }
  await expect.poll(() => readyFrames).toBeGreaterThan(0)
  const root = await page.locator('[data-slot="root"]').elementHandle()
  expect(root).not.toBeNull()
  let navigations = 0
  page.on('framenavigated', () => { navigations++ })

  for (let attempt = 0; attempt < 3; attempt++) {
    const previousReady = readyFrames
    const previousBaseline = sessionBaselines
    const active = sockets.at(-1)!
    await Promise.all([
      active.client.close({ code: 1012, reason: 'test connection loss' }),
      active.server.close({ code: 1012, reason: 'test connection loss' }),
    ])
    await expect.poll(() => readyFrames, { timeout: 20_000 }).toBeGreaterThan(previousReady)
    if (activeSession) {
      await expect.poll(() => sessionBaselines, { timeout: 20_000 }).toBeGreaterThan(previousBaseline)
    }
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    expect(await root!.evaluate(element => element.isConnected)).toBe(true)
    expect(console.pageErrors).toEqual([])
    if (activeSession) expect(await composer.textContent()).toBe(draft)
  }

  expect(navigations).toBe(0)
  if (!activeSession) expect(await page.getByText('Into the Unknown', { exact: true }).isVisible()).toBe(true)
})

it('retains a cold sidebar title while list and control recovery baselines are released in order', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const owned: { browser?: Browser } = {}
  let releaseBarriers = (): void => {}
  onTestFinished(async () => {
    releaseBarriers()
    await owned.browser?.close()
    await scaffold.close()
  })
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
  const sessionId = await seedSession(scaffold, await readFile(seed, 'utf8'), 'connection-recovery-barriers')
  await workspace.attachSession(sessionId)
  const title = 'Recovery barrier title'
  await scaffold.ctx.sessionController.rename({ sessionId, title })

  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery-barriers'))

  let holdList = false
  let observedList = 0
  const listObserved = Promise.withResolvers<undefined>()
  const listRelease = Promise.withResolvers<undefined>()
  const listDelivered = Promise.withResolvers<undefined>()
  let holdControl = false
  const controlObserved = Promise.withResolvers<undefined>()
  const controlRelease = Promise.withResolvers<undefined>()
  releaseBarriers = () => {
    holdList = false
    holdControl = false
    listRelease.resolve(undefined)
    controlRelease.resolve(undefined)
  }
  await page.route('**/api/session/list', async (route) => {
    if (!holdList) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    try {
      observedList += 1
      listObserved.resolve(undefined)
      await listRelease.promise
      await route.fulfill({ response })
      listDelivered.resolve(undefined)
    } finally {
      await response.dispose()
    }
  })

  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  let readyFrames = 0
  let deliveredControlBaselines = 0
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    const server = client.connectToServer()
    sockets.push({ client, server })
    const endpoints = new Map<string, string>()
    let heldControlStream: string | undefined
    const pendingControl: (() => void)[] = []
    client.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; streamId: string; endpoint?: string }
        if (frame.type === 'open' && frame.endpoint !== undefined) endpoints.set(frame.streamId, frame.endpoint)
      }
      server.send(message)
    })
    server.onMessage((message) => {
      let controlBaseline = false
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; streamId: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'ready') readyFrames += 1
        controlBaseline = frame.type === 'item'
          && endpoints.get(frame.streamId) === 'session/control'
          && frame.value?.type === 'baseline'
        if (holdControl && (heldControlStream === frame.streamId || controlBaseline)) {
          if (controlBaseline && heldControlStream === undefined) {
            heldControlStream = frame.streamId
            controlObserved.resolve(undefined)
            void controlRelease.promise.then(() => {
              holdControl = false
              for (const send of pendingControl.splice(0)) send()
            })
          }
          pendingControl.push(() => {
            if (controlBaseline) deliveredControlBaselines += 1
            client.send(message)
          })
          return
        }
      }
      if (controlBaseline) deliveredControlBaselines += 1
      client.send(message)
    })
  })

  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 20_000 })
  const row = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
  await row.getByText(title, { exact: true }).waitFor({ timeout: 20_000 })
  await expect.poll(() => readyFrames).toBeGreaterThan(0)
  await expect.poll(() => deliveredControlBaselines).toBeGreaterThan(0)
  const previousReady = readyFrames
  const previousControl = deliveredControlBaselines
  const root = await page.locator('[data-slot="root"]').elementHandle()
  expect(root).not.toBeNull()
  let navigations = 0
  page.on('framenavigated', () => { navigations += 1 })

  holdList = true
  holdControl = true
  const active = sockets.at(-1)!
  await Promise.all([
    active.client.close({ code: 1012, reason: 'test delayed recovery' }),
    active.server.close({ code: 1012, reason: 'test delayed recovery' }),
  ])
  await Promise.all([listObserved.promise, controlObserved.promise])
  expect(observedList).toBeGreaterThan(0)
  expect(deliveredControlBaselines).toBe(previousControl)
  await expect.poll(() => row.textContent()).toContain(title)
  expect(await root!.evaluate(element => element.isConnected)).toBe(true)

  holdList = false
  listRelease.resolve(undefined)
  await listDelivered.promise
  await expect.poll(() => row.textContent()).toContain(title)
  expect(await root!.evaluate(element => element.isConnected)).toBe(true)

  controlRelease.resolve(undefined)
  await expect.poll(() => deliveredControlBaselines, { timeout: 20_000 }).toBeGreaterThan(previousControl)
  await expect.poll(() => readyFrames, { timeout: 20_000 }).toBeGreaterThan(previousReady)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  await expect.poll(() => row.textContent()).toContain(title)
  expect(await root!.evaluate(element => element.isConnected)).toBe(true)
  expect(navigations).toBe(0)
  expect(console.pageErrors).toEqual([])
})

it('keeps the loopback page connected when browser UI availability reports offline', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery-loopback-offline'))
  let sockets = 0
  let readyFrames = 0
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    sockets += 1
    const server = client.connectToServer()
    client.onMessage((message) => { server.send(message) })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'ready') readyFrames += 1
      }
      client.send(message)
    })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 20_000 })
  await expect.poll(() => readyFrames).toBeGreaterThan(0)
  const root = await page.locator('[data-slot="root"]').elementHandle()
  expect(root).not.toBeNull()
  const initialSockets = sockets
  const disconnected = page.getByRole('button', {
    name: 'Disconnected, reconnect now', exact: true,
  })

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    window.dispatchEvent(new Event('offline'))
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    })
  })
  expect(await page.evaluate(() => navigator.onLine)).toBe(false)
  expect(sockets).toBe(initialSockets)
  expect(await page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).status)).toBe(200)
  expect(await root!.evaluate(element => element.isConnected)).toBe(true)
  await expect.poll(() => disconnected.count()).toBe(0)
  expect(console.warnings).toEqual([])
  await expect.poll(() => page.getByText('Into the Unknown', { exact: true }).isVisible()).toBe(true)

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    window.dispatchEvent(new Event('online'))
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    })
  })
  expect(await page.evaluate(() => navigator.onLine)).toBe(true)
  expect(sockets).toBe(initialSockets)
  expect(await page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).status)).toBe(200)
  expect(await root!.evaluate(element => element.isConnected)).toBe(true)
  await expect.poll(() => disconnected.count()).toBe(0)
  expect(console.warnings).toEqual([])
  expect(console.pageErrors).toEqual([])
})
