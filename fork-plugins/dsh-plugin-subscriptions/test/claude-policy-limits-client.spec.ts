/**
 * The Claude `policy_limits` dimension the Settings card and the composer badge
 * render: the host-side projection that turns the owner's own status into fixed
 * codes, counts and one normalized monitoring notice, and the account line,
 * notice and badge marker those fields produce in both languages.
 *
 * The projection cases use synthetic owner statuses only. The rendered cases use
 * the real line component and the real badge over the real shared cache in
 * jsdom, driving a scripted `subscriptions-auth.status` sequence, so the copy on
 * screen is observed rather than assumed; nothing here reads a credential, an
 * environment value, or the network, and the private `DSH_HOME` comes from the
 * package's own launcher (`test/isolate-home.mjs`). jsdom is the declared DOM
 * fixture for this tier; the spec imports it directly so a missing fixture fails
 * here instead of passing silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createElement, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

// The badge reaches host primitives that ship CSS modules; Node needs only
// their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { SubscriptionUsageBadge } = await import('../src/client/SubscriptionUsageBadge.js')
const { createSubscriptionsCache } = await import('../src/client/subscriptions-cache.js')
css.deregister()

import { projectPolicyLimits } from '../src/auth/rpc.js'
import type { PolicyLimitsOwnerStatus } from '../src/auth/rpc.js'
import { AccountStateLines, accountStateLines } from '../src/client/SubscriptionsSection.js'
import type { AccountStatus, PolicyLimitsStatus } from '../src/client/SubscriptionsSection.js'
import type { ObservableSnapshot, SubscriptionsCache } from '../src/client/subscriptions-cache.js'
import { en, zh } from '../src/client/locales.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

/** Dictionary-bound translator with `{name}` substitution, as the locale seat supplies it. */
function translateFrom(dictionary: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>): string =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

const enT = translateFrom(en)
const zhT = translateFrom(zh)

/** One synthetic owner status; only the members the projection reads. */
function ownerStatus(overrides: Partial<PolicyLimitsOwnerStatus> = {}): PolicyLimitsOwnerStatus {
  return { state: 'current', reason: 'accepted', fallback: 'live', ...overrides }
}

/** One account whose every dimension is nominal. */
function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return { key: 'acct', isDefault: true, credential: { state: 'ready' }, ...overrides }
}

/**
 * The client's own mirror of the dimension. Assigning the host projection to it
 * is the compile-time check that the two declarations have not drifted; a code
 * or field added on one side alone stops compiling here.
 * @param projected - the host-side projection for one account.
 * @returns the same value typed as the client's field.
 */
function asClientField(projected: PolicyLimitsStatus | undefined): AccountStatus['policyLimits'] {
  return projected
}

// ---------------------------------------------------------------------------
// The host-side projection
// ---------------------------------------------------------------------------

test('an owner with no status contributes no dimension', () => {
  assert.equal(projectPolicyLimits(undefined), undefined)
})

test('every state the owner can report crosses as itself', () => {
  for (const state of ['ineligible', 'loading', 'current', 'stale', 'unavailable', 'blocked'] as const) {
    assert.deepEqual(
      projectPolicyLimits(ownerStatus({ state, reason: 'reading' })),
      { state, fallback: 'live' },
      state,
    )
  }
  assert.deepEqual(
    projectPolicyLimits(ownerStatus({ state: 'stale', reason: 'request_failed', fallback: 'stale' })),
    { state: 'stale', fallback: 'stale', code: 'REQUEST_FAILED' },
  )
})

test('the owner reason crosses as a fixed code, and an unlisted one crosses as nothing', () => {
  const codeOf = (reason: string): string | undefined =>
    projectPolicyLimits(ownerStatus({ state: 'unavailable', reason, fallback: 'none' }))?.code
  assert.equal(codeOf('credential_unavailable'), 'CREDENTIAL_UNAVAILABLE')
  assert.equal(codeOf('auth_failed'), 'AUTH_REJECTED')
  assert.equal(codeOf('request_failed'), 'REQUEST_FAILED')
  assert.equal(codeOf('read_failed'), 'REQUEST_FAILED')
  assert.equal(codeOf('parse_failed'), 'PARSE_FAILED')
  assert.equal(codeOf('body_over_limit'), 'RESPONSE_OVER_LIMIT')
  // A reason this build does not map contributes no code rather than its own text.
  assert.equal(codeOf('quota exceeded for organization acme-42'), undefined)
  assert.equal(JSON.stringify(projectPolicyLimits(ownerStatus({ reason: 'quota exceeded for organization acme-42' })))
    .includes('acme-42'), false)
})

