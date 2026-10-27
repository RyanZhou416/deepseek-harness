/** Pool-listing validation and the id merge behind the page's sync control. */

import { describe, expect, it } from 'vitest'
import type { CcPoolModelDraft } from '../src/client/model-draft.ts'
import { mergePoolModels, readDiscoveredModels } from '../src/client/sync.ts'

/** One row as the page edits it. */
function draft(overrides: Partial<CcPoolModelDraft> = {}): CcPoolModelDraft {
  return {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: '1000000',
    maxTokens: '128000',
    defaultReasoning: 'medium',
    ...overrides,
  }
}

describe('readDiscoveredModels', () => {
  it('reports an empty listing instead of staging an empty catalogue', () => {
    expect(readDiscoveredModels([])).toEqual({ kind: 'problem', problem: 'syncEmpty' })
  })

  it('rejects an entry that is not an object or carries no usable id', () => {
    expect(readDiscoveredModels([null])).toEqual({ kind: 'problem', problem: 'syncInvalid' })
    expect(readDiscoveredModels([['claude-sonnet-5-5']])).toEqual({ kind: 'problem', problem: 'syncInvalid' })
    expect(readDiscoveredModels([{ name: 'No id' }])).toEqual({ kind: 'problem', problem: 'syncInvalid' })
    expect(readDiscoveredModels([{ id: 42 }])).toEqual({ kind: 'problem', problem: 'syncInvalid' })
    expect(readDiscoveredModels([{ id: '   ' }])).toEqual({ kind: 'problem', problem: 'syncInvalid' })
  })

  it('rejects the same model id listed twice, after trimming', () => {
    expect(readDiscoveredModels([
      { id: 'claude-sonnet-5-5' },
      { id: ' claude-sonnet-5-5 ' },
    ])).toEqual({ kind: 'problem', problem: 'syncDuplicate' })
  })

  it('normalizes ids and display names, falling back to the id', () => {
    expect(readDiscoveredModels([
      { id: ' claude-sonnet-5-5 ', name: '  Claude Sonnet 5.5  ' },
      { id: 'claude-opus-5-5', name: '   ' },
      { id: 'claude-fable-5-1', name: 7 },
    ])).toEqual({
      kind: 'models',
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5' },
        { id: 'claude-fable-5-1' },
      ],
    })
  })
})

describe('mergePoolModels', () => {
  it('keeps every edited row the pool still lists, with its own metadata', () => {
    const current = [
      draft({ id: 'claude-sonnet-5-5', name: 'Sonnet', contextWindow: '200000', maxTokens: '32000', defaultReasoning: 'max' }),
      draft({ id: 'claude-opus-5-5', name: 'Opus' }),
    ]

    const merge = mergePoolModels(current, [
      { id: 'claude-sonnet-5-5', name: 'Pool name' },
      { id: 'claude-opus-5-5', name: 'Opus pool name' },
    ])

    expect(merge.keptRows).toEqual([0, 1])
    expect(merge.added).toEqual([])
    expect(merge.removedIds).toEqual([])
  })

  it('appends models the table lacks with safe defaults and the pool display name', () => {
    const merge = mergePoolModels([draft()], [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-nova-5', name: 'Claude Nova 5' },
      { id: 'claude-unknown-5' },
    ])

    expect(merge.keptRows).toEqual([0])
    expect(merge.added).toEqual([
      { id: 'claude-nova-5', name: 'Claude Nova 5', contextWindow: '1000000', maxTokens: '128000', defaultReasoning: 'medium' },
      { id: 'claude-unknown-5', name: 'claude-unknown-5', contextWindow: '1000000', maxTokens: '128000', defaultReasoning: 'medium' },
    ])
    expect(merge.removedIds).toEqual([])
  })

  it('reports the rows the pool dropped, in table order and without repeats', () => {
    const merge = mergePoolModels([
      draft({ id: 'claude-sonnet-5-5' }),
      draft({ id: 'claude-gone-5' }),
      draft({ id: 'claude-fable-5-1' }),
      draft({ id: 'claude-gone-5' }),
    ], [{ id: 'claude-sonnet-5-5' }])

    expect(merge.keptRows).toEqual([0])
    expect(merge.removedIds).toEqual(['claude-gone-5', 'claude-fable-5-1'])
  })

  it('keeps an unfinished row that carries no id yet', () => {
    const merge = mergePoolModels([draft({ id: '  ' }), draft({ id: 'claude-sonnet-5-5' })], [
      { id: 'claude-sonnet-5-5' },
      { id: 'claude-nova-5' },
    ])

    expect(merge.keptRows).toEqual([0, 1])
    expect(merge.removedIds).toEqual([])
    expect(merge.added.map(added => added.id)).toEqual(['claude-nova-5'])
  })

  it('adds nothing when every listed model already has a row, duplicate ids included', () => {
    const merge = mergePoolModels([
      draft({ id: 'claude-sonnet-5-5' }),
      draft({ id: 'claude-sonnet-5-5' }),
    ], [{ id: 'claude-sonnet-5-5' }])

    expect(merge.keptRows).toEqual([0, 1])
    expect(merge.added).toEqual([])
  })
})
