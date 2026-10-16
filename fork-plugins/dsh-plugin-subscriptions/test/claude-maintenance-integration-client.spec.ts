/**
 * The client half of the account-status projection: one localized line per
 * reported dimension, a re-login that never reads as a quota cooldown, a
 * provider failure rendered from its fixed code, and a composer badge that
 * states only what takes an account out of service.
 *
 * The component cases mount the real badge over the real shared cache in
 * jsdom, so the rendered copy is observed rather than assumed. jsdom is the
 * declared DOM fixture for this tier; the spec imports it directly so a
 * missing fixture fails here instead of passing silently.
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
const { createSubscriptionsCache } = await import('../src/client/subscriptions-cache.js')
css.deregister()
import { accountStateLines, providerFailureLine } from '../src/client/SubscriptionsSection.js'
import type { AccountStatus } from '../src/client/SubscriptionsSection.js'
import type { ObservableSnapshot, SubscriptionsCache } from '../src/client/subscriptions-cache.js'
import { errorLine, withActionError, withPollError } from '../src/client/provider-errors.js'
import { formatDateTime } from '../src/client/format.js'
import { en, zh } from '../src/client/locales.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<keyof typeof en, string>) {
  return (key: keyof typeof en, params?: Record<string, unknown>): string =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

const enT = translateFrom(en)
const zhT = translateFrom(zh)

/** One account whose every dimension is nominal. */
function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return { key: 'acct', isDefault: true, credential: { state: 'ready' }, ...overrides }
}

test('a re-login and a quota cooldown are different lines, in both languages', () => {
  const reauth = accountStateLines(account({ credential: { state: 'reauth_required', code: 'REAUTH_REQUIRED' } }), enT)
  assert.deepEqual(reauth, [{ text: en.accountStateReauth, tone: 'warn' }])
  assert.equal(reauth[0]!.text.includes(en.accountStateCoolingUnknown), false)

  const cooling = accountStateLines(
    account({ availability: { state: 'cooling', code: 'QUOTA_EXHAUSTED', until: Date.UTC(2026, 0, 1, 12) } }),
    enT,
  )
  assert.deepEqual(cooling, [
    { text: en.accountStateCooling.replace('{date}', formatDateTime(enT, Date.UTC(2026, 0, 1, 12))), tone: 'info' },
  ])

  // The unknown recovery time is stated as unknown rather than guessed.
  assert.deepEqual(
    accountStateLines(account({ availability: { state: 'cooling', code: 'RATE_LIMITED' } }), enT),
    [{ text: en.accountStateCoolingUnknown, tone: 'info' }],
  )
  assert.deepEqual(
    accountStateLines(account({ credential: { state: 'reauth_required', code: 'REAUTH_REQUIRED' } }), zhT),
    [{ text: zh.accountStateReauth, tone: 'warn' }],
  )
})

test('every reported dimension contributes its own line, in a fixed order', () => {
  const lines = accountStateLines(account({
    credential: { state: 'missing' },
    availability: { state: 'refused', code: 'ENFORCEMENT_REFUSAL' },
    protocol: { state: 'upgrade_required', code: 'CLIENT_VERSION_UNSUPPORTED', profileId: 'p' },
    profile: { state: 'stale', capturedAt: 1 },
    policy: { state: 'blocked', code: 'POLICY_UNSUPPORTED', scope: 'tool' },
  }), enT)
  assert.deepEqual(lines, [
    { text: en.accountStateCredentialMissing, tone: 'warn' },
    { text: en.accountStateRefused, tone: 'warn' },
    { text: en.accountStateProtocolUpgrade, tone: 'warn' },
    { text: en.accountStateProfileStale, tone: 'info' },
    { text: en.accountStatePolicyBlocked, tone: 'warn' },
  ])
})

test('a nominal or unreported dimension adds no line', () => {
  assert.deepEqual(accountStateLines(account(), enT), [])
  assert.deepEqual(accountStateLines(account({ profile: { state: 'fresh' }, policy: { state: 'current' } }), enT), [])
  // A fresh profile that lacks a required field is still incomplete.
  assert.deepEqual(accountStateLines(account({ profile: { state: 'fresh', complete: false } }), enT), [
    { text: en.accountStateProfileIncomplete, tone: 'info' },
  ])
  // Unavailable profile/policy are informational facts about the cache, not failures.
  assert.deepEqual(accountStateLines(account({ profile: { state: 'unavailable' }, policy: { state: 'unavailable' } }), enT), [
    { text: en.accountStateProfileUnavailable, tone: 'info' },
    { text: en.accountStatePolicyUnavailable, tone: 'info' },
  ])
  // A consent-required policy is the one policy state that reads as a warning.
  assert.deepEqual(accountStateLines(account({ policy: { state: 'consent-required' } }), enT), [
    { text: en.accountStatePolicyConsent, tone: 'warn' },
  ])
})

test('both dictionaries carry every account-state and failure key', () => {
  for (const key of Object.keys(en)) {
    if (!key.startsWith('accountState') && !key.startsWith('providerFailure')) continue
    assert.ok((en as Record<string, string>)[key]?.length, `en.${key}`)
    assert.ok((zh as Record<string, string>)[key]?.length, `zh.${key}`)
  }
})

