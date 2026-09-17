// Local-day keys (src/shared/days.ts): key construction, calendar arithmetic
// across month/year/DST seams, and the malformed-input null paths.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DAY_KEY_RE, dayKeyOf, mondayOfWeek, shiftDayKey } from '../../src/shared/days'

describe('dayKeyOf', () => {
  test('keys a local instant as YYYY-MM-DD with zero padding', () => {
    // Local noon is deterministic in every timezone.
    assert.equal(dayKeyOf(new Date(2026, 8, 16, 12).getTime()), '2026-09-16')
    assert.equal(dayKeyOf(new Date(2026, 0, 5, 12).getTime()), '2026-01-05')
    assert.equal(dayKeyOf(new Date(2026, 11, 25, 12).getTime()), '2026-12-25')
  })

  test('keys local midnight to the new day', () => {
    assert.equal(dayKeyOf(new Date(2026, 0, 2, 0, 0, 0).getTime()), '2026-01-02')
  })

  test('non-finite and out-of-range instants key null', () => {
    assert.equal(dayKeyOf(Number.NaN), null)
    assert.equal(dayKeyOf(Number.POSITIVE_INFINITY), null)
    assert.equal(dayKeyOf(1e30), null, 'outside the representable date range')
    assert.equal(dayKeyOf(-2 * 86_400_000), null, 'before the epoch in every timezone')
    assert.equal(dayKeyOf(new Date(10000, 0, 1).getTime()), null, 'past the four-digit year')
  })
})

describe('shiftDayKey', () => {
  test('advances and retreats across month and year boundaries', () => {
    assert.equal(shiftDayKey('2026-09-16', 1), '2026-09-17')
    assert.equal(shiftDayKey('2026-09-16', -1), '2026-09-15')
    assert.equal(shiftDayKey('2026-01-31', 1), '2026-02-01')
    assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28')
    assert.equal(shiftDayKey('2027-01-01', -1), '2026-12-31')
    assert.equal(shiftDayKey('2024-02-28', 1), '2024-02-29', 'leap day kept')
  })

  test('malformed keys yield null instead of a rolled-over date', () => {
    assert.equal(shiftDayKey('garbage', 1), null)
    assert.equal(shiftDayKey('2026-13-01', 1), null, 'month 13 would roll over')
    assert.equal(shiftDayKey('2026-02-30', 1), null, 'February 30th does not exist')
    assert.equal(shiftDayKey('2026-9-6', 1), null, 'unpadded fields fail the shape')
  })
})

describe('mondayOfWeek', () => {
  test('every weekday maps to its week’s Monday (2026-09-14 was one)', () => {
    assert.equal(mondayOfWeek('2026-09-14'), '2026-09-14', 'Monday itself')
    assert.equal(mondayOfWeek('2026-09-16'), '2026-09-14', 'Wednesday')
    assert.equal(mondayOfWeek('2026-09-20'), '2026-09-14', 'Sunday belongs to the same Monday-first week')
    assert.equal(mondayOfWeek('2026-09-21'), '2026-09-21', 'the next week starts Monday')
  })

  test('malformed keys yield null', () => {
    assert.equal(mondayOfWeek('junk'), null)
    assert.equal(mondayOfWeek('2026-02-30'), null)
  })
})

describe('DAY_KEY_RE', () => {
  test('matches the emitted shape only', () => {
    assert.equal(DAY_KEY_RE.test('2026-09-16'), true)
    assert.equal(DAY_KEY_RE.test('2026-9-16'), false)
    assert.equal(DAY_KEY_RE.test('2026-09-16T00:00:00'), false)
  })
})
