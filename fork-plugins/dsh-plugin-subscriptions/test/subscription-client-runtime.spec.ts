/**
 * Real composition of the two composer-dock client surfaces: the shared usage
 * badge and the Speed row mounted with React in a DOM, over the real cache, the
 * real model-selection source, and a scripted RPC face.
 *
 * The spec owns the facts a pure component test cannot see: which timers a
 * mounted surface registers (nothing while the panel is closed, one local
 * countdown while it is open, none after unmount) and which model each RPC
 * addresses (a switch re-reads the new model, a read a later choice superseded
 * never reaches the screen, and an explicit refresh stays scoped).
 *
 * jsdom is the declared DOM fixture for this tier; the spec imports it directly
 * so a missing fixture fails here instead of passing silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { useSyncExternalStore } from 'react'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// The components reach host primitives that ship CSS modules; Node needs only
// their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { SubscriptionUsageBadge } = await import('../src/client/SubscriptionUsageBadge.js')
const { SpeedSelect, createSpeedLoader, createSpeedSetter } = await import('../src/client/SpeedSelect.js')
const { createSubscriptionsCache } = await import('../src/client/subscriptions-cache.js')
css.deregister()
import type { ObservableSnapshot, SubscriptionsCache } from '../src/client/subscriptions-cache.js'
import type { ModelRef } from '../src/client/SpeedSelect.js'
import type { ProviderUsage } from '../src/client/SubscriptionsSection.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** One recorded endpoint call. */
interface Call {
  endpoint: string
  payload: Record<string, unknown>
}

/** A scripted `subscriptions-auth` face plus the observations the cases assert on. */
interface Scripted {
  rpc: ConnectionHandle['rpc']
  calls: Call[]
  usageCalls: () => Call[]
  statusCalls: () => number
  roster: (accounts: string[], provider: string) => void
  /** Add one provider's accounts to the roster without dropping the others. */
  addRoster: (accounts: string[], provider: string) => void
  answer: (usage: ProviderUsage) => void
  settle: () => Promise<void>
}

