/**
 * The pinned `policy_limits` envelope: normalization, the raw-body validator and the
 * bounded adoption cache.
 *
 * Every body here is a synthetic fixture from the implementation contract §11 (F1–F14 where
 * they are schema or cache behaviour). No network, no credential and no harness state is
 * involved.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PolicyLimitsCache,
  canonicalPolicyJson,
  parsePolicyLimitsDocument,
  policyValidator,
  sha256Hex,
} from '../src/claude-core/policy-limits.js'
import { isPolicySettled } from '../src/claude-core/no-live-policy.js'

test('F1: a well-formed body parses into the normalized document', () => {
  const parsed = parsePolicyLimitsDocument({
    restrictions: { enforce_x: { allowed: true } },
    compliance_taints: [],
    monitoring_notice: null,
    defaults: {},
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.document.restrictions, { enforce_x: { allowed: true } })
  assert.deepEqual(parsed.document.complianceTaints, [])
  assert.equal(parsed.document.monitoringNotice, null)
  assert.deepEqual(parsed.document.defaults, {})
  assert.equal(parsed.document.lossyComplianceTaints, false)
})

test('F2: restrictions may be empty; every other member takes its default', () => {
  const parsed = parsePolicyLimitsDocument({ restrictions: {} })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.document.restrictions, {})
  assert.deepEqual(parsed.document.coreSkills, [])
})

test('F3/F4: a missing or malformed restrictions member is a parse failure', () => {
  for (const body of [{}, { restrictions: { k: {} } }, { restrictions: [] }]) {
    const parsed = parsePolicyLimitsDocument(body)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.failure.code, 'parse_failed')
  }
})

test('F5: taints that normalize to nothing at all are a parse failure', () => {
  const parsed = parsePolicyLimitsDocument({ restrictions: {}, compliance_taints: ['Bad Name'] })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.failure.code, 'parse_failed')
})

test('F6: a partly unusable taint list keeps the legal taints and marks the document lossy', () => {
  const parsed = parsePolicyLimitsDocument({ restrictions: {}, compliance_taints: [' HIPAA ', 'Bad Name'] })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.document.complianceTaints, ['hipaa'])
  assert.equal(parsed.document.lossyComplianceTaints, true)
})

test('taint normalization trims, lowercases, deduplicates and bounds the list', () => {
  const parsed = parsePolicyLimitsDocument({
    restrictions: {},
    compliance_taints: ['ZDR', 'zdr', 'hipaa', ...Array.from({ length: 20 }, (_, index) => `t${String(index)}`)],
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.document.complianceTaints.length, 16, 'the pinned limit is 16')
  assert.equal(parsed.document.complianceTaints[0], 'zdr')
  assert.equal(parsed.document.complianceTaints[1], 'hipaa')
  assert.equal(parsed.document.lossyComplianceTaints, true)
})

test('F12: an unknown top-level key is stripped, not rejected', () => {
  const parsed = parsePolicyLimitsDocument({ restrictions: {}, extra: 1 })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(Object.hasOwn(parsed.document, 'extra'), false)
})

test('F13/F14: non-empty defaults and a monitoring notice survive as general gates', () => {
  const withDefaults = parsePolicyLimitsDocument({ restrictions: {}, defaults: { a: 1 } })
  assert.equal(withDefaults.ok, true)
  if (!withDefaults.ok) return
  assert.deepEqual(withDefaults.document.defaults, { a: 1 })
  const withNotice = parsePolicyLimitsDocument({
    restrictions: {},
    monitoring_notice: { text: 'x', url: null },
  })
  assert.equal(withNotice.ok, true)
  if (!withNotice.ok) return
  assert.deepEqual(withNotice.document.monitoringNotice, { text: 'x', url: null })
})

test('a monitoring notice outside the bound falls back to null instead of failing the document', () => {
  const parsed = parsePolicyLimitsDocument({
    restrictions: {},
    monitoring_notice: { text: 'x'.repeat(501), url: null },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.document.monitoringNotice, null)
})

test('the canonical form sorts object keys recursively and keeps array order', () => {
  assert.equal(canonicalPolicyJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(canonicalPolicyJson({ a: [2, 1] }), '{"a":[2,1]}')
})

test('the validator is sha256 over the raw body, so member order does not change it', async () => {
  const first = await policyValidator({ restrictions: {}, defaults: { b: 1, a: 2 } })
  const second = await policyValidator({ defaults: { a: 2, b: 1 }, restrictions: {} })
  assert.equal(first, second)
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first, `sha256:${await sha256Hex(canonicalPolicyJson({ restrictions: {}, defaults: { a: 2, b: 1 } }))}`)
})

test('the validator hashes the raw body, including the members the projection strips', async () => {
  const withUnknown = await policyValidator({ restrictions: {}, extra: 1 })
  const withoutUnknown = await policyValidator({ restrictions: {} })
  assert.notEqual(withUnknown, withoutUnknown, 'the raw body is what the server validated')
})

test('the cache adopts one snapshot, exposes the live document and clears', async () => {
  const cache = new PolicyLimitsCache()
  assert.equal(cache.live(), null)
  assert.equal(cache.validator(), undefined)
  const adopted = await cache.adopt({ restrictions: { enforce_a: { allowed: true } } }, { receivedAt: 10 })
  assert.equal(adopted.ok, true)
  assert.equal(cache.live()?.restrictions['enforce_a']?.allowed, true)
  assert.match(cache.validator() ?? '', /^sha256:/)
  assert.equal(cache.current()?.receivedAt, 10)
  // A refused body never replaces the live policy.
  const refused = await cache.adopt({ restrictions: { bad: {} } }, { receivedAt: 20 })
  assert.equal(refused.ok, false)
  assert.equal(cache.current()?.receivedAt, 10)
  cache.clear()
  assert.equal(cache.current(), undefined)
})

test('a signature header is kept for diagnostics only', async () => {
  const cache = new PolicyLimitsCache()
  await cache.adopt({ restrictions: {} }, { receivedAt: 1, signature: 'sig-1' })
  assert.equal(cache.current()?.signature, 'sig-1')
  assert.equal(cache.validator()?.startsWith('sha256:'), true, 'adoption does not depend on the signature')
})

test('an explicit null compliance_taints is a malformed body, not an empty list', () => {
  const parsed = parsePolicyLimitsDocument({ restrictions: {}, compliance_taints: null })
  assert.equal(parsed.ok, false, 'the pinned member only defaults when it is absent')
  if (parsed.ok) return
  assert.equal(parsed.failure.code, 'parse_failed')
})

test('core_skills takes its whole default on any failure, never a filtered subset', () => {
  const valid = parsePolicyLimitsDocument({ restrictions: {}, core_skills: ['a', 'b'] })
  assert.equal(valid.ok, true)
  if (valid.ok) assert.deepEqual([...valid.document.coreSkills], ['a', 'b'])

  const withBadMember = parsePolicyLimitsDocument({ restrictions: {}, core_skills: ['a', 42] })
  assert.equal(withBadMember.ok, true)
  if (withBadMember.ok) assert.deepEqual([...withBadMember.document.coreSkills], [], 'one bad member takes the whole default')

  const withEmptyName = parsePolicyLimitsDocument({ restrictions: {}, core_skills: ['a', ''] })
  assert.equal(withEmptyName.ok, true)
  if (withEmptyName.ok) {
    assert.deepEqual([...withEmptyName.document.coreSkills], ['a', ''], 'the name bound has no minimum: an empty string is legal')
  }

  const oversized = parsePolicyLimitsDocument({
    restrictions: {},
    core_skills: Array.from({ length: 257 }, (_, index) => `s${String(index)}`),
  })
  assert.equal(oversized.ok, true)
  if (oversized.ok) assert.deepEqual([...oversized.document.coreSkills], [], 'an oversized list is not truncated')

  const notAnArray = parsePolicyLimitsDocument({ restrictions: {}, core_skills: 'a' })
  assert.equal(notAnArray.ok, true)
  if (notAnArray.ok) assert.deepEqual([...notAnArray.document.coreSkills], [])
})

test('a monitoring notice URL must carry the https scheme and a host', () => {
  const usable = parsePolicyLimitsDocument({
    restrictions: {},
    monitoring_notice: { text: 'x', url: 'https://example.invalid/notice' },
  })
  assert.equal(usable.ok, true)
  if (usable.ok) {
    assert.deepEqual(usable.document.monitoringNotice, { text: 'x', url: 'https://example.invalid/notice' })
  }

  // The url FIELD catches to null: an unusable url keeps the notice (and its text), so the
  // document stays unsettled instead of losing the gate.
  for (const url of ['http://example.invalid', 'https://', 'https://exa mple.invalid', 'not a url']) {
    const parsed = parsePolicyLimitsDocument({ restrictions: {}, monitoring_notice: { text: 'x', url } })
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.deepEqual(parsed.document.monitoringNotice, { text: 'x', url: null }, `expected ${url} to drop only the url`)
  }
  // A missing or null url is allowed: the pinned schema does not require one.
  const withoutUrl = parsePolicyLimitsDocument({ restrictions: {}, monitoring_notice: { text: 'x' } })
  if (withoutUrl.ok) assert.deepEqual(withoutUrl.document.monitoringNotice, { text: 'x', url: null })
})

test('__proto__ and other unusual keys stay own data keys in the projection and the hash', async () => {
  const body = JSON.parse('{"restrictions":{"__proto__":{"allowed":true},"enforce_a":{"allowed":true}}}') as Record<string, unknown>
  const parsed = parsePolicyLimitsDocument(body)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const restrictions = parsed.document.restrictions as Record<string, unknown>
  assert.equal(Object.hasOwn(restrictions, '__proto__'), true, 'the key is an own property')
  assert.equal((restrictions['__proto__'] as { allowed: boolean }).allowed, true)
  assert.equal(Object.getPrototypeOf(restrictions), Object.prototype, 'the prototype itself is untouched')
  const canonical = canonicalPolicyJson(body)
  assert.equal(canonical.includes('"__proto__"'), true, 'the canonical text keeps the key')
  const withProto = await policyValidator(body)
  const withoutProto = await policyValidator({ restrictions: { enforce_a: { allowed: true } } })
  assert.notEqual(withProto, withoutProto, 'and so does the hash')
})

/** The normalized text of one notice fixture. */
function noticeText(text: string): string | null {
  const parsed = parsePolicyLimitsDocument({ restrictions: {}, monitoring_notice: { text, url: null } })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return null
  return parsed.document.monitoringNotice?.text ?? null
}

