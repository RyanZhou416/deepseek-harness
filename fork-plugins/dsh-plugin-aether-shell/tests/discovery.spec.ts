/**
 * Ontology projection: which native payload shape a discovery reply has, and
 * how the requested page bounds it.
 *
 * `ontology_describe` answers an unknown name with a successful record carrying
 * `error`, so that reply shape — and only that shape — becomes the `unknown`
 * discovery. A builtin value that happens to contain an `error` key elsewhere is
 * not read as a failure.
 */

import { describe, expect, it } from 'vitest'
import { projectOntology } from '../src/discovery.ts'

const categories = (count: number) => Array.from({ length: count }, (_unused, index) => ({
  builtins: index,
  category: `Category${index}`,
  effects: ['pure'],
}))

describe('ontology projection', () => {
  it('pages the manifest and keeps the payload fields a caller reads', () => {
    const { value, discovery } = projectOntology(undefined, {
      categories: categories(5),
      effect_legend: ['pure'],
      hint: 'describe a category',
      ontology: 'manifest',
      total_builtins: 24,
    }, { offset: 0, limit: 2 })
    expect(discovery).toEqual({
      shape: 'manifest',
      offset: 0,
      shown: 2,
      total: 5,
      nextOffset: 2,
      truncated: true,
    })
    expect(value).toEqual({
      categories: categories(5).slice(0, 2),
      effect_legend: ['pure'],
      hint: 'describe a category',
      ontology: 'manifest',
      total_builtins: 24,
    })
  })

  it('reports the final page without a continuation offset', () => {
    const { discovery } = projectOntology(undefined, { categories: categories(5) }, { offset: 4, limit: 2 })
    expect(discovery).toEqual({ shape: 'manifest', offset: 4, shown: 1, total: 5, truncated: false })
  })

  it('reports an empty page past the end as untruncated', () => {
    const { discovery } = projectOntology(undefined, { categories: categories(3) }, { offset: 9, limit: 2 })
    expect(discovery).toEqual({ shape: 'manifest', offset: 3, shown: 0, total: 3, truncated: false })
  })

  it('includes every entry when no page is requested', () => {
    const { discovery } = projectOntology(undefined, { categories: categories(3) })
    expect(discovery).toEqual({ shape: 'manifest', offset: 0, shown: 3, total: 3, truncated: false })
  })

  it('carries the query a named call asked for', () => {
    const { discovery } = projectOntology('Core', { builtins: [{}], category: 'Core' }, { offset: 0, limit: 8 })
    expect(discovery).toEqual({ shape: 'category', query: 'Core', offset: 0, shown: 1, total: 1, truncated: false })
  })

  it('pages a category listing', () => {
    const { value, discovery } = projectOntology('Core', {
      builtins: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      category: 'Core',
      hint: 'pick one',
    }, { offset: 1, limit: 1 })
    expect(discovery).toEqual({
      shape: 'category',
      query: 'Core',
      offset: 1,
      shown: 1,
      total: 3,
      nextOffset: 2,
      truncated: true,
    })
    expect(value).toEqual({ builtins: [{ name: 'b' }], category: 'Core', hint: 'pick one' })
  })

  it('reads the interpreter unknown-name reply as the unknown shape', () => {
    const { value, discovery } = projectOntology('zzz', {
      error: "'zzz' is not a known category or builtin",
      hint: 'call ontology_manifest() to see categories',
    }, { offset: 0, limit: 8 })
    expect(discovery).toEqual({ shape: 'unknown', query: 'zzz', truncated: false })
    expect(value).toEqual({ error: "'zzz' is not a known category or builtin", hint: 'call ontology_manifest() to see categories' })
  })

  it('caps builtin examples by the page limit without capping the parameter contract', () => {
    const examples = Array.from({ length: 3 }, (_unused, index) => ({ code: `pwd(${index})` }))
    const { value, discovery } = projectOntology('pwd', {
      builtin: 'pwd',
      examples,
      parameters: [{ name: 'path' }, { name: 'mode' }],
      signature: 'pwd() -> String',
    }, { offset: 0, limit: 2 })
    expect(discovery).toEqual({ shape: 'builtin', query: 'pwd', truncated: true })
    expect(value).toEqual({
      builtin: 'pwd',
      examples: examples.slice(0, 2),
      parameters: [{ name: 'path' }, { name: 'mode' }],
      signature: 'pwd() -> String',
    })
  })

  it('leaves a builtin detail with few examples intact', () => {
    const detail = { builtin: 'pwd', examples: [{ code: 'pwd()' }], parameters: [], signature: 'pwd() -> String' }
    expect(projectOntology('pwd', detail, { offset: 0, limit: 8 })).toEqual({
      value: detail,
      discovery: { shape: 'builtin', query: 'pwd', truncated: false },
    })
  })

  it('treats a non-record payload as unknown', () => {
    expect(projectOntology('x', 'plain text', { offset: 0, limit: 8 })).toEqual({
      value: 'plain text',
      discovery: { shape: 'unknown', query: 'x', truncated: false },
    })
  })

  it('does not read an `error` field below the record top level as a failure', () => {
    const detail = { builtin: 'x', error: { nested: true }, parameters: [] }
    const { discovery } = projectOntology('x', detail, { offset: 0, limit: 8 })
    expect(discovery.shape).toBe('builtin')
  })
})