test('the failure sub-reason outranks the outcome code it arrived with', () => {
  const codeOf = (reason: string, failureReason: string): string | undefined =>
    projectPolicyLimits(ownerStatus({
      state: 'stale',
      reason,
      fallback: 'stale',
      failure: { reason: failureReason },
    }))?.code
  // The outcome code says only that the read failed; the sub-reason says this
  // plugin's own response-size bound stopped it, which is a different fact.
  assert.equal(codeOf('unsupported', 'body_over_limit'), 'RESPONSE_OVER_LIMIT')
  assert.equal(codeOf('auth_failed', 'credential_unavailable'), 'CREDENTIAL_UNAVAILABLE')
  // A sub-reason outside the map leaves the outcome code standing.
  assert.equal(codeOf('request_failed', 'transport'), 'REQUEST_FAILED')
})

test('keys, taints, scopes and a notice cross as counts, a presence, or the normalized notice', () => {
  const projected = projectPolicyLimits(
    ownerStatus({
      state: 'blocked',
      reason: 'accepted',
      fallback: 'stale',
      fetchedAt: 1_700_000_000_000,
      deniedKeys: ['allow_send_file', 'allow_web_fetch'],
      blockers: ['policy_limits_unknown_keys', 'not_a_blocker_code'],
      taints: ['HIPAA', 'SYNTHETIC_TAINT'],
      unsupportedScopes: [
        { scope: 'policy-defaults', reason: 'the accepted policy stated a capability default this build cannot type' },
        { scope: 'policy-notice', reason: 'a monitoring notice is in force; its text was not stored' },
      ],
      notice: true,
    }),
    [{ key: 'allow_memory_sync', reason: 'this provider has no memory surface' }],
    { text: '<b>monitored</b> by acme', url: 'https://example.invalid/notice' },
  )
  assert.deepEqual(projected, {
    state: 'blocked',
    fallback: 'stale',
    blockers: ['policy_limits_unknown_keys'],
    fetchedAt: 1_700_000_000_000,
    unknownCount: 1,
    deniedCount: 2,
    taintCount: 2,
    unsupportedScopeCount: 2,
    notice: true,
    noticeContent: { text: '<b>monitored</b> by acme', url: 'https://example.invalid/notice' },
  })
  // The field set is the contract: the document, its defaults and its reasons
  // have no member here to travel through.
  assert.deepEqual(Object.keys(projected!), [
    'state', 'fallback', 'blockers', 'fetchedAt', 'unknownCount', 'deniedCount', 'taintCount',
    'unsupportedScopeCount', 'notice', 'noticeContent',
  ])
  const serialized = JSON.stringify(projected)
  for (const behind of [
    'allow_send_file', 'allow_web_fetch', 'allow_memory_sync', 'memory surface',
    'HIPAA', 'SYNTHETIC_TAINT', 'not_a_blocker_code', 'capability default this build cannot type',
  ]) {
    assert.equal(serialized.includes(behind), false, `${behind} must not cross`)
  }
  // A caller that also holds the adopted document cannot leak it through this path.
  const withDocument = {
    ...ownerStatus({ state: 'blocked', reason: 'accepted', deniedKeys: ['allow_web_fetch'] }),
    document: { restrictions: { allow_web_fetch: { allowed: false } } },
    defaults: { keep: 'synthetic-default' },
    taints: ['SYNTHETIC_TAINT'],
    restrictionKeys: ['allow_web_fetch', 'unregistered_key_name'],
    notice: true,
  }
  const projectedWithDocument = projectPolicyLimits(withDocument)
  assert.deepEqual(projectedWithDocument, {
    state: 'blocked', fallback: 'live', deniedCount: 1, taintCount: 1, notice: true,
  })
  assert.deepEqual(Object.keys(projectedWithDocument!), ['state', 'fallback', 'deniedCount', 'taintCount', 'notice'])
  for (const behind of ['allow_web_fetch', 'synthetic-default', 'SYNTHETIC_TAINT', 'restrictions', 'unregistered_key_name']) {
    assert.equal(JSON.stringify(projectedWithDocument).includes(behind), false, `${behind} must not cross`)
  }
})

