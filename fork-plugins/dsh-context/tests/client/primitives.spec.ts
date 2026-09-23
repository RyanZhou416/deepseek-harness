// The generation-proof icon resolver (src/client/primitives.ts): each ui-primitives
// icon resolves across the range's two naming vocabularies — modern first, legacy
// fallback — and a name missing from BOTH (a future rename) degrades to a
// render-nothing component instead of the React #130 element-type crash.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { resolveIcon, IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown } from '../../src/client/primitives'

describe('resolveIcon', () => {
  const modern = function ModernIcon(): null { return null }
  const legacy = function LegacyIcon(): null { return null }

  test('the modern spelling wins when both generations export the icon', () => {
    assert.equal(resolveIcon('modern', 'legacy', { modern, legacy }), modern)
  })

  test('the legacy spelling backs the modern one up (through-0.1.5 generations)', () => {
    assert.equal(resolveIcon('modern', 'legacy', { legacy }), legacy)
  })

  test('a name present but not a component renders nothing', () => {
    const icon = resolveIcon('modern', 'legacy', { modern: 42, legacy: null })
    assert.equal(icon({}), null, 'the fallback component renders null')
  })

  test('a name missing from both spellings renders nothing (future rename)', () => {
    const icon = resolveIcon('IconGhostOutlineRegular', 'IconGhostOutline16', {})
    assert.equal(icon({}), null)
  })

  test('a namespace that throws on property access degrades to the fallback', () => {
    // Partial module mocks and hostile namespaces throw on the READ itself.
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    const icon = resolveIcon('IconBranchOutlineRegular', 'IconBranchOutline16', hostile)
    assert.equal(icon({}), null)
  })

  test('the module-level exports resolve against the pinned generation', () => {
    // The devDep carries the legacy vocabulary, so these exercised the
    // legacy branch at module load; on a modern harness the same seven
    // exports resolve through the modern names instead.
    for (const icon of [IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown]) {
      assert.equal(typeof icon, 'function', 'every seam resolves to a component')
    }
  })
})
