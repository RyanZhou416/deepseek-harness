/**
 * The quota observation core, on synthetic inputs only: one raw fact parse, the legacy
 * projection that injects the providers' shared reset reader, and the strict projection
 * that normalizes each source's own unit exactly once. No network, no headers object.
 *
 * The core is framework-independent, so the static assertions below read its own source
 * text: importing it into a Node test process cannot prove it has no Node import, and a
 * duplicate header parse is invisible from a single call's return value.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sourceUrl } from './source-url.js'

import {
  CLAUDE_UNIFIED_HEADER_PREFIX,
  CLAUDE_UNIFIED_MEMBER_SUFFIXES,
  CLAUDE_UNIFIED_WINDOW_PREFIXES,
  CLAUDE_UNIFIED_WINDOW_SUFFIXES,
  parseRawFacts,
  parseUsageJson,
  projectLegacy,
  projectStrict,
} from '../src/claude-core/quota-observation.js'
import type { QuotaHeaderSource } from '../src/claude-core/quota-observation.js'
import { resetInstantFromValue } from '../src/providers/rate-limit.js'
import { parseUnifiedRateLimit } from '../src/providers/unified-rate-limit.js'

const SOURCE_URL = sourceUrl('claude-core/quota-observation.ts')
const UNIFIED_PREFIX = CLAUDE_UNIFIED_HEADER_PREFIX
const NOW = 1_786_000_000_000

/**
 * The shared reset reader as the core's port, exactly as the plugin's wrapper injects it.
 * @param rawText - the member text the core read.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined.
 */
const resolveReset = (rawText: string | undefined, now: number): number | undefined =>
  resetInstantFromValue(rawText === undefined ? null : rawText, now)

/** A read-only header source over a plain map, counting every read it answers. */
function countingSource(values: Record<string, string>): { source: QuotaHeaderSource; reads: () => number } {
  let reads = 0
  return {
    source: {
      get: (name: string): string | undefined => {
        reads += 1
        return values[name]
      },
    },
    reads: () => reads,
  }
}

/** The unified family's 429 shape, as the existing production spec states it. */
const REJECTED = {
  [`${UNIFIED_PREFIX}status`]: 'rejected',
  [`${UNIFIED_PREFIX}reset`]: '1786147200',
  [`${UNIFIED_PREFIX}representative-claim`]: 'seven_day',
  [`${UNIFIED_PREFIX}overage-status`]: 'rejected',
  [`${UNIFIED_PREFIX}overage-reset`]: '1786147200',
  [`${UNIFIED_PREFIX}overage-utilization`]: '1',
  [`${UNIFIED_PREFIX}overage-surpassed-threshold`]: '1',
  [`${UNIFIED_PREFIX}overage-disabled-reason`]: 'org_spend_cap_reached',
  [`${UNIFIED_PREFIX}5h-utilization`]: '0.82',
  [`${UNIFIED_PREFIX}5h-reset`]: '1786100000',
  [`${UNIFIED_PREFIX}5h-surpassed-threshold`]: '0.75',
}

test('one fact parse reads each member once and classifies absent, blank, unusable and zero apart', () => {
  const { source, reads } = countingSource({
    [`${UNIFIED_PREFIX}status`]: 'allowed',
    // Stated and blank: the same as absent, and never a numeric zero.
    [`${UNIFIED_PREFIX}reset`]: '   ',
    // Stated, present, and not a number.
    [`${UNIFIED_PREFIX}representative-claim`]: 'seven_day',
    [`${UNIFIED_PREFIX}7d-utilization`]: '0',
    [`${UNIFIED_PREFIX}7d-surpassed-threshold`]: 'NaN',
  })
  const facts = parseRawFacts(source)
  const firstRead = reads()
  assert.ok(firstRead > 0, 'the parse reads the family')
  assert.equal(facts.members['status']?.presence, 'present')
  assert.equal(facts.members['status']?.rawText, 'allowed')
  assert.equal(facts.members['status']?.parsedNumber, undefined, 'a status token is not a number')
  assert.equal(facts.members['reset']?.presence, 'absent', 'a blank member is absent')
  assert.equal(facts.members['reset']?.rawText, undefined)
  assert.equal(facts.members['overage-status']?.presence, 'absent', 'a member the source omitted is absent')
  const zero = facts.windows.find(window => window.window === '7d')?.utilization
  assert.equal(zero?.presence, 'present-zero', 'a stated zero is its own presence')
  assert.equal(zero?.parsedNumber, 0)
  const nan = facts.windows.find(window => window.window === '7d')?.surpassedThreshold
  assert.equal(nan?.presence, 'invalid', 'unusable text is stated and unusable, not present')
  assert.equal(nan?.rawText, 'NaN')
  assert.equal(nan?.parsedNumber, undefined, 'unusable text carries no number')
  assert.deepEqual(facts.windows.map(window => window.window), ['5h', '7d', '7d_oi', 'overage'])
  // The wrapper's family gate reads the same names the core does, from one vocabulary: a name
  // the core reads but the gate does not would make a report invisible rather than invalid.
  assert.deepEqual(CLAUDE_UNIFIED_WINDOW_PREFIXES, ['5h', '7d', '7d_oi', 'overage'])
  assert.ok(CLAUDE_UNIFIED_MEMBER_SUFFIXES.includes('status'))
  assert.ok(CLAUDE_UNIFIED_WINDOW_SUFFIXES.includes('utilization'))
})