test('a provider failure renders from its fixed code, never from server text', () => {
  const at = Date.UTC(2026, 0, 1)
  assert.equal(providerFailureLine({ code: 'CREDENTIALS_REJECTED', operation: 'login', at }, enT), en.providerFailureCredentialsRejected)
  assert.equal(providerFailureLine({ code: 'NETWORK', operation: 'login', at }, zhT), zh.providerFailureNetwork)
  const retry = providerFailureLine({ code: 'PROVIDER_REJECTED', operation: 'login', at, status: 429, retryAt: at + 30_000 }, enT)
  assert.ok(retry.startsWith(en.providerFailureProviderRejected))
  assert.ok(retry.includes('can retry after'), 'the stated retry instant is shown')
  // The provider's own status/code are diagnostic fields, not copy.
  assert.equal(retry.includes('429'), false)
})

test('a failed status poll and a failed action stay in separate slots', () => {
  let state = withPollError({}, 'claude', 'poll failed')
  assert.equal(errorLine(state, 'claude'), 'poll failed')
  state = withActionError(state, 'claude', 'action failed')
  assert.equal(errorLine(state, 'claude'), 'action failed', 'the action line outranks the poll line')
  state = withPollError(state, 'claude', undefined)
  assert.equal(errorLine(state, 'claude'), 'action failed', 'a successful poll does not erase the action line')
  state = withActionError(state, 'claude', undefined)
  assert.equal(errorLine(state, 'claude'), undefined)
})

// ---------------------------------------------------------------------------
// The mounted badge
// ---------------------------------------------------------------------------

/** Install the jsdom globals the components and React reach for. */
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

/** A selector hook over one source, as the renderer's own binding supplies it. */
function hookOver<T>(source: ObservableSnapshot<T>) {
  return <Selected,>(selector: (value: T) => Selected): Selected =>
    selector(useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot))
}

/** The scripted `subscriptions-auth` face the badge reads. */
interface Scripted {
  rpc: ConnectionHandle['rpc']
  setAccount: (account: AccountStatus) => void
  settle: () => Promise<void>
}

/** One badge's scripted roster and usage, released on demand. */
function scripted(account: AccountStatus): Scripted {
  let current = account
  const pending: (() => void)[] = []
  const rpc: ConnectionHandle['rpc'] = {
    call: (_channel, endpoint) => {
      if (endpoint === 'subscriptions-auth.status') {
        return Promise.resolve({ ok: true as const, value: { providers: { claude: { busy: false, accounts: [current] } } } })
      }
      return new Promise((resolve) => {
        pending.push(() => resolve({
          ok: true as const,
          value: { supported: true, windows: [{ kind: 'session', usedPercent: 40 }], cache: { state: 'fresh' } },
        }))
      })
    },
  }
  return {
    rpc,
    setAccount: (next) => { current = next },
    settle: async () => {
      const waiting = pending.splice(0)
      for (const release of waiting) release()
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

/** Mount the badge over one cache and settle both its reads. */
async function mountBadge(face: Scripted, cache: SubscriptionsCache): Promise<{ stop: () => void; text: () => string }> {
  // One stable snapshot object: a fresh object per `getSnapshot` call would
  // re-render forever under `useSyncExternalStore`.
  const selection = { provider: 'claude', model: 'claude-opus-5' }
  const model = {
    getSnapshot: () => selection,
    subscribe: () => () => {},
  }
  const stop = render(createElement(SubscriptionUsageBadge, {
    rpc: face.rpc,
    readStatus: () => cache.readStatus(),
    readUsage: (provider, account, mode) => cache.readUsage(provider, account, mode),
    readProvider: (provider, mode) => cache.readProvider(provider, mode),
    readAll: mode => cache.readAll(mode),
    useUsage: hookOver(cache.source),
    useModel: hookOver(model),
  }))
  await face.settle()
  await face.settle()
  const panel = document.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement
  flushSync(() => { panel.click() })
  await face.settle()
  return { stop, text: () => document.body.textContent ?? '' }
}

test('the badge states a dead sign-in and stays silent about a cooling window', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scripted(account({ credential: { state: 'reauth_required', code: 'REAUTH_REQUIRED' } }))
    const cache = createSubscriptionsCache(face.rpc)
    const badge = await mountBadge(face, cache)
    assert.ok(badge.text().includes(en.accountStateReauth), 'the account marker is rendered')
    badge.stop()

    // The same account, merely cooling: the percentage already says it, and the
    // badge must not claim the credential is dead.
    face.setAccount(account({ availability: { state: 'cooling', code: 'QUOTA_EXHAUSTED' } }))
    const coolingCache = createSubscriptionsCache(face.rpc)
    const cooling = await mountBadge(face, coolingCache)
    assert.equal(cooling.text().includes(en.accountStateCoolingUnknown), false)
    assert.equal(cooling.text().includes(en.accountStateReauth), false)
    cooling.stop()
  } finally {
    restoreDom()
  }
})