/** Build the scripted face; every usage read waits until `settle`. */
function scriptedUsage(): Scripted {
  const calls: Call[] = []
  let statusCalls = 0
  let roster: Record<string, unknown> = {}
  let pending: (() => void)[] = []
  let next: ProviderUsage = { supported: true, windows: [] }
  const providerStatus = (accounts: string[]): unknown => ({
    busy: false,
    accounts: accounts.map(key => ({ key, isDefault: key === accounts[0] })),
  })
  const rpc: ConnectionHandle['rpc'] = {
    call: (_channel, endpoint, payload) => {
      const body = payload as Record<string, unknown>
      if (endpoint === 'subscriptions-auth.status') {
        statusCalls += 1
        return Promise.resolve({ ok: true as const, value: { providers: roster } })
      }
      calls.push({ endpoint, payload: body })
      return new Promise((resolve) => {
        pending.push(() => resolve({ ok: true as const, value: next }))
      })
    },
  }
  return {
    rpc,
    calls,
    usageCalls: () => calls.filter(call => call.endpoint === 'subscriptions-auth.usage'),
    statusCalls: () => statusCalls,
    roster: (accounts, provider) => { roster = { [provider]: providerStatus(accounts) } },
    addRoster: (accounts, provider) => { roster = { ...roster, [provider]: providerStatus(accounts) } },
    answer: (usage) => { next = usage },
    settle: async () => {
      const waiting = pending
      pending = []
      for (const release of waiting) release()
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

/** A model-selection source the spec pushes through. */
interface PushedSource extends ObservableSnapshot<ModelRef | null> {
  push: (next: ModelRef | null) => void
}

/** Build the source plus its push. */
function modelSource(initial: ModelRef | null): PushedSource {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push: (next) => {
      current = next
      flushSync(() => { for (const listener of [...listeners]) listener() })
    },
  }
}

/** A selector hook over one source, as the renderer's own binding supplies it. */
function hookOver<T>(source: ObservableSnapshot<T>) {
  return <Selected,>(selector: (value: T) => Selected): Selected =>
    selector(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
}

/** Interval registrations captured for one case, so the spec can simulate elapsed time. */
interface Captured {
  /** Invoke every captured callback whose delay matches, `times` times. */
  fire: (delayMs: number, times: number) => void
  /** Delays of every interval still registered. */
  delays: () => number[]
  /** How many intervals are still registered. */
  live: () => number
  /** Restore the real timer functions. */
  restore: () => void
}

/**
 * Record every `setInterval` the mounted surface registers without faking the
 * clock: React's own scheduling keeps its real timers, and the spec invokes only
 * the captured callbacks it means to simulate.
 * @returns the captured registrations and their restoration.
 */
function captureIntervals(): Captured {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const live = new Map<number, { callback: () => void; delay: number }>()
  let handle = 0
  /** The patched timer face; the handle is a plain number the spec owns. */
  const patchedSet = (callback: () => void, delay?: number): number => {
    handle += 1
    live.set(handle, { callback, delay: delay ?? 0 })
    return handle
  }
  const patchedClear = (id?: number): void => {
    if (id !== undefined) live.delete(id)
  }
  Object.defineProperty(globalThis, 'setInterval', { value: patchedSet, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'clearInterval', { value: patchedClear, configurable: true, writable: true })
  return {
    delays: () => [...live.values()].map(entry => entry.delay),
    live: () => live.size,
    fire: (delayMs, times) => {
      for (const entry of [...live.values()]) {
        if (entry.delay !== delayMs) continue
        for (let index = 0; index < times; index++) flushSync(() => { entry.callback() })
      }
    },
    restore: () => {
      Object.defineProperty(globalThis, 'setInterval', { value: originalSet, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'clearInterval', { value: originalClear, configurable: true, writable: true })
    },
  }
}

/**
 * Install the jsdom globals the components and React reach for.
 * @param JSDOMClass - the jsdom constructor.
 * @returns the restoration of every global this call installed.
 */
function installDom(JSDOMClass: typeof JSDOM): () => void {
  const { window } = new JSDOMClass('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const names = [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ]
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const name of names) {
    const raw: unknown = window[name]
    if (raw === undefined) continue
    const value = typeof raw === 'function' ? (raw as (...args: never[]) => unknown).bind(window) : raw
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/** Render one element into a fresh container and return its unmount. */
function render(element: ReactElement): () => void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return () => {
    flushSync(() => { root.unmount() })
    container.remove()
  }
}

/** A cache over the scripted face with a codex account. */
function cacheOver(face: Scripted): SubscriptionsCache {
  face.roster(['default'], 'codex')
  face.answer({
    supported: true,
    windows: [{ kind: 'session', usedPercent: 25, resetsAt: Date.now() + 3_600_000 }],
    cache: { state: 'fresh', observedAt: Date.now() },
  })
  return createSubscriptionsCache(face.rpc)
}

/** The badge element over one cache and one model source. */
function badgeElement(face: Scripted, cache: SubscriptionsCache, model: PushedSource): ReactElement {
  return createElement(SubscriptionUsageBadge, {
    rpc: face.rpc,
    readStatus: () => cache.readStatus(),
    readUsage: (provider, account, mode) => cache.readUsage(provider, account, mode),
    readProvider: (provider, mode) => cache.readProvider(provider, mode),
    readAll: mode => cache.readAll(mode),
    useUsage: hookOver(cache.source),
    useModel: hookOver(model),
  })
}

/** Settle React's own microtask work and the scripted face. */
async function settle(next: () => Promise<void>): Promise<void> {
  await next()
  await new Promise(resolve => setImmediate(resolve))
}

const CODEX_MODEL: ModelRef = { provider: 'codex', model: 'gpt-5-codex' }

test('the badge reads the local snapshot on mount and registers no timer while collapsed', async () => {
  const restoreDom = installDom(JSDOM)
  const timers = captureIntervals()
  try {
    const face = scriptedUsage()
    const cache = cacheOver(face)
    const stop = render(badgeElement(face, cache, modelSource(CODEX_MODEL)))
    await settle(face.settle)
    // The mount read is the roster plus one local snapshot per listed account,
    // with no refresh key anywhere.
    assert.equal(face.statusCalls(), 1)
    assert.deepEqual(face.usageCalls().map(call => call.payload), [{ provider: 'codex', account: 'default' }])
    // Fifteen minutes of idle time: the collapsed surface owns no timer to fire.
    assert.deepEqual(timers.delays(), [])
    timers.fire(60_000, 15)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(face.usageCalls().length, 1, 'idle time issues no read')
    stop()
  } finally {
    timers.restore()
    restoreDom()
  }
})

test('a model push re-reads the new provider once, and the panel countdown stays local', async () => {
  const restoreDom = installDom(JSDOM)
  const timers = captureIntervals()
  try {
    const face = scriptedUsage()
    face.roster(['default'], 'claude')
    face.answer({ supported: true, windows: [{ kind: 'session', usedPercent: 10 }], cache: { state: 'fresh' } })
    const cache = createSubscriptionsCache(face.rpc)
    const model = modelSource(CODEX_MODEL)
    const stop = render(badgeElement(face, cache, model))
    await settle(face.settle)
    await settle(face.settle)
    const afterMount = face.usageCalls().length

    // The host's model-selection push is the only trigger: nothing polls for it.
    model.push({ provider: 'claude', model: 'claude-opus-5' })
    await settle(face.settle)
    assert.deepEqual(face.usageCalls().slice(afterMount).map(call => call.payload), [
      { provider: 'claude', account: 'default' },
    ])

    // Opening the panel registers the one local countdown, and firing it never reads.
    const panel = document.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement
    flushSync(() => { panel.click() })
    await settle(face.settle)
    const withPanel = face.usageCalls().length
    assert.deepEqual(timers.delays(), [60_000])
    timers.fire(60_000, 15)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(face.usageCalls().length, withPanel, 'the countdown is local only')
    stop()
    assert.equal(timers.live(), 0, 'unmount clears the countdown')
  } finally {
    timers.restore()
    restoreDom()
  }
})

test('opening the panel refreshes the current provider only, and never forces', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scriptedUsage()
    face.roster(['one', 'two'], 'codex')
    face.addRoster(['solo'], 'claude')
    const cache = createSubscriptionsCache(face.rpc)
    face.answer({ supported: true, windows: [{ kind: 'session', usedPercent: 40 }], cache: { state: 'fresh' } })
    const stop = render(badgeElement(face, cache, modelSource(CODEX_MODEL)))
    await settle(face.settle)
    await settle(face.settle)
    face.calls.length = 0

    const panel = document.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement
    flushSync(() => { panel.click() })
    await settle(face.settle)
    const payloads = face.usageCalls().map(call => call.payload)
    // Every provider is re-read from the local snapshot; only the current
    // provider's accounts carry the if-needed refresh, and nothing is forced.
    assert.deepEqual(payloads.filter(payload => payload.refresh === true), [
      { provider: 'codex', account: 'one', refresh: true },
      { provider: 'codex', account: 'two', refresh: true },
    ])
    assert.equal(payloads.some(payload => payload.force !== undefined), false)
    assert.deepEqual(new Set(payloads.filter(payload => payload.refresh === undefined).map(payload => payload.provider)), new Set(['codex', 'claude']))
    stop()
  } finally {
    restoreDom()
  }
})

test('a settled choice outranks a slow read, and every speed read names the model it addresses', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const seen: Call[] = []
    let release: (() => void) | undefined
    const rpc: ConnectionHandle['rpc'] = {
      call: (_channel, endpoint, payload) => {
        seen.push({ endpoint, payload: payload as Record<string, unknown> })
        if (endpoint === 'subscriptions-auth.setSpeed') {
          return Promise.resolve({ ok: true as const, value: { ok: true } })
        }
        return new Promise((resolve) => {
          release = () => resolve({
            ok: true as const,
            value: { tier: 'standard', fastModels: ['gpt-5-codex', 'claude-opus-5'] },
          })
        })
      },
    }
    const model = modelSource(CODEX_MODEL)
    const stop = render(createElement(SpeedSelect, {
      loadSpeed: createSpeedLoader(rpc),
      setSpeed: createSpeedSetter(rpc),
      useModel: hookOver(model),
    }))
    release?.()
    await settle(async () => {})
    assert.deepEqual(seen[0]?.payload, { provider: 'codex', model: 'gpt-5-codex' })
    const row = document.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement
    assert.ok(row.getAttribute('aria-label')?.includes('Standard'), 'the row shows the read tier')

    // A switch moves the row onto the new model, and the read addresses it.
    seen.length = 0
    model.push({ provider: 'codex', model: 'gpt-5.1-codex' })
    release?.()
    await settle(async () => {})
    assert.deepEqual(seen.map(call => call.payload), [{ provider: 'codex', model: 'gpt-5.1-codex' }])

    // Opening starts a slow read; the user's choice settles before it does, and
    // that superseded read must not put the replaced tier back on screen.
    flushSync(() => { row.click() })
    const fast = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
      .find(option => option.textContent?.includes('Fast')) as HTMLButtonElement
    flushSync(() => { fast.click() })
    await settle(async () => {})
    release?.()
    await settle(async () => {})
    assert.ok(document.querySelector('[aria-haspopup="menu"]')?.getAttribute('aria-label')?.includes('Fast'),
      'the settled choice survives the read it superseded')
    stop()
  } finally {
    restoreDom()
  }
})