test('the projectors consume the facts they are handed and read no header a second time', () => {
  const { source, reads } = countingSource(REJECTED)
  const facts = parseRawFacts(source)
  const afterParse = reads()
  const legacy = projectLegacy(facts, { resolveReset, now: NOW })
  const strict = projectStrict(facts, { now: NOW })
  assert.equal(reads(), afterParse, 'neither projector touches the source')
  assert.equal(legacy.status, 'rejected')
  assert.equal(strict.length, 2, 'the 5h and overage windows both state a utilization')
  // One body of facts, two readings: the projectors differ in unit and encoding, not in how
  // many times the response was read.
  assert.deepEqual(strict[0], {
    source: 'ratelimit-headers',
    kind: '5h',
    scopeKind: 'account',
    normalizedPct: 82,
    unit: 'ratio',
    resetFormat: 'epoch-seconds',
    resetsAtMs: 1_786_100_000_000,
    observedAtMs: NOW,
  })
})

test('the legacy projection keeps every reset encoding the injected reader accepts', () => {
  const cases: [string, number | undefined][] = [
    // Epoch milliseconds are preserved, not multiplied by a thousand a second time.
    ['1786100000000', 1_786_100_000_000],
    ['1786100000', 1_786_100_000_000],
    ['6m0s', NOW + 360_000],
    ['Fri, 15 Jan 2027 10:30:00 GMT', Date.parse('Fri, 15 Jan 2027 10:30:00 GMT')],
    ['whenever', undefined],
  ]
  for (const [raw, expected] of cases) {
    const facts = parseRawFacts(countingSource({ [`${UNIFIED_PREFIX}5h-reset`]: raw }).source)
    const legacy = projectLegacy(facts, { resolveReset, now: NOW })
    assert.equal(legacy.windows[0]?.resetsAt, expected, `the reset '${raw}' resolves through the injected reader`)
  }
})

test('the legacy projection reproduces the plugin report field for field', () => {
  const facts = parseRawFacts(countingSource(REJECTED).source)
  const expected = parseUnifiedRateLimit(new Headers(REJECTED), NOW)
  assert.deepEqual(projectLegacy(facts, { resolveReset, now: NOW }), expected)
})

test('the legacy projection keeps a statusless report unstated rather than allowed', () => {
  const facts = parseRawFacts(countingSource({ [`${UNIFIED_PREFIX}5h-reset`]: '1786100000' }).source)
  const legacy = projectLegacy(facts, { resolveReset, now: NOW })
  assert.equal(legacy.status, 'other')
  assert.deepEqual(legacy.windows, [{ window: '5h', resetsAt: 1_786_100_000_000 }])
})

