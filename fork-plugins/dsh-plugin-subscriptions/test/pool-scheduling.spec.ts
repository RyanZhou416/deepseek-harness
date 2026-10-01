/** Configurable, bounded account preferences independent of provider I/O. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply } from '../src/index.js'
import { poolSchedulingScore, resolvePoolScheduling } from '../src/providers/pool-scheduling.js'
import type { MemberQuota } from '../src/providers/pool-usage.js'
import type { ConcretePoolMember } from '../src/providers/pool-family.js'

const now = Date.UTC(2026, 8, 30)
const member: ConcretePoolMember = { provider: 'codex', model: 'm', account: 'a' }

test('pool scheduling schema resolves partial deployment overrides and rejects invalid choices', (t) => {
  const result = resolvePoolScheduling({ resetWeight: 0, loadPenalty: 2 })
  assert.equal(result.resetWeight, 0)
  assert.equal(result.loadPenalty, 2)
  assert.equal(result.codexDrainBelowPercent, 10)
  const config = Config({ pool: { scheduling: { codexDrainWeight: 3 } } })
  assert.equal(config.pool?.scheduling?.codexDrainWeight, 3)
  for (const invalid of [
    { resetWeight: -1 }, { resetWeight: Infinity }, { loadPenalty: NaN },
    { codexDrainBelowPercent: 101 }, { weeklyResetHorizonMs: 0 }, { sessionResetHorizonMs: 1.5 },
    { resetWeight: Number.MAX_VALUE, codexDrainWeight: Number.MAX_VALUE },
  ]) assert.throws(() => resolvePoolScheduling(invalid))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  assert.throws(() => apply(ctx, { providers: [], pool: { enabled: false, scheduling: { resetWeight: Infinity } } }))
})

test('reset and finishing bonuses remain bounded while account load can outweigh them', () => {
  const policy = resolvePoolScheduling()
  const quota: MemberQuota = {
    available: true, urgency: 1, fetchedAt: now, preferFreshCredit: true,
    windows: [{ kind: 'weekly', usedPercent: 99, resetsAt: now + 1 }],
  }
  const score = poolSchedulingScore(member, quota, 1, 0, policy, now)
  assert.ok(score > 4 && score < 1 + policy.resetWeight + policy.codexDrainWeight + policy.freshCreditWeight)
  assert.ok(poolSchedulingScore(member, quota, 1, 10, policy, now) < 1)
  assert.equal(poolSchedulingScore(member, quota, 1, 10, { ...policy, loadPenalty: 0 }, now), score)
  const other = { ...member, provider: 'grok' as const }
  assert.equal(poolSchedulingScore(other, { ...quota, preferFreshCredit: false }, 1, 0, policy, now), 1)
})

test('unknown or elapsed reset times receive no reset bonus and zero disables finishing', () => {
  const policy = resolvePoolScheduling({ codexDrainBelowPercent: 0 })
  for (const resetsAt of [undefined, now - 1, now]) {
    const quota: MemberQuota = { available: true, urgency: 1, fetchedAt: now,
      windows: [{ kind: 'session', usedPercent: 99, ...resetsAt === undefined ? {} : { resetsAt } }] }
    assert.equal(poolSchedulingScore(member, quota, 1, 0, policy, now), 1)
  }
  assert.equal(poolSchedulingScore(member, { available: true, urgency: 0, fetchedAt: 0 }, 0, 1, policy, now), 0.5)
})

test('a weekly bottleneck can finish even when the short window has plenty of quota', () => {
  const quota: MemberQuota = { available: true, urgency: 1, fetchedAt: now, windows: [
    { kind: 'session', usedPercent: 10 }, { kind: 'weekly', usedPercent: 97 },
  ] }
  const policy = resolvePoolScheduling()
  assert.equal(poolSchedulingScore(member, quota, 1, 0, policy, now), 1.7)
  assert.equal(poolSchedulingScore({ ...member, provider: 'claude' }, quota, 1, 0, policy, now), 1)
  assert.equal(poolSchedulingScore(member, { ...quota, available: false }, 1, 0, policy, now), 1)
})