test('a notice text drops the pinned character classes', () => {
  const cases: Array<[string, string]> = [
    ['Policy\u0000notice', 'Policynotice'],
    ['a\u007Fb', 'ab'],
    ['a\u200Bb', 'ab'],
    ['a\u2028b', 'ab'],
    ['a\u2800b', 'ab'],
    ['a\uE000b', 'ab'],
    ['a\uFFF9b', 'ab'],
    ['a\uD800b', 'ab'],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(noticeText(raw), expected, `expected ${JSON.stringify(raw)} to normalize to ${JSON.stringify(expected)}`)
  }
})

test('a notice text removes escape sequences whole, not only their introducer', () => {
  assert.equal(noticeText('\u001B[31mred\u001B[0m'), 'red')
  assert.equal(noticeText('\u001B]8;;https://example.invalid\u0007link\u001B]8;;\u0007'), 'link')
})

test('a notice text keeps the emoji joiners and drops a joiner run that only leads', () => {
  assert.equal(noticeText('a\u200Db'), 'a\u200Db', 'a ZWJ between two characters is a joiner, not noise')
  assert.equal(noticeText('\uD83D\uDC68\u200D\uD83D\uDC69'), '\uD83D\uDC68\u200D\uD83D\uDC69', 'an emoji ZWJ sequence survives intact')
  assert.equal(noticeText('\u200Ex'), 'x', 'a format mark outside the three joiners is dropped')
  assert.equal(noticeText('\u200D\u200Dx'), 'x', 'a joiner run with nothing before it is dropped')
  assert.equal(noticeText(' \u200D\u200Dx'), ' x', 'and so is one that follows whitespace')
})