test('the strict projection normalizes the header ratio once and only converts epoch seconds', () => {
  const atCap = parseRawFacts(countingSource({ [`${UNIFIED_PREFIX}7d-utilization`]: '1' }).source)
  assert.equal(projectStrict(atCap, { now: NOW })[0]?.normalizedPct, 100, 'a ratio of one is 100 percent')
  const overCap = parseRawFacts(countingSource({ [`${UNIFIED_PREFIX}7d-utilization`]: '1.02' }).source)
  assert.equal(
    projectStrict(overCap, { now: NOW })[0]?.normalizedPct,
    102,
    'the strict projection converts and does not clamp',
  )
  const millis = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}5h-utilization`]: '0.5',
    // The header path states epoch seconds. A value already in milliseconds is not seconds,
    // and is not converted: guessing here would report an instant thirty thousand years out.
    [`${UNIFIED_PREFIX}5h-reset`]: '1786100000000',
  }).source)
  const [observation] = projectStrict(millis, { now: NOW })
  assert.equal(observation?.resetFormat, 'unknown')
  assert.equal(observation?.resetsAtMs, undefined)
  assert.equal(observation?.normalizedPct, 50, 'the utilization is unaffected by the unusable reset')
  // An explicit zero is `1970-01-01T00:00:00Z`: a stated instant, not an absent one. Whether it
  // is still useful is the caller's freshness question, which this parser does not decide.
  const epochZero = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}5h-utilization`]: '0.5',
    [`${UNIFIED_PREFIX}5h-reset`]: '0',
  }).source)
  const [atEpoch] = projectStrict(epochZero, { now: NOW })
  assert.equal(atEpoch?.resetsAtMs, 0)
  assert.equal(atEpoch?.resetFormat, 'epoch-seconds')
  assert.equal(atEpoch?.normalizedPct, 50, 'the utilization is independent of the reset')
  // The declared range is the last second of the last four-digit UTC year. The bound and the
  // value one second past it are decided by the application, not by the service.
  const atBound = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}5h-utilization`]: '0.5',
    [`${UNIFIED_PREFIX}5h-reset`]: '253402300799',
  }).source)
  assert.equal(projectStrict(atBound, { now: NOW })[0]?.resetsAtMs, 253_402_300_799_000)
  const pastBound = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}5h-utilization`]: '0.5',
    [`${UNIFIED_PREFIX}5h-reset`]: '253402300800',
  }).source)
  assert.equal(
    projectStrict(pastBound, { now: NOW })[0]?.resetsAtMs,
    undefined,
    'a value past the four-digit year bound is not re-read as milliseconds',
  )
  assert.equal(projectStrict(pastBound, { now: NOW })[0]?.resetFormat, 'unknown')
  // Unsupported encodings stay unknown rather than being normalized into a plausible instant.
  for (const unsupported of ['-1', '1786100000.5', '1.7861e12', '6m0s', 'Fri, 15 Jan 2027 10:30:00 GMT']) {
    const facts = parseRawFacts(countingSource({
      [`${UNIFIED_PREFIX}5h-utilization`]: '0.5',
      [`${UNIFIED_PREFIX}5h-reset`]: unsupported,
    }).source)
    const [read] = projectStrict(facts, { now: NOW })
    assert.equal(read?.resetsAtMs, undefined, `strict does not convert '${unsupported}'`)
    assert.equal(read?.resetFormat, 'unknown')
  }
})

test('a window with no usable utilization produces no strict observation', () => {
  const facts = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}status`]: 'rejected',
    [`${UNIFIED_PREFIX}7d-reset`]: '1786147200',
  }).source)
  assert.deepEqual(projectStrict(facts, { now: NOW }), [], 'no stated utilization is not a zero-percent window')
  const blank = parseRawFacts(countingSource({ [`${UNIFIED_PREFIX}7d-utilization`]: ' ' }).source)
  assert.deepEqual(projectStrict(blank, { now: NOW }), [], 'a blank utilization is absent, not zero')
})

test('the numeric domain is checked on both sides of the wire', () => {
  // The port and the observation time are typed numbers, so a non-finite value is the only
  // unusable input that can reach them: the projector must not accept it as an observation.
  const facts = parseRawFacts(countingSource({ [`${UNIFIED_PREFIX}7d-utilization`]: '0.5' }).source)
  assert.throws(() => projectStrict(facts, { now: Number.NaN }), /finite observation time/)
  assert.throws(
    () => projectLegacy(facts, { resolveReset, now: Number.POSITIVE_INFINITY }),
    /finite observation time/,
  )
  // A response whose numeric member is not a finite number is wire input, not a typed value,
  // and it is classified rather than coerced.
  const wire = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}7d-utilization`]: 'Infinity',
    [`${UNIFIED_PREFIX}7d-surpassed-threshold`]: 'not-a-number',
  }).source)
  assert.deepEqual(projectStrict(wire, { now: NOW }), [], 'an unusable utilization yields no reading')
  const legacy = projectLegacy(wire, { resolveReset, now: NOW })
  assert.deepEqual(legacy.windows, [], 'a window with no usable member is not a window')
})

