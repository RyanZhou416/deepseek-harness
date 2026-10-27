/** Catalogue draft conversion and the validation that blocks a save. */

import { describe, expect, it } from 'vitest'
import {
  draftOf, draftsEqual, draftsOf, emptyDraft, isPositiveIntegerText, modelsOfDrafts, validateDrafts,
} from '../src/client/model-draft.ts'
import type { CcPoolModel } from '../src/client/contract.ts'

const MODEL: CcPoolModel = {
  id: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  defaultReasoning: 'medium',
}

describe('catalogue drafts', () => {
  it('spells stored entries as text and converts a valid list back with trimmed text', () => {
    const draft = draftOf(MODEL)
    expect(draft).toEqual({
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      contextWindow: '1000000',
      maxTokens: '128000',
      defaultReasoning: 'medium',
    })
    expect(modelsOfDrafts([{ ...draft, id: ' claude-sonnet-5-5 ', name: ' Claude Sonnet 5.5 ' }])).toEqual([MODEL])
    expect(draftsOf([MODEL])).toEqual([draft])
  })

  it('starts a new row without an id and at the middle effort', () => {
    expect(emptyDraft()).toEqual({ id: '', name: '', contextWindow: '', maxTokens: '', defaultReasoning: 'medium' })
  })

  it('compares draft lists field by field', () => {
    const row = draftOf(MODEL)
    expect(draftsEqual([row], [{ ...row }])).toBe(true)
    expect(draftsEqual([row], [{ ...row, maxTokens: '1' }])).toBe(false)
    expect(draftsEqual([row], [])).toBe(false)
  })

  it('reads stored text in the form a save writes, falling back to the id for a blank name', () => {
    expect(draftOf({ ...MODEL, id: '  claude-sonnet-5-5  ', name: '  Claude Sonnet 5.5  ' })).toEqual(draftOf(MODEL))
    // The Host accepts a whitespace-only display name; the page reads the
    // value it would write (the id) instead of opening on an error it cannot clear.
    expect(draftOf({ ...MODEL, name: '   ' })).toMatchObject({ id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' })
  })

  it('compares the values a save would store, not the padding around them', () => {
    const row = draftOf(MODEL)
    expect(draftsEqual(
      [{ ...row, id: ' claude-sonnet-5-5 ', name: ' Claude Sonnet 5.5 ', contextWindow: ' 01000000 ', maxTokens: '0128000 ' }],
      [row],
    )).toBe(true)
    // Two readable capacities are compared by number; an unreadable one stays
    // different from a readable one, and equal when written the same way.
    expect(draftsEqual([row], [{ ...row, contextWindow: '02000000' }])).toBe(false)
    expect(draftsEqual([row], [{ ...row, maxTokens: '1.5' }])).toBe(false)
    expect(draftsEqual([{ ...row, maxTokens: '1.5' }], [{ ...row, maxTokens: ' 1.5 ' }])).toBe(true)
  })

  it('accepts padded ids and names as the trimmed text a save writes', () => {
    const padded = { ...draftOf(MODEL), id: '  claude-sonnet-5-5  ', name: '  Claude Sonnet 5.5  ' }

    expect(validateDrafts([padded])).toEqual([])
    expect(modelsOfDrafts([padded])).toEqual([MODEL])
  })

  it('reads two ids that differ only in padding as the same id', () => {
    const row = draftOf(MODEL)

    expect(validateDrafts([row, { ...row, id: ' claude-sonnet-5-5 ' }])).toEqual([
      { row: 0, field: 'id', key: 'idDuplicate' },
      { row: 1, field: 'id', key: 'idDuplicate' },
    ])
  })

  it('judges capacities as digits-only positive whole numbers', () => {
    for (const text of ['1', '128000', ' 42 ']) expect(isPositiveIntegerText(text)).toBe(true)
    for (const text of ['', '  ', '0', '-1', '1.5', '1e6', 'lots', '1,000']) expect(isPositiveIntegerText(text)).toBe(false)
  })

  it('reports every field problem with the row that owns it', () => {
    const draft = draftOf(MODEL)
    const errors = validateDrafts([
      { ...draft, id: '' },
      { ...draft },
      { ...draft, contextWindow: '0', maxTokens: '1.5', defaultReasoning: 'off' },
    ])
    expect(errors).toEqual([
      { row: 0, field: 'id', key: 'idBlank' },
      { row: 1, field: 'id', key: 'idDuplicate' },
      { row: 2, field: 'id', key: 'idDuplicate' },
      { row: 2, field: 'contextWindow', key: 'positiveInteger' },
      { row: 2, field: 'maxTokens', key: 'positiveInteger' },
      { row: 2, field: 'defaultReasoning', key: 'reasoningLevel' },
    ])
  })

  it('reports a blank display name', () => {
    expect(validateDrafts([{ ...draftOf(MODEL), name: '  ' }])).toEqual([
      { row: 0, field: 'name', key: 'nameBlank' },
    ])
  })

  it('refuses an empty list and any invalid draft when converting', () => {
    expect(modelsOfDrafts([])).toBeUndefined()
    expect(modelsOfDrafts([{ ...draftOf(MODEL), id: '' }])).toBeUndefined()
  })
})
