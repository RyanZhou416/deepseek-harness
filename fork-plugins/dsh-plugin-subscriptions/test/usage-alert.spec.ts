/**
 * The account card's red usage line: which fact it states and whether it is
 * attributed to the account alone or to the pool routing around it. Pure
 * derivation, no DOM and no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
// The section imports host primitives that ship CSS modules; these pure-logic
// assertions need only their empty class map, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { usageAlert, usageAlertKey } = await import('../src/client/SubscriptionsSection.js')
css.deregister()
import type { PoolReport, RateLimitReport, UsageWindow } from '../src/client/SubscriptionsSection.js'

const NOW = Date.now()
const LATER = NOW + 3_600_000

function report(overrides: Partial<RateLimitReport> = {}): RateLimitReport {
  return { status: 'allowed', windows: [], observedAt: NOW, ...overrides }
}

/** A full weekly window: the percentage-derived state, with no header report. */
const FULL_WINDOW: UsageWindow[] = [{ kind: 'weekly', usedPercent: 100, resetsAt: LATER }]

test('the header verdict outranks the reported window percentages', () => {
  const alert = usageAlert('claude', [], report({ status: 'rejected', resetsAt: LATER }))
  assert.deepEqual(alert, { kind: 'rejected', attribution: 'account', resetsAt: LATER })
  assert.equal(usageAlertKey(alert!), 'usageAccountRejected')
})

test('a rejected account with a clear peer is attributed to the pool', () => {
  const pool: PoolReport = { peerAvailable: true, coolingUntil: LATER, coolingReason: 'quota' }
  const alert = usageAlert('claude', [], report({ status: 'rejected', resetsAt: LATER }), pool)
  assert.deepEqual(alert, { kind: 'rejected', attribution: 'pool', resetsAt: LATER })
  assert.equal(usageAlertKey(alert!), 'usagePoolCooling')
})

test('an overage-status rejection counts as rejected even when the base status allows', () => {
  const alert = usageAlert('claude', [], report({ status: 'allowed', overageStatus: 'rejected' }))
  assert.equal(alert?.kind, 'rejected')
})

test('a dead login is an account fact even while a peer is serving', () => {
  const pool: PoolReport = { peerAvailable: true, coolingUntil: LATER, coolingReason: 'auth' }
  const alert = usageAlert('claude', FULL_WINDOW, report({ status: 'rejected' }), pool)
  assert.deepEqual(alert, { kind: 'relogin', attribution: 'account', resetsAt: LATER })
  assert.equal(usageAlertKey(alert!), 'usageAccountRelogin')
})

test('the allowed_warning status reports a near state, pool-attributed when a peer serves', () => {
  const warning = report({ status: 'allowed_warning', resetsAt: LATER })
  const account = usageAlert('claude', [], warning)
  assert.deepEqual(account, { kind: 'warning', attribution: 'account', resetsAt: LATER })
  assert.equal(usageAlertKey(account!), 'usageNearlyExhausted')
  const pooled = usageAlert('claude', [], warning, { peerAvailable: true })
  assert.equal(usageAlertKey(pooled!), 'usagePoolCooling')
})

test('overage is a pool observation only, and only while a peer can serve', () => {
  const inUse = report({ status: 'allowed', overageInUse: true, overageResetsAt: LATER })
  assert.equal(usageAlert('claude', [], inUse), undefined, 'with no peer the account is serving fine')
  const alert = usageAlert('claude', [], inUse, { peerAvailable: true })
  assert.deepEqual(alert, { kind: 'overage', attribution: 'pool', resetsAt: LATER })
  assert.equal(usageAlertKey(alert!), 'usagePoolOverage')
})

test('a pool cooldown without a header report still marks the account', () => {
  const pooled = usageAlert('claude', [], undefined, { peerAvailable: true, coolingUntil: LATER, coolingReason: 'quota' })
  assert.deepEqual(pooled, { kind: 'cooldown', attribution: 'pool', resetsAt: LATER })
  assert.equal(usageAlertKey(pooled!), 'usagePoolCooling')
  const alone = usageAlert('claude', [], undefined, { peerAvailable: false, coolingUntil: LATER, coolingReason: 'quota' })
  assert.deepEqual(alone, { kind: 'cooldown', attribution: 'account', resetsAt: LATER })
  assert.equal(usageAlertKey(alone!), 'usageLimitReached')
})

test('an elapsed cooldown and an elapsed reset instant are not reported', () => {
  const pool: PoolReport = { peerAvailable: true, coolingUntil: NOW - 1, coolingReason: 'quota' }
  assert.equal(usageAlert('claude', [], undefined, pool), undefined)
  assert.deepEqual(
    usageAlert('claude', [], report({ status: 'rejected', resetsAt: NOW - 1 }), { peerAvailable: true }),
    { kind: 'rejected', attribution: 'pool' },
    'a reset already past is dropped rather than rendered',
  )
})

test('the percentage rule keeps its per-provider threshold and pool attribution', () => {
  const full = usageAlert('claude', FULL_WINDOW)
  assert.deepEqual(full, { kind: 'limit', attribution: 'account', resetsAt: LATER })
  assert.equal(usageAlertKey(full!), 'usageLimitReached')
  const pool = usageAlert('claude', FULL_WINDOW, undefined, { peerAvailable: true })
  assert.equal(usageAlertKey(pool!), 'usagePoolCooling')

  // Codex and Claude spend a window to 100%; every other provider is out at 95%.
  const near = usageAlert('cursor', [{ kind: 'weekly', usedPercent: 96, resetsAt: LATER }])
  assert.equal(near?.kind, 'near')
  assert.equal(usageAlertKey(near!), 'usageNearlyExhausted')
  assert.equal(usageAlert('cursor', [{ kind: 'weekly', usedPercent: 90 }]), undefined)
  assert.equal(usageAlert('claude', [{ kind: 'weekly', usedPercent: 96 }]), undefined)
})

test('no report, no windows and no pool report nothing', () => {
  assert.equal(usageAlert('claude', undefined), undefined)
  assert.equal(usageAlert('claude', []), undefined)
  assert.equal(usageAlert('claude', [], report()), undefined)
  assert.equal(usageAlert('claude', [], report(), { peerAvailable: false }), undefined)
})