test('the notice text bound is checked on the raw member, before normalization', () => {
  const overBound = parsePolicyLimitsDocument({
    restrictions: {},
    monitoring_notice: { text: `${'x'.repeat(500)}\u200B`, url: null },
  })
  assert.equal(overBound.ok, true)
  if (overBound.ok) {
    assert.equal(overBound.document.monitoringNotice, null, '501 raw code units is over the bound even though it normalizes to 500')
  }
  assert.equal(noticeText('x'.repeat(500)), 'x'.repeat(500))
})

test('a notice url carrying an unusable code point drops only the url', () => {
  for (const url of [
    'https://example.invalid/\u200B',
    'https://example.invalid/\u2028',
    'https://example.invalid/\u009B',
    'https://example.invalid/\uD800',
    'https://example.invalid/\u{10EEEE}',
  ]) {
    const parsed = parsePolicyLimitsDocument({ restrictions: {}, monitoring_notice: { text: 'x', url } })
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.deepEqual(parsed.document.monitoringNotice, { text: 'x', url: null }, `expected ${JSON.stringify(url)} to drop only the url`)
    }
  }
  // The pinned refine refuses those code points and nothing broader: a private-use code point
  // and a combining mark are outside it, so they stay usable.
  for (const url of ['https://example.invalid/\uE000', 'https://example.invalid/a\u0301b']) {
    const parsed = parsePolicyLimitsDocument({ restrictions: {}, monitoring_notice: { text: 'x', url } })
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.deepEqual(parsed.document.monitoringNotice, { text: 'x', url })
  }
})

test('a notice with a dropped url keeps its normalized text and stays unsettled', () => {
  const parsed = parsePolicyLimitsDocument({
    restrictions: {},
    monitoring_notice: { text: 'patch\u0000 required', url: 'https://exa\u200Bmple.invalid' },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.document.monitoringNotice, { text: 'patch required', url: null })
  assert.equal(isPolicySettled(parsed.document), false)
})
