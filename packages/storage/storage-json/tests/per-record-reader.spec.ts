/**
 * Per-record `recordReader` behavior: the on-demand read capability a lazy
 * domain opens with. It must report the unit's key index without reading
 * record documents, read exactly one document per call, and apply the same
 * per-record contract the open-time load applies (a foreign document reads as
 * absent; an unsafe key or undeclared table is a caller error).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-reader-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const descriptor = {
  name: 'reader',
  version: 2,
  tables: ['sessions'],
  hasGlobal: true,
  layout: 'per-record',
  compatibleVersions: [1],
} as const

/** One per-record document at `<root>/reader/sessions/<key>.json`. */
async function writeRecord(root: string, key: string, version: number, record: unknown): Promise<void> {
  const dir = join(root, 'reader', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${key}.json`), JSON.stringify({ version, record }), 'utf8')
}

async function openUnit(root: string): Promise<KvUnit> {
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open({ ...descriptor, tables: [...descriptor.tables] })
  return unit
}

describe('per-record recordReader', () => {
  it('reports the key index and global slot without materializing the unit', async () => {
    const root = await freshRoot()
    const unit = await openUnit(root)
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    // A never-materialized tree is the empty unit, and listing creates nothing.
    expect(await reader.listKeys()).toEqual({ tables: { sessions: [] }, global: null })
    await writeRecord(root, 'b', 2, { title: 'b' })
    await writeRecord(root, 'a', 2, { title: 'a' })
    await writeFile(join(root, 'reader', 'global.json'), JSON.stringify({ version: 2, record: { theme: 'dark' } }))
    await writeFile(join(root, 'reader', 'sessions', 'not-json.txt'), 'ignored')
    await writeFile(join(root, 'reader', 'sessions', 'unsafe key.json'), JSON.stringify({ version: 2, record: {} }))
    const index = await reader.listKeys()
    // Directory order is the host's; the index must report exactly the readable keys.
    expect([...index.tables['sessions'] ?? []].sort()).toEqual(['a', 'b'])
    expect(index.global).toEqual({ theme: 'dark' })
    // Reading the global does not need a record read.
    expect(await reader.listKeys()).toMatchObject({ global: { theme: 'dark' } })
    await unit.close()
  })

  it('reads one accepted document and treats every foreign document as absent', async () => {
    const root = await freshRoot()
    await writeRecord(root, 'current', 2, { title: 'current' })
    await writeRecord(root, 'compatible', 1, { title: 'older' })
    await writeRecord(root, 'stale', 99, { title: 'discarded' })
    await mkdir(join(root, 'reader', 'sessions'), { recursive: true })
    await writeFile(join(root, 'reader', 'sessions', 'malformed.json'), 'not json')
    await writeFile(join(root, 'reader', 'sessions', 'scalar.json'), '42')
    await writeFile(join(root, 'reader', 'sessions', 'headerless.json'), JSON.stringify({ record: { title: 'x' } }))
    await writeFile(join(root, 'reader', 'sessions', 'string-version.json'), JSON.stringify({ version: '2', record: {} }))
    const unit = await openUnit(root)
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    expect(reader.read('sessions', 'current')).toEqual({ title: 'current' })
    // A declared compatible version still reads as its own data.
    expect(reader.read('sessions', 'compatible')).toEqual({ title: 'older' })
    for (const key of ['stale', 'malformed', 'scalar', 'headerless', 'string-version', 'missing']) {
      expect(reader.read('sessions', key)).toBeUndefined()
    }
    await unit.close()
  })

  it('reads one document asynchronously with the same contract', async () => {
    const root = await freshRoot()
    await writeRecord(root, 'current', 2, { title: 'current' })
    const unit = await openUnit(root)
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    await expect(reader.readAsync('sessions', 'current')).resolves.toEqual({ title: 'current' })
    await expect(reader.readAsync('sessions', 'missing')).resolves.toBeUndefined()
    await expect(reader.readAsync('sessions', '..')).rejects.toThrow(/not path-safe/)
    await unit.close()
    await expect(reader.readAsync('sessions', 'current')).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects an unsafe key, an undeclared table, and every call after close', async () => {
    const root = await freshRoot()
    const unit = await openUnit(root)
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    expect(() => reader.read('sessions', '..')).toThrow(/not path-safe/)
    expect(() => reader.read('other', 'k')).toThrow(/does not declare table/)
    await unit.close()
    expect(() => reader.read('sessions', 'k')).toThrow(/closed/)
    await expect(reader.listKeys()).rejects.toMatchObject({ code: 'closed' })
  })

  it('bootstraps a legacy whole-unit file before listing its documents', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'reader.json'), JSON.stringify({
      unit: { name: 'reader', version: 1 },
      global: null,
      tables: { sessions: { legacy: { title: 'migrated' } } },
    }))
    const unit = await openUnit(root)
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    expect(await reader.listKeys()).toMatchObject({ tables: { sessions: ['legacy'] } })
    expect(reader.read('sessions', 'legacy')).toEqual({ title: 'migrated' })
    await unit.close()
  })

  it('leaves a foreign, malformed, or stale legacy file alone', async () => {
    const cases = [
      'not json',
      JSON.stringify({ unit: { name: 'other', version: 1 }, tables: { sessions: { a: 1 } } }),
      JSON.stringify({ unit: { name: 'reader', version: 99 }, tables: { sessions: { a: 2 } } }),
      JSON.stringify({ unit: { name: 'reader', version: 1 }, tables: 'not-a-map' }),
    ]
    for (const legacy of cases) {
      const root = await freshRoot()
      await writeFile(join(root, 'reader.json'), legacy, 'utf8')
      const unit = await openUnit(root)
      const reader = unit.recordReader
      if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
      expect(await reader.listKeys()).toEqual({ tables: { sessions: [] }, global: null })
      await unit.close()
    }
  })

  it('reports an unreadable global document as absent', async () => {
    const root = await freshRoot()
    await mkdir(join(root, 'reader'), { recursive: true })
    await writeFile(join(root, 'reader', 'global.json'), JSON.stringify({ version: 99, record: { theme: 'stale' } }))
    const unit = await openUnit(root)
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    expect(await reader.listKeys()).toMatchObject({ global: null })
    await unit.close()
  })

  it('reports no global slot when the descriptor does not declare one', async () => {
    const root = await freshRoot()
    await mkdir(join(root, 'reader'), { recursive: true })
    await writeFile(join(root, 'reader', 'global.json'), JSON.stringify({ version: 2, record: { theme: 'dark' } }))
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'reader', version: 2, tables: ['sessions'], hasGlobal: false, layout: 'per-record' })
    const reader = unit.recordReader
    if (reader === undefined) throw new Error('per-record unit must expose a recordReader')
    expect(await reader.listKeys()).toEqual({ tables: { sessions: [] }, global: null })
    await unit.close()
  })
})