test('a usage document yields its legacy windows and, on request, strict observations', () => {
  const body = {
    five_hour: { utilization: 6, resets_at: '2026-04-08T18:59:59Z' },
    seven_day: { utilization: 35, resets_at: '2026-04-14T16:59:59Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 21, resets_at: null },
  }
  const legacy = parseUsageJson(body, NOW)
  assert.deepEqual(legacy.windows, [
    { kind: 'session', usedPercent: 6, resetsAt: Date.parse('2026-04-08T18:59:59Z') },
    { kind: 'weekly', usedPercent: 35, resetsAt: Date.parse('2026-04-14T16:59:59Z') },
    { kind: 'weekly', scope: 'Sonnet', usedPercent: 21 },
  ])
  // The unstated window (`seven_day_opus` above, null) and the window with an explicit null
  // reset are absent information, not rejected values: nothing is counted for them and no date
  // is invented.
  assert.equal(legacy.issues, undefined)
  assert.equal(legacy.rejectedWindowKeys, undefined)
  const strict = parseUsageJson(body, NOW, { strictObservations: true })
  assert.deepEqual(strict.windows, legacy.windows)
  assert.deepEqual(strict.strictObservations, [
    {
      source: 'usage-json',
      kind: '5h',
      scopeKind: 'account',
      normalizedPct: 6,
      unit: 'percent',
      resetFormat: 'iso',
      resetsAtMs: Date.parse('2026-04-08T18:59:59Z'),
      observedAtMs: NOW,
    },
    {
      source: 'usage-json',
      kind: '7d',
      scopeKind: 'account',
      normalizedPct: 35,
      unit: 'percent',
      resetFormat: 'iso',
      resetsAtMs: Date.parse('2026-04-14T16:59:59Z'),
      observedAtMs: NOW,
    },
    {
      source: 'usage-json',
      kind: '7d',
      // The key names a model family, which is the one model dimension the source classifies.
      scopeKind: 'model-family',
      family: 'sonnet',
      normalizedPct: 21,
      unit: 'percent',
      resetFormat: 'unknown',
      observedAtMs: NOW,
    },
  ])
})

test('a missing window, an explicit null and an unusable percent stay apart', () => {
  const body = {
    // A stated zero percent: a reading, not an absent window.
    five_hour: { utilization: 0 },
    // Explicitly null here, absent (never stated) in the sibling case, and stated-but-unreadable
    // as `{}` in the case below: three different states, and only the third is counted.
    seven_day: null,
    seven_day_sonnet: { utilization: Number.NaN },
    // Recognized, and not mapped: neither this key's extent nor its scope is established, so a
    // reading here would claim more than the source states.
    seven_day_oauth_apps: { utilization: 5 },
    cinder_cove: { utilization: 3 },
  }
  const parsed = parseUsageJson(body, NOW)
  assert.deepEqual(parsed.windows, [
    { kind: 'session', usedPercent: 0 },
  ])
  // The null window is an unavailable observation and counts nothing; the stated object with an
  // unusable percent and the two unsupported keys are the counted rejections.
  assert.equal(parsed.rejectedWindowKeys, 3, 'the NaN percent and both unsupported keys are counted')
  // Each rejected value counts once, under the code that names why it could not be read.
  assert.deepEqual(parsed.issues, { 'percent-missing': 1, 'window-key-unsupported': 2 })
})

test('an empty window object is an unreadable window, not an absent one', () => {
  // `{}` states a window whose percent is missing, which is counted; a null or absent window is
  // no observation at all. Neither becomes a zero-percent reading.
  const parsed = parseUsageJson({ five_hour: {} }, NOW, { strictObservations: true })
  assert.deepEqual(parsed.windows, [])
  assert.deepEqual(parsed.strictObservations, [])
  assert.equal(parsed.rejectedWindowKeys, 1)
  assert.deepEqual(parsed.issues, { 'percent-missing': 1 })
})

test('the nested limits array wins when it carries an entry, and one body yields one set of windows', () => {
  const body = {
    five_hour: { utilization: 99 },
    limits: [
      { kind: 'session', percent: 0, resets_at: '2026-04-08T18:59:59Z' },
      { kind: 'weekly_all', percent: 100 },
      { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped' },
    ],
  }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  assert.deepEqual(parsed.windows, [
    { kind: 'session', usedPercent: 0, resetsAt: Date.parse('2026-04-08T18:59:59Z') },
    { kind: 'weekly', usedPercent: 100 },
    { kind: 'weekly', scope: 'Opus', usedPercent: 7 },
  ])
  assert.equal(parsed.windows.length, 3, 'the flat 99 percent window is not also reported')
  assert.equal(parsed.strictObservations?.length, 3)
  const scoped = parsed.strictObservations?.[2]
  assert.equal(scoped?.kind, '7d', 'a model-scoped window keeps the same token as the account week')
  assert.equal(
    scoped?.scopeKind,
    'unknown-scope',
    'and it is never equivalent to the account week: the row names no model this build can bind',
  )
  assert.equal(scoped?.family, undefined, 'a display name is never reported as a family or an id')
  assert.equal(scoped?.normalizedPct, 7, 'a percent is taken as stated, never multiplied by a hundred')
  const anonymous = parsed.strictObservations?.[1]
  assert.equal(anonymous?.kind, '7d')
  assert.equal(anonymous?.scopeKind, 'account', 'the whole-account week is the account reading')
  assert.equal(anonymous?.resetFormat, 'unknown', 'a missing reset states no encoding')
  assert.deepEqual(parsed.issues, { 'percent-missing': 1 })
})

test('a model-scoped weekly window is never reported as the account weekly window', () => {
  const body = { limits: [
    { kind: 'weekly_all', percent: 40 },
    { kind: 'weekly_scoped', percent: 8, scope: { model: { display_name: 'Opus' } } },
    { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Sonnet' } } },
  ] }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  const observations = parsed.strictObservations ?? []
  assert.deepEqual(observations.map(observation => [observation.kind, observation.scopeKind, observation.family]), [
    ['7d', 'account', undefined],
    ['7d', 'unknown-scope', undefined],
    ['7d', 'unknown-scope', undefined],
  ], 'the two model rows and the account window share a token and are still distinguishable')
  assert.notDeepEqual(observations[1], observations[2], 'two model rows that differ in percent stay two readings')
  assert.notDeepEqual(observations[0], observations[2], 'a model row is never the account window')
})

test('a percent outside the application range is refused for strict and kept for legacy', () => {
  const body = { limits: [{ kind: 'session', percent: -1 }, { kind: 'weekly_all', percent: 101 }] }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  // The legacy list has only ever required a finite number, and the range check is this
  // application's own: it decides what is `known`, not which windows exist.
  assert.deepEqual(parsed.windows, [
    { kind: 'session', usedPercent: -1 },
    { kind: 'weekly', usedPercent: 101 },
  ])
  assert.deepEqual(parsed.strictObservations, [], 'neither reading is known')
  assert.deepEqual(parsed.issues, { 'percent-out-of-range': 2 })
})

test('QS-N1: an account week and the model-family weeks are separate readings', () => {
  const body = {
    five_hour: { utilization: 6 },
    seven_day: { utilization: 35 },
    seven_day_opus: { utilization: 12, resets_at: '2026-04-14T16:59:59Z' },
    seven_day_sonnet: { utilization: 21, resets_at: '2026-04-14T16:59:59Z' },
  }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  const shape = (observations: readonly { kind: string; scopeKind: string; family?: string }[]): [string, string, string | undefined][] =>
    observations.map(observation => [observation.kind, observation.scopeKind, observation.family])
  assert.deepEqual(shape(parsed.strictObservations ?? []), [
    ['5h', 'account', undefined],
    ['7d', 'account', undefined],
    ['7d', 'model-family', 'opus'],
    ['7d', 'model-family', 'sonnet'],
  ], 'a model-family week is never marked account, and the account week carries no family')
  // The legacy label is unchanged by any of this: it is the provider's wording for the window.
  assert.deepEqual(parsed.windows.map(window => window.scope), [undefined, undefined, 'Opus', 'Sonnet'])
})

test('QS-N2: two unidentified model rows stay two readings, whatever they share', () => {
  const body = { limits: [
    { kind: 'weekly_scoped', percent: 8, resets_at: '2026-04-14T16:59:59Z', scope: { model: { display_name: 'Opus' } } },
    { kind: 'weekly_scoped', percent: 8, resets_at: '2026-04-14T16:59:59Z', scope: { model: { display_name: 'Opus' } } },
  ] }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  const observations = parsed.strictObservations ?? []
  assert.equal(observations.length, 2, 'the same label, reset and scope kind never collapse two source rows')
  assert.deepEqual(observations.map(observation => observation.scopeKind), ['unknown-scope', 'unknown-scope'])
  assert.equal(new Set(observations).size, 2, 'nor do they become one object')
})

test('QS-N3: a display name is never an identity, even one spelled like a catalog id', () => {
  const body = { limits: [
    { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'claude-opus-4-1' } } },
  ] }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  const [observation] = parsed.strictObservations ?? []
  assert.equal(observation?.scopeKind, 'unknown-scope')
  assert.equal(observation?.family, undefined, 'a row display name is not a family either')
  assert.ok(
    !JSON.stringify(observation).includes('claude-opus-4-1'),
    'no catalog-looking display name reaches the strict reading',
  )
  assert.equal(
    parsed.windows[0]?.scope,
    'claude-opus-4-1',
    'the legacy surface keeps showing the display name the response spelled',
  )
})

test('QS-N4: the overage-included week keeps its own scope, key and observation time', () => {
  const facts = parseRawFacts(countingSource({
    [`${UNIFIED_PREFIX}status`]: 'allowed_warning',
    [`${UNIFIED_PREFIX}7d-utilization`]: '0.6',
    [`${UNIFIED_PREFIX}7d-reset`]: '1786147200',
    [`${UNIFIED_PREFIX}7d_oi-utilization`]: '0.9',
    [`${UNIFIED_PREFIX}7d_oi-reset`]: '1786233600',
  }).source)
  const observations = projectStrict(facts, { now: NOW })
  assert.deepEqual(
    observations.map(observation => [observation.kind, observation.scopeKind, observation.resetsAtMs, observation.observedAtMs]),
    [
      ['7d', 'account', 1_786_147_200_000, NOW],
      ['7d_oi', 'unknown-scope', 1_786_233_600_000, NOW],
    ],
    'the aggregate status neither merges the windows nor restates the overage-included week as account',
  )
  assert.equal(observations[0]?.normalizedPct, 60, 'no minimum or maximum replaces either window')
  assert.equal(observations[1]?.normalizedPct, 90)
  const legacy = projectLegacy(facts, { resolveReset, now: NOW })
  assert.deepEqual(
    legacy.windows.map(window => window.window),
    ['7d', '7d_oi'],
    'the legacy report keeps both windows under their own keys',
  )
})

test('QS-N5: a family window states its family, never a guess about the current model', () => {
  const parsed = parseUsageJson({ seven_day_sonnet: { utilization: 21 } }, NOW, { strictObservations: true })
  const [observation] = parsed.strictObservations ?? []
  assert.equal(observation?.family, 'sonnet', 'the key states the family, and that is all it states')
  assert.equal(observation?.scopeKind, 'model-family')
  assert.ok(
    !JSON.stringify(observation).includes('claude'),
    'nothing in the reading claims which model a request may use',
  )
  // A window this module maps carries no family: the session and account weeks are the account's.
  const session = parseUsageJson({ five_hour: { utilization: 6 } }, NOW, { strictObservations: true })
  assert.equal(session.strictObservations?.[0]?.scopeKind, 'account', 'the session window is the account one')
  assert.equal(session.strictObservations?.[0]?.family, undefined, 'and it carries no family')
})

test('QS-N6: only the account windows are the ones a scope-narrow caller may take', () => {
  // This project has no Mac IPC adapter, so the filter a future consumer would run is not built
  // here: the case reads the parser's own output and asserts which readings such a caller may
  // take and which it must withhold.
  const parsed = parseUsageJson({
    five_hour: { utilization: 6 },
    seven_day: { utilization: 35 },
    seven_day_opus: { utilization: 12 },
  }, NOW, { strictObservations: true })
  const observations = parsed.strictObservations ?? []
  const eligible = observations.filter(observation => observation.scopeKind === 'account')
  assert.deepEqual(
    eligible.map(observation => observation.kind),
    ['5h', '7d'],
    'the authenticated context\'s own session and all-model weeks are the eligible readings',
  )
  const withheld = observations.filter(observation => observation.scopeKind !== 'account')
  assert.deepEqual(
    withheld.map(observation => [observation.kind, observation.scopeKind, observation.family]),
    [['7d', 'model-family', 'opus']],
    'a family reading is withheld rather than rewritten into an account window',
  )
  assert.ok(
    withheld.every(observation => observation.normalizedPct !== 0),
    'withholding does not turn a reading into a fabricated zero',
  )
  assert.equal(eligible.length + withheld.length, observations.length, 'every reading is either taken or withheld')

  // The same caller facing a nested model row: `limits` wins, so the only reading is unscoped.
  const nested = parseUsageJson(
    { limits: [{ kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Opus' } } }] },
    NOW,
    { strictObservations: true },
  )
  assert.deepEqual(
    nested.strictObservations?.map(observation => [observation.kind, observation.scopeKind]),
    [['7d', 'unknown-scope']],
    'a row with no stable identity is withheld as well',
  )

  const onlyUnsupported = parseUsageJson(
    { seven_day_oauth_apps: { utilization: 5 }, cinder_cove: { utilization: 3 } },
    NOW,
    { strictObservations: true },
  )
  assert.deepEqual(onlyUnsupported.strictObservations, [], 'no reading is invented for keys with no established extent')
  assert.deepEqual(onlyUnsupported.windows, [], 'and none is forced into the legacy weekly list either')
})

test('a flat percent outside the application range keeps legacy and yields no strict reading', () => {
  const body = {
    five_hour: { utilization: 140 },
    seven_day: { utilization: -3 },
  }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  assert.deepEqual(parsed.windows, [
    { kind: 'session', usedPercent: 140 },
    { kind: 'weekly', usedPercent: -3 },
  ], 'the legacy list has only ever required a finite number')
  assert.deepEqual(parsed.strictObservations, [], 'neither is a known reading')
  assert.deepEqual(parsed.issues, { 'percent-out-of-range': 2 })
})

test('the legacy reset stays parseable where the strict reading needs the ISO subset', () => {
  const legacyOnly: [string, number][] = [
    // An HTTP-date states its zone, so both the runtime and the assertion agree everywhere.
    ['Fri, 15 Jan 2027 10:30:00 GMT', Date.parse('Fri, 15 Jan 2027 10:30:00 GMT')],
    // The runtime normalizes an impossible day into the next month; the legacy surfaces have
    // always shown that instant, and this change does not narrow them.
    ['2026-02-30T00:00:00Z', Date.parse('2026-02-30T00:00:00Z')],
  ]
  for (const [value, expected] of legacyOnly) {
    const body = { five_hour: { utilization: 12, resets_at: value } }
    const parsed = parseUsageJson(body, NOW, { strictObservations: true })
    assert.equal(parsed.windows[0]?.resetsAt, expected, `legacy still reads '${value}'`)
    const [observation] = parsed.strictObservations ?? []
    assert.equal(observation?.resetFormat, 'unknown', `strict does not call '${value}' an ISO instant`)
    assert.equal(observation?.resetsAtMs, undefined)
  }
  const iso = parseUsageJson(
    { five_hour: { utilization: 12, resets_at: '2026-04-08T18:59:59.500+02:00' } },
    NOW,
    { strictObservations: true },
  )
  const [qualified] = iso.strictObservations ?? []
  assert.equal(qualified?.resetFormat, 'iso', 'an offset-qualified instant is the subset strict accepts')
  assert.equal(qualified?.resetsAtMs, Date.parse('2026-04-08T18:59:59.500+02:00'))
  assert.equal(iso.windows[0]?.resetsAt, Date.parse('2026-04-08T18:59:59.500+02:00'))
})

test('an impossible calendar date is not an ISO instant', () => {
  const impossible = parseUsageJson(
    { five_hour: { utilization: 12, resets_at: '2026-02-30T00:00:00Z' } },
    NOW,
    { strictObservations: true },
  )
  assert.equal(impossible.strictObservations?.[0]?.resetFormat, 'unknown')
  assert.equal(impossible.strictObservations?.[0]?.resetsAtMs, undefined)
  // A leap day that exists is an instant; the same shape one day off in a common year is not.
  const leap = parseUsageJson(
    { five_hour: { utilization: 12, resets_at: '2028-02-29T00:00:00Z' } },
    NOW,
    { strictObservations: true },
  )
  assert.equal(leap.strictObservations?.[0]?.resetFormat, 'iso')
  const common = parseUsageJson(
    { five_hour: { utilization: 12, resets_at: '2027-02-29T00:00:00Z' } },
    NOW,
    { strictObservations: true },
  )
  assert.equal(common.strictObservations?.[0]?.resetFormat, 'unknown')
})

test('a numeric reset on the usage path is not read as epoch seconds', () => {
  const body = { five_hour: { utilization: 12, resets_at: 1786100000 } }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  assert.deepEqual(parsed.windows, [{ kind: 'session', usedPercent: 12 }])
  const [observation] = parsed.strictObservations ?? []
  assert.equal(observation?.resetFormat, 'unknown')
  assert.equal(observation?.resetsAtMs, undefined, 'a model-scoped seconds branch would not generalize here')
  assert.deepEqual(parsed.issues, { 'reset-shape-invalid': 1 })
})

test('an unrecognized top-level key is counted and never echoed', () => {
  const body = {
    five_hour: { utilization: 6 },
    secret_canary_window: { utilization: 6 },
    scope: { model: { display_name: 'display-canary' } },
  }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  assert.equal(parsed.unknownTopLevelKeys, 2)
  const rendered = JSON.stringify(parsed)
  assert.ok(!rendered.includes('secret_canary_window'), 'an unrecognized key name never leaves the parser')
  assert.ok(!rendered.includes('display-canary'), 'a display name never leaves the parser')
  // The counter is the only representation of that fact: no issue code duplicates it, so the
  // two totals are never added together.
  assert.equal(parsed.issues, undefined)
  const [observation] = parsed.strictObservations ?? []
  assert.notEqual(observation?.kind, 'unknown', 'the recognized window is still reported')
})

test('a display name rides the legacy label only, and never a strict scope', () => {
  const body = { limits: [{ kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'display-canary' } } }] }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  assert.equal(parsed.windows[0]?.scope, 'display-canary', 'the legacy surface still shows the provider label')
  const [observation] = parsed.strictObservations ?? []
  assert.deepEqual(observation, {
    source: 'usage-json',
    kind: '7d',
    scopeKind: 'unknown-scope',
    normalizedPct: 9,
    unit: 'percent',
    resetFormat: 'unknown',
    observedAtMs: NOW,
  }, 'the display name has no path into the strict reading')
})

test('a recognized key with no established extent stays unsupported on both projections', () => {
  const body = {
    seven_day_oauth_apps: { utilization: 5, resets_at: '2026-04-14T16:59:59Z' },
    cinder_cove: { utilization: 3 },
    five_hour: { utilization: 6 },
  }
  const parsed = parseUsageJson(body, NOW, { strictObservations: true })
  assert.deepEqual(parsed.windows, [{ kind: 'session', usedPercent: 6 }], 'legacy ignores both keys, as it always has')
  assert.deepEqual(
    parsed.strictObservations?.map(observation => [observation.kind, observation.scopeKind]),
    [['5h', 'account']],
    'no account reading is invented for a key whose extent is not established',
  )
  assert.equal(parsed.rejectedWindowKeys, 2)
  assert.deepEqual(parsed.issues, { 'window-key-unsupported': 2 })
})

test('a body that is not an object reports nothing rather than an empty window', () => {
  for (const body of [undefined, null, 'text', 4, true, []]) {
    assert.deepEqual(parseUsageJson(body, NOW), { windows: [] })
  }
})

test('the core reads no clock, keeps no module state and imports no runtime dependency', () => {
  const source = readFileSync(SOURCE_URL, 'utf8')
  assert.ok(!/from\s+['"]node:/.test(source), 'the core imports no Node built-in')
  assert.ok(!/Date\.now/.test(source), 'the observation time is injected, never read from the clock')
  assert.ok(!/ProviderId/.test(source), 'the core carries no provider route')
  assert.ok(!/^\s*(?:const|let|var)\s+\w+\s*=\s*new Map/m.test(source), 'no module-level table')
  // Comments name the modules this one deliberately does not import. The core is expected to
  // depend on nothing at all: adding any import specifier here fails this check.
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual(specifiers, [], 'the core imports nothing, not even a sibling module')
  for (const fn of ['parseRawFacts', 'projectLegacy', 'projectStrict', 'parseUsageJson']) {
    assert.ok(source.includes(`export function ${fn}`), `${fn} is one of the module's own entry points`)
  }
})