test('a notice crosses through its own projection, and only fixed blocker codes cross', () => {
  // Zero gaps, zero refusals and zero scopes are omitted, not reported as a count of none.
  assert.deepEqual(projectPolicyLimits(ownerStatus(), []), { state: 'current', fallback: 'live' })
  assert.deepEqual(projectPolicyLimits(ownerStatus({ notice: false })), { state: 'current', fallback: 'live' })
  // Presence without content: the retained snapshot kept that a notice exists.
  assert.deepEqual(projectPolicyLimits(ownerStatus({ notice: true })), { state: 'current', fallback: 'live', notice: true })
  assert.deepEqual(projectPolicyLimits(ownerStatus({ blockers: ['not_a_blocker_code'] })), { state: 'current', fallback: 'live' })
  assert.deepEqual(projectPolicyLimits(ownerStatus({ blockers: ['policy_limits_lossy_taints'] })), {
    state: 'current', fallback: 'live', blockers: ['policy_limits_lossy_taints'],
  })
  // The owner's `url: null` is no destination, and a destination that is not an
  // https one never reaches an href.
  const content = { state: 'current', fallback: 'live', noticeContent: { text: 'notice' } } as const
  assert.deepEqual(projectPolicyLimits(ownerStatus(), [], { text: 'notice', url: null }), content)
  assert.deepEqual(projectPolicyLimits(ownerStatus(), [], { text: 'notice', url: 'javascript:alert(1)' }), content)
  assert.deepEqual(projectPolicyLimits(ownerStatus(), [], { text: 'notice', url: 'http://example.invalid/n' }), content)
})

test('the host projection satisfies the client mirror', () => {
  const projected = projectPolicyLimits(ownerStatus({
    state: 'blocked', reason: 'body_over_limit', fallback: 'stale', fetchedAt: 7, deniedKeys: ['a'],
  }), [{ key: 'b', reason: 'gap' }])
  assert.deepEqual(asClientField(projected), {
    state: 'blocked',
    fallback: 'stale',
    code: 'RESPONSE_OVER_LIMIT',
    fetchedAt: 7,
    unknownCount: 1,
    deniedCount: 1,
  })
  // The blocker vocabulary and the notice are mirrored too: a code or a field
  // either side drops stops compiling here.
  assert.deepEqual(asClientField(projectPolicyLimits(
    ownerStatus({ blockers: ['policy_limits_core_skills_unstored'] }),
    [],
    { text: 'notice', url: 'https://example.invalid/notice' },
  )), {
    state: 'current',
    fallback: 'live',
    blockers: ['policy_limits_core_skills_unstored'],
    noticeContent: { text: 'notice', url: 'https://example.invalid/notice' },
  })
  assert.equal(asClientField(undefined), undefined)
})

// ---------------------------------------------------------------------------
// The account line
// ---------------------------------------------------------------------------

test('an account that reports no policy-limits dimension gains no line', () => {
  assert.deepEqual(accountStateLines(account(), enT), [])
  // A reported `current` verdict from a live document is the only silent state.
  assert.deepEqual(accountStateLines(account({ policyLimits: { state: 'current', fallback: 'live' } }), enT), [])
})

test('each reported policy-limits state states its own fact', () => {
  const lineOf = (policyLimits: PolicyLimitsStatus, t = enT): string =>
    accountStateLines(account({ policyLimits }), t)[0]!.text
  assert.deepEqual(accountStateLines(account({ policyLimits: { state: 'blocked', fallback: 'live' } }), enT), [
    { text: en.accountStatePolicyLimitsBlocked, tone: 'warn' },
  ])
  assert.equal(lineOf({ state: 'loading', fallback: 'none' }), en.accountStatePolicyLimitsLoading)
  assert.equal(lineOf({ state: 'stale', fallback: 'stale' }), en.accountStatePolicyLimitsStale)
  assert.equal(lineOf({ state: 'unavailable', fallback: 'none' }), en.accountStatePolicyLimitsUnavailable)
  assert.equal(lineOf({ state: 'ineligible', fallback: 'none' }), en.accountStatePolicyLimitsIneligible)
})

