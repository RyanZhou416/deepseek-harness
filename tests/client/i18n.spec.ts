import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH, type DictKey } from '../../src/client/i18n'

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
}

describe('dictionaries', () => {
  test('every value is a non-empty string', () => {
    for (const dict of [DICT_ZH, DICT_EN]) {
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', key)
        assert.ok(value.length > 0, key)
      }
    }
  })

  test('interpolation placeholders agree between locales for every key', () => {
    for (const key of Object.keys(DICT_EN) as DictKey[]) {
      if (key === 'block.line') {
        assert.deepEqual(placeholders(DICT_ZH[key]), ['n'])
        assert.deepEqual(placeholders(DICT_EN[key]), [])
        continue
      }
      assert.deepEqual(placeholders(DICT_ZH[key]), placeholders(DICT_EN[key]), key)
    }
  })
})