test('the policy-limits line never states a sign-in, quota, or managed-policy fact', () => {
  const lineOf = (policyLimits: PolicyLimitsStatus): string =>
    accountStateLines(account({ policyLimits }), enT)[0]!.text
  const unavailable = lineOf({ state: 'unavailable', fallback: 'none' })
  assert.equal(unavailable.includes(en.accountStateReauth), false)
  assert.equal(unavailable.includes(en.accountStateCredentialMissing), false)
  assert.equal(unavailable.includes(en.accountStateCoolingUnknown), false)

  const blocked = lineOf({ state: 'blocked', fallback: 'live' })
  assert.equal(blocked.includes(en.accountStatePolicyBlocked), false, 'the managed policy is a different dimension')
  assert.equal(blocked.includes('quota'), false)

  // A stale document still limits this account; an ineligible one was never read.
  assert.equal(lineOf({ state: 'stale', fallback: 'stale' }).includes('still apply'), true)
  const ineligible = lineOf({ state: 'ineligible', fallback: 'none' })
  assert.equal(ineligible.includes('not checked'), true)
  assert.equal(ineligible.includes('up to date'), false)
})

test('a fixed failure code is named beside the state, and a verdict with nothing live is not silent', () => {
  assert.deepEqual(accountStateLines(account({
    policyLimits: { state: 'unavailable', code: 'CREDENTIAL_UNAVAILABLE', fallback: 'none' },
  }), enT), [{
    text: `${en.accountStatePolicyLimitsUnavailable} · ${en.accountStatePolicyLimitsCredential}`,
    tone: 'info',
  }])
  // This plugin's own response-size bound is named as its own, never as a
  // restriction the provider stated.
  const overLimit = accountStateLines(account({
    policyLimits: { state: 'stale', code: 'RESPONSE_OVER_LIMIT', fallback: 'stale' },
  }), enT)[0]!.text
  assert.equal(overLimit.endsWith(en.accountStatePolicyLimitsResponseLimit), true)
  assert.equal(overLimit.includes(en.accountStatePolicyLimitsBlocked), false)
  // A `current` verdict answered from no live document is not a confirmed read.
  assert.deepEqual(accountStateLines(account({
    policyLimits: { state: 'current', fallback: 'none' },
  }), enT), [{ text: en.accountStatePolicyLimitsUnconfirmed, tone: 'info' }])
})

test('the policy-limits copy is localized in both languages', () => {
  assert.deepEqual(accountStateLines(account({ policyLimits: { state: 'blocked', fallback: 'live' } }), zhT), [
    { text: zh.accountStatePolicyLimitsBlocked, tone: 'warn' },
  ])
  assert.deepEqual(accountStateLines(account({
    policyLimits: { state: 'unavailable', code: 'AUTH_REJECTED', fallback: 'none' },
  }), zhT), [{
    text: `${zh.accountStatePolicyLimitsUnavailable} · ${zh.accountStatePolicyLimitsAuthRejected}`,
    tone: 'info',
  }])
  for (const key of Object.keys(en)) {
    if (!key.startsWith('accountStatePolicyLimits')) continue
    assert.ok((en as Record<string, string>)[key]?.length, `en.${key}`)
    assert.ok((zh as Record<string, string>)[key]?.length, `zh.${key}`)
  }
})

test('a notice line labels the provider prose, and a notice whose text was not read is not no notice', () => {
  const notice = { text: 'Your organization monitors usage', url: 'https://example.invalid/notice' }
  assert.deepEqual(accountStateLines(account({
    policyLimits: { state: 'current', fallback: 'live', notice: true, noticeContent: notice },
  }), enT), [{
    text: en.accountStatePolicyLimitsNotice.replace('{text}', notice.text),
    tone: 'info',
    url: notice.url,
  }])
  // A retained snapshot keeps the notice's existence without its text.
  assert.deepEqual(accountStateLines(account({
    policyLimits: { state: 'current', fallback: 'live', notice: true },
  }), zhT), [{ text: zh.accountStatePolicyLimitsNoticePending, tone: 'info' }])
  // An account with no notice stays silent.
  assert.deepEqual(accountStateLines(account({
    policyLimits: { state: 'current', fallback: 'live' },
  }), enT), [])
})

test('the rendered notice stays text, and only an https destination becomes a link', () => {
  const htmlText = '<img src=x onerror="alert(1)"> & "quoted"'
  for (const [dictionary, t] of [[en, enT], [zh, zhT]] as const) {
    const unsafe = renderToStaticMarkup(createElement(AccountStateLines, {
      t,
      lines: accountStateLines(account({
        policyLimits: {
          state: 'current',
          fallback: 'live',
          notice: true,
          noticeContent: { text: htmlText, url: 'javascript:alert(1)' },
        },
      }), t),
    }))
    // Provider prose is escaped, so it cannot become markup.
    assert.equal(unsafe.includes('<img'), false)
    assert.ok(unsafe.includes('&lt;img src=x onerror='))
    assert.ok(unsafe.includes('&amp;'))
    // A destination that is not an https one produces no link at all.
    assert.equal(unsafe.includes('<a '), false)
    assert.equal(unsafe.includes('javascript:'), false)
    assert.ok(unsafe.includes(dictionary.accountStatePolicyLimitsNotice.replace('{text}', '').trim()))

    const linked = renderToStaticMarkup(createElement(AccountStateLines, {
      t,
      lines: accountStateLines(account({
        policyLimits: {
          state: 'current',
          fallback: 'live',
          notice: true,
          noticeContent: { text: 'monitoring in force', url: 'https://example.invalid/notice' },
        },
      }), t),
    }))
    assert.ok(linked.includes('href="https://example.invalid/notice"'))
    assert.ok(linked.includes('target="_blank"'))
    assert.ok(linked.includes('rel="noopener noreferrer"'))
    assert.ok(linked.includes(dictionary.accountStatePolicyLimitsNoticeLink))
  }
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
  /** Every endpoint this face was asked for, so the reads a render performs are observable. */
  readonly calls: readonly string[]
}

/** One badge's scripted roster and usage, released on demand. */
function scripted(account: AccountStatus): Scripted {
  let current = account
  const pending: (() => void)[] = []
  const calls: string[] = []
  const rpc: ConnectionHandle['rpc'] = {
    call: (_channel, endpoint) => {
      calls.push(endpoint)
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
    calls,
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
async function mountBadge(
  face: Scripted,
  cache: SubscriptionsCache,
  t: (key: string, params?: Record<string, unknown>) => string,
): Promise<{ stop: () => void; text: () => string }> {
  // One stable snapshot object: a fresh object per `getSnapshot` call would
  // re-render forever under `useSyncExternalStore`.
  const selection = { provider: 'claude', model: 'claude-opus-5' }
  const model = { getSnapshot: () => selection, subscribe: () => () => {} }
  const stop = render(createElement(SubscriptionUsageBadge, {
    rpc: face.rpc,
    t,
    readStatus: () => cache.readStatus(),
    readUsage: (provider, key, mode) => cache.readUsage(provider, key, mode),
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

test('the badge marks a blocking policy limit and stays silent about the other states', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    for (const [dictionary, t] of [[en, enT], [zh, zhT]] as const) {
      const face = scripted(account())
      const unreported = await mountBadge(face, createSubscriptionsCache(face.rpc), t)
      assert.equal(
        unreported.text().includes(dictionary.accountStatePolicyLimitsBlocked),
        false,
        'a dimension the node half did not report adds no marker',
      )
      unreported.stop()

      face.setAccount(account({ policyLimits: { state: 'current', fallback: 'live' } }))
      const current = await mountBadge(face, createSubscriptionsCache(face.rpc), t)
      assert.equal(current.text().includes(dictionary.accountStatePolicyLimitsBlocked), false)
      current.stop()

      // A stale document keeps limiting this account but does not take it out of
      // service, so the badge says nothing the Settings card does not own.
      face.setAccount(account({ policyLimits: { state: 'stale', fallback: 'stale' } }))
      const stale = await mountBadge(face, createSubscriptionsCache(face.rpc), t)
      assert.equal(stale.text().includes(dictionary.accountStatePolicyLimitsBlocked), false)
      stale.stop()

      face.setAccount(account({ policyLimits: { state: 'blocked', fallback: 'live', deniedCount: 2 } }))
      const blocked = await mountBadge(face, createSubscriptionsCache(face.rpc), t)
      assert.ok(blocked.text().includes(dictionary.accountStatePolicyLimitsBlocked), 'the blocking state is marked')
      blocked.stop()
    }
  } finally {
    restoreDom()
  }
})

test('a notice rides on the status read and makes no request of its own', async () => {
  const restoreDom = installDom(JSDOM)
  try {
    const face = scripted(account({
      policyLimits: {
        state: 'current',
        fallback: 'live',
        notice: true,
        noticeContent: { text: 'monitoring in force', url: 'https://example.invalid/notice' },
      },
    }))
    const badge = await mountBadge(face, createSubscriptionsCache(face.rpc), enT)
    badge.stop()
    // The notice arrives inside the roster read: no notice endpoint, and no
    // request the URL could have triggered.
    assert.deepEqual([...new Set(face.calls)], ['subscriptions-auth.status', 'subscriptions-auth.usage'])
  } finally {
    restoreDom()
  }
})
